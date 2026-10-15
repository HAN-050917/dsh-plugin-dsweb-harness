/**
 * Minimal client for the DeepSeek consumer web app (chat.deepseek.com).
 *
 * This talks to the same private endpoints the website itself uses, with the
 * signed-in user's own bearer token. Read paths (session list, message
 * history) need no proof of work; the completion path does, so `lib/pow.js`
 * solves DeepSeekHashV1 before every send.
 *
 * @module dsh-deepseek-web-chat/deepseek
 */

import { solveAndBuildHeader } from './pow.js';

export const WEB_ORIGIN = 'https://chat.deepseek.com';
export const COMPLETION_TARGET = '/api/v0/chat/completion';
export const CONTINUE_TARGET = '/api/v0/chat/continue';

/**
 * How many seamless continuation rounds one turn may splice.
 *
 * Upstream cuts a long answer off mid-sentence and asks for `/chat/continue`
 * (status `INCOMPLETE` / `auto_continue: true`). The web app does this
 * automatically; so do we, with the same bound ds2api uses.
 */
const AUTO_CONTINUE_LIMIT = 8;

/**
 * Session-list paging bounds.
 *
 * Upstream answers `ILLEGAL_COUNT` above 100, so a page can never be bigger
 * than this; `MAX_PAGES` is only a runaway guard (a 12-page walk would be 1200
 * conversations).
 */
const MAX_PAGE = 100;
const MAX_PAGES = 12;

/** The web app's own client identity; several endpoints behave differently without it. */
const CLIENT_VERSION = '2.0.4';
const APP_VERSION = '20241129.1';

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Mobile Safari/537.36';

/** Model type ids the web app accepts (`promptcompat.GetModelType` in ds2api). */
export const MODEL_TYPES = [
  { id: 'default', label: 'V4 快速 (default)' },
  { id: 'expert', label: 'V4 专家 (expert)' },
  { id: 'vision', label: 'V4 视觉 (vision)' },
];

/**
 * Request headers for the consumer web endpoints.
 *
 * Exported so probes and tests reuse the *real* header builder instead of
 * hand-copying it: a hand-rolled variant missing the session-scoped `referer`
 * gets `{code:0, data:null}` back from `fetch_page` — a silent empty result
 * that looks exactly like "this account has no sessions".
 */
export function baseHeaders(token, sessionId) {
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'user-agent': UA,
    origin: WEB_ORIGIN,
    referer: sessionId ? `${WEB_ORIGIN}/a/chat/s/${sessionId}` : `${WEB_ORIGIN}/`,
    'x-app-version': APP_VERSION,
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'accept-charset': 'UTF-8',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Pull the envelope status the way ds2api's `extractResponseStatus` does. */
export function responseStatus(payload) {
  if (!payload || typeof payload !== 'object') return { code: 0, bizCode: 0, msg: '', bizMsg: '' };
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const bizData = data.biz_data && typeof data.biz_data === 'object' ? data.biz_data : {};
  return {
    code: Number(payload.code ?? 0),
    bizCode: Number(data.biz_code ?? 0),
    msg: typeof payload.msg === 'string' ? payload.msg : '',
    bizMsg: typeof data.biz_msg === 'string' ? data.biz_msg : typeof bizData.msg === 'string' ? bizData.msg : '',
  };
}

/** True when a status triple means "your token is gone", not "your request was wrong". */
export function isAuthFailure(status, envelope) {
  if (status === 401 || status === 403) return true;
  const { code, bizCode, msg, bizMsg } = envelope;
  if ([40001, 40002, 40003].includes(code) || [40001, 40002, 40003].includes(bizCode)) return true;
  const text = `${msg} ${bizMsg}`.toLowerCase();
  return /token|unauthorized|expired|not login|login required|invalid jwt|未登录|登录|认证|令牌|凭证|会话过期/.test(
    text,
  );
}

export class DeepSeekWebError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DeepSeekWebError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 0;
    this.bizCode = options.bizCode ?? 0;
    this.authFailed = Boolean(options.authFailed);
  }
}

/** One JSON request against the web API, with envelope-level error reporting. */
export async function webJson(path, options = {}) {
  const { token, method = 'GET', body, signal, sessionId } = options;
  const response = await fetch(`${WEB_ORIGIN}${path}`, {
    method,
    headers: baseHeaders(token, sessionId),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DeepSeekWebError(
      `chat.deepseek.com 返回了非 JSON 响应 (HTTP ${response.status})`,
      { status: response.status, authFailed: response.status === 401 || response.status === 403 },
    );
  }
  const envelope = responseStatus(payload);
  if (!response.ok || envelope.code !== 0 || envelope.bizCode !== 0) {
    const detail = envelope.bizMsg || envelope.msg || `HTTP ${response.status}`;
    throw new DeepSeekWebError(detail, {
      status: response.status,
      code: envelope.code,
      bizCode: envelope.bizCode,
      authFailed: isAuthFailure(response.status, envelope),
    });
  }
  return payload;
}

function bizData(payload) {
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
  return data.biz_data && typeof data.biz_data === 'object' ? data.biz_data : {};
}

/**
 * Session titles come back percent-encoded (the reference backup tooling runs
 * `unquote()` on every title for exactly this reason). A title that is not
 * valid percent-encoding — a bare `%` typed by the user, say — would make
 * `decodeURIComponent` throw, so the raw text is the fallback.
 */
export function decodeTitle(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Who the token belongs to; also the cheapest validity probe. */
export async function fetchCurrentUser(token, signal) {
  const payload = await webJson('/api/v0/users/current', { token, signal });
  const user = bizData(payload).user ?? bizData(payload);
  const email = typeof user.email === 'string' ? user.email : '';
  const mobile = typeof user.mobile_number === 'string' ? user.mobile_number : '';
  const name = typeof user.name === 'string' && user.name ? user.name : email || mobile || 'DeepSeek 用户';
  return { name, email, mobile, id: user.id ?? null };
}

/**
 * Session list, newest first.
 *
 * The endpoint caps a page at 100 (`count=101` answers `ILLEGAL_COUNT`, and so
 * does 500 — which is why asking for 500 used to fall through to the cursor
 * form below and silently return one page). Paging is done with the age of the
 * OLDEST row already seen: `lte_cursor.updated_at=<that timestamp>` returns the
 * next page starting at it, so the boundary row repeats and has to be de-duped
 * by id. Verified against a live account: 4 requests walked 329 conversations,
 * where a single request stopped at 100.
 *
 * `lte_cursor.pinned` must ride along — without it the request is rejected.
 */
export async function listSessions(token, options = {}) {
  const count = Math.max(1, Math.min(MAX_PAGE, Number(options.count) || MAX_PAGE));
  const signal = options.signal;
  const maxPages = Math.max(1, Math.min(MAX_PAGES, Number(options.maxPages) || MAX_PAGES));

  const collect = (payload) => {
    const data = bizData(payload);
    const sessions = Array.isArray(data.chat_sessions) ? data.chat_sessions : [];
    return {
      sessions: sessions
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({
          id: s.id,
          title: decodeTitle(s.title) || '未命名对话',
          titleType: s.title_type ?? null,
          pinned: Boolean(s.pinned),
          updatedAt: Number(s.updated_at) || 0,
        })),
      hasMore: Boolean(data.has_more),
    };
  };

  const page = async (cursor) => {
    const query =
      cursor === null
        ? `/api/v0/chat_session/fetch_page?count=${count}&lte_cursor.pinned=false`
        : `/api/v0/chat_session/fetch_page?count=${count}&lte_cursor.pinned=false&lte_cursor.updated_at=${cursor}`;
    return collect(await webJson(query, { token, signal }));
  };

  const first = await page(null);

  // A caller that only wants the newest slice (or a probe) can stop here.
  if (options.singlePage) return first;

  const merged = [];
  const seen = new Set();
  let cursor = null;
  let current = first;
  let pages = 0;

  for (;;) {
    pages += 1;
    for (const session of current.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      merged.push(session);
    }

    const oldest = current.sessions[current.sessions.length - 1];
    if (!current.hasMore || !oldest || pages >= maxPages) break;
    // The cursor is the oldest row's timestamp; if it will not move, another
    // request would return the same page forever.
    if (oldest.updatedAt === cursor) break;
    cursor = oldest.updatedAt;
    const next = await page(cursor);
    // A page that adds nothing new is the end of the road, `has_more` or not.
    if (!next.sessions.some((s) => !seen.has(s.id))) break;
    current = next;
  }

  return { sessions: merged, hasMore: current.hasMore, pages };
}

/**
 * Full message history of one conversation.
 *
 * The payload carries NO `content` on a message: the text lives in
 * `fragments[]`, and which fragment holds the visible body depends on the role.
 * Verified against a live account:
 *   USER      -> a single `REQUEST` fragment holding the prompt
 *   ASSISTANT -> `THINK` (reasoning), then `RESPONSE` (the answer), plus
 *                `TOOL_SEARCH` / `TOOL_OPEN` bookkeeping fragments
 * A `TEMPLATE_RESPONSE` fragment replaces the body when the safety filter
 * tripped, so it is real content too — but `THINK` must never be concatenated
 * into the answer or reopened sessions show reasoning as if the model had said
 * it.
 */
const BODY_FRAGMENT_TYPES = new Set(['RESPONSE', 'REQUEST', 'TEMPLATE_RESPONSE']);
const THINKING_FRAGMENT_TYPES = new Set(['THINK']);

/**
 * Bookkeeping fragments that must never reach the reader.
 *
 * A search round is not just an answer: upstream announces a `SEARCH` fragment
 * (queries + result list), then writes `搜索到 12 个网页` into it as accounting,
 * and closes with a canned TIP. The web app draws those as inline chips around
 * the answer; we have no chip UI, so the honest thing is to drop them — the
 * reason `搜索到 36 个网页` once appeared glued to the front of an answer.
 */
const META_FRAGMENT_TYPES = new Set(['SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN', 'TIP', 'SEARCH_RESULT']);

/**
 * Map an upstream fragment type onto how its content is displayed.
 *
 * `state.fragmentKind` carries this, not just text/thinking, because the deltas
 * that follow a fragment container append (`response/fragments/-1/content`) are
 * typed by what was announced — and a search round's `-1` is the SEARCH
 * fragment, whose content is accounting rather than prose.
 */
function kindOfType(type) {
  const upper = String(type ?? '').toUpperCase();
  if (upper === 'THINK' || upper === 'THINKING') return 'thinking';
  if (upper === 'RESPONSE' || upper === 'TEMPLATE_RESPONSE') return 'text';
  return 'meta';
}

/**
 * Paths whose value is protocol state, never prose.
 *
 * `response/conversation_mode` is the load-bearing one: a search turn sets it to
 * `"SEARCH"` (or `"DEEP_SEARCH"`), and because a bare `{"p":…,"v":"SEARCH"}` used
 * to fall through to the generic string branch it landed in the body — the
 * literal `DEEP_SEARCH` prefix the user saw glued to their answer. The rest are
 * per-fragment bookkeeping that must not be mistaken for content either.
 */
const SKIP_PATHS = new Set([
  'response/conversation_mode',
  'response/search_status',
  'response/search_enabled',
  'response/search_triggered',
  'response/extra_search_providers',
  'response/has_pending_fragment',
  'response/auto_continue',
  'response/incomplete_message',
  'response/files',
  'response/feedback',
  'response/ban_edit',
  'response/ban_regenerate',
  'response/thinking_enabled',
  'response/accumulated_token_usage',
  'response/inserted_at',
  'response/message_id',
  'response/parent_id',
  'response/model',
  'response/role',
  'response/fragments/-1/results',
  'response/fragments/-1/queries',
  'response/fragments/-1/references',
  'response/fragments/-1/status',
  'response/fragments/-1/search_status',
]);

/**
 * Bare protocol words that are never an answer.
 *
 * A control word can also arrive with no path at all. Only exact protocol
 * vocabulary is listed, so a genuine short answer is still kept.
 */
const CONTROL_WORDS = new Set([
  'FINISHED',
  'CONTENT_FILTER',
  'WIP',
  'INCOMPLETE',
  'AUTO_CONTINUE',
  'DEEP_SEARCH',
  'SEARCH',
  'SEARCHING',
  'THINKING',
]);

function collectFragmentText(message, wanted, options = {}) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const includeUntyped = options.includeUntyped !== false;
  const parts = [];
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object') continue;
    const type = String(fragment.type ?? '').toUpperCase();
    if (type && !wanted.has(type)) continue;
    if (!type && !includeUntyped) continue;
    const text =
      typeof fragment.content === 'string'
        ? fragment.content
        : typeof fragment.text === 'string'
          ? fragment.text
          : '';
    if (text) parts.push(text);
  }
  // Some payload variants do put a plain `content` on the message itself.
  if (!parts.length && !fragments.length && typeof message.content === 'string') return message.content;
  return parts.join('');
}

/**
 * Remove search/TIP bookkeeping that leaked into a collected body.
 *
 * The typed lookup above already excludes it, but the last-resort branch of
 * `parseHistoryMessages` accepts any fragment so that an unknown future type is
 * not silently dropped. A turn whose ONLY fragments are bookkeeping would then
 * be resurrected as an answer reading `搜索到 12 个网页本回答由AI生成…`, so the
 * meta text is subtracted from whatever was collected.
 */
function stripFragmentText(message, content) {
  if (!content) return content;
  let cleaned = content;
  for (const fragment of Array.isArray(message.fragments) ? message.fragments : []) {
    if (!fragment || typeof fragment !== 'object') continue;
    const type = String(fragment.type ?? '').toUpperCase();
    if (!META_FRAGMENT_TYPES.has(type)) continue;
    const text = typeof fragment.content === 'string' ? fragment.content : '';
    if (text && cleaned.includes(text)) cleaned = cleaned.split(text).join('');
  }
  return cleaned.trim() ? cleaned : '';
}

/**
 * Turn one upstream history envelope into the panel's message list.
 *
 * Kept separate from the request so `test-history.mjs` can replay a real
 * captured payload: the shape of this endpoint is not documented anywhere and
 * was wrong once already (`messages[]` instead of `chat_messages[]`), which
 * silently produced an empty transcript while the session list worked fine.
 */
export function parseHistoryMessages(payload) {
  const data = bizData(payload);
  const raw = Array.isArray(data.chat_messages)
    ? data.chat_messages
    : Array.isArray(data.messages)
      ? data.messages
      : [];
  return raw
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = String(message.role ?? '').toUpperCase() === 'USER' ? 'user' : 'assistant';
      // A user turn is a REQUEST fragment; an assistant turn is its RESPONSE.
      // Fall back to any fragment when the role is unknown, and to a plain
      // `content` field for payload variants that still ship one.
      const wanted = role === 'user' ? new Set(['REQUEST']) : BODY_FRAGMENT_TYPES;
      let content = collectFragmentText(message, wanted);
      if (!content) content = collectFragmentText(message, BODY_FRAGMENT_TYPES, { includeUntyped: false });
      if (!content) {
        content = collectFragmentText(message, new Set(), { includeUntyped: true });
      }
      // Bookkeeping fragments are dropped here rather than in `wanted`, because
      // the last-resort branch above would otherwise resurrect them as an answer
      // when a turn carries *only* search accounting.
      content = stripFragmentText(message, content);
      const reasoning = role === 'assistant' ? collectFragmentText(message, THINKING_FRAGMENT_TYPES) : '';
      // A user turn with attachments carries one FILE fragment per upload batch
      // (`{type:'FILE', files:[{id,file_name,status,…}]}`) ahead of the REQUEST.
      const files = [];
      for (const fragment of Array.isArray(message.fragments) ? message.fragments : []) {
        if (!fragment || typeof fragment !== 'object') continue;
        if (String(fragment.type ?? '').toUpperCase() !== 'FILE') continue;
        for (const f of Array.isArray(fragment.files) ? fragment.files : []) {
          if (f && typeof f === 'object' && typeof f.id === 'string') files.push(fileRecord(f));
        }
      }
      return {
        role,
        content,
        reasoning,
        files,
        id: message.message_id ?? message.id ?? null,
        status: typeof message.status === 'string' ? message.status : '',
      };
    })
    .filter((message) => message && message.content !== '');
}

export async function fetchMessages(token, sessionId, signal) {
  const payload = await webJson(
    `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
    { token, signal, sessionId },
  );
  return parseHistoryMessages(payload);
}

export async function createSession(token, signal) {
  const payload = await webJson('/api/v0/chat_session/create', {
    token,
    method: 'POST',
    body: { agent: 'chat' },
    signal,
  });
  const data = bizData(payload);
  const direct = typeof data.id === 'string' ? data.id.trim() : '';
  if (direct) return direct;
  const nested = data.chat_session && typeof data.chat_session.id === 'string' ? data.chat_session.id.trim() : '';
  if (nested) return nested;
  throw new DeepSeekWebError('创建会话成功但响应中没有会话 id');
}

/** Ask for a challenge and turn it into the `x-ds-pow-response` header value. */
const COMPLETION_BODY_TYPES = new Set(['RESPONSE', 'TEMPLATE_RESPONSE']);

/** Upstream asks for challenges at `/api/v0/chat/create_pow_challenge` for EVERY target — file uploads included. */
export async function solvePowHeader(token, options = {}) {
  const targetPath = options.targetPath || COMPLETION_TARGET;
  const payload = await webJson('/api/v0/chat/create_pow_challenge', {
    token,
    method: 'POST',
    body: { target_path: targetPath },
    signal: options.signal,
  });
  const challenge = bizData(payload).challenge;
  if (!challenge || typeof challenge !== 'object') {
    throw new DeepSeekWebError('创建 PoW 挑战成功但响应中没有 challenge');
  }
  return solveAndBuildHeader(challenge, { signal: options.signal, onProgress: options.onProgress });
}

/* ------------------------------------------------------------------ *
 * File upload (chat.deepseek.com "send a file" path)
 * ------------------------------------------------------------------ */

export const UPLOAD_TARGET = '/api/v0/file/upload_file';

/** The web bundle caps uploads at `maxCount:50, maxSizeMB:cv(0x6400000)` = 100 MiB. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Upload one file and return its terminal record.
 *
 * The wire order (reverse-engineered from the real bundle + verified live):
 *   1. PoW challenge for `/api/v0/file/upload_file` — a DIFFERENT target than
 *      completion; reusing a completion header fails the upload check.
 *   2. multipart POST, field name `file`, WITHOUT a caller-set `content-type`
 *      (fetch must mint the boundary) and WITHOUT `accept-charset`.
 *   3. poll `fetch_files` until the record leaves PENDING/PARSING (~1s).
 *
 * `data` is a Uint8Array/Buffer; `fileName` may be any unicode string — it
 * travels inside the multipart part, not a header, so no escaping is needed.
 */
export async function uploadFile(token, file, options = {}) {
  const { fileName, contentType = 'application/octet-stream', data } = file;
  if (!data) throw new DeepSeekWebError('上传缺少文件内容');
  const size = data.byteLength ?? data.size ?? 0;
  if (size > MAX_FILE_BYTES) {
    throw new DeepSeekWebError(`文件超过 100MB 上限（${Math.round(size / 1024 / 1024)}MB）`);
  }

  const { header } = await solvePowHeader(token, { targetPath: UPLOAD_TARGET, signal: options.signal });

  // `content-type` must be dropped so fetch generates the multipart boundary
  // itself; a caller-set JSON/boundary header makes upstream answer
  // `Invalid boundary for multipart/form-data request`.
  const headers = baseHeaders(token);
  delete headers['content-type'];
  delete headers['accept-charset'];
  headers['x-ds-pow-response'] = header;
  headers['x-file-size'] = String(size);

  const form = new FormData();
  form.append('file', new Blob([data], { type: contentType }), fileName || 'file');

  const response = await fetch(`${WEB_ORIGIN}${UPLOAD_TARGET}`, {
    method: 'POST',
    headers,
    body: form,
    signal: options.signal,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DeepSeekWebError(`chat.deepseek.com 返回了非 JSON 响应 (HTTP ${response.status})`, {
      status: response.status,
      authFailed: response.status === 401 || response.status === 403,
    });
  }
  const envelope = responseStatus(payload);
  if (!response.ok || envelope.code !== 0 || envelope.bizCode !== 0) {
    throw new DeepSeekWebError(envelope.bizMsg || envelope.msg || `HTTP ${response.status}`, {
      status: response.status,
      code: envelope.code,
      bizCode: envelope.bizCode,
      authFailed: isAuthFailure(response.status, envelope),
    });
  }
  const record = fileRecord(bizData(payload));
  if (!record.id) throw new DeepSeekWebError('上传成功但响应中没有文件 id');
  return record;
}

/** Normalize one upstream file record into the shape the panel renders. */
export function fileRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof r.id === 'string' ? r.id : '',
    fileName: typeof r.file_name === 'string' ? r.file_name : '',
    status: typeof r.status === 'string' ? r.status : '',
    size: Number(r.file_size) || 0,
    isImage: Boolean(r.is_image),
    modelKind: typeof r.model_kind === 'string' ? r.model_kind : '',
    errorCode: r.error_code ?? null,
    tokenUsage: Number(r.token_usage) || 0,
  };
}

/** `GET /api/v0/file/fetch_files?file_ids=a,b` — one snapshot of the records. */
export async function fetchFiles(token, fileIds, signal) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).filter((id) => typeof id === 'string' && id);
  if (!ids.length) return [];
  const payload = await webJson(`/api/v0/file/fetch_files?file_ids=${encodeURIComponent(ids.join(','))}`, { token, signal });
  const data = bizData(payload);
  const files = Array.isArray(data.files) ? data.files : [];
  return files.map(fileRecord);
}

/** Parse states a file never leaves; anything else is still being parsed. */
export const FILE_TERMINAL = new Set(['SUCCESS', 'FAILED', 'CONTENT_FILTER']);

/**
 * Poll a file set until every record is terminal.
 *
 * Live behavior: PENDING → PARSING → SUCCESS within about a second, but the
 * first upload after a cold start has taken visibly longer, so the default
 * deadline is generous (20s) and every poll reports the freshest snapshot via
 * `onPoll` so the panel can keep a spinner honest.
 */
export async function waitForFiles(token, fileIds, options = {}) {
  const deadline = Date.now() + (Number(options.timeoutMs) || 20000);
  let records = [];
  for (;;) {
    records = await fetchFiles(token, fileIds, options.signal);
    const byId = new Map(records.map((r) => [r.id, r]));
    const allSettled = fileIds.every((id) => byId.has(id) && FILE_TERMINAL.has(byId.get(id).status));
    if (options.onPoll) options.onPoll(records);
    if (allSettled || Date.now() >= deadline) {
      return fileIds.map((id) => byId.get(id) || null);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 600);
      if (options.signal) {
        const cancel = () => {
          clearTimeout(timer);
          resolve();
        };
        if (options.signal.aborted) cancel();
        else options.signal.addEventListener('abort', cancel, { once: true });
      }
    });
    if (options.signal && options.signal.aborted) throw new DeepSeekWebError('上传已取消');
  }
}


/* ------------------------------------------------------------------ *
 * SSE parsing
 * ------------------------------------------------------------------ */

const SKIP_CONTAINS = ['quasi_status', 'elapsed_secs', 'pending_fragment', 'fragments/-1/status', 'fragments/-2/status', 'fragments/-3/status'];
const SKIP_EXACT = new Set(['response/search_status']);

function shouldSkipPath(path) {
  if (SKIP_PATHS.has(path)) return true;
  if (SKIP_EXACT.has(path)) return true;
  if (path.startsWith('response/fragments/') && path.endsWith('/status')) {
    return /^-?\d+$/.test(path.slice('response/fragments/'.length, -'/status'.length));
  }
  return SKIP_CONTAINS.some((needle) => path.includes(needle));
}

/** `response/status`, `status`, and fragment `/status` carry control words, not text. */
function isStatusPath(path) {
  return path === 'status' || path === 'response/status' || /\/status$/.test(path);
}

const TERMINAL_STATUS = new Set(['FINISHED', 'CONTENT_FILTER']);
const PENDING_STATUS = new Set(['WIP', 'INCOMPLETE', 'AUTO_CONTINUE']);

function fragmentText(fragment) {
  if (!fragment || typeof fragment !== 'object') return { type: '', content: '' };
  const type = String(fragment.type ?? '').toUpperCase();
  let content = typeof fragment.content === 'string' ? fragment.content : '';
  if (!content && Array.isArray(fragment.fragments)) {
    content = fragment.fragments.map((item) => (typeof item?.content === 'string' ? item.content : '')).join('');
  }
  return { type, content };
}

/**
 * Reduce one decoded SSE `data:` payload into visible content.
 *
 * Mirrors ds2api's `ParseSSEChunkForContentDetailed`: an empty path means the
 * value is body text (the web app sends plain tokens that way), a fragment
 * container APPEND carries whole fragments, and status paths only ever carry
 * control words. Whitespace-only tokens are real and must be kept.
 */
export function reduceChunk(chunk, state) {
  const out = { text: '', thinking: '', status: null, searchStatus: null, usage: null };
  if (!chunk || typeof chunk !== 'object' || !('v' in chunk)) return out;
  const path = typeof chunk.p === 'string' ? chunk.p : '';
  const op = typeof chunk.o === 'string' ? chunk.o.toUpperCase() : '';
  if (shouldSkipPath(path)) return out;

  if (isStatusPath(path)) {
    const value = chunk.v;
    if (typeof value === 'string') {
      const word = value.trim().toUpperCase();
      if (TERMINAL_STATUS.has(word)) out.status = word;
      else if (PENDING_STATUS.has(word)) out.status = word;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.v === 'string') {
          const word = item.v.trim().toUpperCase();
          if (TERMINAL_STATUS.has(word) || PENDING_STATUS.has(word)) out.status = word;
        }
      }
    }
    return out;
  }

  const push = (text, kind) => {
    if (!text || kind === 'meta') return;
    if (kind === 'thinking') {
      out.thinking += text;
      state.emittedThinking = (state.emittedThinking || '') + text;
    } else {
      out.text += text;
      state.emittedText = (state.emittedText || '') + text;
    }
  };
  // Fragments reached through the container-append branch are appended by
  // `collectFragment`, which has no `out` of its own — hand it this closure so
  // the emitted-text ledger stays complete and continuation snapshots dedupe.
  state.pushText = push;
  const walk = (value, path = typeof chunk.p === 'string' ? chunk.p : '') => {
    if (typeof value === 'string') {
      if (value === 'FINISHED' && (path === '' || path === 'status')) {
        out.status = 'FINISHED';
        return;
      }
      // A nested patch's `p` is a LEAF (`content`, `status`), so it must be
      // composed onto the path it arrived under: `response/fragments/-1` +
      // `content` is the SEARCH fragment's accounting text, and treating it as
      // `content` let `搜索到 12 个网页` into the body.
      const kind = resolveKind(path, state);
      if (kind === 'meta') return;
      if (path === '' && CONTROL_WORDS.has(value.trim().toUpperCase())) return;
      push(value, kind);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.p === 'string') {
          const nestedPath = joinPath(path, item.p);
          if (shouldSkipPath(nestedPath)) continue;
          if (isStatusPath(nestedPath)) {
            const word = typeof item.v === 'string' ? item.v.trim().toUpperCase() : '';
            if (TERMINAL_STATUS.has(word) || PENDING_STATUS.has(word)) out.status = word;
            continue;
          }
          walk(item.v, nestedPath);
          continue;
        }
        walk(item, path);
      }
      return;
    }
    if (value && typeof value === 'object') {
      // A bare fragment, reached through `{"p":"response/fragments","o":"APPEND","v":[{...}]}`.
      // This is the frame that SWITCHES the current kind: the container append
      // announces a new RESPONSE/THINK fragment, and every following
      // `response/fragments/-1/content` delta is typed by what was announced here.
      // Missing this branch silently routes a whole answer into the reasoning pane.
      if (typeof value.type === 'string' && (typeof value.content === 'string' || Array.isArray(value.fragments))) {
        collectFragment(value, out, state, 'live');
        return;
      }
      // Initial envelope: `{"v":{"response":{...}}}`. Its fragment content is a
      // PREFIX of the answer, not a replay: the deltas that follow continue
      // after it. Dropping it (the old "history" mode) loses the head of every
      // answer — and loses SHORT answers entirely, because a two-character
      // reply only ever arrives in this frame. Verified against all five real
      // captures: envelope + deltas == full text, and no delta re-sends it.
      const response = value.response && typeof value.response === 'object' ? value.response : value;
      for (const fragment of Array.isArray(response.fragments) ? response.fragments : []) {
        collectEnvelopeFragment(fragment, out, state, push);
      }
      if (typeof value.text === 'string' || typeof value.content === 'string') {
        push(value.text || value.content, resolveKind(path, state));
      }
    }
  };

  walk(chunk.v);
  return out;
}

/**
 * Compose a nested patch path onto the path of the batch that carried it.
 *
 * `{p:'response/fragments/-1', v:[{p:'content', v:'…'}]}` and the flat
 * `{p:'response/fragments/-1/content', v:'…'}` describe the same location; the
 * parser has to see them as one path or the fragment type cannot be resolved.
 */
function joinPath(base, leaf) {
  if (!leaf) return base;
  if (!base) return leaf;
  return `${base.replace(/\/+$/, '')}/${leaf.replace(/^\/+/, '')}`;
}

function resolveKind(path, state) {
  if (path === 'response/thinking_content') return 'thinking';
  if (path === 'response/content') return 'text';
  if (path.includes('response/fragments') && path.includes('/content')) return state.fragmentKind || 'text';
  if (path === '') return state.fragmentKind === 'thinking' ? 'thinking' : state.fragmentKind === 'meta' ? 'meta' : 'text';
  // Any other path (a batch leaf, an unknown patch target) is typed by the
  // fragment currently announced, so a SEARCH fragment's `content` stays meta.
  return state.fragmentKind || 'text';
}

function collectFragment(fragment, out, state, mode) {
  const { type, content } = fragmentText(fragment);
  const kind = kindOfType(type);
  state.fragmentKind = kind;
  if (kind === 'meta') {
    if (type === 'TIP' && content) state.tip = content;
    return;
  }
  if (mode === 'live' && content) {
    // MUST go through `push`: it also maintains `state.emittedText`, which
    // `newTail` uses to trim a continuation round's re-sent snapshot. Writing to
    // `out.text` directly leaves the ledger short, and the next snapshot then
    // re-appends text this turn already streamed — a duplicated head.
    pushFragment(content, out, state, kind);
  }
}

/** Append live fragment content through the reducer's `push`, when available. */
function pushFragment(content, out, state, kind) {
  if (typeof state.pushText === 'function') {
    state.pushText(content, kind);
    return;
  }
  if (kind === 'thinking') {
    out.thinking += content;
    state.emittedThinking = (state.emittedThinking || '') + content;
  } else {
    out.text += content;
    state.emittedText = (state.emittedText || '') + content;
  }
}

/**
 * Absorb the init envelope's fragment content into the body.
 *
 * The envelope is a PREFIX of the fragment it introduces, not a replay, so the
 * naive `out.text += content` is right for the first envelope of a turn. It is
 * NOT right for a later round of the same turn: a continuation round re-sends
 * the fragment as a fresh snapshot, whose head is text already streamed. So the
 * envelope content is trimmed against what this turn has already emitted, and
 * only the genuinely new tail is appended. Without this, a continued answer
 * repeats its whole opening.
 */
function collectEnvelopeFragment(fragment, out, state, push) {
  const { type, content } = fragmentText(fragment);
  const kind = kindOfType(type);
  if (kind === 'meta') {
    if (type === 'TIP' && content) state.tip = content;
    // A SEARCH fragment is the active fragment for the round, so its kind still
    // has to be recorded: the `搜索到 12 个网页` BATCH that follows carries the
    // bare leaf path `content` and is classified by what was announced here.
    state.fragmentKind = kind;
    return;
  }
  state.fragmentKind = kind;
  if (!content) return;
  if (kind === 'thinking') {
    push(newTail(content, state.emittedThinking || ''), 'thinking');
    return;
  }
  push(newTail(content, state.emittedText || ''), 'text');
}

/**
 * Return only the part of `content` not already covered by `emitted`.
 *
 * A snapshot that re-sends already-seen text yields its new tail; a plain
 * prefix extension yields the whole extension. When the two overlap but the
 * snapshot is not an extension of what was emitted (upstream rewrote the head),
 * the snapshot wins from the divergence point so no text is lost.
 */
function newTail(content, emitted) {
  if (!emitted) return content;
  if (content.startsWith(emitted)) return content.slice(emitted.length);
  if (emitted.endsWith(content)) return '';

  // Longest suffix of `emitted` that is a prefix of `content`.
  const max = Math.min(emitted.length, content.length);
  for (let len = max; len > 0; len -= 1) {
    if (emitted.endsWith(content.slice(0, len))) return content.slice(len);
  }
  return content;
}

/**
 * Stream one completion turn.
 *
 * Yields `{type:'text'|'thinking'|'status'|'usage'|'done'|'error', ...}` so the
 * caller can forward deltas without knowing the wire format.
 */
export async function* streamCompletion(token, request, signal) {
  const { sessionId, prompt, modelType = 'default', thinking = false, search = false, parentMessageId = null, refFileIds = [] } = request;
  const { header } = await solvePowHeader(token, { signal, onProgress: request.onProgress });

  const response = await postStream(
    COMPLETION_TARGET,
    token,
    header,
    {
      chat_session_id: sessionId,
      model_type: modelType,
      parent_message_id: parentMessageId,
      prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
    },
    sessionId,
    signal,
  );

  // Reducer state is shared across rounds on purpose: a continuation appends to
  // the SAME fragment, so the current fragment kind must survive the round trip.
  const state = { fragmentKind: 'text', tip: null };
  const round = { responseMessageId: 0, lastStatus: '', finished: false, autoContinue: false };

  let body = response.body;
  for (let attempt = 0; ; attempt += 1) {
    if (!body) throw new DeepSeekWebError('响应没有可读的流');
    for await (const event of readStream(body, state, round)) {
      // An in-stream upstream rejection (backend_err and friends) ends the turn:
      // the answer is empty and no continuation can fix it, so stop instead of
      // looping and report the reason the user actually sees.
      if (event.type === 'error') {
        yield event;
        yield { type: 'done', status: round.lastStatus || 'ERROR' };
        return;
      }
      yield event;
    }

    // Upstream says the answer was cut off and wants another round. Without this
    // the user sees a silently truncated reply, because the stream still ends
    // with a normal terminal event.
    if (round.finished || !shouldContinue(round) || !sessionId) break;
    if (attempt >= AUTO_CONTINUE_LIMIT) {
      yield { type: 'note', text: `已连续续写 ${AUTO_CONTINUE_LIMIT} 次仍未结束，已停止。` };
      break;
    }

    yield { type: 'continue', round: attempt + 1 };
    const next = await postStream(
      CONTINUE_TARGET,
      token,
      header, // the challenge already solved for this turn covers its continuations
      { chat_session_id: sessionId, message_id: round.responseMessageId, fallback_to_resume: true },
      sessionId,
      signal,
    );
    round.finished = false;
    round.lastStatus = '';
    round.autoContinue = false;
    body = next.body;
  }

  if (state.tip) yield { type: 'note', text: state.tip };
  if (round.finished && round.lastStatus) yield { type: 'status', status: round.lastStatus };
  yield { type: 'done', status: round.lastStatus || 'FINISHED' };
}

/** True when upstream explicitly asked for another round (plain WIP does not count). */
export function shouldContinue(round) {
  if (round.finished || round.responseMessageId <= 0) return false;
  if (round.autoContinue) return true;
  const status = String(round.lastStatus || '').toUpperCase();
  return status === 'INCOMPLETE' || status === 'AUTO_CONTINUE';
}

/** POST a streaming endpoint and translate a non-2xx body into a typed error. */
async function postStream(path, token, powHeader, body, sessionId, signal) {
  const response = await fetch(`${WEB_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      ...baseHeaders(token, sessionId),
      accept: 'text/event-stream',
      'x-ds-pow-response': powHeader,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let envelope = {};
    try {
      envelope = responseStatus(JSON.parse(text));
    } catch {
      /* non-JSON error body */
    }
    throw new DeepSeekWebError(envelope.bizMsg || envelope.msg || `HTTP ${response.status}`, {
      status: response.status,
      code: envelope.code ?? 0,
      bizCode: envelope.bizCode ?? 0,
      authFailed: isAuthFailure(response.status, envelope),
    });
  }
  return response;
}

/**
 * Interpret a JSON *envelope* that carries an upstream rejection.
 *
 * The completion endpoint does not only answer as SSE. When it refuses a request
 * outright it returns HTTP 200 with a plain envelope, either inside a `data:`
 * frame or as the whole body:
 *   {"code":0,"data":{"biz_code":9,"biz_msg":"invalid ref file id"}}   ← probe 91
 *   {"code":<non-zero>,"msg":"…"}
 * Such a chunk has no `v` field, so it reduces to nothing and the turn ended
 * "FINISHED" with an EMPTY answer and no error — the user pressed send and saw
 * nothing at all. Returns an error event, or null when the envelope is fine.
 */
function envelopeFailure(raw) {
  const text = String(raw || '').trim();
  if (!text || text[0] !== '{') return null;
  let chunk;
  try {
    chunk = JSON.parse(text);
  } catch {
    return null;
  }
  if (!chunk || typeof chunk !== 'object') return null;
  const data = chunk.data && typeof chunk.data === 'object' ? chunk.data : {};
  const bizCode = Number(data.biz_code ?? 0);
  const code = Number(chunk.code ?? 0);
  if (bizCode === 0 && code === 0) return null;
  const detail =
    typeof data.biz_msg === 'string' && data.biz_msg
      ? data.biz_msg
      : typeof chunk.msg === 'string' && chunk.msg
        ? chunk.msg
        : `biz_code ${bizCode || code}`;
  return { type: 'error', error: `DeepSeek 拒绝了这次请求：${detail}`, bizCode: bizCode || code };
}

/** Pump one SSE body, yielding deltas and recording the round's continue signals. */
export async function* readStream(body, state, round) {
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingStatus = null;
  // Some rejections carry no SSE framing at all (see envelopeFailure), so the
  // raw body is kept until it is clear whether any `data:` line ever arrived.
  let sawData = false;
  let rawSeen = '';

  const handleData = function* (raw) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (chunk && typeof chunk === 'object' && typeof chunk.event === 'string') {
      // `event: close` does NOT mean the answer is complete — the captured
      // two-round stream below ends round 1 with `close` and then continues.
      // Only a FINISHED/CONTENT_FILTER status is terminal, so still harvest the
      // id/status signals this frame may carry (`ready` carries the message id).
      observeRound(chunk, round);
      return;
    }
    // An upstream rejection arrives as `event: hint` carrying
    // `{"type":"error","content":"…","finish_reason":"backend_err"}`: no `v`
    // field, so reduceChunk returns empty and the failure would otherwise
    // surface as a silently EMPTY answer. Forward it as a real error event.
    if (chunk && chunk.type === 'error' && typeof chunk.content === 'string' && chunk.content) {
      yield { type: 'error', error: chunk.content, finishReason: chunk.finish_reason || '' };
      return;
    }
    // An outright rejection does NOT always arrive as SSE. /api/v0/chat/completion
    // answers HTTP 200 with a plain JSON envelope — no `event:` prefix, no `v`
    // field — when it refuses the request: a referenced file that is still
    // parsing comes back as `{"code":0,"data":{"biz_code":9,…}}` (probe91). That
    // envelope reduces to nothing, so the turn used to end "FINISHED" with an
    // EMPTY answer and no error: the user pressed send and simply got nothing.
    // Report it as a real error instead of silently producing a blank reply.
    const rejection = envelopeFailure(trimmed);
    if (rejection) {
      yield rejection;
      return;
    }
    observeRound(chunk, round);
    const reduced = reduceChunk(chunk, state);
    if (reduced.thinking) yield { type: 'thinking', text: reduced.thinking };
    if (reduced.text) yield { type: 'text', text: reduced.text };
    if (reduced.status) {
      if (reduced.status === 'FINISHED' || reduced.status === 'CONTENT_FILTER') {
        round.finished = true;
        yield { type: 'status', status: reduced.status };
      } else {
        pendingStatus = reduced.status;
      }
    }
    const usage = extractUsage(chunk);
    if (usage) yield { type: 'usage', usage };
  };

  for await (const bytes of body) {
    const text = decoder.decode(bytes, { stream: true });
    buffer += text;
    if (rawSeen.length < 8192) rawSeen += text;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      sawData = true;
      yield* handleData(trimmed.slice(5));
    }
  }
  if (buffer.trim().startsWith('data:')) {
    sawData = true;
    yield* handleData(buffer.trim().slice(5));
  }

  // A refusal can be the ENTIRE body, with no SSE framing to notice it by:
  // HTTP 200 + `content-type: application/json` +
  // `{"code":0,"msg":"","data":{"biz_code":9,"biz_msg":"invalid ref file id"}}`
  // (probe91, a referenced file that had not finished parsing). Nothing above
  // matched, so without this the turn ended with no text and no error at all —
  // the "uploaded a Word file and got no output" bug.
  if (!sawData) {
    const rejection = envelopeFailure(rawSeen);
    if (rejection) yield rejection;
  }

  if (!round.finished && pendingStatus) {
    round.lastStatus = pendingStatus;
    yield { type: 'status', status: pendingStatus };
  }
}

/**
 * Record the per-round continue signals from one chunk.
 *
 * `ready` carries the response message id, the init envelope carries it again as
 * `v.response.message_id`, and the incomplete signal arrives as a status word
 * (direct, nested, or inside a `BATCH` patch list) or as `auto_continue: true`.
 * A `BATCH` patch list is reached through `v`, so the walk must descend into it.
 */
export function observeRound(chunk, round) {
  if (typeof chunk.response_message_id === 'number' && chunk.response_message_id > 0) {
    round.responseMessageId = chunk.response_message_id;
  }

  const applyStatus = (raw) => {
    if (typeof raw !== 'string') return;
    const word = raw.trim().toUpperCase();
    if (!word) return;
    // Mirrors the reference: record the word first, then latch the terminal flag.
    round.lastStatus = word;
    if (word === 'FINISHED' || word === 'CONTENT_FILTER') round.finished = true;
  };

  // `inherited` is the path a nested patch list came from, so a patch whose own
  // `p` is a bare leaf (`accumulated_token_usage`) still resolves correctly.
  const visit = (value, inherited, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited, depth + 1);
      return;
    }
    const own = typeof value.p === 'string' && value.p ? value.p : '';
    const path = own || inherited;

    if (own === 'response/status' || own === 'status' || own === 'response/quasi_status' || own === 'quasi_status') {
      applyStatus(value.v);
    } else if (own === 'response/auto_continue' || own === 'auto_continue') {
      if (value.v === true) round.autoContinue = true;
    }
    // A bare `{"v":"..."}` with no path is CONTENT, never a status word — the
    // captured stream is full of tokens like `{"v":"}"}` mid-answer. The genuine
    // bare `{"v":"FINISHED"}` terminator is handled by reduceChunk's own status
    // output, which readStream folds into `round.finished`.

    if (typeof value.message_id === 'number' && value.message_id > 0) round.responseMessageId = value.message_id;
    if (value.auto_continue === true) round.autoContinue = true;
    if (typeof value.status === 'string') applyStatus(value.status);

    for (const [key, nested] of Object.entries(value)) {
      if (key === 'content' || key === 'text' || key === 'p') continue;
      visit(nested, path, depth + 1);
    }
  };

  visit(chunk, '', 0);
}

function extractUsage(chunk) {
  const found = walkUsage(chunk);
  return found;
}

function walkUsage(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walkUsage(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value.accumulated_token_usage === 'number') return { total: value.accumulated_token_usage };
  for (const nested of Object.values(value)) {
    const hit = walkUsage(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Rename a conversation (the web app has no insert path; this is metadata only). */
export async function sessionTitle(token, sessionId, signal) {
  try {
    const payload = await webJson(
      `/api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false`,
      { token, signal },
    );
    const data = bizData(payload);
    const hit = (Array.isArray(data.chat_sessions) ? data.chat_sessions : []).find((s) => s.id === sessionId);
    return hit && typeof hit.title === 'string' ? hit.title : '';
  } catch {
    return '';
  }
}
