/**
 * Verify the auto-continue decision against the REAL captured two-round stream.
 *
 * `continue-thinking-snapshot-replay-20260405` is a genuine capture of one
 * DeepSeek answer that upstream cut off after round 1 and finished after round 2:
 * completion returned 649,506 bytes ending in `response/status = INCOMPLETE`,
 * then continue returned 136,876 bytes ending in `FINISHED`.
 *
 * The frame boundaries are read from `meta.json`'s `capture.rounds` — the number
 * of rounds and the event offsets inside the single concatenated `.sse` file.
 * This is the only real evidence available for the continue decision, so it is
 * asserted directly: round 1 must ask for a continue, round 2 must not.
 *
 * Run: node test-continue.mjs [samplesRoot]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeRound, shouldContinue, reduceChunk } from './lib/deepseek.js';

const DEFAULT_ROOT =
  'C:/Users/p/Documents/deepseek-harness/default-workspace/src/ds2api/ds2api-main/tests/raw_stream_samples/continue-thinking-snapshot-replay-20260405';

const dir = process.argv[2] ?? DEFAULT_ROOT;

let failures = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const lines = readFileSync(join(dir, 'upstream.stream.sse'), 'utf8').split(/\r?\n/);

console.log(`capture rounds: ${meta.capture.rounds.map((r) => r.label).join(', ')}`);
console.log(`total lines: ${lines.length}`);

/** Find the inclusive line index of each `event: ready` — one per round. */
const readyAt = [];
for (let i = 0; i < lines.length; i += 1) {
  if (/^event:\s*ready\s*$/.test(lines[i])) readyAt.push(i);
}
check('found both round boundaries', readyAt.length === 2, `readyAt=${JSON.stringify(readyAt)}`);

/** Feed one round through observeRound exactly as streamCompletion does. */
function pumpRound(from, to) {
  const state = { fragmentKind: 'text', tip: null };
  const round = { responseMessageId: 0, lastStatus: '', finished: false, autoContinue: false };
  let text = '';
  for (let i = from; i <= to && i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    // Mirrors readStream: an event frame is observed but never reduced.
    observeRound(chunk, round);
    if (chunk && typeof chunk === 'object' && typeof chunk.event === 'string') continue;
    const reduced = reduceChunk(chunk, state);
    text += reduced.text;
    if (reduced.status === 'FINISHED' || reduced.status === 'CONTENT_FILTER') round.finished = true;
  }
  return { round, text };
}

const [first, second] = readyAt;

console.log('\n=== round 1 (completion) ===');
const round1 = pumpRound(first, second - 1);
console.log(
  `messageId=${round1.round.responseMessageId} lastStatus=${JSON.stringify(round1.round.lastStatus)} ` +
    `finished=${round1.round.finished} autoContinue=${round1.round.autoContinue}`,
);
console.log(`visible ${round1.text.length} chars, tail ${JSON.stringify(round1.text.slice(-60))}`);

// THE load-bearing assertion: round 1 says INCOMPLETE, so without auto-continue
// the user would silently receive a truncated answer — the stream still ends
// with a normal `event: finish` and `event: close`.
check('round 1 harvested the response message id', round1.round.responseMessageId > 0, `${round1.round.responseMessageId}`);
check('round 1 is not marked finished', round1.round.finished === false);
check('round 1 requests a continue', shouldContinue(round1.round) === true, `lastStatus=${round1.round.lastStatus}`);

console.log('\n=== round 2 (continue) ===');
const round2 = pumpRound(second, lines.length - 1);
console.log(
  `messageId=${round2.round.responseMessageId} lastStatus=${JSON.stringify(round2.round.lastStatus)} ` +
    `finished=${round2.round.finished} autoContinue=${round2.round.autoContinue}`,
);
console.log(`visible ${round2.text.length} chars`);
check('round 2 is terminal', round2.round.finished === true);
check('round 2 does not request a continue', shouldContinue(round2.round) === false);

// A plain WIP status (how every normal stream opens) must never trigger a round.
const wip = { responseMessageId: 7, lastStatus: 'WIP', finished: false, autoContinue: false };
check('plain WIP does not request a continue', shouldContinue(wip) === false);
const noId = { responseMessageId: 0, lastStatus: 'INCOMPLETE', finished: false, autoContinue: false };
check('INCOMPLETE without a message id does not continue', shouldContinue(noId) === false);
const auto = { responseMessageId: 7, lastStatus: 'WIP', finished: false, autoContinue: true };
check('auto_continue:true does request a continue', shouldContinue(auto) === true);

// `ready` carries response_message_id at the TOP level of an event frame — the
// frame that must still be harvested even though it is never reduced as content.
const readyFrameBody = lines[first + 1].trim().slice(5);
const readyObserved = { responseMessageId: 0, lastStatus: '', finished: false, autoContinue: false };
observeRound(JSON.parse(readyFrameBody), readyObserved);
check('ready frame yields the response message id', readyObserved.responseMessageId > 0, `${readyObserved.responseMessageId}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
