/**
 * Renders the reasoning row in its OPEN state, inside the shipped theme.
 *
 *   node tools/build-expanded-preview.mjs
 *
 * build-preview.mjs measures the collapsed row, which is what a reader sees by
 * default and therefore the geometry that matters most. The open state is the
 * other half of the same control: it has to show the whole chain in secondary
 * typography without the header drifting off the top. `useState` is stubbed to
 * start open so the row returns that state directly.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readThemeCss, readShippedCss } from './extract-theme-css.mjs';
import { liftFunction } from './lift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const source = readFileSync(join(pkg, 'lib', 'client.js'), 'utf8');

const lift = (name) => liftFunction(source, name).snippet;

const mdStart = source.indexOf('function softJoin');
const markdown = source.slice(mdStart, mdStart + liftFunction(source.slice(mdStart), 'renderRich').end);
const thinkStart = source.indexOf('function ThinkIcon');
const think = source.slice(thinkStart, thinkStart + liftFunction(source.slice(thinkStart), 'ThinkRow').end);
const strip = new Function(`${lift('stripCitations')}\nreturn stripCitations;`)();

const h = (type, props, ...children) => {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
  return typeof type === 'function'
    ? { component: type, props: props || {}, children: flat }
    : { type, props: props || {}, children: flat };
};
// Open, which is the state this preview exists to show.
const React = { useState: () => [true, () => {}] };
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

const factory = new Function(
  'h',
  'React',
  'i18n',
  'stripCitations',
  `${markdown}\n${think}\nreturn { renderRich, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon };`,
);
const { renderRich, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon } = factory(h, React, i18n, strip);
const GLYPHS = new Set([ThinkIcon, ChevronDownIcon, ChevronUpIcon]);

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ATTRIBUTES = {
  className: 'class',
  tabIndex: 'tabindex',
  ariaHidden: 'aria-hidden',
  ariaExpanded: 'aria-expanded',
  strokeWidth: 'stroke-width',
};

function render(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (node.component) {
    if (node.component === ThinkRow || GLYPHS.has(node.component)) return render(node.component(node.props));
    return `<!-- unhandled component ${escapeHtml(node.component.name || 'anonymous')} -->`;
  }
  const attributes = Object.entries(node.props)
    .filter(([name]) => name !== 'key')
    .filter(([, value]) => typeof value !== 'function')
    .map(([name, value]) => {
      const attribute = ATTRIBUTES[name] || name;
      if (value === true) return ` ${attribute}`;
      if (value === false) return attribute.startsWith('aria-') ? ` ${attribute}="false"` : '';
      if (value === null || value === undefined) return '';
      return ` ${attribute}="${escapeHtml(value)}"`;
    })
    .join('');
  return `<${node.type}${attributes}>${node.children.map(render).join('')}</${node.type}>`;
}

const chain = [
  '第一步：先确认课件里的空位符号是中文全角，直接复制会报错。',
  '',
  '第二步：响应函数 R = det(M) - k·trace(M)²，k 取 0.06，这是课件给定的值，不要改成 0.04。',
  '',
  '第三步：非极大值抑制用 3×3 邻域，阈值取 0.01·Rmax，这两点必须与课件一致。',
  '',
  '第四步：CNN 部分用 MNIST，训练轮数与学习率要写进实验报告。',
].join('\n');

const answer = ['下面给你一份可直接补全、运行的代码。', '', '```matlab', 'k = 0.06;', '```'].join('\n');

const cssStart = source.indexOf('const CSS = `');
const css = source.slice(cssStart + 'const CSS = `'.length, source.indexOf('\n`;', cssStart));
const theme = readThemeCss();
if (theme === null) {
  console.error('theme tokens not found; extract the theme bundle first');
  process.exit(1);
}

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>reasoning row, open</title>
<style>${theme}</style>
${readShippedCss().map((sheet) => `<style>${sheet}</style>`).join('\n')}
<style>${css}</style>
<style>
  body { --dsh-content-font-size: 14px; --dsh-content-font-delta: 0px;
         --dsh-content-font-size-secondary: 13px; --dsh-content-font-delta-secondary: 0px;
         --dsh-chat-content-width: 748px; --dsh-conversation-column-width: 1169px;
         margin: 0; padding: 24px;
         background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
</style>
</head><body>
<div class="dswc-thread">
  <div class="dswc-turn" data-role="assistant"><div class="dswc-answer">
    ${render(ThinkRow({ text: chain, running: false, t: i18n }))}
    <div class="dswc-text">${renderRich(answer, 'open').map(render).join('')}</div>
  </div></div>
</div>
</body></html>`;

const outDir = join(pkg, '..', '_preview');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'expanded.html');
writeFileSync(outFile, page);
console.log(`${outFile} (${page.length} bytes)`);
