/**
 * Load-time smoke test for lib/client.js.
 *
 * The suite lifts individual blocks out of the client bundle, so nothing else
 * proves that the WHOLE file still evaluates under the shell's module protocol.
 * A throw here would leave the user without a panel at all, so: run the real
 * source with the real `window.__ModuleLoader__.load` handshake and a stub
 * `react`, then assert the factory returns a cordis plugin.
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
};
const document = {
  createElement: () => ({ style: {}, dataset: {}, textContent: '', setAttribute() {}, appendChild() {}, remove() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useEffect() {},
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  /* The panel's error boundary is a class component, so materializing the
     bundle needs a Component base — nothing here ever renders it. */
  Component: class {
    constructor(props) {
      this.props = props;
    }

    setState(patch) {
      this.state = { ...(this.state || {}), ...patch };
    }
  },
  Fragment: 'Fragment',
};

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(label + (detail ? ` — ${detail}` : ''));
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
};

check('module registers itself', /window\.__ModuleLoader__\.load\(\{/.test(source));

const factory = new Function('window', 'document', 'navigator', 'require', source);
const returns = factory(window, document, window.navigator, (id) => {
  if (id === 'react') return React;
  if (id === 'react-dom') return { render() {} };
  throw new Error(`unexpected require(${id})`);
});

check('the protocol handshake ran', !!(loaded && loaded.id === 'dsh-deepseek-web-chat'), String(loaded && loaded.id));
check('the factory is callable', typeof (loaded && loaded.factory) === 'function');
check('nothing was returned at top level', returns === undefined);

const plugin = loaded.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

check('exports an apply function', typeof plugin.apply === 'function');
check('declares its service deps', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject));
check('declares layout + locale', plugin.inject.includes('layout') && plugin.inject.includes('locale'), JSON.stringify(plugin.inject));

// The factory must also survive apply() against a minimal ctx: that is where the
// surface wiring, the shortcut registration and the slot registrations run.
const registered = { slots: [], shortcuts: [], effects: [], injections: [] };
const noop = () => () => {};
const ctx = {
  slots: {
    inject: (name, fn) => { registered.injections.push(name); fn(); },
    register: (def) => { registered.slots.push(def.name + (def.key ? `#${def.key}` : '')); return noop; },
    entriesOfSlot: () => [],
  },
  locale: { bind: () => ({ t: (k) => k }) },
  layout: { selectPanel() {}, usePanelInfo: () => null },
  inject: (deps, fn) => {
    registered.injections.push(deps.join('+'));
    if (typeof fn === 'function') fn({ shortcuts: { register: (def) => { registered.shortcuts.push(def.id); return noop; } }, effect: (fn2) => { registered.effects.push(fn2); return noop; } });
    return noop;
  },
  effect: (fn) => { registered.effects.push(fn); return noop; },
  on: () => noop,
};

try {
  plugin.apply(ctx);
  check('apply() runs without throwing', true);
} catch (error) {
  check('apply() runs without throwing', false, String(error && error.stack ? error.stack.split('\n')[0] : error));
}

check('registered the sidebar panel list', registered.slots.includes('sidebar.panellist'), JSON.stringify(registered.slots));
check('registered the keyed main occupant', registered.slots.includes(`main#deepseek-web-chat`), JSON.stringify(registered.slots));
check('registered the header switch', registered.slots.includes('conversation.header.leading'), JSON.stringify(registered.slots));
check('subscribed to the shortcuts service', registered.injections.includes('shortcuts'), JSON.stringify(registered.injections));

process.stdout.write(`\nclient.js load smoke: ${failures.length ? `${failures.length} FAILING` : 'all passing'}\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
