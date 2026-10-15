/**
 * Regression: DeepSeek answers must be rendered as markdown, not as preformatted
 * text with a code block here and there.
 *
 * The harness draws answers with `@deepseek-ai/dsh-client-ui-primitives`
 * (MarkdownText + CodeBlock). A plugin may not import that package, so this
 * plugin carries a hand-written renderer aimed at the same visual target; this
 * file is what keeps it honest.
 *
 * The renderer is lifted OUT of the shipped bundle — the real function bodies,
 * evaluated with a stub `h` — so no assertion here can pass against a copy of
 * the logic that has drifted from what users see.
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

// The markdown section runs from softJoin to the end of renderRich, which is
// every helper the renderer needs: softJoin, the inline pattern and its escapes,
// unescapeInline, safeHref, renderInline, the code-card icons, CodeBlock and
// renderRich itself. Anchoring on the first of those keeps the slice contiguous;
// stripCitations sits just above and is lifted separately.
const sectionStart = source.indexOf('function softJoin');
assert.ok(sectionStart !== -1, 'the markdown section must exist');
const lifted = liftFunction('renderRich', source.slice(sectionStart));
const section = source.slice(sectionStart, sectionStart + lifted.end);

// React.createElement, flattened the way a test can read it.
let keyCounter = 0;
const h = (type, props, ...children) => {
  const flat = [];
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    flat.push(child);
  };
  return { type, props: props || {}, children: flat, key: (props && props.key) || `k${keyCounter++}` };
};
const React = { useState: (value) => [value, () => {}] };
const i18n = (key) => key;

/** The lifted snippet of `stripCitations`, as a standalone function. */
const strip = new Function(`${liftFunction('stripCitations').snippet}\nreturn stripCitations;`)();
const factory = new Function(
  'h',
  'React',
  'i18n',
  'stripCitations',
  `${section}\nreturn { renderRich, renderInline, softJoin, CodeBlock, renderCode, codeTokens, codeFileName };`,
);
const { renderRich, renderInline, softJoin, CodeBlock, renderCode, codeTokens, codeFileName } = factory(h, React, i18n, strip);
assert.equal(typeof renderRich, 'function', 'the lifted section must expose renderRich');

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
};

// A component element reads as its function name, so assertions stay readable.
const tagName = (node) => (typeof node.type === 'function' ? node.type.name : node.type);
const tags = (nodes) => nodes.map((node) => (typeof node === 'string' ? '#text' : tagName(node)));
const textOf = (node) => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  // A component element holds no rendered output until it is called; its props
  // are the source of truth (CodeBlock takes `code` and `lang`).
  if (typeof node.type === 'function') return String((node.props && node.props.code) || '');
  return (node.children || []).map(textOf).join('');
};
const find = (nodes, tag) => nodes.find((node) => typeof node !== 'string' && tagName(node) === tag);
const findAll = (nodes, tag, out = []) => {
  for (const node of nodes) {
    if (typeof node === 'string' || !node) continue;
    if (tagName(node) === tag) out.push(node);
    findAll(node.children || [], tag, out);
  }
  return out;
};

// ---- block level -----------------------------------------------------------

let out = renderRich('第一段。\n\n第二段。', 'p');
check('two blank-line-separated paragraphs become two <p>', JSON.stringify(tags(out)) === '["p","p"]', JSON.stringify(tags(out)));
check('paragraph text is intact', textOf(out[0]) === '第一段。' && textOf(out[1]) === '第二段。', JSON.stringify(out.map(textOf)));

out = renderRich('# 标题一\n\n## 标题二\n\n### 标题三\n\n#### 四级\n\n##### 五级', 'h');
check(
  'headings map to h1…h5 with the dswc-h* classes',
  JSON.stringify(tags(out)) === '["h1","h2","h3","h4","h5"]' &&
    out.every((node, index) => node.props.className === `dswc-h${index + 1}`),
  JSON.stringify(out.map((node) => node.props.className)),
);

out = renderRich('- 第一项\n- 第二项\n- 第三项', 'u');
check('an unordered list becomes one <ul> of three <li>', tags(out)[0] === 'ul' && findAll(out, 'li').length === 3, JSON.stringify(tags(out)));
check('list items keep their text', findAll(out, 'li').map(textOf).join('|') === '第一项|第二项|第三项', findAll(out, 'li').map(textOf).join('|'));

out = renderRich('1. 甲\n2. 乙', 'o');
check('an ordered list becomes <ol>', tags(out)[0] === 'ol' && findAll(out, 'li').length === 2, JSON.stringify(tags(out)));

out = renderRich('- 外层\n  - 内层\n- 外层二', 'n');
const nestedLists = findAll(out, 'ul');
check('an indented item nests a second list', nestedLists.length === 2, `found ${nestedLists.length} ul`);
check('the nested list belongs to the first item', textOf(nestedLists[1]) === '内层', textOf(nestedLists[1]));

out = renderRich('正文。\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n结尾。', 'c');
check(
  'a fenced block becomes a code card between the paragraphs',
  JSON.stringify(tags(out)) === '["p","CodeBlock","p"]',
  JSON.stringify(tags(out)),
);
const card = out[1];
check('the code card carries the language', card.props.lang === 'js', String(card.props.lang));
check(
  'the code text survives verbatim',
  card.props.code === 'const a = 1;\nconst b = 2;',
  JSON.stringify(card.props.code),
);

out = renderRich('```py\nprint(1)', 'x');
check(
  'an UNCLOSED fence still renders its code (streaming truncation)',
  tags(out)[0] === 'CodeBlock' && out[0].props.code === 'print(1)',
  JSON.stringify(tags(out)),
);

out = renderRich('> 引用第一行\n> 引用第二行', 'q');
check('a blockquote becomes <blockquote> with a nested paragraph', tags(out)[0] === 'blockquote' && !!find(out[0].children, 'p'), JSON.stringify(tags(out)));

out = renderRich('---', 'r');
check('a thematic break becomes <hr>', tags(out)[0] === 'hr', JSON.stringify(tags(out)));

out = renderRich('| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |', 't');
check('a pipe table becomes a scrollable <table>', tags(out)[0] === 'div' && out[0].props.className === 'dswc-table-wrap' && !!find(out[0].children, 'table'), JSON.stringify(tags(out)));
check('the header row has two <th>', findAll(out, 'th').length === 2, String(findAll(out, 'th').length));
check('two body rows give four <td>', findAll(out, 'td').length === 4, String(findAll(out, 'td').length));
check('cell text is preserved', findAll(out, 'td').map(textOf).join('|') === 'a|1|b|2', findAll(out, 'td').map(textOf).join('|'));

// ---- inline ----------------------------------------------------------------

let inline = renderInline('这里有 `code` 和 **粗体** 以及 *斜体*。', 'i');
check(
  'inline code, strong and em are wrapped',
  JSON.stringify(inline.filter((node) => typeof node !== 'string').map((node) => node.type)) === '["code","strong","em"]',
  JSON.stringify(inline.filter((node) => typeof node !== 'string').map((node) => node.type)),
);
check('inline code carries the dswc-inline-code class', find(inline, 'code').props.className === 'dswc-inline-code');

inline = renderInline('见 [文档](https://example.com/a) 这一节', 'l');
const link = find(inline, 'a');
check('a markdown link becomes <a> with href and rel', !!link && link.props.href === 'https://example.com/a' && link.props.rel === 'noopener noreferrer', JSON.stringify(link && link.props));
check('link text is the label, not the URL', textOf(link) === '文档', textOf(link));

inline = renderInline('见 [文档](javascript:alert) 这一节', 'j');
check('a javascript: href loses its link but keeps its label', find(inline, 'a') === undefined && textOf(inline) === '见 文档 这一节', JSON.stringify(inline));

inline = renderInline('见 [文档](#section) 这一节', 'h');
const anchor = find(inline, 'a');
check('an in-page anchor stays a link and does not open a window', !!anchor && anchor.props.href === '#section' && anchor.props.target === undefined, JSON.stringify(anchor && anchor.props));

inline = renderInline('~~删掉了~~ 保留了', 'd');
check('strikethrough becomes <del>', find(inline, 'del') !== undefined && textOf(find(inline, 'del')) === '删掉了', JSON.stringify(tags(inline)));

inline = renderInline('a[0] 和 `b` 都要留下', 'm');
check('an ordinary bracket is left alone', textOf(inline[0]) === 'a[0] 和 ', JSON.stringify(textOf(inline[0])));

inline = renderInline('**粗`代`体**', 'x');
check(
  'emphasis may wrap inline code',
  JSON.stringify(inline.filter((node) => typeof node !== 'string').map((node) => node.type)) === '["strong"]' && textOf(find(inline, 'strong')) === '粗代体' && findAll(find(inline, 'strong').children, 'code').length === 1,
  JSON.stringify(tags(inline)),
);

inline = renderInline('![图](https://example.com/a.png) 之后', 'img');
check('an image becomes <img> with the alt text', !!find(inline, 'img') && find(inline, 'img').props.alt === '图', JSON.stringify(tags(inline)));

inline = renderInline('见 <https://example.com> 这里', 'au');
check('an autolink becomes a link whose text is the URL', textOf(find(inline, 'a')) === 'https://example.com', textOf(find(inline, 'a')));

inline = renderInline('\\*不是斜体\\* 但 *是*', 'esc');
check('a backslash escape protects the character', textOf(inline[0]) === '*不是斜体* 但 ' && !!find(inline, 'em'), JSON.stringify(inline));

// ---- soft wrapping ---------------------------------------------------------

// The shipped renderer returns mdast text verbatim, so a soft line break stays a
// literal newline in the text node and the browser folds it to one space. The
// join has to keep the newline for that to happen at all — collapsing it here
// would drop the space between two CJK lines, which is a silent reflow.
check('soft-wrapped lines keep their newline for the browser to fold', softJoin(['你好，', '世界。']) === '你好，\n世界。', JSON.stringify(softJoin(['你好，', '世界。'])));
check('Latin lines keep the newline too', softJoin(['hello', 'world']) === 'hello\nworld', JSON.stringify(softJoin(['hello', 'world'])));
check('a single line is unchanged', softJoin(['只有一行']) === '只有一行', softJoin(['只有一行']));

out = renderRich('这是一段会被\n软换行的中文。', 's');
check('a soft-wrapped paragraph stays one paragraph', tags(out).join() === 'p' && textOf(out[0]) === '这是一段会被\n软换行的中文。', JSON.stringify(textOf(out[0])));

out = renderRich('第一行  \n第二行', 'hb');
check('two trailing spaces are a hard break, not a soft one', tags(out).join() === 'p' && !!find(out[0].children, 'br'), JSON.stringify(tags(out[0].children)));

// ---- the real transcript ---------------------------------------------------

const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'history-sample.json'), 'utf8'));
const messages = fixture.data.biz_data.chat_messages;
const news = messages[3];
const body = String(news.fragments.find((f) => f.type === 'RESPONSE').content);
const rendered = renderRich(body, 'real');
// Markdown syntax is consumed by the renderer, so compare against a projection
// of the source that has the syntax taken out too. Anything else that vanishes
// is dropped content, which is what this assertion is here to catch.
const syntaxFree = (text) =>
  strip(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[*+-]|\d+\.)\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*\|?\s*$/gm, '')
    .replace(/\|/g, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, '');
const plain = syntaxFree(body);
const shown = textOf(rendered).replace(/\s+/g, '');
check(
  'the real news answer renders to (almost) the same characters it started with',
  shown === plain,
  `${shown.length} vs ${plain.length}${shown === plain ? '' : `\n  only in source: ${JSON.stringify(plain.slice(0, 400))}\n  only in render: ${JSON.stringify(shown.slice(0, 400))}`}`,
);
check('the real answer renders as blocks, not one blob', rendered.length >= 1 && rendered.every((node) => typeof node !== 'string'), String(rendered.length));
check('no source marker reaches the rendered text', !/\[(?:reference|citation)\s*:\s*\d+\]/.test(textOf(rendered)));
check(
  'the real answer keeps its bullet list and heading',
  tags(rendered).includes('h3') && tags(rendered).includes('ul'),
  JSON.stringify(tags(rendered)),
);

// A markdown-heavy answer: every construct at once, nothing may be lost.
const heavy = [
  '# 结论',
  '',
  '第一段有 `inline`、**强调** 和 [链接](https://a.b/c)。',
  '',
  '1. 甲',
  '2. 乙',
  '   - 嵌套',
  '',
  '> 引用',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x: number = 1;',
  '```',
  '',
  '---',
  '',
  '最后一段。',
].join('\n');
const heavyOut = renderRich(heavy, 'heavy');
check(
  'a kitchen-sink answer renders every block type',
  JSON.stringify(tags(heavyOut)) === '["h1","p","ol","blockquote","div","CodeBlock","hr","p"]',
  JSON.stringify(tags(heavyOut)),
);
check(
  'nothing in a kitchen-sink answer is dropped',
  findAll(heavyOut, 'CodeBlock').length === 1 &&
    textOf(heavyOut).includes('第一段有 inline、强调 和 链接。') &&
    textOf(heavyOut).includes('嵌套') &&
    textOf(heavyOut).includes('最后一段。'),
  JSON.stringify(textOf(heavyOut).slice(0, 200)),
);

// ---- the code card toolbar -------------------------------------------------

const block = h(CodeBlock, { code: 'x', lang: 'js' });
check('CodeBlock is a component, so React.useState is available to it', typeof block.type === 'function');
const cardTree = [block.type(block.props)];
check(
  'the code card renders the language, a wrap control, a copy control and a download control',
  cardTree[0].type === 'div' && findAll(cardTree, 'button').length === 3 && textOf(findAll(cardTree, 'span')[0]) === 'js',
  JSON.stringify(tags(cardTree)),
);
check(
  'every toolbar control is a 24px icon button with a label',
  findAll(cardTree, 'button').every((button) => button.props.className === 'dswc-codeblock-action' && typeof button.props['aria-label'] === 'string' && button.props['aria-label'].length > 0),
  JSON.stringify(findAll(cardTree, 'button').map((button) => button.props['aria-label'])),
);
check(
  'the wrap control reports its pressed state',
  findAll(cardTree, 'button').some((button) => button.props['aria-pressed'] === true),
);
const unknown = h(CodeBlock, { code: 'x', lang: 'not-a-language' });
check(
  'an unknown info string is labelled generically, not printed raw',
  textOf(findAll([unknown.type(unknown.props)], 'span')[0]) === 'code.label',
  textOf(findAll([unknown.type(unknown.props)], 'span')[0]),
);
check(
  'the code text is rendered verbatim',
  textOf(findAll(cardTree, 'code')[0]) === 'x',
  JSON.stringify(textOf(findAll(cardTree, 'code')[0])),
);

// ---- token colouring -------------------------------------------------------
// The colours themselves come from the theme's shiki custom properties, which
// test-style checks; what matters here is which stretches of source get which
// class, and that an unknown language is handed back untouched.

const jsTokens = codeTokens('const n = 1; // note\nfoo(bar);', { words: ['const'], line: ['//'], block: [], strings: ['"'], escape: true, calls: true });
const jsKinds = jsTokens.map(([kind]) => kind).join(' ');
check(
  'a JS fence is split into keyword, number, comment and call tokens',
  jsKinds.includes('kw') && jsKinds.includes('num') && jsKinds.includes('com') && jsKinds.includes('fn'),
  jsKinds,
);
check(
  'every character of the source survives the scan',
  jsTokens.map(([, text]) => text).join('') === 'const n = 1; // note\nfoo(bar);',
  JSON.stringify(jsTokens.map(([, text]) => text).join('')),
);
check(
  'a comment wins over the operators it contains',
  jsTokens.some(([kind, text]) => kind === 'com' && text === '// note'),
  JSON.stringify(jsTokens),
);
check(
  'a string stays one token, quotes included',
  codeTokens('a = "x // y"', { words: [], line: ['//'], block: [], strings: ['"'], escape: true })
    .some(([kind, text]) => kind === 'str' && text === '"x // y"'),
  JSON.stringify(codeTokens('a = "x // y"', { words: [], line: ['//'], block: [], strings: ['"'], escape: true })),
);
check(
  'a matlab line comment and the trailing keyword are both coloured',
  (() => {
    const tokens = codeTokens('% 拟合\nend', { words: ['end'], line: ['%'], block: [], strings: ["'"], escape: false });
    return tokens.some(([kind, text]) => kind === 'com' && text === '% 拟合') && tokens.some(([kind, text]) => kind === 'kw' && text === 'end');
  })(),
  JSON.stringify(codeTokens('% 拟合\nend', { words: ['end'], line: ['%'], block: [], strings: ["'"], escape: false })),
);
check(
  'an unknown language renders as the untouched string',
  renderCode('const a = 1;', 'not-a-language') === 'const a = 1;',
  JSON.stringify(renderCode('const a = 1;', 'not-a-language')),
);
check(
  'an unknown language still loads the plain rule set rather than the C one',
  renderCode('if a then end', 'not-a-language') === 'if a then end',
  JSON.stringify(renderCode('if a then end', 'not-a-language')),
);
check(
  'a python fence colours keywords, calls and comments',
  (() => {
    const nodes = renderCode('def f(x):\n    return g(x)  # note', 'python');
    const classes = nodes.filter((node) => node && node.props).map((node) => node.props.className);
    return classes.includes('dswc-tok-kw') && classes.includes('dswc-tok-fn') && classes.includes('dswc-tok-com');
  })(),
  JSON.stringify(renderCode('def f(x):\n    return g(x)  # note', 'python').filter((node) => node && node.props).map((node) => node.props.className)),
);
check(
  'a download carries a sensible file name',
  codeFileName('python') === 'snippet.py' && codeFileName('jsx') === 'snippet.jsx' && codeFileName('') === 'snippet.txt',
  [codeFileName('python'), codeFileName('jsx'), codeFileName('')].join(' / '),
);

const failed = results.filter((entry) => !entry.ok);
console.log(failed.length === 0 ? `\nALL PASS — renderRich: ${results.length} assertions` : `\n${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
