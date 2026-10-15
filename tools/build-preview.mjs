/**
 * Builds a standalone page that renders the plugin's markdown output inside the
 * shipped theme, so the result can be inspected and screenshotted without the
 * Electron shell.
 *
 *   node tools/build-preview.mjs
 *
 * Writes _preview/preview.html next to the extracted theme stylesheet. The page
 * loads the real theme tokens and the plugin's own stylesheet, then renders the
 * same answers through the plugin's renderRich, and finally measures a set of
 * computed styles and prints them into the document for --dump-dom to read.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readThemeCss, readShippedCss } from './extract-theme-css.mjs';
import { liftFunction } from './lift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const source = readFileSync(join(pkg, 'lib', 'client.js'), 'utf8');

// ---- lift the renderer out of the bundle ------------------------------------

const cssStart = source.indexOf('const CSS = `');
const cssEnd = source.indexOf('\n`;', cssStart);
if (cssStart === -1 || cssEnd === -1) throw new Error('the stylesheet template must exist');
const css = source.slice(cssStart + 'const CSS = `'.length, cssEnd);

const sectionStart = source.indexOf('function softJoin');
const section = source.slice(sectionStart, sectionStart + liftFunction(source.slice(sectionStart), 'renderRich').end);
const strip = new Function(`${liftFunction(source, 'stripCitations').snippet}\nreturn stripCitations;`)();

// The reasoning row is its own section, after the markdown helpers. It is lifted
// rather than copied so the geometry measured below is the geometry shipped.
const thinkStart = source.indexOf('function ThinkIcon');
if (thinkStart === -1) throw new Error('the reasoning section must exist');
const think = source.slice(thinkStart, thinkStart + liftFunction(source.slice(thinkStart), 'ThinkRow').end);

const i18n = (key) =>
  ({
    'code.copy': '复制',
    'code.copied': '复制成功',
    'code.wrap': '自动换行',
    'code.unwrap': '取消自动换行',
    'code.label': '代码',
    'think.title': '思考',
    'think.running': '思考中',
  })[key] || key;

const React = { useState: (value) => [value, () => {}], createElement: null };
const h = (type, props, ...children) => {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
  if (typeof type === 'function') return { component: type, props: props || {}, children: flat };
  return { type, props: props || {}, children: flat };
};
const factory = new Function('h', 'React', 'i18n', 'stripCitations', `${section}\n${think}\nreturn { renderRich, renderInline, softJoin, CodeBlock, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon };`);
const { renderRich, CodeBlock, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon } = factory(h, React, i18n, strip);

// Stateless glyphs, invoked rather than copied.
const GLYPHS = new Set([ThinkIcon, ChevronDownIcon, ChevronUpIcon]);

// ---- serialize the React-ish tree to HTML -----------------------------------

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// React prop name -> HTML attribute. Getting this wrong is silent: a `className`
// attribute is not a class, so every style token silently stops applying and the
// preview looks wrong for a reason that has nothing to do with the stylesheet.
const ATTRIBUTES = {
  className: 'class',
  tabIndex: 'tabindex',
  ariaPressed: 'aria-pressed',
  ariaHidden: 'aria-hidden',
  ariaExpanded: 'aria-expanded',
  readOnly: 'readonly',
  strokeWidth: 'stroke-width',
};

function render(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (node.component) {
    // Only CodeBlock is a component, and it needs a live React to hold state; the
    // static shell below is what it renders on first paint.
    const { code, lang } = node.props;
    const label = ['js', 'javascript', 'ts', 'typescript', 'python', 'py', 'json', 'bash', 'sh', 'html', 'css', 'go', 'rust', 'sql', 'yaml', 'md'].includes(String(lang).toLowerCase())
      ? lang
      : i18n('code.label');
    if (node.component === CodeBlock) {
      return `<div class="dswc-codeblock" data-wrap="true"><div class="dswc-codeblock-banner"><div class="dswc-codeblock-head"><div class="dswc-codeblock-heading"><span class="dswc-codeblock-lang">${escapeHtml(label)}</span></div><div class="dswc-codeblock-actions"><button type="button" class="dswc-codeblock-action" aria-label="${escapeHtml(i18n('code.unwrap'))}" aria-pressed="true">${WRAP_ICON}</button><button type="button" class="dswc-codeblock-action" aria-label="${escapeHtml(i18n('code.copy'))}">${COPY_ICON}</button></div></div></div><pre class="dswc-pre"><code class="dswc-code">${escapeHtml(code)}</code></pre></div>`;
    }
    // Collapsed is the state under measurement, and useState is stubbed at its
    // initial value, so the row returns exactly that.
    if (node.component === ThinkRow) return render(node.component(node.props));
    if (GLYPHS.has(node.component)) return render(node.component(node.props));
    return `<!-- unhandled component ${escapeHtml(node.component.name || 'anonymous')} -->`;
  }
  const attributes = Object.entries(node.props)
    .filter(([name]) => name !== 'key')
    // Handlers are functions, not attributes; React would attach them as
    // listeners, and printing their source produces broken markup.
    .filter(([, value]) => typeof value !== 'function')
    .map(([name, value]) => {
      const attribute = ATTRIBUTES[name] || name;
      if (value === true) return ` ${attribute}`;
      // React renders an aria boolean as its literal string, so dropping
      // aria-expanded={false} would make the preview claim the row is open.
      if (value === false) return attribute.startsWith('aria-') ? ` ${attribute}="false"` : '';
      if (value === null || value === undefined) return '';
      // `style` arrives as an object ({textAlign:'right'}) because that is what
      // React accepts; stringifying it directly would emit "[object Object]" and
      // make every alignment measurement meaningless.
      if (attribute === 'style' && typeof value === 'object') {
        const declarations = Object.entries(value)
          .map(([property, setting]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${setting}`)
          .join(';');
        return ` style="${escapeHtml(declarations)}"`;
      }
      return ` ${attribute}="${escapeHtml(value)}"`;
    })
    .join('');
  return `<${node.type}${attributes}>${node.children.map(render).join('')}</${node.type}>`;
}

const WRAP_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor"></path><path d="M2 15H1V1H2V15Z" fill="currentColor"></path><path d="M15 15H14V1H15V15Z" fill="currentColor"></path></svg>';
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"><rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"></rect><path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor"></path></svg>';

// ---- the sample answer ------------------------------------------------------

const answer = [
  '## 今日要闻摘要',
  '',
  '下面是**重点**内容，包含 `inline code`、[链接](https://example.com) 与 ~~过时信息~~。',
  '',
  '1. 第一项',
  '2. 第二项，带一段较长的说明文字，用来观察中文在列宽内的折行效果以及行距是否与工作模式一致。',
  '   - 嵌套子项',
  '   - 另一个子项',
  '',
  '- [x] 已经完成的任务',
  '- [ ] 还没做的任务',
  '',
  '| 名称 | 数量 | 备注 | 状态 |',
  '| :--- | ---: | :---: | --- |',
  '| 甲 | 12 | 无 | 正常 |',
  '| 乙 | 3 | 略 | 待定 |',
  '',
  '> 引用一段话，说明这段文字的来源。',
  '> 第二行引用。',
  '',
  '```js',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  '---',
  '',
  '行内公式与硬换行：第一行  ',
  '第二行，以及一段很长的中文文本，用于测量容器查询下的最大宽度是否落在 680–920px 之间并且居中。',
  '',
  '```',
  '裸围栏，没有语言标签',
  '```',
  '',
  '```',
  '```',
].join('\n');

const body = renderRich(answer, 'preview').map(render).join('\n');

// A chain long enough that printing it inline would push the answer off-screen —
// which is exactly the condition the collapsed row exists for, so it is the
// condition the geometry below is measured under.
const longChain = [
  '用户想要一个完整的实验报告，但先要注意课件里的空位符号是中文全角的，直接复制会报错。',
  '',
  '先确认 Harris 的响应函数 R = det(M) - k·trace(M)²，k 取 0.06 是课件给定的值，不要改成 0.04。',
  '',
  '第二步要考虑非极大值抑制的邻域：课件用 3×3，阈值取 0.01·Rmax，这两点必须和课件一致，',
  '否则检测到的角点数量会对不上，实验报告里的结论也就站不住。',
  '',
  '最后是 CNN 那部分：手写数字识别需要用 MNIST，训练轮数与学习率要写进报告。',
].join('\n');
const reasoning = render(ThinkRow({ text: longChain, running: false, t: i18n }));

// ---- the harness page -------------------------------------------------------

// The page must carry the real token sheet inline: `file:///C:/…` hrefs are read
// as a `c:` URL scheme and silently dropped, and the extracted index-*.css holds
// component rules only — the `:root` tokens live in the theme bundle's inline CSS.
const theme = readThemeCss();
if (theme === null) {
  console.error('theme tokens not found; extract the theme bundle first');
  process.exit(1);
}
const shipped = readShippedCss();

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>dsh-deepseek-web-chat preview</title>
<style>${theme}</style>
${shipped.map((sheet) => `<style>${sheet}</style>`).join('\n')}
<style>${css}</style>
<style>
  /* The shell sets these on body at runtime; the defaults are 14px and 0px. */
  body { --dsh-content-font-size: 14px; --dsh-content-font-delta: 0px;
         --dsh-content-font-size-secondary: 13px; --dsh-content-font-delta-secondary: 0px;
         --dsh-chat-content-width: 748px; --dsh-chat-user-width: 748px;
         --dsh-conversation-column-width: 1169px; --dsh-scrollbar-width: 5px;
         margin: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
  #measure { font: 12px/16px monospace; white-space: pre; padding: 16px; }
</style>
</head>
<body>
<div class="dswc-scroll" style="height:auto;overflow:visible">
  <div class="dswc-thread">
    <div class="dswc-turn" data-role="assistant">
      <div class="dswc-answer">
        ${reasoning}
        <div class="dswc-text">${body}</div>
      </div>
    </div>
    <div class="dswc-turn" data-role="user">
      <div class="dswc-bubble"><div class="dswc-text"><p class="dswc-p">用户提问，用来检查气泡宽度与圆角。</p></div></div>
    </div>
  </div>
</div>
<pre id="measure"></pre>
<script>
  const css = (selector, property) => {
    const node = document.querySelector(selector);
    if (!node) return selector + ' MISSING';
    return getComputedStyle(node)[property];
  };
  const lines = [
    'thread max-width        ' + css('.dswc-thread', 'maxWidth'),
    'thread display          ' + css('.dswc-thread', 'display'),
    'scroll padding          ' + css('.dswc-scroll', 'padding'),
    'answer gap              ' + css('.dswc-answer', 'gap'),
    'paragraph margin        ' + css('.dswc-p', 'marginTop'),
    'h2 font                 ' + css('.dswc-h2', 'font'),
    'h2 margin               ' + css('.dswc-h2', 'margin'),
    'strong weight           ' + css('.dswc-text strong', 'fontWeight'),
    'list padding            ' + css('.dswc-md-list', 'paddingLeft'),
    'nested list margin-top  ' + css('.dswc-md-list li > .dswc-md-list', 'marginTop'),
    'inline code padding     ' + css('.dswc-inline-code', 'padding'),
    'inline code radius      ' + css('.dswc-inline-code', 'borderRadius'),
    'inline code border      ' + css('.dswc-inline-code', 'borderTopWidth'),
    'code card radius        ' + css('.dswc-codeblock', 'borderRadius'),
    'code card background    ' + css('.dswc-codeblock', 'backgroundColor'),
    'code header padding     ' + css('.dswc-codeblock-head', 'padding'),
    'code header background  ' + css('.dswc-codeblock-head', 'backgroundColor'),
    'code lang colour        ' + css('.dswc-codeblock-lang', 'color'),
    'code action size        ' + css('.dswc-codeblock-action', 'width') + ' x ' + css('.dswc-codeblock-action', 'height'),
    'code body padding       ' + css('.dswc-pre', 'padding'),
    'code body white-space   ' + css('.dswc-pre', 'whiteSpace'),
    'table wrap overflow-x   ' + css('.dswc-table-wrap', 'overflowX'),
    'table wrap data-wide    ' + document.querySelector('.dswc-table-wrap').getAttribute('data-wide'),
    'table width             ' + css('.dswc-table', 'width'),
    'th padding              ' + css('.dswc-table th', 'padding'),
    'th text-align           ' + css('.dswc-table th:nth-child(2)', 'textAlign'),
    'td min-width            ' + css('.dswc-table td', 'minWidth'),
    'col1 text-align         ' + css('.dswc-table th:nth-child(1)', 'textAlign'),
    'col3 text-align         ' + css('.dswc-table th:nth-child(3)', 'textAlign'),
    'link colour             ' + css('.dswc-link', 'color'),
    'link weight             ' + css('.dswc-link', 'fontWeight'),
    'link underline          ' + css('.dswc-link', 'textDecorationLine'),
    'quote border            ' + css('.dswc-quote', 'borderLeftWidth'),
    'hr height               ' + css('.dswc-hr', 'height'),
    'checkbox accent         ' + css('.dswc-text input[type=checkbox]', 'accentColor'),
    'task list marker        ' + css('.dswc-md-list.contains-task-list', 'listStyleType'),
    'bubble max-width        ' + css('.dswc-turn[data-role=user] .dswc-bubble', 'maxWidth'),
    'bubble radius           ' + css('.dswc-bubble', 'borderRadius'),
    'plain fence is bare pre ' + (document.querySelector('.dswc-plain-pre') ? 'yes' : 'MISSING'),
    'hard break present      ' + (document.querySelector('.dswc-p br') ? 'yes' : 'MISSING'),
    'think row height        ' + css('.dswc-think-row', 'height'),
    'think row font          ' + css('.dswc-think-row', 'fontSize'),
    'think row colour        ' + css('.dswc-think-row', 'color'),
    'think title colour      ' + css('.dswc-think-title', 'color'),
    'think title weight      ' + css('.dswc-think-title', 'fontWeight'),
    'think summary overflow  ' + css('.dswc-think-summary-text', 'textOverflow'),
    'think summary nowrap    ' + css('.dswc-think-summary-text', 'whiteSpace'),
    'think summary text      ' + JSON.stringify((document.querySelector('.dswc-think-summary-text') || {}).textContent),
    'think body present      ' + (document.querySelector('.dswc-think-body') ? 'yes' : 'no'),
    'think separator size    ' + css('.dswc-think-separator', 'width') + ' x ' + css('.dswc-think-separator', 'height'),
    'think glyph idle shown  ' + css('.dswc-think-icon-idle', 'display'),
    'think glyph hover shown ' + css('.dswc-think-chevron-hover', 'display'),
    'think row is one line   ' + (() => {
      const row = document.querySelector('.dswc-think-row');
      if (!row) return 'MISSING';
      const chain = document.querySelector('.dswc-think-body');
      return 'row ' + Math.round(row.getBoundingClientRect().height) + 'px vs answer '
        + Math.round(row.parentElement.parentElement.getBoundingClientRect().height) + 'px, body '
        + (chain ? Math.round(chain.getBoundingClientRect().height) + 'px' : 'collapsed');
    })(),
  ];
  document.getElementById('measure').textContent = lines.join('\\n');
</script>
</body></html>
`;

const outDir = join(pkg, '..', '_preview');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'preview.html');
writeFileSync(outFile, page);
console.log(`${outFile} (${page.length} bytes, ${shipped.length + 1} stylesheet(s))`);
