/**
 * Replay a REAL captured `GET /api/v0/chat/history_messages` envelope through
 * the history parser.
 *
 * Why this file exists: the first implementation read `data.biz_data.messages[]`
 * and got an empty array on every session — the session list synced fine, so
 * nothing looked broken, but every transcript came back empty. The payload key
 * is `chat_messages[]`, and a message carries NO `content` of its own: the text
 * lives in `fragments[]`, typed REQUEST / RESPONSE / THINK / TEMPLATE_RESPONSE /
 * TOOL_SEARCH / TOOL_OPEN / TIP. Getting any of that wrong is invisible until a
 * user opens a conversation, so it is pinned here against real bytes.
 */
import { parseHistoryMessages } from '../dsh-deepseek-web-chat/lib/deepseek.js';
import { readFileSync } from 'node:fs';

function check(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      got  ${JSON.stringify(got).slice(0, 140)}\n      want ${JSON.stringify(want).slice(0, 140)}`);
  return ok;
}

function checkTrue(name, value, detail = '') {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

let allOk = true;
const FIXTURE =
  'C:/Users/p/Documents/deepseek-harness/default-workspace/dsh-deepseek-web-chat/fixtures/history-sample.json';
const payload = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// The regression itself: the payload is keyed `chat_messages`, NOT `messages`.
const biz = payload.data.biz_data;
allOk = checkTrue('fixture uses the upstream key `chat_messages`', Array.isArray(biz.chat_messages) && biz.chat_messages.length === 4, `${biz.chat_messages.length} messages`) && allOk;
allOk = checkTrue('fixture deliberately has NO `messages` key (the original bug)', !('messages' in biz)) && allOk;

const messages = parseHistoryMessages(payload);
allOk = check('every message survives with a body', messages.length, 4) && allOk;
allOk = check(
  'roles map to the panel vocabulary',
  messages.map((m) => m.role).join(','),
  'user,assistant,user,assistant',
) && allOk;

// A user turn is a REQUEST fragment.
allOk = check('the user prompt is the REQUEST fragment', messages[0].content, '你好') && allOk;

// An assistant turn: RESPONSE is the body, THINK is separate reasoning.
allOk = checkTrue(
  'the assistant body is the RESPONSE fragment',
  messages[1].content.startsWith('你好！很高兴见到你'),
  messages[1].content.slice(0, 40),
) && allOk;
allOk = checkTrue(
  'reasoning is exposed separately, not swallowed or dropped',
  messages[1].reasoning.startsWith('嗯，用户发来一句简单的'),
  messages[1].reasoning.slice(0, 30),
) && allOk;
allOk = checkTrue(
  'THINK never leaks into the visible answer',
  !messages[1].content.includes('嗯，用户发来'),
) && allOk;

// The news turn is the interesting one: one assistant message holds THINK,
// TOOL_SEARCH, TOOL_OPEN x13, more THINK, RESPONSE and a TIP.
const news = messages[3];
allOk = checkTrue('the news answer is the RESPONSE fragment', news.content.startsWith('今天是2026年10月14日'), news.content.slice(0, 30)) && allOk;
allOk = checkTrue(
  'tool bookkeeping never leaks into the answer',
  !news.content.includes('搜索到 36 个网页') && !news.content.includes('TOOL'),
) && allOk;
allOk = checkTrue(
  'the trailing TIP note never leaks into the answer',
  !news.content.includes('本回答由 AI 生成'),
) && allOk;
allOk = checkTrue(
  '`[reference:N]` stays in the body — it is real answer text',
  news.content.includes('[reference:0]'),
) && allOk;
allOk = checkTrue(
  'the news turn still carries its reasoning',
  news.reasoning.includes('用户想了解2026年10月14日的新闻'),
) && allOk;

// Payload variants that still ship a plain `content`, and the legacy `messages`
// key, must keep working.
const legacy = parseHistoryMessages({
  code: 0,
  data: { biz_data: { messages: [{ role: 'USER', content: 'hi' }, { role: 'ASSISTANT', content: 'hello' }] } },
});
allOk = check('a legacy `messages[]` payload still parses', legacy.length, 2) && allOk;
allOk = check('a message-level `content` is used as a fallback', legacy[0].content, 'hi') && allOk;

// Empty assistant turns are dropped rather than rendered as blank bubbles.
const blank = parseHistoryMessages({
  code: 0,
  data: { biz_data: { chat_messages: [{ role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'only thinking' }] }] } },
});
allOk = check('a turn with no body is dropped', blank.length, 0) && allOk;

console.log(allOk ? '\nALL PASS' : '\nFAILED');
process.exitCode = allOk ? 0 : 1;
