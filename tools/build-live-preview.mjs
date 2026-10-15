/**
 * Renders a REAL answer from the user's synced DeepSeek history through the
 * plugin's renderer, inside the shipped theme, so formatting can be judged on
 * content that actually came from the web app.
 *
 *   node tools/build-live-preview.mjs [sessionId]
 *
 * The synthetic sample in build-preview.mjs covers every construct, but it is
 * written by hand — it cannot show whether a real 26-message experiment
 * walkthrough, with its tables, nested lists and code, survives the renderer.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readThemeCss, readShippedCss } from './extract-theme-css.mjs';
import { liftFunction } from './lift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const outDir = join(pkg, '..', '_preview');
mkdirSync(outDir, { recursive: true });

const base = 'http://127.0.0.1:19387/dsh-deepseek-web-chat';

// ---- pick a session with the most messages ----------------------------------

let sessionId = process.argv[2];
if (sessionId === undefined) {
  const sessions = (await (await fetch(`${base}/sessions?count=500&refresh=1`)).json()).sessions ?? [];
  let best = { count: -1, id: null };
  for (const session of sessions) {
    const payload = await (await fetch(`${base}/messages?sessionId=${encodeURIComponent(session.id)}&refresh=1`)).json();
    const count = payload.messages?.length ?? 0;
    if (count > best.count) best = { count, id: session.id };
  }
  sessionId = best.id;
  console.log(`richest session: ${sessionId} (${best.count} messages)`);
}

const payload = await (await fetch(`${base}/messages?sessionId=${encodeURIComponent(sessionId)}&refresh=1`)).json();
const messages = payload.messages ?? [];
if (messages.length === 0) {
  console.error('no messages for that session');
  process.exit(1);
}

// ---- lift the renderer ------------------------------------------------------

const source = readFileSync(join(pkg, 'lib', 'client.js'), 'utf8');

const cssStart = source.indexOf('const CSS = `');
const cssEnd = source.indexOf('\n`;', cssStart);
const css = source.slice(cssStart + 'const CSS = `'.length, cssEnd);

const sectionStart = source.indexOf('function stripCitations(');
const lifted = liftFunction(source.slice(sectionStart), 'renderRich');
const section = source.slice(sectionStart, sectionStart + lifted.end);

// The reasoning row lives in its own section, after the markdown helpers.
const thinkStart = source.indexOf('function ThinkIcon');
if (thinkStart === -1) throw new Error('the reasoning section must exist');
const thinkLifted = liftFunction(source.slice(thinkStart), 'ThinkRow');
const think = source.slice(thinkStart, thinkStart + thinkLifted.end);

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
const helpers = section.slice(section.indexOf('function softJoin'));
const factory = new Function(
  'h',
  'React',
  'i18n',
  'stripCitations',
  `${helpers}\n${think}\nreturn { renderRich, renderInline, softJoin, CodeBlock, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon };`,
);
const h = (type, props, ...children) => {
  if (typeof type === 'function') return { component: true, type, props: props ?? {}, children };
  const flat = [];
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    flat.push(child);
  }
  return { type, props: props ?? {}, children: flat };
};
const React = {
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
};
const { renderRich, CodeBlock, ThinkRow, ThinkIcon, ChevronDownIcon, ChevronUpIcon } = factory(h, React, i18n, (text) => String(text));

// The three reasoning glyphs, invoked rather than copied.
const GLYPHS = new Set([ThinkIcon, ChevronDownIcon, ChevronUpIcon]);

// ---- serialize --------------------------------------------------------------

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ATTRIBUTES = {
  className: 'class',
  tabIndex: 'tabindex',
  ariaPressed: 'aria-pressed',
  ariaHidden: 'aria-hidden',
  ariaExpanded: 'aria-expanded',
  readOnly: 'readonly',
  strokeWidth: 'stroke-width',
};

// The code card is a component (it owns copy/wrap state), so it is not a plain
// node. Serializing it here with the markup its first paint produces keeps real
// answers — which are full of MATLAB listings — from silently losing every block.
const HIGHLIGHTED = new Set([
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'docker', 'dockerfile', 'go', 'graphql', 'html', 'http',
  'java', 'javascript', 'js', 'json', 'jsx', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'md',
  'matlab', 'nginx', 'objectivec', 'perl', 'php', 'plaintext', 'powershell', 'python', 'py', 'r',
  'ruby', 'rust', 'sass', 'scss', 'shell', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'typescript',
  'xml', 'yaml', 'yml', 'zsh',
]);
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"><rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"></rect><path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor"></path></svg>';
const WRAP_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor"></path><path d="M2 15H1V1H2V15Z" fill="currentColor"></path><path d="M15 15H14V1H15V15Z" fill="currentColor"></path></svg>';

// Traced from the shipped reasoning glyphs, same geometry as the client half.

function renderCodeBlock(props) {
  const raw = String(props.lang ?? '');
  const label = HIGHLIGHTED.has(raw.toLowerCase()) ? raw : '代码';
  return `<div class="dswc-codeblock" data-wrap="true"><div class="dswc-codeblock-banner"><div class="dswc-codeblock-head"><div class="dswc-codeblock-heading"><span class="dswc-codeblock-lang">${escapeHtml(label)}</span></div><div class="dswc-codeblock-actions"><button type="button" class="dswc-codeblock-action" aria-pressed="true">${WRAP_ICON}</button><button type="button" class="dswc-codeblock-action">${COPY_ICON}</button></div></div></div><pre class="dswc-pre"><code class="dswc-code">${escapeHtml(props.code)}</code></pre></div>`;
}

// Components are invoked, not duplicated: the row's markup lives in client.js
// only, so a preview built from a copy could disagree with what users see.
function render(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (node.component) {
    if (node.type === CodeBlock) return renderCodeBlock(node.props);
    // Collapsed is the interesting state, and useState is stubbed at its
    // initial value, so the row returns exactly that. Its glyph children come
    // back as plain <svg> nodes and fall through to the branch below.
    if (node.type === ThinkRow) return render(node.type(node.props));
    // The glyphs are stateless components returning plain <svg>, so invoking
    // them keeps their paths in client.js where the panel gets them.
    if (GLYPHS.has(node.type)) return render(node.type(node.props));
    return `<!-- unhandled component ${escapeHtml(node.type.name || 'anonymous')} -->`;
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
      if (attribute === 'style' && typeof value === 'object') {
        return ` style="${escapeHtml(Object.entries(value).map(([p, v]) => `${p}:${v}`).join(';'))}"`;
      }
      return ` ${attribute}="${escapeHtml(value)}"`;
    })
    .join('');
  return `<${node.type}${attributes}>${node.children.map(render).join('')}</${node.type}>`;
}

const turns = messages
  .map((message) => {
    const isUser = message.role === 'user';
    const body = renderRich(String(message.content ?? ''), 'live');
    const reasoning = !isUser && message.reasoning
      ? render(ThinkRow({ text: String(message.reasoning), running: false, t: i18n }))
      : '';
    const inner = `<div class="dswc-text">${body.map(render).join('')}</div>`;
    return isUser
      ? `<div class="dswc-turn" data-role="user"><div class="dswc-bubble">${inner}</div></div>`
      : `<div class="dswc-turn" data-role="assistant"><div class="dswc-answer">${reasoning}${inner}</div></div>`;
  })
  .join('\n');

const theme = readThemeCss();
const shipped = readShippedCss();

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>live history render</title>
<style>${theme}</style>
${shipped.map((sheet) => `<style>${sheet}</style>`).join('\n')}
<style>${css}</style>
<style>
  body { --dsh-content-font-size: 14px; --dsh-content-font-delta: 0px;
         --dsh-content-font-size-secondary: 13px; --dsh-content-font-delta-secondary: 0px;
         --dsh-chat-content-width: 748px; --dsh-chat-user-width: 748px;
         --dsh-conversation-column-width: 1169px; --dsh-scrollbar-width: 5px;
         margin: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
</style>
</head><body>
<div class="dswc-scroll" style="height:auto;overflow:visible"><div class="dswc-thread">${turns}</div></div>
</body></html>`;

const outFile = join(outDir, 'live.html');
writeFileSync(outFile, page);
console.log(`${outFile} (${messages.length} messages, ${page.length} bytes)`);
