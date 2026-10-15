/**
 * Prove the envelope fix end to end on the real two-round capture:
 *   1. round 1's full reasoning survives (it used to be missing its 2-char head);
 *   2. round 2 does NOT duplicate round 1's 50k-char snapshot;
 *   3. a short answer that ONLY ever arrives in an envelope survives.
 */
import { reduceChunk } from '../dsh-deepseek-web-chat/lib/deepseek.js';
import { readFileSync } from 'node:fs';

function check(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      got  ${JSON.stringify(got).slice(0, 120)}\n      want ${JSON.stringify(want).slice(0, 120)}`);
  return ok;
}

let allOk = true;
const FILE =
  'C:/Users/p/Documents/deepseek-harness/default-workspace/src/ds2api/ds2api-main/tests/raw_stream_samples/continue-thinking-snapshot-replay-20260405/upstream.stream.sse';

const rounds = [];
{
  let current = null;
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (line.startsWith('event:')) {
      if (line.slice(6).trim() === 'ready') {
        current = [];
        rounds.push(current);
      }
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const c = JSON.parse(payload);
      if (!current) {
        current = [];
        rounds.push(current);
      }
      current.push(c);
    } catch {
      /* ignore */
    }
  }
}

// The reducer state is SHARED across rounds by streamCompletion, so replay it
// the same way: one state, two sequential rounds.
const state = { fragmentKind: 'text', tip: null };
const perRound = [];
for (const frames of rounds) {
  const acc = { text: '', thinking: '' };
  for (const c of frames) {
    const r = reduceChunk(c, state);
    acc.text += r.text;
    acc.thinking += r.thinking;
  }
  perRound.push(acc);
}

allOk = check('two rounds were parsed', rounds.length, 2) && allOk;
// Round 1 = 2 chars from its envelope ("我们") + 50095 from deltas.
allOk = check('round 1 keeps its full reasoning (no lost head)', perRound[0].thinking.length, 50097) && allOk;
allOk = check('round 1 reasoning starts at the true beginning', perRound[0].thinking.startsWith('我们被问到'), true) && allOk;
allOk = check('round 1 emits no answer text before the answer fragment', perRound[0].text, '') && allOk;

// Round 2's envelope re-sends round 1's 50097 chars plus "/P". Trimming must
// leave only the 2 NEW chars, and the round's own deltas add 683 more — so the
// round contributes 685, not 50782. Without the trim the total nearly doubles
// (50097 + 50782 = 100879), which is the duplication this guards against.
const dupe = perRound[1].thinking.includes(perRound[0].thinking.slice(0, 200));
allOk = check('round 2 does NOT replay round 1 reasoning (no duplication)', dupe, false) && allOk;
allOk = check('round 2 contributes only its new reasoning tail', perRound[1].thinking.length, 685) && allOk;
allOk = check('round 2 new tail starts where round 1 stopped', perRound[1].thinking.startsWith('/P'), true) && allOk;
allOk = check('round 2 carries the answer', perRound[1].text.length, 242) && allOk;
allOk = check('round 2 answer starts correctly', perRound[1].text.startsWith('园丁可以保证'), true) && allOk;

// The whole turn, end to end: no text is lost and nothing is duplicated.
const totalThinking = perRound[0].thinking.length + perRound[1].thinking.length;
allOk = check('whole turn keeps every reasoning char exactly once', totalThinking, 50782) && allOk;

// A round-2 envelope whose content is entirely already-emitted must add nothing.
{
  const s = { fragmentKind: 'text', tip: null, emittedText: 'hello world' };
  const frame = { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: 'hello world' }] } } };
  const r = reduceChunk(frame, s);
  allOk = check('a fully-replayed envelope adds no text', r.text, '') && allOk;
}
{
  const s = { fragmentKind: 'text', tip: null, emittedText: 'hello world' };
  const frame = { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: 'hello world and more' }] } } };
  const r = reduceChunk(frame, s);
  allOk = check('a snapshot extension adds only the new tail', r.text, ' and more') && allOk;
}
{
  // The bug that started this: a short answer that arrives ONLY in the envelope.
  const s = { fragmentKind: 'text', tip: null };
  const frame = { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: '收到' }] } } };
  const r = reduceChunk(frame, s);
  allOk = check('a short envelope-only answer survives', r.text, '收到') && allOk;
}
{
  // A fresh turn must not inherit the previous turn's emitted text.
  const s = { fragmentKind: 'text', tip: null };
  const frame = { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: '收到' }] } } };
  reduceChunk(frame, s);
  const second = reduceChunk({ v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: '收到' }] } } }, s);
  allOk = check('second envelope in the same turn is treated as a replay', second.text, '') && allOk;
}

console.log(allOk ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(allOk ? 0 : 1);
