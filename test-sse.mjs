/**
 * Replay the REAL captured chat.deepseek.com upstream SSE streams (from the local
 * ds2api project's tests/raw_stream_samples) through this plugin's reducer, and
 * assert the visible text is rebuilt correctly.
 *
 * This is the closest thing to end-to-end verification available without the
 * user's browser token: the byte stream is genuine DeepSeek output.
 *
 * Run: node test-sse.mjs [samplesRoot]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reduceChunk, readStream } from './lib/deepseek.js';

const DEFAULT_ROOT =
  'C:/Users/p/Documents/deepseek-harness/default-workspace/src/ds2api/ds2api-main/tests/raw_stream_samples';

const root = process.argv[2] ?? DEFAULT_ROOT;

/** Feed one raw `.sse` body through the reducer the way `streamCompletion` does. */
function replay(raw) {
  const state = { fragmentKind: 'text', tip: null };
  let text = '';
  let thinking = '';
  let status = null;
  let events = 0;
  let frames = 0;
  const statuses = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      events += 1;
      continue;
    }
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk && typeof chunk === 'object' && typeof chunk.event === 'string') continue;
    frames += 1;
    const reduced = reduceChunk(chunk, state);
    text += reduced.text;
    thinking += reduced.thinking;
    if (reduced.status) {
      status = reduced.status;
      statuses.push(reduced.status);
    }
  }
  return { text, thinking, status, statuses, events, frames };
}

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const samples = readdirSync(root).filter((entry) => {
  try {
    return statSync(join(root, entry)).isDirectory();
  } catch {
    return false;
  }
});

if (samples.length === 0) {
  console.error(`no sample directories under ${root}`);
  process.exit(2);
}

// Control words that must never leak into the visible answer.
const CONTROL_WORDS = ['FINISHED', 'CONTENT_FILTER', 'AUTO_CONTINUE', 'INCOMPLETE', 'WIP'];

for (const sample of samples) {
  const file = join(root, sample, 'upstream.stream.sse');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(root, sample, 'meta.json'), 'utf8'));
  } catch {
    /* meta is optional */
  }

  const result = replay(raw);
  console.log(`\n=== ${sample} (${meta.capture?.label ?? 'stream'}, ${result.frames} data frames, ${result.events} events) ===`);
  console.log(`visible  ${result.text.length} chars, ${JSON.stringify(result.text.slice(0, 90))}`);
  console.log(`thinking ${result.thinking.length} chars`);
  console.log(`status   ${JSON.stringify(result.statuses)}`);

  check(`${sample}: produced visible text`, result.text.length > 0);
  check(`${sample}: produced reasoning text`, result.thinking.length > 0);

  // The bug this guards: a RESPONSE-fragment arrival that fails to switch the
  // current kind routes the whole answer into the reasoning pane. Every one of
  // these samples is a long answer, so a few-char "visible" text is a failure,
  // not a short answer.
  check(
    `${sample}: visible answer is substantial`,
    result.text.length >= 40,
    `${result.text.length} chars`,
  );

  for (const word of CONTROL_WORDS) {
    check(`${sample}: no control word ${word} in body`, !result.text.includes(word));
  }

  // The samples are Chinese answers; mojibake would show up as U+FFFD or the
  // classic GBK-as-Latin1 signatures. A correct UTF-8 decode has neither.
  check(`${sample}: no replacement characters`, !result.text.includes('\uFFFD'));
  check(`${sample}: no CJK mojibake run`, !/[\u00C0-\u00FF]{3,}/.test(result.text));

  if (meta.capture?.contains_finished_token) {
    check(`${sample}: reached a terminal status`, result.status === 'FINISHED', `got ${result.status}`);
  }
  check(`${sample}: no leading/trailing control padding`, result.text === result.text.trim() || result.text.startsWith(' '));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);

/* ---- the real backend_err capture must surface as an error event ----- */

{
  const file = join(root, '..', '..', '..', '..', '..', '_probe', 'backend-err-sample.sse');
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  if (raw) {
    console.log('\n=== backend-err-sample (upstream rejection capture) ===');
    // readStream is the layer streamCompletion consumes; the whole point of the
    // fix is that THIS layer yields the error instead of silently dropping it.
    const state = { fragmentKind: 'text', tip: null };
    const round = { responseMessageId: 0, lastStatus: '', finished: false, autoContinue: false };
    const stream = readStream(rawToWebStream(raw), state, round);
    const events = [];
    for await (const event of stream) events.push(event);

    const error = events.find((event) => event.type === 'error');
    check('the hint error is yielded as an event', Boolean(error && /unavailable/i.test(String(error && error.error))),
      error ? JSON.stringify(error) : `events=${events.map((event) => event.type).join(',')}`);
    check('the error keeps the upstream finish reason', Boolean(error && error.finishReason === 'backend_err'),
      error && error.finishReason);
    check('no visible text is emitted for an errored turn', !events.some((event) => event.type === 'text'));
  } else {
    console.log('\nskip  backend-err-sample.sse not found (error-frame assertions skipped)');
  }
}

/* ---- a JSON rejection envelope must not read as an empty answer ----- */

{
  // The completion endpoint does not always answer as SSE. When it refuses the
  // request outright (a referenced file that is still parsing) it returns HTTP
  // 200 with a plain JSON envelope — `{"code":0,"data":{"biz_code":9,…}}` (probe89).
  // That frame has no `v` field, so it reduced to nothing and the turn ended
  // "FINISHED" with an EMPTY answer and no error, which is precisely the "上传
  // word 后发消息没有输出" symptom. readStream must turn it into a real error.
  const run = async (raw) => {
    const state = { fragmentKind: 'text', tip: null };
    const round = { responseMessageId: 0, lastStatus: '', finished: false, autoContinue: false };
    const events = [];
    for await (const event of readStream(rawToWebStream(raw), state, round)) events.push(event);
    return events;
  };

  const rejectedEvents = await run(
    // Verbatim probe91 capture: a referenced file that had not finished parsing.
    // HTTP 200, content-type: application/json, no `data:` line anywhere.
    '{"code":0,"msg":"","data":{"biz_code":9,"biz_msg":"invalid ref file id","biz_data":null}}',
  );
  const rejection = rejectedEvents.find((event) => event.type === 'error');
  check(
    'a bare biz_code rejection envelope becomes an error event',
    Boolean(rejection && /invalid ref file id/.test(String(rejection.error))),
    rejection ? JSON.stringify(rejection) : `events=${rejectedEvents.map((e) => e.type).join(',')}`,
  );
  check(
    'the rejection keeps its upstream biz_code',
    Boolean(rejection && rejection.bizCode === 9),
    rejection && String(rejection.bizCode),
  );

  const framed = await run(
    'data: {"code":0,"data":{"biz_code":13,"biz_msg":"thinking cannot be with file"}}\n\n',
  );
  const framedError = framed.find((event) => event.type === 'error');
  check(
    'the same envelope inside a data: frame is caught too',
    Boolean(framedError && framedError.bizCode === 13),
    framedError ? JSON.stringify(framedError) : `events=${framed.map((e) => e.type).join(',')}`,
  );

  const accepted = await run('{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":null}}');
  check(
    'a successful envelope is not mistaken for a rejection',
    !accepted.some((event) => event.type === 'error'),
    `events=${accepted.map((e) => e.type).join(',')}`,
  );
}

/** Wrap a string as a web ReadableStream the way fetch().body behaves. */
function rawToWebStream(raw) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
}

process.exit(failures === 0 ? 0 : 1);
