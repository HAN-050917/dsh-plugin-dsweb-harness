/**
 * Regression: the plugin's stylesheet must stay inside the theme vocabulary.
 *
 * Styling rule for a Harness plugin: the `--dsw-*` custom properties are the
 * only shared styling dependency (practices.md). A misspelled token does not
 * throw — `var(--dsw-alias-border-l03)` simply resolves to nothing and the
 * border silently disappears, which is exactly the kind of drift a screenshot
 * cannot catch in dark mode. So every token this plugin references is checked
 * against the token sheet the shipped theme bundle declares.
 *
 * The fixture is generated from that bundle, so it cannot rot into a list of
 * tokens somebody remembered. Regenerate with tools/dump-theme-tokens.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');
const theme = JSON.parse(readFileSync(join(here, 'fixtures', 'theme-tokens.json'), 'utf8'));

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ---- the stylesheet, lifted out of the shipped bundle ----------------------

const cssStart = source.indexOf('const CSS = `');
assert.ok(cssStart !== -1, 'client.js must define the CSS template literal');
// The sheet ends at the first line that is just a closing backtick, which is how
// it is written; scanning for an unescaped backtick instead would stop early on
// the `\`` inside a font stack.
const cssEnd = source.indexOf('\n`;', cssStart);
assert.ok(cssEnd > cssStart, 'the CSS template literal must be closed');
const CSS = source.slice(cssStart + 'const CSS = `'.length, cssEnd);

// ---- tokens ---------------------------------------------------------------

const declared = new Set(theme.tokens);
const runtime = new Set(theme.runtime);

const referenced = new Set();
for (const match of CSS.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) referenced.add(match[1]);

check('the stylesheet references theme tokens at all', referenced.size >= 20, String(referenced.size));
check(
  'no token outside the shipped theme vocabulary (or the runtime set)',
  [...referenced].every((token) => declared.has(token) || runtime.has(token)),
  [...referenced]
    .filter((token) => !declared.has(token) && !runtime.has(token))
    .sort()
    .join(', '),
);

// A custom property the plugin itself defines is fine, but it must be declared
// here and nowhere else — the theme is not a namespace to squat in.
const locallyDeclared = [...CSS.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map((m) => m[1]);
check(
  'the plugin declares no custom properties of its own',
  locallyDeclared.length === 0,
  locallyDeclared.join(', '),
);

// The theme sheet is the color authority: no raw hex colors, and rgb() only
// where the value is deliberately transparent.
const rawColors = [];
for (const match of CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) rawColors.push(match[0]);
check('no raw hex colors', rawColors.length === 0, rawColors.join(', '));

const opaqueRgb = [...CSS.matchAll(/rgba?\(([^)]*)\)/g)].filter((m) => !/\/\s*0(?:\.0+)?\s*\)?\s*$/.test(m[0]) && !/,\s*0(?:\.0+)?\s*$/.test(m[0]));
check(
  'rgb()/rgba() only for fully transparent fills',
  opaqueRgb.length === 0,
  opaqueRgb.map((m) => m[0]).join(', '),
);

// Fallbacks are allowed — a token may be missing in an older host — but every
// `var()` that has one must still name a real token, which the check above
// already enforces. This one guards the reverse: a font shorthand that lost its
// token and hardened into a literal.
check(
  'markdown type comes from the type tokens, not literals',
  /font:\s*var\(--dsw-font-markdown-base/.test(CSS) && /font:\s*var\(--dsw-font-markdown-h1/.test(CSS),
  'expected the markdown font tokens to be used',
);

// ---- classes --------------------------------------------------------------

const definedClasses = new Set([...CSS.matchAll(/\.(dswc-[A-Za-z0-9_-]+)/g)].map((m) => m[1]));

// Class names are collected from string literals in the CODE, not from the
// whole file: the stylesheet's own selectors would otherwise count as "uses",
// which is exactly how a dead rule hides.
//
// This is a lexer, not a regex, because a regex that looks for quotes is wrong:
// `INLINE_PATTERN` is a regex literal containing backticks and quotes, so a
// quote-driven scan starts a bogus template literal inside it and swallows the
// next few hundred lines of real code — which is exactly how a first attempt at
// this check reported a dozen live classes as dead.
const codeOnly = source.slice(0, cssStart) + source.slice(cssEnd);
const literals = [];
{
  let previous = '';
  for (let i = 0; i < codeOnly.length; i += 1) {
    const char = codeOnly[i];
    const next = codeOnly[i + 1];
    if (char === '/' && next === '/') {
      i = codeOnly.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (char === '/' && next === '*') {
      i = codeOnly.indexOf('*/', i + 2) + 1;
      continue;
    }
    // A `/` after a value divides; after an operator, `(`, `,`, `=` or the start
    // of a statement it opens a regex literal. Mirrors test-markdown.mjs.
    if (char === '/' && !/[\w)\]]$/.test(previous)) {
      for (i += 1; i < codeOnly.length; i += 1) {
        if (codeOnly[i] === '\\') i += 1;
        else if (codeOnly[i] === '\n') break;
        else if (codeOnly[i] === '/') break;
        else if (codeOnly[i] === '[') {
          while (i < codeOnly.length && codeOnly[i] !== ']') {
            if (codeOnly[i] === '\\') i += 1;
            i += 1;
          }
        }
      }
      previous = '/';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let value = '';
      for (i += 1; i < codeOnly.length; i += 1) {
        if (codeOnly[i] === '\\') {
          value += codeOnly[i + 1] ?? '';
          i += 1;
          continue;
        }
        if (codeOnly[i] === char) break;
        value += codeOnly[i];
      }
      literals.push(value);
      previous = char;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
  }
}

// `dswc-h${level}` names a class per heading level, so a name that runs straight
// into `${` is matched by prefix instead of exactly. Only interpolated names get
// that latitude — a plain typo like `dswc-bod` still fails.
const usedClasses = new Set();
const prefixedClasses = new Set();
for (const value of literals) {
  for (const match of value.matchAll(/\bdswc-[A-Za-z0-9_-]+/g)) {
    const after = value.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (after === '${') prefixedClasses.add(match[0]);
    else usedClasses.add(match[0]);
  }
}
const covers = (name) => definedClasses.has(name) || [...definedClasses].some((cls) => cls.startsWith(name));

check(
  'every class used in code is defined in the stylesheet',
  [...usedClasses].every((name) => definedClasses.has(name)) && [...prefixedClasses].every(covers),
  [...usedClasses].filter((name) => !definedClasses.has(name)).concat([...prefixedClasses].filter((name) => !covers(name))).sort().join(', '),
);

// Unused rules are dead weight. An interpolated prefix counts as a use for every
// class it can expand to, so the heading levels are covered by `dswc-h${level}`.
const unused = [...definedClasses]
  .filter((name) => !usedClasses.has(name) && ![...prefixedClasses].some((prefix) => name.startsWith(prefix)))
  .sort();
check('no dead classes accumulate', unused.length === 0, unused.join(', '));

// ---- the prefix rule ------------------------------------------------------

check(
  'every class carries the plugin prefix',
  [...definedClasses].every((name) => name.startsWith('dswc-')),
  [...definedClasses].filter((name) => !name.startsWith('dswc-')).join(', '),
);

// The shell owns `data-ds-dark-theme`; a plugin that hard-codes a dark palette
// instead of using tokens breaks the moment the user switches themes.
check(
  'the stylesheet never reacts to the dark-theme attribute itself',
  !CSS.includes('data-ds-dark-theme'),
  'use theme tokens instead of a dark-only rule',
);

const failed = results.filter((entry) => !entry.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — stylesheet: ${referenced.size} theme tokens, ${definedClasses.size} classes`
    : `\n${failed.length} FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
