/**
 * Replay a REAL search-enabled chat.deepseek.com turn through the reducer.
 *
 * Why this file exists: the five samples under
 * `src/ds2api/.../raw_stream_samples` contain **zero** search turns — a scan for
 * `[reference:` and `search_status` across all of them returned 0 hits — so the
 * path a real 联网搜索 round takes was never exercised. It leaked, and the user
 * caught it before any test did:
 *
 *   搜索到 12 个网页 + SEARCH + 新闻主要集中在…
 *        ^ fragment accounting      ^ conversation_mode    ^ the real answer
 *
 * Fixture `fixtures/search-sample.sse` was captured from the live account with
 * `search_enabled: true` (session deleted afterwards). The three leaking frames
 * are, verbatim:
 *
 *   {"v":{"response":{…,"fragments":[{"id":2,"type":"SEARCH",…}]}}}        type SEARCH
 *   {"p":"response/fragments/-1","o":"BATCH","v":[
 *      {"p":"status","v":"FINISHED"},{"p":"content","v":"搜索到 12 个网页"}]}   leaf path under a SEARCH fragment
 *   {"p":"response/conversation_mode","o":"SET","v":"SEARCH"}              protocol state
 *
 * Run: node test-search.mjs
 */
import { readFileSync } from 'node:fs';
import { reduceChunk } from './lib/deepseek.js';

const file = new URL('./fixtures/search-sample.sse', import.meta.url);
const raw = readFileSync(file, 'utf8');

const state = { fragmentKind: 'text', tip: null };
let text = '';
let thinking = '';
const statuses = [];
let frames = 0;

for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
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
  if (reduced.status) statuses.push(reduced.status);
}

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`=== search-sample.sse: ${frames} data frames ===`);
console.log(`visible  ${text.length} chars`);
console.log(`head     ${JSON.stringify(text.slice(0, 100))}`);

check('fixture is a search turn', raw.includes('"type":"SEARCH"'));
check('fixture carried the accounting text', raw.includes('搜索到 12 个网页'));
check('fixture carries conversation_mode SEARCH', raw.includes('"response/conversation_mode"'));

check('produced the answer body', text.length >= 400, `${text.length} chars`);

// The exact pollution the user reported.
check('no fragment accounting in the body', !text.includes('搜索到'), JSON.stringify(text.slice(0, 40)));
check('no SEARCH mode word at the head', !text.startsWith('SEARCH'), JSON.stringify(text.slice(0, 20)));
check('no DEEP_SEARCH in the body', !text.includes('DEEP_SEARCH'));
check('no conversation mode word in the body', !/\bSEARCH\b/.test(text));
check('body starts with the real answer', text.startsWith('今天的新闻主要集中在'), JSON.stringify(text.slice(0, 30)));
check(
  'body does not start with protocol vocabulary',
  !/^(SEARCH|SEARCHING|THINKING|WIP|INCOMPLETE|AUTO_CONTINUE|FINISHED|CONTENT_FILTER)/.test(text),
);

// The answer's own inline citations are content and must survive; the count is
// what the web app renders as chips, and dropping them loses information.
check('inline [citation:N] markers survive', text.includes('[citation:1]'));
check('no TIP footer leaked', !text.includes('本回答由'));
check('no result payload leaked', !text.includes('cite_index') && !text.includes('snippet'));
check('no query text leaked', !text.includes('2026年10月14日 广州 新闻'));

check('no replacement characters', !text.includes('\uFFFD'));
check('reached a terminal status', statuses.includes('FINISHED'), JSON.stringify(statuses));
check('thinking stayed out of the body', thinking.length === 0 || !text.includes(thinking.slice(0, 20)));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
