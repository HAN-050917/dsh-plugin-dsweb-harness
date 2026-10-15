/**
 * Regression: inline source markers must not reach the user's eyes.
 *
 * DeepSeek puts `[reference:N]` / `[citation:N]` inside the ANSWER body and the
 * web app renders each one as a numbered chip linked to its source panel. This
 * plugin has no source panel, so the markers are pure noise — the user's own
 * screenshot of a search answer was `…广交会致贺信。[reference:0][reference:1]…`.
 *
 * Stripping happens at RENDER time on purpose: a marker can be split across two
 * SSE deltas (`[refe` + `rence:0]`), which a per-chunk parser cannot see, and the
 * stored transcript stays faithful to upstream.
 *
 * The function is lifted OUT of the shipped bundle (brace-balanced scan) so this
 * file fails if `lib/client.js` regresses to plain `String(text)`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

function lift(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `client.js must define ${name}()`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const snippet = source.slice(start, i + 1);
        return new Function(`${snippet}\nreturn ${name};`)();
      }
    }
  }
  throw new Error(`${name}() body must be brace-balanced`);
}

const strip = lift('stripCitations');

const cases = [
  // The exact shape from the user's screenshot.
  ['广交会致贺信。[reference:0][reference:1]', '广交会致贺信。'],
  // A single marker mid-sentence keeps the sentence readable.
  ['这是重要新闻[reference:2]。', '这是重要新闻。'],
  // The live-search spelling.
  ['今天有新闻[citation:11]。', '今天有新闻。'],
  // Markers on their own line vanish without leaving a blank line behind.
  ['第一段\n[reference:3]\n第二段', '第一段\n第二段'],
  // Ordinary brackets and unrelated numbers must survive untouched.
  ['数组 a[0] 和 a[1] 不是引用', '数组 a[0] 和 a[1] 不是引用'],
  ['【参考】不是标记', '【参考】不是标记'],
  ['版本 [2] 已发布', '版本 [2] 已发布'],
  // `[reference:` with a non-numeric payload is still a marker, not body text.
  ['结论[reference:abc]', '结论'],
  // Nothing to strip: the string is returned unchanged.
  ['普通回答', '普通回答'],
  ['', ''],
];

for (const [input, want] of cases) {
  assert.equal(strip(input), want, `stripCitations(${JSON.stringify(input)})`);
}

// Real fixture text: the news answer's markers go, the prose stays.
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'history-sample.json'), 'utf8'));
const news = fixture.data.biz_data.chat_messages[3];
const body = String(news.fragments.find((f) => f.type === 'RESPONSE').content);
assert.ok(body.includes('[reference:'), 'fixture must actually contain markers (else this test is vacuous)');
const cleaned = strip(body);
assert.ok(!/\[(?:reference|citation)\s*:\s*\d+\]/.test(cleaned), 'no marker survives');
// Prose survives: the leading sentence is untouched, character for character.
const head = body.slice(0, body.indexOf('[reference:'));
assert.ok(head.length > 20, 'fixture must have real prose before the first marker');
assert.ok(cleaned.includes(head), 'prose before the first marker survives verbatim');
// Only whitespace is removed with the markers; every other char is preserved.
const withoutMarkers = body.replace(/\[reference:\d+\]/g, '');
assert.equal(
  cleaned.replace(/\s+/g, ''),
  withoutMarkers.replace(/\s+/g, ''),
  'no prose is eaten along with the markers',
);
assert.ok(cleaned.includes('今天是2026年10月14日'), 'the real answer text is intact');

// A marker split across two deltas is handled because stripping runs on the
// assembled string, not per chunk.
const split = ['结', '论', '[refe', 'rence:', '7', ']', '。'].join('');
assert.equal(strip(split), '结论。', 'a marker split across deltas still goes away');

console.log(`ALL PASS — stripCitations: ${cases.length} cases + real fixture + split-delta marker`);
