/** Diagnostic: show how each distinct chunk shape is classified for one sample. */
import { readFileSync } from 'node:fs';
import { reduceChunk } from './lib/deepseek.js';

const file = process.argv[2];
const raw = readFileSync(file, 'utf8');
const state = { fragmentKind: 'text', tip: null };

const shapes = new Map();
let idx = 0;
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) continue;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  let chunk;
  try { chunk = JSON.parse(payload); } catch { continue; }
  idx += 1;
  const before = state.fragmentKind;
  const reduced = reduceChunk(chunk, state);
  const after = state.fragmentKind;
  const shape = `${chunk.p ?? '(no p)'} | o=${chunk.o ?? '-'} | v=${Array.isArray(chunk.v) ? 'array' : typeof chunk.v}`;
  const key = `${shape} -> ${before}${after !== before ? '=>' + after : ''} txt=${reduced.text ? 'Y' : '-'} thk=${reduced.thinking ? 'Y' : '-'}`;
  const rec = shapes.get(key) ?? { count: 0, first: idx, sample: null };
  rec.count += 1;
  if (!rec.sample) {
    rec.sample = JSON.stringify(chunk).slice(0, 180);
    rec.out = JSON.stringify(reduced).slice(0, 200);
  }
  shapes.set(key, rec);
}

console.log(`${idx} data frames, ${shapes.size} distinct classifications\n`);
for (const [key, rec] of [...shapes.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`×${String(rec.count).padStart(5)}  first#${rec.first}  ${key}`);
  console.log(`         in : ${rec.sample}`);
  console.log(`         out: ${rec.out}`);
}
