/**
 * Host half of the DeepSeek Web Chat plugin.
 *
 * Responsibilities:
 *  - own the consumer-web bearer token (owner-only vault file);
 *  - proxy chat.deepseek.com, because the browser cannot call it directly
 *    (cross-origin, and the token must never live in page JavaScript);
 *  - solve the proof of work the completion endpoint demands;
 *  - keep a local snapshot of the synced history so the panel opens instantly
 *    and still shows something when the network is down.
 *
 * Every route is registered on `webServer` under one prefix and re-applies the
 * trust fence itself: exact/prefix routes bypass the shell's `/api` fence, and
 * this route hands out access to the user's DeepSeek account.
 *
 * @module dsh-deepseek-web-chat
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DeepSeekWebError,
  FILE_TERMINAL,
  MAX_FILE_BYTES,
  MODEL_TYPES,
  createSession,
  fetchCurrentUser,
  fetchFiles,
  fetchMessages,
  listSessions,
  streamCompletion,
  uploadFile,
  waitForFiles,
} from './deepseek.js';
import { clearToken, readVault, resolveStateDir, saveToken, tokenPreview } from './vault.js';

export const name = 'deepseek-web-chat';

const ROUTE_PREFIX = '/dsh-deepseek-web-chat';
const MAX_BODY_BYTES = 256 * 1024;
const CACHE_LIMIT = 200;

/**
 * How long POST /upload blocks on the upstream parse before answering anyway.
 *
 * Waiting for the parse used to be the whole design (20s ceiling), which made
 * uploading a 2MB .docx take 16s of dead time and, past the ceiling, handed the
 * picker a still-parsing file that upstream then refused — an empty answer with
 * no error. The parse is upstream work we cannot hurry, so the handler now only
 * covers the common "already parsed" case and the panel polls /files for the
 * rest (`status` stays PENDING/PARSING until it settles).
 */
const UPLOAD_SETTLE_MS = 1500;

/**
 * How long /chat waits for a referenced file to finish parsing before refusing
 * the turn. The panel refuses to send a parsing attachment, so this is a safety
 * net for a stale tab or a direct API caller — short on purpose, because a
 * caller that gets no feedback for a minute is worse off than one told to wait.
 */
const FILE_READY_MS = 5000;

/* ------------------------------------------------------------------ *
 * Local snapshot
 * ------------------------------------------------------------------ */

function cachePath() {
  return join(resolveStateDir(), 'cache.json');
}

function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'));
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {},
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return { sessions: [], messages: {}, files: {}, updatedAt: null };
  }
}

function writeCache(cache) {
  try {
    mkdirSync(resolveStateDir(), { recursive: true });
    const ids = Object.keys(cache.messages).slice(-CACHE_LIMIT);
    const trimmed = { sessions: cache.sessions, messages: {}, files: {}, updatedAt: cache.updatedAt };
    for (const id of ids) trimmed.messages[id] = cache.messages[id];
    // Session attachments outlive the message window they were used in: keep
    // them for every session the cache still knows, not only for visible ones.
    for (const id of Object.keys(cache.files || {}).slice(-CACHE_LIMIT)) {
      const list = cache.files[id];
      if (Array.isArray(list) && list.length > 0) trimmed.files[id] = list;
    }
    writeFileSync(cachePath(), JSON.stringify(trimmed), 'utf8');
  } catch {
    /* a cache that cannot be written must never fail the request */
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function loopbackAuthority(host) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

/**
 * Trust fence for this prefix.
 *
 * `Origin` is the only header a browser page cannot forge, so: refuse a Host
 * that is neither loopback nor a trusted authority (DNS rebinding), refuse an
 * explicit cross-site fetch, and require the Origin to match the Host when it
 * is present at all.
 */
function refuse(request, response) {
  const host = request.headers.host;
  if (!loopbackAuthority(host)) {
    sendJson(response, 403, { error: 'untrusted host' });
    return true;
  }
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    sendJson(response, 403, { error: 'cross-site request refused' });
    return true;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  if (typeof origin !== 'string' || origin === 'null' || origin.trim() === '') {
    sendJson(response, 403, { error: 'untrusted origin' });
    return true;
  }
  try {
    if (new URL(origin).host !== host) {
      sendJson(response, 403, { error: 'untrusted origin' });
      return true;
    }
  } catch {
    sendJson(response, 403, { error: 'untrusted origin' });
    return true;
  }
  return false;
}

/**
 * Own the abort handle for one `/chat` turn.
 *
 * Two things have to be true for "停止" to mean anything:
 *
 * 1. A second turn must not leave the first one running. The handle is
 *    single-slot, so starting a turn aborts whatever was streaming before it —
 *    otherwise an abandoned tab keeps burning the account's rate limit.
 * 2. A browser disconnect must abort the upstream request. `request.on('close')`
 *    cannot report that here: `readJsonBody` drains the body first, so the
 *    request stream is already finished and never emits 'close' on a later
 *    disconnect (verified against this Node). The response does fire on a
 *    dropped connection, and it fires again after a normal end — where
 *    `writableEnded` is already true, which is how the two are told apart.
 */
function bindTurnAbort(response, abortRef) {
  if (abortRef.current) abortRef.current.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fail(response, error) {
  const authFailed = error instanceof DeepSeekWebError && error.authFailed;
  const status = authFailed ? 401 : error instanceof DeepSeekWebError ? 400 : 500;
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
    authFailed,
  });
}

/** A token is required for everything except reading the vault state. */
function requireToken(response, vault) {
  if (!vault.token) {
    sendJson(response, 401, { error: '还没有配置 DeepSeek 网页版登录令牌', authFailed: true });
    return null;
  }
  return vault.token;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Wire version shared with `lib/client.js`.
 *
 * The two halves update on completely different schedules: the browser half is
 * hot-reloaded from disk within half a second, but this half only changes when
 * DSH restarts and re-imports the module. So an edit that touches both can be
 * half-live for hours, and the symptom is a UI that looks current while the
 * host still answers the old way — an empty conversation, a 400, or a stray
 * "缺少 sessionId". Reporting the version lets the client say that out loud
 * instead of leaving the user to guess. Bump this whenever a route's shape or
 * the reply's meaning changes.
 *
 * 4: `/sessions` pages the whole history with `lte_cursor.updated_at` and
 *    reports how many pages it walked. An old host stops at 100 conversations.
 * 5: `/upload` + `/files` + attachment-aware `/chat`. An old host has none of
 *    the file routes and would silently drop a /chat body that carries
 *    `refFileIds` and answer without the file — worse than a clear version
 *    banner, hence the bump.
 * 6: `/upload` returns the file's real parse `status` (plus `settled`) instead
 *    of blocking up to 20s on the parse, and `/chat` answers 409 while a
 *    referenced file is still parsing. An old host would return a record that
 *    already looked finished, which is the empty-answer bug itself.
 * 7: a session remembers its files, so a follow-up turn still reads the
 *    document without re-attaching it (upstream keeps nothing; probe96). An old
 *    host silently drops the file after the first question.
 */
const PROTOCOL = 7;

function statePayload(vault, cache) {
  return {
    protocol: PROTOCOL,
    hasToken: Boolean(vault.token),
    tokenPreview: tokenPreview(vault.token),
    savedAt: vault.savedAt,
    user: vault.user,
    modelTypes: MODEL_TYPES,
    sessionCount: cache.sessions.length,
    syncedAt: cache.updatedAt,
    stateDir: resolveStateDir(),
  };
}

async function handleState(response, vault, cache) {
  if (!vault.token) return sendJson(response, 200, statePayload(vault, cache));
  // Validate lazily: a stored token may have expired since the last session.
  try {
    const user = await fetchCurrentUser(vault.token);
    const fresh = saveToken(vault.token, user);
    return sendJson(response, 200, { ...statePayload(fresh, cache), valid: true });
  } catch (error) {
    if (error instanceof DeepSeekWebError && error.authFailed) {
      return sendJson(response, 200, {
        ...statePayload(vault, cache),
        valid: false,
        error: '令牌已失效，请重新获取',
      });
    }
    // Network trouble is not an auth verdict.
    return sendJson(response, 200, { ...statePayload(vault, cache), valid: null, error: error.message });
  }
}

/**
 * Accept every shape the user can realistically paste.
 *
 * chat.deepseek.com keeps its session in `localStorage.userToken`, which is a
 * JSON envelope (`{"value":"<token>","__version":"0"}`), and DevTools users
 * often copy the whole `Authorization: Bearer …` header instead. All three
 * forms are normalized to the bare token.
 */
function normalizeToken(raw) {
  let value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  value = value.replace(/^Bearer\s+/i, '').trim();
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      const inner = parsed && typeof parsed.value === 'string' ? parsed.value : '';
      if (inner) value = inner.trim();
    } catch {
      /* not an envelope: keep the literal text */
    }
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\s+/g, '');
}

async function handleSetToken(request, response, cache) {
  const body = await readJsonBody(request);
  const token = normalizeToken(body.token);
  if (!token) return sendJson(response, 400, { error: '令牌为空' });
  try {
    const user = await fetchCurrentUser(token);
    const vault = saveToken(token, user);
    return sendJson(response, 200, { ...statePayload(vault, cache), valid: true });
  } catch (error) {
    if (error instanceof DeepSeekWebError && !error.authFailed && error.status === 0) {
      // Transient network failure: keep it, the user can retry.
      const vault = saveToken(token, null);
      return sendJson(response, 200, {
        ...statePayload(vault, cache),
        valid: null,
        error: `已保存，但暂时无法验证：${error.message}`,
      });
    }
    throw new DeepSeekWebError(
      error instanceof DeepSeekWebError && error.authFailed ? '令牌无效或已过期' : error.message,
      { authFailed: true },
    );
  }
}

async function handleSessions(request, response, vault, cache) {
  const token = requireToken(response, vault);
  if (!token) return;
  const url = new URL(request.url, 'http://localhost');
  // `count` is a PAGE size, not a total: upstream rejects anything over 100 and
  // `listSessions` walks the rest with the cursor. `pages` bounds the walk.
  const count = Number(url.searchParams.get('count')) || undefined;
  const maxPages = Number(url.searchParams.get('pages')) || undefined;
  const refresh = url.searchParams.get('refresh') !== '0';
  if (!refresh && cache.sessions.length > 0) {
    return sendJson(response, 200, { sessions: cache.sessions, syncedAt: cache.updatedAt, cached: true });
  }
  const { sessions, hasMore, pages } = await listSessions(token, { count, maxPages });
  cache.sessions = sessions;
  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return sendJson(response, 200, { sessions, hasMore, pages, syncedAt: cache.updatedAt, cached: false });
}

async function handleMessages(request, response, vault, cache) {
  const token = requireToken(response, vault);
  if (!token) return;
  const url = new URL(request.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId') || '';
  if (!sessionId) return sendJson(response, 400, { error: '缺少 sessionId' });
  const refresh = url.searchParams.get('refresh') !== '0';
  const cached = cache.messages[sessionId];
  if (!refresh && Array.isArray(cached) && cached.length > 0) {
    return sendJson(response, 200, { messages: cached, cached: true });
  }
  const messages = await fetchMessages(token, sessionId);
  // An empty transcript is never a useful cache entry. Upstream returning nothing
  // is exactly the case a retry has to be able to fix, and caching it pins the
  // blank in place — which is how a parsing bug once looked like an empty history.
  if (messages.length > 0) {
    cache.messages[sessionId] = messages;
    cache.updatedAt = new Date().toISOString();
    writeCache(cache);
  }
  return sendJson(response, 200, { messages, cached: false });
}

async function handleNewSession(response, vault) {
  const token = requireToken(response, vault);
  if (!token) return;
  const sessionId = await createSession(token);
  return sendJson(response, 200, { sessionId });
}

/**
 * Upload one attachment and answer as soon as upstream accepts the bytes.
 *
 * The browser sends the RAW bytes with the file name riding in the
 * `x-file-name` header: parsing multipart in the host would mean re-implementing
 * a boundary parser for no gain, and JSON-inflating the bytes would triple the
 * payload. The header value is percent-encoded by the client and decoded here.
 *
 * The handler does NOT wait out the parse any more (see UPLOAD_SETTLE_MS): it
 * returns the first snapshot taken after a short settle window, and the record
 * carries its real `status`, so the panel can render "解析中" and poll /files
 * instead of holding the picker hostage for the whole parse.
 */
async function handleUpload(request, response, vault) {
  const token = requireToken(response, vault);
  if (!token) return;
  const rawName = request.headers['x-file-name'] || '';
  const fileName = decodeURIComponent(String(rawName)) || 'file';
  const declared = Number(request.headers['content-length']) || 0;
  if (declared > MAX_FILE_BYTES) {
    return sendJson(response, 413, { error: `文件超过 100MB 上限` });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) {
      return sendJson(response, 413, { error: '文件超过 100MB 上限' });
    }
    chunks.push(chunk);
  }
  if (size === 0) return sendJson(response, 400, { error: '上传内容为空' });
  const data = Buffer.concat(chunks);
  const contentType = typeof request.headers['content-type'] === 'string' && request.headers['content-type']
    ? request.headers['content-type'].split(';')[0].trim()
    : 'application/octet-stream';
  // Deliberately NOT `request.signal`: under this DSH build it aborts once the
  // body is drained even for healthy requests. The response close event tracks
  // whether the browser still receives the result; pass its signal through both
  // the upload request and the parse-status polling loop.
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const record = await uploadFile(token, { data, fileName, contentType }, { signal: controller.signal });
    // Short settle window: a small text file is parsed upstream before the POST
    // even returns, so most uploads still answer SUCCESS here (and no extra
    // /files round trip is needed). A document that is still parsing comes back
    // with its PENDING/PARSING status rather than blocking this handler.
    const settled = await waitForFiles(token, [record.id], {
      timeoutMs: UPLOAD_SETTLE_MS,
      signal: controller.signal,
    });
    const file = settled[0] || record;
    return sendJson(response, 200, { file, settled: FILE_TERMINAL.has(file.status) });
  } catch (error) {
    if (controller.signal.aborted) return;
    throw error;
  }
}

/**
 * Ids among `ids` that upstream has not finished parsing yet, plus the subset it
 * still knows about at all.
 *
 * The completion endpoint answers HTTP 200 with `biz_code 9` and NO stream
 * frames while a referenced file is still PENDING/PARSING (probe89), which is
 * how a Word attachment used to produce a blank reply. Waiting here turns that
 * into either a normal answer or an explicit 409; failures that DID reach a
 * terminal state are left alone, because upstream reports those itself.
 *
 * `alive` lets a caller drop remembered ids that have expired or been deleted
 * upstream instead of failing every later turn of that session.
 */
async function inspectRefFiles(token, ids, signal) {
  if (ids.length === 0) return { pending: [], alive: [] };
  const snapshot = await fetchFiles(token, ids, signal);
  const byId = new Map(snapshot.filter(Boolean).map((file) => [file.id, file]));
  const alive = ids.filter((id) => byId.has(id));
  const waiting = alive.filter((id) => !FILE_TERMINAL.has(byId.get(id).status));
  if (waiting.length === 0) return { pending: [], alive };
  const settled = await waitForFiles(token, waiting, { timeoutMs: FILE_READY_MS, signal });
  const after = new Map(settled.filter(Boolean).map((file) => [file.id, file]));
  const pending = waiting.filter((id) => {
    const record = after.get(id) || byId.get(id);
    return !record || !FILE_TERMINAL.has(record.status);
  });
  return { pending, alive };
}

/**
 * The files later turns of one session must keep referencing.
 *
 * Upstream does NOT keep a parsed file in the session context: a follow-up turn
 * sent without `ref_file_ids` cannot see the document at all (probe96 — asked
 * for coordinates in a Word file it had just read, the model answered that the
 * conversation contained no such data). chat.deepseek.com works because the
 * attachment stays with the conversation, so this host remembers the ids per
 * session and re-sends them on every later turn.
 */
function sessionFileIds(cache, sessionId) {
  const list = sessionId && cache.files ? cache.files[sessionId] : null;
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : [];
}

function rememberSessionFiles(cache, sessionId, ids) {
  if (!sessionId) return;
  if (!cache.files) cache.files = {};
  if (ids.length === 0) delete cache.files[sessionId];
  else cache.files[sessionId] = [...new Set(ids)];
}

/** Snapshot of one or more file records (the panel polls this while uploading). */
async function handleFiles(request, response, vault) {
  const token = requireToken(response, vault);
  if (!token) return;
  const url = new URL(request.url, 'http://localhost');
  const ids = (url.searchParams.get('file_ids') || '').split(',').filter(Boolean);
  const files = await fetchFiles(token, ids);
  return sendJson(response, 200, { files });
}

/**
 * Stream one chat turn as SSE.
 *
 * The browser cannot use `EventSource` here because it cannot POST, so the
 * client reads this response body with `fetch` + a `ReadableStream` reader.
 */
async function handleChat(request, response, vault, cache, abortRef) {
  const token = requireToken(response, vault);
  if (!token) return;
  const body = await readJsonBody(request);
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  // Attachments: the browser uploads each file first (POST /upload) and sends
  // the resulting ids here. Empty ids are dropped so a half-finished picker
  // state cannot produce a bogus upstream request.
  const attachedIds = Array.isArray(body.refFileIds)
    ? body.refFileIds.filter((id) => typeof id === 'string' && id)
    : [];
  // This conversation's files ride along on every turn (see sessionFileIds):
  // without them a follow-up question cannot see the document. `detachFiles`
  // is the explicit "this conversation no longer needs the file".
  const detach = body.detachFiles === true;
  const remembered = detach ? [] : sessionFileIds(cache, sessionId);
  const refFileIds = [...new Set([...attachedIds, ...remembered])];
  // A turn may be file-only: upstream accepts an empty prompt when
  // ref_file_ids is non-empty (probe84), and rejects both empty with
  // biz_code 6 "missing prompt or ref file" (probe83).
  if (!prompt.trim() && refFileIds.length === 0) {
    return sendJson(response, 400, { error: '消息为空' });
  }

  const controller = bindTurnAbort(response, abortRef);
  // Display names for the local snapshot; upstream only sees the ids.
  const attachmentNames = (Array.isArray(body.attachments) ? body.attachments : [])
    .filter((a) => a && typeof a.name === 'string' && a.name)
    .map((a) => a.name);

  // Gate the turn on the attachments actually being parsed. This runs BEFORE the
  // SSE head is written so an unparsed attachment is a clean 409 the panel can
  // show, instead of an upstream biz_code 9 that surfaces as an empty answer.
  let usedRefFileIds = refFileIds;
  try {
    const { pending, alive } = await inspectRefFiles(token, refFileIds, controller.signal);
    if (pending.length > 0) {
      if (abortRef.current === controller) abortRef.current = null;
      return sendJson(response, 409, {
        error: '附件还在解析中，请等解析完成后再发送',
        pending,
      });
    }
    // A remembered id upstream no longer lists has expired or been deleted:
    // drop it instead of failing every later turn of the session. A freshly
    // attached id is kept even when the snapshot missed it (upload/read race).
    const live = new Set(alive);
    usedRefFileIds = refFileIds.filter((id) => attachedIds.includes(id) || live.has(id));
    if (sessionId) rememberSessionFiles(cache, sessionId, detach ? [] : usedRefFileIds);
  } catch (error) {
    if (abortRef.current === controller) abortRef.current = null;
    if (controller.signal.aborted) return;
    return fail(response, error);
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof response.flushHeaders === 'function') response.flushHeaders();
  const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    if (!sessionId) {
      sessionId = await createSession(token, controller.signal);
      emit({ type: 'session', sessionId });
    } else {
      emit({ type: 'session', sessionId });
    }
    // A brand-new session only gets its id here, so the memory this turn
    // established has to be re-keyed onto the id upstream just handed out.
    if (!detach) rememberSessionFiles(cache, sessionId, usedRefFileIds);
    emit({ type: 'phase', phase: 'pow' });
    const collected = [];
    const reasoning = [];
    // Caveats belong to the ANSWER, not to the live stream: if the safety filter
    // tripped or the auto-continue budget ran out, the cached transcript has to
    // carry that too, or reopening the session shows a truncated reply as if it
    // were complete.
    let note = '';
    let filtered = false;
    for await (const event of streamCompletion(
      token,
      {
        sessionId,
        prompt,
        modelType: typeof body.modelType === 'string' ? body.modelType : 'default',
        thinking: Boolean(body.thinking),
        search: Boolean(body.search),
        refFileIds: usedRefFileIds,
      },
      controller.signal,
    )) {
      if (event.type === 'text') collected.push(event.text);
      else if (event.type === 'thinking') reasoning.push(event.text);
      else if (event.type === 'note') note = event.text || '';
      else if (event.type === 'status' && event.status === 'CONTENT_FILTER') filtered = true;
      if (event.type === 'phase') continue;
      emit(event);
    }
    const answer = collected.join('');
    if (answer) {
      const list = Array.isArray(cache.messages[sessionId]) ? cache.messages[sessionId] : [];
      // The user turn carries its attachments the same way a synced upstream
      // turn does (`files`), so a reload renders both identically. `names`
      // feeds the chip label because synced turns carry real file names; a
      // freshly sent turn only has the ids until the next sync. Only what the
      // user attached THIS turn is stored for display — the remembered session
      // files still ride upstream, they are just not re-shown per turn.
      list.push({ role: 'user', content: prompt, files: attachedIds, names: attachmentNames });
      // `reasoning` is carried the same way the history route carries a synced
      // turn's THINK fragment, so a turn sent from here reads back identically
      // whether it came from /chat or from a fresh upstream read.
      list.push({ role: 'assistant', content: answer, reasoning: reasoning.join(''), note, filtered });
      cache.messages[sessionId] = list;
      cache.updatedAt = new Date().toISOString();
      const known = cache.sessions.some((session) => session.id === sessionId);
      if (!known) {
        // File-only turns have no prompt to title from; upstream shows the
        // file name, so fall back to the first attachment's name.
        cache.sessions.unshift({
          id: sessionId,
          title: (prompt || attachmentNames.join(', ')).slice(0, 60),
          titleType: null,
          pinned: false,
          updatedAt: Date.now() / 1000,
        });
      }
      writeCache(cache);
    }
    emit({ type: 'end', sessionId });
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'error', error: '已停止生成', aborted: true });
    } else {
      emit({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        authFailed: error instanceof DeepSeekWebError ? error.authFailed : false,
      });
    }
  } finally {
    // Only clear our own handle: a newer /chat may already have replaced it.
    if (abortRef.current === controller) abortRef.current = null;
    if (!response.writableEnded) response.end();
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const cache = readCache();
  const abortRef = { current: null };

  ctx.effect(() => () => {
    if (abortRef.current) abortRef.current.abort();
    writeCache(cache);
  }, 'deepseek-web-chat: flush cache');

  ctx.inject(['webServer'], (hostCtx) => {
    const register = (kind, path, handler) =>
      hostCtx.effect(
        () => hostCtx.webServer.register({ kind, path, handler }),
        `deepseek-web-chat: ${kind} ${path}`,
      );

    register('exact', `${ROUTE_PREFIX}/state`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleState(response, readVault(), cache);
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/token`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleSetToken(request, response, cache);
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/token/clear`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
      clearToken();
      return sendJson(response, 200, statePayload(readVault(), cache));
    });

    register('exact', `${ROUTE_PREFIX}/sessions`, async (request, response) => {
      if (refuse(request, response)) return;
      try {
        return await handleSessions(request, response, readVault(), cache);
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/messages`, async (request, response) => {
      if (refuse(request, response)) return;
      try {
        return await handleMessages(request, response, readVault(), cache);
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/session/new`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleNewSession(response, readVault());
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/chat`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleChat(request, response, readVault(), cache, abortRef);
      } catch (error) {
        if (!response.headersSent) return fail(response, error);
        response.end();
      }
    });

    register('exact', `${ROUTE_PREFIX}/upload`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleUpload(request, response, readVault());
      } catch (error) {
        return fail(response, error);
      }
    });

    register('exact', `${ROUTE_PREFIX}/files`, async (request, response) => {
      if (refuse(request, response)) return;
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' });
      try {
        return await handleFiles(request, response, readVault());
      } catch (error) {
        return fail(response, error);
      }
    });
  });
}
