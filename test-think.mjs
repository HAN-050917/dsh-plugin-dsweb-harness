/**
 * Regression: the reasoning disclosure must behave like the shipped
 * ReasoningRow, not like a wall of preformatted text.
 *
 * Why this matters: a synced DeepSeek chain can run to thousands of characters
 * (the fixture in this package has a 193-character one, real ones are far
 * longer). Printing it inline pushes the answer itself off-screen, which is the
 * complaint this row exists to answer. The shipped row solves it with a 24px
 * summary line that expands on demand, so this plugin draws the same thing.
 *
 * The row is lifted OUT of the shipped bundle and evaluated with a stub `h`, so
 * no assertion here can pass against a copy of the logic that has drifted from
 * what users see.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

/**
 * Brace-balanced lift of `function name(` … matching `}`.
 *
 * A plain counter is not enough: this section contains regex literals, and a
 * quantifier like `{2,}` opens no brace but closes one, which ends the scan
 * mid-function. So the scanner skips strings, template literals, comments and
 * regexes, and only counts braces in real code.
 */
function liftFunction(name, body = source) {
  const start = body.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `client.js must define ${name}()`);
  let depth = 0;
  let started = false;
  let previous = '';
  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    const next = body[i + 1];
    if (char === '/' && next === '/') {
      i = body.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (char === '/' && next === '*') {
      i = body.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < body.length; i += 1) {
        if (body[i] === '\\') i += 1;
        else if (body[i] === char) break;
      }
      previous = char;
      continue;
    }
    // A `/` after a value is division; after an operator, `(`, `,`, `=` or the
    // start of a statement it opens a regex literal.
    if (char === '/' && !/[\w)\]]$/.test(previous)) {
      for (i += 1; i < body.length; i += 1) {
        if (body[i] === '\\') i += 1;
        else if (body[i] === '\n') break;
        else if (body[i] === '/') break;
        else if (body[i] === '[') {
          while (i < body.length && body[i] !== ']') {
            if (body[i] === '\\') i += 1;
            i += 1;
          }
        }
      }
      previous = '/';
      continue;
    }
    if (char === '{') {
      depth += 1;
      started = true;
    } else if (char === '}') {
      depth -= 1;
      if (started && depth === 0) return { snippet: body.slice(start, i + 1), start, end: i + 1 };
    }
    if (!/\s/.test(char)) previous = char;
  }
  throw new Error(`${name}() body must be brace-balanced`);
}

// The markdown section, because the expanded body renders through renderRich.
const markdownStart = source.indexOf('function softJoin');
assert.ok(markdownStart !== -1, 'the markdown section must exist');
const markdownLift = liftFunction('renderRich', source.slice(markdownStart));
const markdown = source.slice(markdownStart, markdownStart + markdownLift.end);

// The reasoning section: the glyphs, the summary helpers and the row itself.
const thinkStart = source.indexOf('function ThinkIcon');
assert.ok(thinkStart !== -1, 'the reasoning section must exist');
const thinkLift = liftFunction('ThinkRow', source.slice(thinkStart));
const think = source.slice(thinkStart, thinkStart + thinkLift.end);

let keyCounter = 0;
const h = (type, props, ...children) => {
  const flat = [];
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    flat.push(child);
  }
  return { type, props: props || {}, children: flat, key: (props && props.key) || `k${keyCounter++}` };
};
const i18n = (key) => key;
const strip = new Function(`${liftFunction('stripCitations').snippet}\nreturn stripCitations;`)();

/** Build the lifted section with a chosen initial state for the row. */
function load(expanded) {
  const React = { useState: (value) => [expanded === undefined ? value : expanded, () => {}] };
  const factory = new Function(
    'h',
    'React',
    'i18n',
    'stripCitations',
    `${markdown}\n${think}\nreturn { ThinkRow, firstLine, latestCompletedParagraphFirstLine, ThinkIcon, ChevronDownIcon, ChevronUpIcon };`,
  );
  return factory(h, React, i18n, strip);
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
};

const findAll = (nodes, type) => {
  const found = [];
  const walk = (list) => {
    for (const node of list) {
      if (node === null || node === undefined || typeof node === 'string') continue;
      if (node.type === type) found.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes);
  return found;
};
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
};

// ---- the summary helpers --------------------------------------------------

{
  const { firstLine, latestCompletedParagraphFirstLine } = load();

  check('a settled chain is summarised by its first line', firstLine('第一段\n第二段') === '第一段', firstLine('第一段\n第二段'));
  check('a single-line chain summarises as itself', firstLine('只有一行') === '只有一行');

  const streaming = '开头一句。\n\n第二段已经写完。\n\n最后一段还在流式';
  check(
    'a streaming chain previews the last COMPLETED paragraph, not the half-written one',
    latestCompletedParagraphFirstLine(streaming) === '第二段已经写完。',
    latestCompletedParagraphFirstLine(streaming),
  );
  check(
    'a streaming chain with no completed paragraph yet previews nothing',
    latestCompletedParagraphFirstLine('第一段还没结束') === '',
    JSON.stringify(latestCompletedParagraphFirstLine('第一段还没结束')),
  );
  check(
    'blank lines with trailing spaces still count as a paragraph break',
    latestCompletedParagraphFirstLine('甲\n \n乙\n\n丙未完成') === '乙',
    latestCompletedParagraphFirstLine('甲\n \n乙\n\n丙未完成'),
  );
}

// ---- collapsed (the default) ---------------------------------------------

{
  const { ThinkRow } = load(false);
  const tree = ThinkRow({ text: '第一段。\n\n第二段。', running: false, t: i18n });

  check('the row is collapsed by default', tree.props['data-expanded'] === undefined, String(tree.props['data-expanded']));
  check('the collapsed row reports itself as settled', tree.props['data-state'] === 'ok', String(tree.props['data-state']));
  check('the collapsed row names the block', textOf(findAll([tree], 'span').filter((s) => s.props.className === 'dswc-think-title')) === 'think.title', 'title span');
  check(
    'the collapsed row previews the first line',
    textOf(findAll([tree], 'span').filter((s) => s.props.className === 'dswc-think-summary-text')) === '第一段。',
  );
  check('no chain text is rendered while collapsed', !textOf(tree).includes('第二段。'), textOf(tree));
  check(
    'the row is a real button for the keyboard',
    findAll([tree], 'div').some((d) => d.props.role === 'button' && d.props.tabIndex === 0 && d.props['aria-expanded'] === false),
  );
  check('the collapsed row is the height of one line, by class', findAll([tree], 'div').some((d) => d.props.className === 'dswc-think-row'));

  // A summary drawn from markdown must not print its emphasis markers.
  const bold = ThinkRow({ text: '**重点**先讲。\n后面。', running: false, t: i18n });
  check(
    'the preview drops bold markers instead of printing asterisks',
    textOf(findAll([bold], 'span').filter((s) => s.props.className === 'dswc-think-summary-text')) === '重点先讲。',
  );

  // An empty chain has nothing to preview, so the dot and the text are absent.
  const empty = ThinkRow({ text: '', running: false, t: i18n });
  check('an empty chain previews nothing at all', findAll([empty], 'span').every((s) => s.props.className !== 'dswc-think-summary'));
}

// ---- expanded -------------------------------------------------------------

{
  const { ThinkRow } = load(true);
  const tree = ThinkRow({ text: '第一段。\n\n第二段。', running: false, t: i18n });

  check('an open row says so on the element', tree.props['data-expanded'] === 'true', String(tree.props['data-expanded']));
  check('an open row drops the preview', !findAll([tree], 'span').some((s) => s.props.className === 'dswc-think-summary'));
  check('an open row renders the whole chain, not a slice', textOf(tree).includes('第二段。'), textOf(tree));
  check(
    'the opened chain is rendered as markdown, in a body of its own',
    findAll([tree], 'div').some((d) => d.props.className === 'dswc-think-body'),
  );
  check('an open row keeps the title visible', textOf(tree).includes('think.title'));
// ---- the leading glyph ----------------------------------------------------

{
  const closedModule = load(false);
  const openModule = load(true);

  // The glyphs are elements of a COMPONENT type, so a search for 'svg' would
  // never match; resolve the type instead, exactly as React would. Note the
  // comparison must use the glyphs of the SAME module instance that built the
  // row: each load() call compiles its own copy of the section.
  const glyphsOf = (node, glyphs) => {
    const out = [];
    const walk = (list) => {
      for (const child of list) {
        if (child === null || child === undefined || typeof child === 'string') continue;
        if (glyphs.includes(child.type)) out.push(child);
        if (Array.isArray(child.children)) walk(child.children);
      }
    };
    walk([node]);
    return out;
  };

  const closedGlyphs = [closedModule.ThinkIcon, closedModule.ChevronDownIcon, closedModule.ChevronUpIcon];
  const closed = glyphsOf(closedModule.ThinkRow({ text: '想完了。', running: false, t: i18n }), closedGlyphs);
  check(
    'a collapsed row shows the think glyph, plus a hover chevron',
    closed.length === 2 && closed[0].type === closedModule.ThinkIcon && closed[1].type === closedModule.ChevronDownIcon,
    closed.map((g) => g.type.name).join(','),
  );

  const openGlyphs = [openModule.ThinkIcon, openModule.ChevronDownIcon, openModule.ChevronUpIcon];
  const open = glyphsOf(openModule.ThinkRow({ text: '想完了。', running: false, t: i18n }), openGlyphs);
  check(
    'an open row swaps the pair for a single up chevron',
    open.length === 1 && open[0].type === openModule.ChevronUpIcon,
    open.map((g) => g.type.name).join(','),
  );

  // The glyphs must be real 14px line art on the current text colour, not
  // nothing at all — an empty <svg> would pass a mere presence check.
  const art = openModule.ChevronUpIcon();
  check(
    'the chevron is a 14px currentColor stroke glyph',
    art.type === 'svg' && art.props.width === 14 && art.props.height === 14 && art.children[0].props.stroke === 'currentColor',
    `${art.props.width}px ${art.children[0].props.stroke}`,
  );
  const swirl = closedModule.ThinkIcon();
  check(
    'the think glyph draws three paths, one filled dot among them',
    swirl.type === 'svg' && swirl.children.length === 3 && swirl.children.filter((p) => p.props.fill === 'currentColor').length === 1,
    `${swirl.children.length} paths`,
  );
  check(
    'the glyphs are hidden from assistive tech, since the title carries the meaning',
    art.props['aria-hidden'] === 'true' && swirl.props['aria-hidden'] === 'true',
  );
}
}

// ---- running --------------------------------------------------------------

{
  const { ThinkRow } = load(false);
  const running = ThinkRow({ text: '正在想……', running: true, t: i18n });
  const settled = ThinkRow({ text: '想完了。', running: false, t: i18n });

  check('a streaming row reports itself as running', running.props['data-state'] === 'running', String(running.props['data-state']));
  check(
    'a streaming row announces its state to a screen reader',
    findAll([running], 'span').some((s) => s.props.className === 'dswc-visually-hidden' && textOf(s) === 'think.running'),
  );
  check(
    'a settled row is not announced as running',
    !findAll([settled], 'span').some((s) => s.props.className === 'dswc-visually-hidden'),
  );
}

// ---- the stylesheet carries the geometry ----------------------------------

{
  const cssStart = source.indexOf('const CSS = `');
  const cssEnd = source.indexOf('\n`;', cssStart);
  const CSS = source.slice(cssStart + 'const CSS = `'.length, cssEnd);
  check(
    'the collapsed row is pinned to the shipped 24px line height',
    /\.dswc-think:not\(\[data-expanded\]\)\s*\{[^}]*height:\s*calc\(24px \+ var\(--dsh-content-font-delta/.test(CSS),
  );
  check(
    'the row geometry is measured against the content font delta, not a literal',
    /\.dswc-think-row\s*\{[^}]*height:\s*calc\(24px \+ var\(--dsh-content-font-delta/.test(CSS),
  );
}

const failed = results.filter((entry) => !entry.ok);
console.log(failed.length === 0 ? `\nALL PASS — reasoning row: ${results.length} assertions` : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
