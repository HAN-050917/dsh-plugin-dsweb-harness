/**
 * Reports stray backticks inside the plugin's CSS template literal.
 *
 * The stylesheet is a template literal, so a backtick inside a CSS comment ends
 * the string early and `node --check` fails with a confusing error pointing at
 * prose. This prints every offending line so they can be rewritten.
 *
 *   node tools/find-css-backticks.mjs lib/client.js
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'lib/client.js';
const source = readFileSync(file, 'utf8');
const start = source.indexOf('const CSS = `');
if (start === -1) {
  console.error('no `const CSS = ` template found');
  process.exit(1);
}
const bodyStart = source.indexOf('`', start + 'const CSS = '.length) + 1;
const end = source.indexOf('\n`;', bodyStart);
if (end === -1) {
  console.error('unterminated CSS template');
  process.exit(1);
}
const body = source.slice(bodyStart, end);
const before = source.slice(0, bodyStart);
const baseLine = before.split('\n').length;
let count = 0;
body.split('\n').forEach((line, index) => {
  if (!line.includes('`')) return;
  count += 1;
  console.log(`${baseLine + index}: ${line.trim()}`);
});
console.log(count ? `${count} line(s) contain a backtick inside the CSS template` : 'clean: no backticks inside the CSS template');
process.exit(count ? 1 : 0);
