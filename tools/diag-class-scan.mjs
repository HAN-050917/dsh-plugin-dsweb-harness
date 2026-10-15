/**
 * Diagnostic: why does test-style.mjs disagree with the stylesheet?
 *
 * The class checks depend on a hand-written string-literal scanner. This prints
 * what that scanner actually sees, so a misalignment is visible instead of
 * being guessed at. Not part of the suite.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const cssStart = source.indexOf('const CSS = `');
const cssEnd = source.indexOf('\n`;', cssStart);
console.log('cssStart', cssStart, 'cssEnd', cssEnd, 'len', source.length);
console.log('tail after cssEnd:', JSON.stringify(source.slice(cssEnd, cssEnd + 40)));

const codeOnly = source.slice(0, cssStart) + source.slice(cssEnd);
const literals = [];
for (let i = 0; i < codeOnly.length; i += 1) {
  const quote = codeOnly[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') continue;
  let value = '';
  const at = i;
  for (i += 1; i < codeOnly.length; i += 1) {
    if (codeOnly[i] === '\\') {
      value += codeOnly[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (codeOnly[i] === quote) break;
    value += codeOnly[i];
  }
  literals.push({ at, quote, value });
}

console.log('literals found:', literals.length);
const huge = literals.filter((l) => l.value.length > 400);
console.log('suspiciously long literals:', huge.length);
for (const l of huge.slice(0, 5)) {
  console.log('  at', l.at, 'quote', l.quote, 'len', l.value.length, JSON.stringify(l.value.slice(0, 120)));
}

const used = new Set(
  literals.flatMap((l) => [...l.value.matchAll(/\bdswc-[A-Za-z0-9_-]+/g)].map((m) => m[0])),
);
const defined = new Set([...source.slice(cssStart, cssEnd).matchAll(/\.(dswc-[A-Za-z0-9_-]+)/g)].map((m) => m[1]));
console.log('defined', defined.size, 'used', used.size);
console.log('defined but unused:', [...defined].filter((c) => !used.has(c)).join(', '));
console.log('used but undefined:', [...used].filter((c) => !defined.has(c)).join(', '));
