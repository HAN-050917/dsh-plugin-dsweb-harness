/**
 * Render smoke test for lib/client.js.
 *
 * `test-load.mjs` proves the bundle evaluates and that apply() registers the
 * right slots — but it never RENDERS anything. That left a hole big enough for
 * a real regression to walk through: `chipStatusText()` is a factory-scope
 * helper, and factory scope has no `t` (translations there go through the
 * `i18n` variable), so calling `t(...)` from it throws `ReferenceError: t is
 * not defined` the moment the panel draws an attachment chip. React then
 * unmounts the whole main panel: the sidebar still lists conversations, but the
 * conversation area is blank and every click "does nothing" — with the chip
 * still in the (module-level) store, a reload was the only way out.
 *
 * So this suite renders the real components with a stub React and the real
 * store: the panel must survive every state it can be drawn in, including
 * attachment chips.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

let loaded = null;
const window = {
  __ModuleLoader__: { load: (entry) => { loaded = entry; } },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { platform: 'Win32', userAgent: 'node' },
  innerWidth: 1600,
  innerHeight: 900,
};
const document = {
  baseURI: 'http://127.0.0.1:19387/',
  createElement: () => ({ style: {}, dataset: {}, textContent: '', setAttribute() {}, appendChild() {}, remove() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
};

/* A React good enough to CALL a component function once — plus enough of
   Component for the panel's error boundary to be instantiated. */
class StubComponent {
  constructor(props) {
    this.props = props;
  }

  setState(patch) {
    this.state = { ...(this.state || {}), ...(typeof patch === 'function' ? patch(this.state) : patch) };
  }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect() {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Component: StubComponent,
  Fragment: 'Fragment',
};

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(label + (detail ? ` — ${detail}` : ''));
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail && !ok ? ` — ${detail}` : ''}\n`);
};

/**
 * Static half of the same guard: a factory-scope function may only call `t()`
 * if it takes `t` as a parameter or destructures it locally (components get it
 * from props). Catches the whole class, not just the chip that happened to
 * break, at every render state instead of only the ones this suite drives.
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');

const strayT = (text) => {
  const lines = text.split(/\r?\n/);
  const decls = [];
  lines.forEach((line, index) => {
    const match = line.match(/^    (?:async )?function ([A-Za-z0-9_$]+)\(([^)]*)\)/);
    if (match) decls.push({ name: match[1], args: match[2], line: index + 1 });
  });
  const offenders = [];
  for (let i = 0; i < decls.length; i += 1) {
    const raw = lines.slice(decls[i].line - 1, i + 1 < decls.length ? decls[i + 1].line - 1 : lines.length).join('\n');
    const body = stripComments(raw);
    if (!/(^|[^A-Za-z0-9_$.])t\(/.test(body)) continue;
    const takesT = /\bt\b/.test(decls[i].args);
    const bindsT = /(?:const|let|var)\s+t\s*=/.test(body) || /\{[^}]*\bt\b[^}]*\}\s*=\s*[A-Za-z_$]/.test(body);
    if (!takesT && !bindsT) offenders.push(`${decls[i].name} (line ${decls[i].line})`);
  }
  return offenders;
};

const stray = strayT(source);
check('no factory-scope helper calls t() without binding it', stray.length === 0, stray.join(', '));

const factory = new Function('window', 'document', 'navigator', 'require', source);
const require_ = (id) => {
  if (id === 'react') return React;
  if (id === 'react-dom') return { render() {} };
  throw new Error(`unexpected require(${id})`);
};
factory(window, document, window.navigator, require_);
const plugin = loaded.factory(require_);

/* ---- fake host: state + one upload -------------------------------- */

const responses = {
  '/dsh-deepseek-web-chat/state': {
    protocol: 7,
    hasToken: true,
    tokenPreview: 'abcd…wxyz',
    valid: true,
    user: { name: 'tester' },
    modelTypes: [{ id: 'default', label: 'V4' }],
  },
  '/dsh-deepseek-web-chat/upload': { file: { id: 'file-1', status: 'SUCCESS', size: 10 } },
  '/dsh-deepseek-web-chat/sessions': { sessions: [{ id: 's1', title: 'hello' }] },
  '/dsh-deepseek-web-chat/messages': { messages: [] },
};
globalThis.fetch = async (url) => {
  const path = String(url).split('?')[0];
  const payload = responses[path];
  if (!payload) {
    return { ok: false, status: 404, async text() { return JSON.stringify({ error: `no fake for ${path}` }); } };
  }
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
};

/* ---- apply() and grab the real render functions -------------------- */

const rendered = new Map();
const effects = [];
const noop = () => () => {};
const ctx = {
  slots: {
    inject: (name, fn) => { fn(); return noop; },
    register: (def, render) => {
      rendered.set(def.name + (def.key ? `#${def.key}` : ''), render);
      return noop;
    },
    entriesOfSlot: () => [],
  },
  // `register` only fires inside effects, which this harness records instead of
  // running — the real value of the dictionaries is exercised by test-i18n.
  locale: { register: () => noop, bind: () => (key) => key },
  layout: { selectPanel() {}, usePanelInfo: () => null },
  inject: (deps, fn) => {
    if (typeof fn === 'function') {
      fn({ shortcuts: { register: () => noop }, effect: (fn2) => { effects.push(fn2); return noop; } });
    }
    return noop;
  },
  effect: (fn) => { effects.push(fn); return noop; },
  on: () => noop,
};

try {
  plugin.apply(ctx);
  check('apply() runs without throwing', true);
} catch (error) {
  check('apply() runs without throwing', false, String(error && error.message));
}

check('the main panel is registered', rendered.has('main#deepseek-web-chat'), [...rendered.keys()].join(', '));

if (!rendered.has('main#deepseek-web-chat')) {
  process.stdout.write(`\nrender smoke: ${failures.length} FAILING\n`);
  process.exit(1);
}

const slotProps = { usePanelInfo: () => null };
const panelElement = rendered.get('main#deepseek-web-chat')(slotProps);
/* The seat wraps ChatPanel in the error boundary; the panel's own props (t,
   actions, layout) live on the wrapped child. */
const panelChild = (Array.isArray(panelElement.children) ? panelElement.children : []).find(
  (child) => child && child.type && typeof child.type === 'function',
);
const panelProps = panelChild ? panelChild.props : panelElement.props;

/**
 * Call the component tree the way React would, and report the first throw. A
 * seat may register a component directly (the render IS the tree) or a wrapper
 * returning `h(Component, props)`; classes must be instantiated, and one level
 * of wrapping (the error boundary) must be walked through to reach the panel.
 */
const drawNode = (node, depth = 0) => {
  if (node == null || depth > 40) return { error: null };
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = drawNode(child, depth + 1);
      if (result.error) return result;
    }
    return { error: null };
  }
  if (typeof node !== 'object' || typeof node.type !== 'function') return { error: null };
  const props = { ...(node.props || {}), children: node.children };
  try {
    const isClass = node.type.prototype && typeof node.type.prototype.render === 'function';
    return drawNode(isClass ? new node.type(props).render() : node.type(props), depth + 1);
  } catch (error) {
    return { error: `${error && error.name}: ${error && error.message}` };
  }
};

const draw = (out) => drawNode(typeof out === 'function' ? out(slotProps) : out);

/* ---- state 1: loading (before the host answers) -------------------- */

const loading = draw(panelElement);
check('the panel draws its loading state', !loading.error, loading.error);

/* ---- state 2: ready, no attachments ------------------------------- */

await panelProps.actions.loadState();
const ready = draw(panelElement);
check('the panel draws a ready conversation', !ready.error, ready.error);

/* ---- state 3: a settled attachment chip (the regression) ---------- */

await panelProps.actions.uploadAttachment({ name: 'sample.docx', size: 36801, type: 'application/octet-stream' });
const withChip = draw(panelElement);
check('the panel draws a settled attachment chip', !withChip.error, withChip.error);

/* ---- state 4: a chip whose parse failed --------------------------- */

responses['/dsh-deepseek-web-chat/upload'] = { file: { id: 'file-2', status: 'FAILED', size: 10 } };
await panelProps.actions.uploadAttachment({ name: 'broken.pdf', size: 1024, type: 'application/pdf' });
const withBadChip = draw(panelElement);
check('the panel draws a rejected attachment chip', !withBadChip.error, withBadChip.error);

/* ---- the other two seats must draw too ---------------------------- */

for (const seat of ['sidebar.panellist', 'conversation.header.leading']) {
  const render = rendered.get(seat);
  if (!render) {
    check(`${seat} is registered`, false);
    continue;
  }
  const drawn = draw(render);
  check(`${seat} draws`, !drawn.error, drawn.error);
}

/* ---- state 5: a real conversation (markdown, thinking, citations) -- */

responses['/dsh-deepseek-web-chat/messages'] = {
  messages: [
    { role: 'user', content: '这份文档讲了什么？', names: ['基于匹配的平移跟踪.docx'] },
    {
      role: 'assistant',
      content: '# 摘要\n\n灰度阈值 `0.46`，共 **4** 个连通域。\n\n```js\nconst a = 1;\n```\n\n| 点位 | x |\n| --- | --- |\n| Spot 2 | 262.5005 |\n\n- 第一项\n- 第二项[reference:1]',
      thinking: '先看正文，再看表格，最后核对坐标。',
      note: '已解析',
    },
  ],
};
await panelProps.actions.openSession('s1');
const conversation = draw(panelElement);
check('the panel draws a conversation with markdown, thinking and citations', !conversation.error, conversation.error);

/* ---- state 6: no token yet (the setup card) ------------------------ */

responses['/dsh-deepseek-web-chat/state'] = { protocol: 7, hasToken: false, valid: false, modelTypes: [] };
await panelProps.actions.loadState();
const setup = draw(panelElement);
check('the panel draws the token setup card', !setup.error, setup.error);

/* ---- the error boundary must actually contain a render error ------- */

const boundary = panelElement.type;
check('the main panel is wrapped in an error boundary', typeof boundary.getDerivedStateFromError === 'function', String(boundary && boundary.name));

if (typeof boundary.getDerivedStateFromError === 'function') {
  const instance = new boundary({ children: 'panel' });
  check('the boundary passes children through while healthy', instance.render() === 'panel');

  const boom = new Error('cannot read properties of undefined');
  instance.setState(boundary.getDerivedStateFromError(boom));
  let fallback = null;
  try {
    fallback = instance.render();
  } catch (error) {
    check('the boundary renders its fallback instead of rethrowing', false, String(error && error.message));
  }
  const texts = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (node.children) node.children.forEach(walk);
  };
  walk(fallback);
  const joined = texts.join(' ');
  check('the fallback names the failure and offers a retry', /panel\.crashed/.test(joined) && /panel\.reset/.test(joined), joined.slice(0, 120));
  check('the fallback shows the underlying error text', /cannot read properties of undefined/.test(joined), joined.slice(0, 160));
}

/* ---- state 7: who owns the list ----------------------------------- */

/* Renders the tree the same way `drawNode` does, but keeps the class names and
   text so the panel's SHAPE can be asserted, not just "it did not throw". */
const surfaceOf = (out) => {
  const found = { classes: [], texts: [] };
  const walk = (node, depth = 0) => {
    if (node == null || depth > 40) return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, depth + 1));
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      found.texts.push(String(node));
      return;
    }
    if (typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') found.classes.push(node.props.className);
    const type = node.type;
    if (typeof type === 'function') {
      const props = { ...(node.props || {}), children: node.children };
      try {
        const isClass = type.prototype && typeof type.prototype.render === 'function';
        walk(isClass ? new type(props).render() : type(props), depth + 1);
      } catch {
        /* a state that cannot draw is reported by drawNode(), not here */
      }
      return;
    }
    walk(node.children, depth + 1);
  };
  walk(typeof out === 'function' ? out(slotProps) : out);
  return found;
};

// Back to a signed-in panel: the ownership question only exists once the chat
// body (not the token card) is what is being drawn.
responses['/dsh-deepseek-web-chat/state'] = {
  protocol: 7,
  hasToken: true,
  tokenPreview: 'abcd…wxyz',
  valid: true,
  user: { name: 'tester' },
  modelTypes: [{ id: 'default', label: 'V4' }],
};
await panelProps.actions.loadState();

// No sidebar row to host the 聊天 page: the panel is the only place a list can
// live, so it draws its own column.
const withoutSidebar = surfaceOf(panelElement);
check(
  'with no sidebar row the panel still draws its own list',
  withoutSidebar.classes.includes('dswc-side'),
  withoutSidebar.classes.join(' '),
);

// Hand the plugin a row that accepts the tab. `install()` runs from the effects
// `apply()` recorded, exactly like the host would run them.
const insertedTabs = [];
ctx.slots.entriesOfSlot = () => [
  {
    __dshNativeTabs: {
      getTabs: () => [{ id: 'channels' }],
      insert: (tab) => {
        insertedTabs.push(tab);
        return () => {};
      },
      subscribe: () => () => {},
    },
  },
];
for (const effect of effects) {
  try {
    effect();
  } catch {
    /* effects that need a richer host are not what this state is about */
  }
}
check('the sidebar row accepted the 聊天 tab', insertedTabs.length === 1, String(insertedTabs.length));

// Registered: the leftmost column owns the list now, so the panel must not draw
// a second copy — it points at the sidebar instead (the row may be on 任务, or
// the sidebar may be collapsed).
const withSidebar = surfaceOf(panelElement);
check(
  'a registered sidebar page removes the panel column in every tab state',
  !withSidebar.classes.includes('dswc-side'),
  withSidebar.classes.join(' '),
);
check(
  'and the panel says where the list went, with the click that shows it',
  withSidebar.classes.includes('dswc-side-hint') &&
    withSidebar.texts.includes('side.hint') &&
    withSidebar.texts.includes('side.open'),
  [...withSidebar.classes, ...withSidebar.texts].join(' ').slice(0, 160),
);
check('the tab it inserted renders the same sessions', typeof insertedTabs[0].render === 'function' && insertedTabs[0].label === 'tab.label', JSON.stringify(insertedTabs[0] && insertedTabs[0].label));

/* ---- the 聊天/工作 switch keeps the seat it has in 工作 mode -------- */

/* In 工作 mode DSH renders the switch in `conversation.header.leading`, i.e.
   hard against the LEFT edge of the title row. Parking the panel's own copy
   after `.dswc-spacer` made it jump to the right edge the moment the user
   entered 聊天 — the reported "切换按钮跑到右边去". The head is drawn before the
   body and before the composer, so the FIRST spacer in walk order is the head's:
   the switch has to come before it. */
const headClasses = withSidebar.classes;
const switchAt = headClasses.findIndex((name) => name.includes('dswc-mode-switch'));
const spacerAt = headClasses.indexOf('dswc-spacer');
check('the panel draws the mode switch', switchAt !== -1, headClasses.join(' '));
check(
  'the mode switch is drawn before the spacer, i.e. anchored left',
  switchAt !== -1 && spacerAt !== -1 && switchAt < spacerAt,
  `switchAt=${switchAt} spacerAt=${spacerAt}`,
);

process.stdout.write(`\nrender smoke: ${failures.length ? `${failures.length} FAILING` : 'all passing'}\n`);
if (failures.length) {
  for (const line of failures) process.stdout.write(`  - ${line}\n`);
  process.exit(1);
}
