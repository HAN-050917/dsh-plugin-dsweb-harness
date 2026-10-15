/**
 * Regression: the browser half must keep the QUERY STRING when it builds the
 * host URL.
 *
 * `request()` calls `fetch(api(API + path))` and every interesting call carries
 * parameters: `/messages?sessionId=…&refresh=1`, `/sessions?refresh=1`,
 * `/chat` (no query). The original helper returned `new URL(...).pathname`,
 * which silently dropped everything from `?` on: `/messages` then arrived with an
 * empty `sessionId` and the host answered `400 缺少 sessionId` — the panel showed
 * that error instead of the transcript. `/sessions` survived only because the
 * host defaults `count`/`refresh`, which is exactly why the bug hid for so long.
 *
 * The test loads `api()` OUT of the real bundle source rather than re-writing it,
 * so it fails if the shipped code regresses (verified by mutation: restoring
 * `.pathname` fails this file while every other suite stays green).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

const start = source.indexOf('function api(path) {');
assert.ok(start !== -1, 'client.js must define api(path)');

// Balanced-brace scan from the opening brace of the function body.
const open = source.indexOf('{', start);
let depth = 0;
let end = -1;
for (let i = open; i < source.length; i += 1) {
  const ch = source[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
assert.ok(end !== -1, 'api(path) body must be brace-balanced');

const snippet = source.slice(start, end);
const api = new Function('document', `${snippet}\nreturn api;`)({
  baseURI: 'http://127.0.0.1:19387/',
});

const API = '/dsh-deepseek-web-chat';
const cases = [
  [`${API}/state`, `${API}/state`],
  [`${API}/messages?sessionId=abc-123&refresh=1`, `${API}/messages?sessionId=abc-123&refresh=1`],
  [`${API}/sessions?refresh=1`, `${API}/sessions?refresh=1`],
  [`${API}/token/clear`, `${API}/token/clear`],
];

// A session id with characters that must stay percent-encoded end to end.
const encoded = 'a%2Fb+c%3D';
cases.push([`${API}/messages?sessionId=${encoded}`, `${API}/messages?sessionId=${encoded}`]);

for (const [input, want] of cases) {
  const got = api(input);
  assert.equal(got, want, `api(${JSON.stringify(input)}) must keep the query`);
  // The server side reads these back with searchParams, so round-trip it.
  if (input.includes('?')) {
    const a = new URL('http://h' + want);
    const b = new URL('http://h' + input);
    assert.equal(a.search, b.search, `query must survive for ${input}`);
  }
}

// The parameter the host requires must be readable after the helper ran.
{
  const url = new URL('http://h' + api(`${API}/messages?sessionId=cfb8386b&refresh=1`));
  assert.equal(url.searchParams.get('sessionId'), 'cfb8386b', 'sessionId must be readable by the host');
  assert.equal(url.searchParams.get('refresh'), '1', 'refresh must be readable by the host');
}

// Guard the exact regression: pathname-only output has no `?` where one belongs.
assert.ok(
  api(`${API}/messages?sessionId=x`).includes('?'),
  'api() must not strip the query string (the 缺少 sessionId regression)',
);

console.log('ALL PASS — api() keeps the query string (5 cases + host round-trip)');
