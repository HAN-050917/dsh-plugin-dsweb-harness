/**
 * Route-level test for the host half.
 *
 * The two behaviours worth pinning down here are the ones that only show up
 * over a real socket and that a reviewer cannot see by reading the code:
 *
 *  1. "停止" must actually stop the UPSTREAM turn. The panel aborts the browser
 *     fetch, which closes the connection to this route; the route has to notice
 *     and abort its own request to chat.deepseek.com. `request.on('close')` does
 *     NOT report that here (the body was drained first), which is exactly the
 *     bug this test exists to catch if someone "simplifies" the wiring back.
 *  2. A second /chat must abort the first one, or an abandoned tab keeps
 *     generating on the user's account.
 *
 * Everything runs against a fake chat.deepseek.com: `globalThis.fetch` is
 * patched to redirect the web origin to a local server, so no token and no
 * network are needed. The module under test is the real `lib/index.js`, loaded
 * through a fake cordis context.
 *
 * Run: node test-chat-route.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* Isolate the vault/cache in a scratch DSH_HOME before anything reads it. */
const home = mkdtempSync(join(tmpdir(), 'dsh-chat-route-'));
process.env.DSH_HOME = home;

const upstreamSeen = [];
let upstreamOpen = 0;
let holdTurns = false;
// When set, the completion endpoint replays the real backend_err capture
// (HTTP 200 + a hint frame carrying the error) instead of a healthy turn.
let errorTurns = false;
// When set, fetch_files reports a document whose parse has not finished yet,
// which is what a large .docx looks like for the first ~16 seconds.
let pendingFiles = false;

/**
 * Stream frames, then either end (a completed turn) or hold the connection open
 * with SSE comments (a turn that never reaches a terminal status).
 *
 * `onClose` is told which of the two happened, because that is the whole point
 * of the test: in hold mode the only thing that can close this socket is the
 * plugin aborting its upstream request.
 */
function sse(response, frames, { onClose } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.flushHeaders();
  let completed = false;
  response.on('close', () => onClose && onClose(completed));
  let index = 0;
  const timer = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      clearInterval(timer);
      return;
    }
    if (index < frames.length) {
      response.write(`data: ${frames[index]}\n\n`);
      index += 1;
      if (!holdTurns && index >= frames.length) {
        completed = true;
        clearInterval(timer);
        response.end();
      }
      return;
    }
    // Hold mode: a comment frame keeps the socket alive without being content.
    response.write(': keepalive\n\n');
  }, 40);
}

/* ---- fake chat.deepseek.com ---------------------------------------- */

const upstream = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsedUrl = new URL(request.url, 'http://x');
  const path = parsedUrl.pathname;
  const upstreamRecord = { path: `${path}${parsedUrl.search}`, aborted: false, response, body };
  upstreamSeen.push(upstreamRecord);
  response.on('close', () => {
    if (!response.writableEnded) upstreamRecord.aborted = true;
  });

  const json = (payload) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  if (path === '/api/v0/users/current') {
    return json({ code: 0, data: { biz_data: { email: 'tester@example.com' } } });
  }
  if (path === '/api/v0/chat_session/create') {
    return json({ code: 0, data: { biz_data: { id: 'session-fake-1' } } });
  }
  if (path === '/api/v0/chat/create_pow_challenge') {
    // A real, solvable challenge: the official vector behind test-pow.mjs, whose
    // answer is 42 for `testsalt_1700000000_<n>`. An unsolvable fixture would
    // fail the turn before it ever reaches the completion endpoint.
    // target_path echoes the caller's requested endpoint (completion vs upload) —
    // upstream asks at this single path for EVERY target, file uploads included.
    const wanted = JSON.parse(body || '{}').target_path || '/api/v0/chat/completion';
    return json({
      code: 0,
      data: {
        biz_data: {
          challenge: {
            algorithm: 'DeepSeekHashV1',
            challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
            salt: 'testsalt',
            expire_at: 1700000000,
            difficulty: 1000,
            signature: 'sig',
            target_path: wanted,
          },
        },
      },
    });
  }
  if (path === '/api/v0/file/upload_file') {
    // Multipart shape check: the client library strips the JSON content-type so
    // the boundary survives; a test that only checked status would let a broken
    // header set pass silently and fail only against the real upstream.
    const contentType = String(request.headers['content-type'] || '');
    const size = Number(request.headers['x-file-size'] || 0);
    const ok = contentType.startsWith('multipart/form-data; boundary=') && size > 0;
    return json({
      code: 0,
      data: {
        biz_data: ok
          ? { id: 'file-fake-1', status: 'PENDING', file_name: 'probe.txt', file_size: size, model_kind: 'VISION', is_image: false }
          : { id: '', status: 'FAILED', error_code: 'BAD_REQUEST' },
      },
    });
  }
  if (path === '/api/v0/file/fetch_files') {
    const fileId = parsedUrl.searchParams.get('file_ids');
    return json({
      code: 0,
      data: {
        biz_data: {
          files: [
            {
              id: fileId || 'file-fake-1',
              status: pendingFiles ? 'PARSING' : 'SUCCESS',
              file_name: 'probe.txt',
              file_size: 12,
              model_kind: 'VISION',
              is_image: false,
            },
          ],
        },
      },
    });
  }
  if (path === '/api/v0/chat/history_messages') {
    // Real shape: the key is `chat_messages`, and the text lives in typed
    // fragments rather than a `content` field. A route test that only ever sees
    // `messages[]` would not have caught the bug that emptied every transcript.
    return json({
      code: 0,
      data: {
        biz_data: {
          chat_messages: [
            { role: 'USER', fragments: [{ type: 'REQUEST', content: '你好' }] },
            {
              role: 'ASSISTANT',
              fragments: [
                { type: 'THINK', content: '用户打了个招呼' },
                { type: 'RESPONSE', content: '你好！有什么可以帮忙的吗？' },
              ],
            },
          ],
        },
      },
    });
  }
  if (path === '/api/v0/chat_session/fetch_page') {
    return json({
      code: 0,
      data: {
        biz_data: {
          chat_sessions: [
            { id: 'session-fake-1', title: 'Fake%20session', title_type: 'SYSTEM', pinned: false, updated_at: 1791979393.03 },
          ],
          has_more: false,
        },
      },
    });
  }
  if (path === '/api/v0/chat/completion' || path === '/api/v0/chat/continue') {
    upstreamOpen += 1;
    const record = upstreamSeen[upstreamSeen.length - 1];
    if (errorTurns) {
      // The real capture (_probe/backend-err-sample.sse): an event-frame error
      // hint. `event:` lines are transport, `data:` is what readStream parses,
      // so the hint must arrive on the data line for the reducer to see it.
      return sse(response, [
        '{"v":{"response":{"message_id":2,"status":"WIP","fragments":[]}}}',
        '{"type":"error","content":"Server is temporarily unavailable.","clear_response":true,"finish_reason":"backend_err"}',
        '{"click_behavior":"retry","auto_resume":false}',
      ], {
        onClose: () => {
          record.aborted = true;
        },
      });
    }
    return sse(
      response,
      [
        '{"v":{"response":{"message_id":1,"status":"WIP","fragments":[]}}}',
        '{"v":"hello "}',
        '{"v":"world"}',
        // Never terminal while `holdTurns` is on, so an aborted turn is
        // distinguishable from a finished one.
        '{"p":"response/status","o":"SET","v":"FINISHED"}',
      ],
      {
        onClose: () => {
          record.aborted = true;
        },
      },
    );
  }
  response.writeHead(404);
  response.end('{}');
});

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://chat.deepseek.com')) {
    return realFetch(url.replace('https://chat.deepseek.com', `http://127.0.0.1:${upstreamPort}`), init);
  }
  if (url.startsWith('http://127.0.0.1:0/') || url.startsWith('http://localhost:0/')) {
    // waitForFiles' 600ms poll loop hitting a dead port would spin forever; a
    // hanging test here means the poll deadline logic broke, so fail loudly.
    return Promise.reject(new Error(`test fetch hole punched: ${url}`));
  }
  return realFetch(input, init);
};

/* ---- load the real host half through a fake cordis context ---------- */

const { apply } = await import('./lib/index.js');
const { saveToken } = await import('./lib/vault.js');

saveToken('fake-token', null);

const routes = new Map();
const effects = [];
const fakeCtx = {
  effect: (factory, label) => {
    const dispose = factory();
    effects.push({ dispose, label });
  },
  inject: (services, callback) => {
    if (services.includes('webServer')) {
      callback({
        effect: (factory) => fakeCtx.effect(factory),
        webServer: {
          register: (route) => {
            routes.set(`${route.kind} ${route.path}`, route.handler);
            return () => routes.delete(`${route.kind} ${route.path}`);
          },
        },
      });
    }
  },
};
apply(fakeCtx);
assert.equal(routes.size, 9, `expected 9 routes, registered ${[...routes.keys()].join(', ')}`);

const server = http.createServer((request, response) => {
  const handler = routes.get(`exact ${new URL(request.url, 'http://x').pathname}`);
  if (!handler) {
    response.writeHead(404);
    return response.end();
  }
  return handler(request, response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const post = (path, body, init = {}) =>
  realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    body: JSON.stringify(body),
    ...init,
  });

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/* ---- 1. a client "停止" aborts the upstream turn -------------------- */

holdTurns = true;
{
  const controller = new AbortController();
  const response = await post('/dsh-deepseek-web-chat/chat', { prompt: 'hi there' }, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  let aborted = false;
  // Abort only once the upstream turn is genuinely streaming: the plugin emits
  // its session frame BEFORE it solves the proof of work and calls upstream, so
  // aborting on the first frame would prove nothing about the upstream request.
  for (let i = 0; i < 200 && !aborted; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (i === 0) {
      check('the chat route streams SSE frames', seen.includes('data:'));
    }
    if (seen.includes('"type":"text"')) {
      controller.abort();
      aborted = true;
    }
  }
  check('the turn reached the streaming stage before the abort', aborted);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const turns = upstreamSeen.filter((entry) => entry.path.endsWith('/chat/completion'));
  const turn = turns[turns.length - 1];
  check(
    'client abort aborts the upstream completion request',
    Boolean(turn && turn.aborted),
    turn ? `upstream requests=${turns.length} aborted=${turn.aborted}` : 'no upstream completion request was made',
  );
}

/* ---- 2. normal completion still finishes and commits --------------- */

holdTurns = false;
{
  const response = await post('/dsh-deepseek-web-chat/chat', { prompt: 'second question' });
  const text = await response.text();
  check('a completed turn ends with the end frame', text.includes('"type":"end"'));
  check('a completed turn carries the streamed answer', text.includes('hello '));
}

/* ---- 3. a newer turn aborts the one before it ---------------------- */

holdTurns = true;
{
  const first = await post('/dsh-deepseek-web-chat/chat', { prompt: 'turn one' });
  await first.body.getReader().read();
  const before = upstreamSeen.filter((entry) => entry.path.endsWith('/chat/completion')).length;
  const second = await post('/dsh-deepseek-web-chat/chat', { prompt: 'turn two' });
  await second.body.getReader().read();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const turns = upstreamSeen.filter((entry) => entry.path.endsWith('/chat/completion'));
  check(
    'starting a new turn aborts the previous one',
    turns.length === before + 1 && Boolean(turns[before - 1] && turns[before - 1].aborted),
  );
  second.body.cancel().catch(() => {});
}

/* ---- 3b. an upstream backend_err reaches the client as an error frame */

{
  // The defect this pins down: readStream used to drop every `event:` hint and
  // the reducer ignored frames without `v`, so upstream rejections surfaced as
  // an EMPTY answer with `done: FINISHED` and no explanation.
  errorTurns = true;
  const response = await post('/dsh-deepseek-web-chat/chat', { prompt: 'backend error probe' });
  const text = await response.text();
  const frames = text.split('\n\n').filter((frame) => frame.startsWith('data:'));
  const events = frames.map((frame) => {
    try {
      return JSON.parse(frame.slice(5).trim());
    } catch {
      return {};
    }
  });
  const error = events.find((event) => event.type === 'error');
  check(
    'an upstream backend_err surfaces as an SSE error frame',
    Boolean(error && /unavailable/i.test(String(error.error))),
    error ? JSON.stringify(error) : `frames=${events.map((event) => event.type).join(',')}`,
  );
  check(
    'the error frame carries the upstream finish reason',
    Boolean(error && error.finishReason === 'backend_err'),
    error && error.finishReason,
  );
  check(
    'an errored turn stays empty and never fakes completion text',
    !events.some((event) => event.type === 'text'),
    `text frames=${events.filter((event) => event.type === 'text').length}`,
  );
  check(
    'an errored turn still ends so the client unlocks',
    events.some((event) => event.type === 'done') && events[events.length - 1].type === 'end',
    `last=${events.length && events[events.length - 1].type}`,
  );
  // An empty answer must not be cached as a real turn: reopening the session
  // would otherwise show a fabricated blank exchange forever.
  const messages = await realFetch(
    `http://127.0.0.1:${port}/dsh-deepseek-web-chat/messages?sessionId=session-fake-1`,
    { headers: { host: `127.0.0.1:${port}` } },
  );
  const payload = await messages.json();
  const leaked = (payload.messages || []).filter(
    (message) => message.role === 'user' && message.content === 'backend error probe',
  );
  check(
    'an errored turn is not committed to the transcript cache',
    leaked.length === 0,
    `cached user turns=${leaked.length}`,
  );
  errorTurns = false;
}

/* ---- 4. the history route parses real fragments -------------------- */

{
  const response = await realFetch(
    `http://127.0.0.1:${port}/dsh-deepseek-web-chat/messages?sessionId=session-fake-1&refresh=1`,
    { headers: { host: `127.0.0.1:${port}` } },
  );
  const payload = await response.json();
  check('the history route returns the transcript', response.status === 200 && Array.isArray(payload.messages) && payload.messages.length === 2, `status=${response.status} messages=${payload.messages && payload.messages.length}`);
  check(
    'the REQUEST fragment becomes the user turn',
    Boolean(payload.messages && payload.messages[0] && payload.messages[0].content === '你好'),
    payload.messages && payload.messages[0] && payload.messages[0].content,
  );
  check(
    'the RESPONSE fragment becomes the body and THINK stays separate',
    Boolean(
      payload.messages &&
        payload.messages[1] &&
        payload.messages[1].content === '你好！有什么可以帮忙的吗？' &&
        payload.messages[1].reasoning === '用户打了个招呼',
    ),
    payload.messages && payload.messages[1] && `content=${JSON.stringify(payload.messages[1].content)} reasoning=${JSON.stringify(payload.messages[1].reasoning)}`,
  );
  check('thinking never leaks into the visible body', Boolean(payload.messages && payload.messages[1] && !payload.messages[1].content.includes('用户打了个招呼')));
}

/* ---- 5. the session list route decodes titles ---------------------- */

{
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/sessions?count=5&refresh=1`, {
    headers: { host: `127.0.0.1:${port}` },
  });
  const payload = await response.json();
  check(
    'the session list route returns the account list',
    response.status === 200 && Array.isArray(payload.sessions) && payload.sessions.length === 1,
    `status=${response.status} sessions=${payload.sessions && payload.sessions.length}`,
  );
  // Titles arrive percent-encoded; the list must carry the readable form, since
  // that string is what the sidebar and the panel actually show.
  check(
    'a percent-encoded session title is decoded',
    Boolean(payload.sessions && payload.sessions[0] && payload.sessions[0].title === 'Fake session'),
    payload.sessions && payload.sessions[0] && JSON.stringify(payload.sessions[0].title),
  );
}

/* ---- 6. the trust fence still rejects a foreign origin ------------- */
{
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/state`, {
    headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' },
  });
  check('a foreign Origin is refused', response.status === 403, `got ${response.status}`);
}

/* ---- 6b. the upload route round-trips through the fake upstream ---- */

{
  // The browser uploads raw bytes with metadata in headers (see handleUpload);
  // the route wraps them into multipart for upstream and waits for the parse
  // to settle before replying. A fully consumed HTTP request must not abort its
  // upstream work just because the host request signal is no longer useful.
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/upload`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('probe.txt'),
    },
    body: 'hello upload',
  });
  const payload = await response.json();
  check('a completed upload is not aborted with the drained request stream', response.status === 200, `status=${response.status} ${JSON.stringify(payload)}`);
  check(
    'the upload route returns a settled file record',
    response.status === 200 && payload.file && payload.file.id === 'file-fake-1' && payload.file.status === 'SUCCESS' && payload.settled === true,
    JSON.stringify(payload),
  );
  const seen = upstreamSeen.map((entry) => entry.path);
  check(
    'an upload solves its own PoW challenge and posts multipart',
    Boolean(upstreamSeen.find((entry) => entry.path === '/api/v0/file/upload_file')),
    `paths=${seen.filter((p) => p.startsWith('/api/v0/file') || p.includes('pow')).join(',')}`,
  );
  const empty = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/upload`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', 'x-file-name': 'empty.txt' },
    body: '',
  });
  check('an empty upload body is rejected', empty.status === 400, `got ${empty.status}`);
  const tooLarge = await new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/upload`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-length': String(100 * 1024 * 1024 + 1),
        'x-file-name': 'large.bin',
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  check('oversized upload is rejected before reading the body', tooLarge === 413, `got ${tooLarge}`);
  const files = await realFetch(
    `http://127.0.0.1:${port}/dsh-deepseek-web-chat/files?file_ids=file-fake-1`,
    { headers: { host: `127.0.0.1:${port}` } },
  );
  const filePayload = await files.json();
  check(
    'the files route returns the record list',
    files.status === 200 && Array.isArray(filePayload.files) && filePayload.files[0].id === 'file-fake-1',
    JSON.stringify(filePayload),
  );
}


/* ---- 6c. a slow parse must neither block /upload nor reach /chat ---- */

{
  // The bug this covers: a 2MB .docx is parsed ~16s upstream. The old handler
  // blocked /upload for up to 20s (frozen picker, "上传速度过慢") and, past that
  // ceiling, still returned a PENDING record as if it were usable. A turn sent
  // with that id comes back from upstream as biz_code 9 with NO frames — the
  // plugin emitted zero text and zero error, i.e. the blank answer users saw.
  pendingFiles = true;
  // The previous section leaves turns held open on purpose; a real turn has to
  // end for this one to be readable.
  holdTurns = false;
  const started = Date.now();
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/upload`, {
    method: 'POST',
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'x-file-name': encodeURIComponent('报告.docx'),
    },
    body: 'pretend this is a docx',
  });
  const payload = await response.json();
  const elapsed = Date.now() - started;
  check(
    'an unparsed upload answers without waiting the parse out',
    response.status === 200 && elapsed < 5000,
    `status=${response.status} elapsed=${elapsed}ms`,
  );
  check(
    'an unparsed upload reports its real status and is flagged unsettled',
    Boolean(payload.file) && payload.file.status === 'PARSING' && payload.settled === false,
    JSON.stringify(payload),
  );

  const completionsBefore = upstreamSeen.filter((entry) => entry.path === '/api/v0/chat/completion').length;
  const chat = await post('/dsh-deepseek-web-chat/chat', {
    prompt: '这份文档讲了什么？',
    refFileIds: ['file-fake-1'],
  });
  const chatBody = await chat.json();
  check(
    'a turn referencing a still-parsing file is refused',
    chat.status === 409,
    `status=${chat.status} body=${JSON.stringify(chatBody)}`,
  );
  check(
    'the refusal names the file that is still parsing',
    Array.isArray(chatBody.pending) && chatBody.pending[0] === 'file-fake-1',
    JSON.stringify(chatBody),
  );
  const completionsAfter = upstreamSeen.filter((entry) => entry.path === '/api/v0/chat/completion').length;
  check(
    'the refused turn never reached upstream',
    completionsAfter === completionsBefore,
    `completion calls ${completionsBefore} -> ${completionsAfter}`,
  );

  // Once upstream finishes, the very same id must go through.
  pendingFiles = false;
  const ok = await post('/dsh-deepseek-web-chat/chat', {
    prompt: '这份文档讲了什么？',
    refFileIds: ['file-fake-1'],
  });
  const okText = await ok.text();
  check(
    'the same attachment works once its parse finishes',
    ok.status === 200 && okText.includes('"type":"end"'),
    `status=${ok.status} frames=${okText.split('\n\n').length}`,
  );
}

/* ---- 6d. an attachment-aware turn carries refFileIds upstream ------ */

{
  // The feature's contract: ids ride into the upstream completion body, and a
  // file-only turn (empty prompt) is allowed — upstream rejects "both empty"
  // but accepts prompt:'' + files (probe84).
  holdTurns = false;
  const response = await post('/dsh-deepseek-web-chat/chat', {
    prompt: '',
    refFileIds: ['file-fake-1', '', 'file-fake-2'],
    attachments: [{ name: 'probe.txt' }],
  });
  const text = await response.text();
  check(
    'a file-only turn streams and ends',
    text.includes('"type":"end"'),
  );
  const turn = [...upstreamSeen].reverse().find((entry) => entry.path === '/api/v0/chat/completion');
  check(
    'the attachment turn reached upstream',
    Boolean(turn),
  );
  const empty = await post('/dsh-deepseek-web-chat/chat', { prompt: '   ' });
  check('an empty prompt with no attachments is still rejected', empty.status === 400, `got ${empty.status}`);
}

/* ---- 6e. a session keeps its files for the turns that follow ------- */

{
  // Upstream keeps NOTHING: a follow-up turn that omits ref_file_ids cannot
  // read the document any more (probe96 — the model answered "the conversation
  // does not contain those points"). So the host has to re-send the ids itself
  // for every later turn, and the user has to be able to drop them again.
  holdTurns = false;
  const first = await post('/dsh-deepseek-web-chat/chat', {
    prompt: '这份文档讲了什么？',
    refFileIds: ['file-fake-1'],
  });
  const firstText = await first.text();
  const sessionId = (firstText.match(/"sessionId":"([^"]+)"/) || [])[1];
  check('a turn that carries a file reports its session', Boolean(sessionId), firstText.slice(0, 140));
  const firstTurn = [...upstreamSeen].reverse().find((entry) => entry.path === '/api/v0/chat/completion');
  check(
    'the first turn references the file upstream',
    /"ref_file_ids":\["file-fake-1"\]/.test(firstTurn.body || ''),
    String(firstTurn.body).slice(0, 200),
  );

  const follow = await post('/dsh-deepseek-web-chat/chat', { prompt: '那第三个表格呢？', sessionId });
  await follow.text();
  const followTurn = [...upstreamSeen].reverse().find((entry) => entry.path === '/api/v0/chat/completion');
  check(
    'a follow-up turn still references the session file',
    /"ref_file_ids":\["file-fake-1"\]/.test(followTurn.body || ''),
    String(followTurn.body).slice(0, 200),
  );

  const detached = await post('/dsh-deepseek-web-chat/chat', {
    prompt: '换个话题',
    sessionId,
    detachFiles: true,
  });
  await detached.text();
  const detachedTurn = [...upstreamSeen].reverse().find((entry) => entry.path === '/api/v0/chat/completion');
  check(
    'detaching drops the file from this turn on',
    /"ref_file_ids":\[\]/.test(detachedTurn.body || ''),
    String(detachedTurn.body).slice(0, 200),
  );

  const after = await post('/dsh-deepseek-web-chat/chat', { prompt: '还是没有文件', sessionId });
  await after.text();
  const afterTurn = [...upstreamSeen].reverse().find((entry) => entry.path === '/api/v0/chat/completion');
  check(
    'the drop sticks for the rest of the session',
    /"ref_file_ids":\[\]/.test(afterTurn.body || ''),
    String(afterTurn.body).slice(0, 200),
  );
}

/* ---- 7. the client can tell whether the host half is current ------- */
{
  // Both halves ship from one directory but update on different schedules:
  // client.js hot-reloads in half a second, this module only when DSH restarts.
  // Without a version the half-updated state looks like an ordinary bug (an
  // empty conversation), so the state route has to advertise it.
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/state`, {
    headers: { host: `127.0.0.1:${port}` },
  });
  const payload = await response.json();
  check(
    'the state route reports a protocol version',
    response.status === 200 && Number.isInteger(payload.protocol) && payload.protocol > 0,
    `status=${response.status} protocol=${JSON.stringify(payload.protocol)}`,
  );

  // The client's copy is the authority on what it expects; the two must agree
  // or every install reports "stale" the moment either half is edited alone.
  const clientSource = readFileSync(join(here, 'lib', 'client.js'), 'utf8');
  const declared = clientSource.match(/const PROTOCOL = (\d+);/);
  check(
    'the client half expects the version this route reports',
    Boolean(declared) && Number(declared[1]) === payload.protocol,
    `client says ${declared && declared[1]}, host says ${payload.protocol}`,
  );
}

/* ---- 8. GET-only routes reject the other methods ------------------- */
{
  // The old host answered POST /state with 200, which is how a stale backend
  // was identified during development. Keeping the guard keeps that signal.
  const response = await realFetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/state`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}` },
  });
  check('POST on a GET-only route is refused', response.status === 405, `got ${response.status}`);
}

/* ---- teardown ------------------------------------------------------ */

for (const effect of effects) if (typeof effect.dispose === 'function') effect.dispose();
server.close();
upstream.close();
globalThis.fetch = realFetch;
rmSync(home, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
