// Strip literal colour fallbacks out of `var(--token, <literal>)`.
//
// The theme sheet is the colour authority, so a fallback literal is dead weight
// that also silently breaks dark mode: if the token ever went missing the panel
// would fall back to a light-only hex instead of the theme's own value. The
// tokens are verified against the shipped sheet by test-style.mjs, so the
// fallback can simply go.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || 'lib/client.js';
let source = readFileSync(path, 'utf8');
const before = source.length;

// Nested forms collapse inwards: `var(--a, var(--b, #hex))` first loses `#hex`.
const literal = /var\(\s*(--[A-Za-z0-9-]+)\s*,\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\))\s*\)/g;

let total = 0;
for (let round = 0; round < 5; round += 1) {
  const hits = [...source.matchAll(literal)];
  if (hits.length === 0) break;
  source = source.replace(literal, 'var($1)');
  total += hits.length;
}

writeFileSync(path, source);
console.log(`${path}: removed ${total} literal fallback(s), ${before} -> ${source.length} bytes`);

const remaining = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
console.log(remaining.length === 0 ? 'no colour literals left' : `still present: ${remaining.join(', ')}`);
