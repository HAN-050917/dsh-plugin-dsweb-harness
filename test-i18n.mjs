/**
 * Regression: the two dictionaries must stay complete and in step.
 *
 * `ctx.locale.bind(NS)` returns the key itself when a translation is missing, so
 * a typo does not throw — the panel just renders `think.title` where 思考 should
 * be. That is invisible to every other suite: test-style.mjs only looks at CSS
 * class names, and test-think.mjs only at the reasoning row's behaviour, so a
 * key that exists in zh but not en (or a call site naming a key nobody defined)
 * would ship silently. This suite is that missing guard.
 *
 * It also catches the opposite drift: a key left in the dictionaries after the
 * last call site was deleted is dead weight that makes the next reader think a
 * feature still exists.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ---- lift the two dictionary literals --------------------------------------

/**
 * Slices `const <name> = {` up to the line that closes it. The dictionaries are
 * written with the closing brace alone on its own line, and their values are
 * plain strings, so a line scan is exact here where a brace counter would have
 * to understand the quotes inside `setup.snippet`.
 */
function liftDictionary(name) {
  const head = `const ${name} = {`;
  const start = source.indexOf(head);
  assert.ok(start !== -1, `client.js must define ${name}`);
  const end = source.indexOf('\n    };', start);
  assert.ok(end > start, `${name} must be closed by a line holding only "};"`);
  const literal = source.slice(start + head.length - 1, end + '\n    }'.length);
  return new Function(`return ${literal};`)();
}

const zh = liftDictionary('zh');
const en = liftDictionary('en');

check('both dictionaries were lifted', typeof zh === 'object' && typeof en === 'object');
check('the dictionaries are not empty', Object.keys(zh).length > 20, String(Object.keys(zh).length));

// ---- every call site names a key that exists --------------------------------

/**
 * Keys referenced from code, found by SUBSTRING rather than by a regex.
 *
 * A quote-matching regex looks obvious here and is wrong: the file is full of
 * comments with apostrophes ("the row's owner", "a key nobody defined"), and
 * one of those flips the quote parity for the rest of the file, so `t('panel.title')`
 * stops matching and dozens of live keys get reported as dead. Searching for
 * `'key'` as a plain substring cannot be desynchronised that way, and the
 * dictionaries' own text is excluded by slicing the two blocks out first.
 *
 * Both spellings are honoured: components get `t` as a prop, while the
 * module-scope actions (`send`, `loadState`) reach the same dictionary through
 * the `i18n` handle, and a key only used from there is not dead.
 */
const code = source
  .replace(source.slice(source.indexOf('const zh = {'), source.indexOf('\n    };', source.indexOf('const zh = {')) + '\n    }'.length), '')
  .replace(source.slice(source.indexOf('const en = {'), source.indexOf('\n    };', source.indexOf('const en = {')) + '\n    }'.length), '');

const used = new Set(
  Object.keys(zh).filter((key) => code.includes(`'${key}'`) || code.includes(`"${key}"`) || code.includes(`\`${key}\``)),
);

check('call sites were found at all', used.size > 20, String(used.size));

const missingZh = [...used].filter((key) => !(key in zh)).sort();
check('every key used in code is defined in zh', missingZh.length === 0, missingZh.join(', '));

const missingEn = [...used].filter((key) => !(key in en)).sort();
check('every key used in code is defined in en', missingEn.length === 0, missingEn.join(', '));

// ---- no hardcoded fallback bypasses the dictionaries ------------------------

/**
 * `describe(error) || '同步失败'` was the shape that hid a real defect: the
 * literal is Chinese, so an English UI showed Chinese on a failed sync, and
 * nothing else in the suite could see it. Any `||` whose right side is a quoted
 * string in this file is a wording that skipped the dictionary.
 */
const fallbacks = [];
for (const line of source.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
  const match = trimmed.match(/\|\|\s*(['"])([^'"]{2,})\1/);
  if (match) fallbacks.push(`${trimmed.slice(0, 70)} → ${match[2]}`);
}
check('no error wording bypasses the dictionaries', fallbacks.length === 0, fallbacks.join(' | '));

// ---- the two dictionaries must have identical key sets ----------------------

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();

const onlyZh = zhKeys.filter((key) => !(key in en));
check('no key is zh-only', onlyZh.length === 0, onlyZh.join(', '));

const onlyEn = enKeys.filter((key) => !(key in zh));
check('no key is en-only', onlyEn.length === 0, onlyEn.join(', '));

check(
  'the dictionaries hold the same number of keys',
  zhKeys.length === enKeys.length,
  `${zhKeys.length} vs ${enKeys.length}`,
);

// ---- no dead keys -----------------------------------------------------------

// A key nothing calls means a deleted feature left its wording behind.
const unused = zhKeys.filter((key) => !used.has(key));
check('no dictionary key is unused', unused.length === 0, unused.join(', '));

// ---- values must be real, non-empty strings ---------------------------------

const badZh = zhKeys.filter((key) => typeof zh[key] !== 'string' || zh[key].trim() === '');
check('every zh value is a non-empty string', badZh.length === 0, badZh.join(', '));

const badEn = enKeys.filter((key) => typeof en[key] !== 'string' || en[key].trim() === '');
check('every en value is a non-empty string', badEn.length === 0, badEn.join(', '));

// A value identical to its key is the shape a stub takes when somebody adds a
// key to one dictionary and pastes the key name as a placeholder.
const placeholder = zhKeys.filter((key) => zh[key] === key || en[key] === key);
check('no value is just its own key', placeholder.length === 0, placeholder.join(', '));

// ---- the English dictionary must not carry Chinese text ---------------------

/**
 * `state.empty.inSidebar` said "the sidebar's 聊天 tab" in the ENGLISH
 * dictionary — written while the tab was only ever seen in Chinese. Every other
 * assertion here passes on that: the key exists, both sides have it, the value
 * is non-empty. Only looking at the characters catches it, and the failure mode
 * is a user on an English UI being told to click a tab that reads "Chat".
 *
 * `setup.snippet` is the one zh value that is code rather than prose, so it is
 * exempt from the reverse check.
 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const cjkInEn = enKeys.filter((key) => CJK.test(en[key]));
check('no English value contains Chinese characters', cjkInEn.length === 0, cjkInEn.join(', '));

const proseZh = zhKeys.filter((key) => key !== 'setup.snippet' && !CJK.test(zh[key]));
check('every Chinese value is actually Chinese', proseZh.length === 0, proseZh.join(', '));

// ---- the dictionaries are registered together -------------------------------

check(
  'both dictionaries are registered in one call',
  /ctx\.locale\.register\(NS,\s*\{\s*zh,\s*en\s*\}\)/.test(source),
  'ctx.locale.register must receive { zh, en }',
);

const failed = results.filter((entry) => !entry.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — dictionaries: ${zhKeys.length} keys, ${used.size} call sites`
    : `\n${failed.length} FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
