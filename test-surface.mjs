/**
 * Regression: the 聊天 / 工作 surface axis.
 *
 * Reverse-engineered from the ChatGPT/Codex desktop app, where 聊天 / 工作 is a
 * *surface* (`codexAppMode`) rather than an agent mode, and where the choice is
 * persisted independently of any conversation (`home-composer-mode-v1`), the
 * transition is idempotent, and a LOCATION is remembered per mode and restored
 * on re-entry — falling back to a FRESH conversation when that location is gone.
 *
 * ui-layout resets on reload ("Layout state resets on reload"), so the
 * persistence has to live in this bundle, and its failure modes are all silent:
 * a switch that forgets, one that re-navigates to where you already are, or a
 * restore that drops you into a stale (or wrongly fresh) chat.
 *
 * `surfaceStore` is lifted OUT of the shipped bundle and driven against a fake
 * layout and fake storage, so this fails if the shipped behaviour drifts.
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

// ---- lift helpers ------------------------------------------------------------

/**
 * The source text of `function <name>(…) { … }`, brace-balanced.
 *
 * The parameter list is skipped by matching PARENTHESES first: several of these
 * take a destructured object (`HeaderModeSwitch({ t, ... })`,
 * `syncSessions({ silent = false } = {})`), and counting braces from the first
 * `{` would stop at the end of the parameters instead of the end of the body.
 */
function lift(name, body = source) {
  const start = body.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `client.js must define ${name}()`);
  const parenOpen = body.indexOf('(', start);
  let parens = 0;
  let afterParams = -1;
  for (let i = parenOpen; i < body.length; i += 1) {
    if (body[i] === '(') parens += 1;
    else if (body[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        afterParams = i;
        break;
      }
    }
  }
  assert.ok(afterParams !== -1, `${name} parameter list must be paren-balanced`);
  const open = body.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  assert.fail(`${name} body must be brace-balanced`);
}

/** The source text of the object literal assigned by `<head>`. */
function liftLiteral(head) {
  const start = source.indexOf(head);
  assert.ok(start !== -1, `client.js must define ${head}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`${head} literal must be brace-balanced`);
}

const readSurface = new Function(`${lift('readSurface')}\nreturn readSurface;`)();
const isSameSurface = new Function(`${lift('isSameSurface')}\nreturn isSameSurface;`)();
const recallTarget = new Function(`${lift('recallTarget')}\nreturn recallTarget;`)();

// ---- the pure decisions ------------------------------------------------------

check('an unset surface falls back to 工作', readSurface(null) === 'work', readSurface(null));
check('a persisted 聊天 is honoured', readSurface('chat') === 'chat', readSurface('chat'));
check('a persisted 工作 is honoured', readSurface('work') === 'work', readSurface('work'));
// Anything else is corruption, not a surface: 工作 is the safe default.
check('garbage in the stored value falls back to 工作', readSurface('codex') === 'work', readSurface('codex'));

check('switching to the current surface is a no-op', isSameSurface('chat', 'chat', false) === true);
check('switching to the other surface is not', isSameSurface('chat', 'work', false) === false);
check('a forced switch re-runs even on the current surface', isSameSurface('chat', 'chat', true) === false);

check(
  'a remembered live session is the restore target',
  JSON.stringify(recallTarget({ chat: { sessionId: 's1' } }, 'chat', [{ id: 's1' }, { id: 's2' }])) ===
    '{"kind":"session","id":"s1"}',
);
check(
  'a remembered session that is GONE falls back to a fresh conversation',
  recallTarget({ chat: { sessionId: 'gone' } }, 'chat', [{ id: 's1' }]).kind === 'new',
);
check(
  'no memory at all means a fresh conversation',
  recallTarget({ chat: null }, 'chat', [{ id: 's1' }]).kind === 'new',
);
check('an absent location map is tolerated', recallTarget(undefined, 'chat', []).kind === 'new');

// ---- the store, driven against a fake layout --------------------------------

const PANEL_ID = 'deepseek-web-chat';
const SURFACE_KEY = 'dsh-deepseek-web-chat.surface.v1';
const LOCATION_KEY = 'dsh-deepseek-web-chat.locations.v1';
const memory = new Map();
const storageGet = (key) => (memory.has(key) ? memory.get(key) : null);
const storageSet = (key, value) => memory.set(key, value);
const makeStore = new Function(
  'readSurface',
  'isSameSurface',
  'recallTarget',
  'storageGet',
  'storageSet',
  'store',
  'openSession',
  'startNewSession',
  'PANEL_ID',
  'SURFACE_KEY',
  'LOCATION_KEY',
  'activateSidebarTab',
  'setTimeout',
  `return ${liftLiteral('const surfaceStore = {')};`,
);

const makeHarness = (initial = {}) => {
  const calls = [];
  const layout = {
    selectPanel: (panelId) => {
      calls.push(['selectPanel', panelId]);
      if (harness.failSelection) throw new Error('layout.selectPanel: main panel is not registered');
    },
  };
  const state = {
    activeId: null,
    sessions: [],
    syncedAt: null,
    ...initial,
  };
  const harness = {
    calls,
    failSelection: false,
    store: {
      get value() {
        return state;
      },
      set: (patch) => Object.assign(state, patch),
    },
    opened: [],
    fresh: 0,
    // The sidebar's tab row is pointed at 任务 / 聊天 on every surface change;
    // there is no API for it, so the plugin clicks the row's own button.
    tabs: [],
    activateSidebarTab: (which) => {
      harness.tabs.push(which);
      return true;
    },
    openSession: (id) => {
      harness.opened.push(id);
      state.activeId = id;
    },
    startNewSession: () => {
      harness.fresh += 1;
      state.activeId = null;
    },
  };
  const built = makeStore(
    readSurface,
    isSameSurface,
    recallTarget,
    storageGet,
    storageSet,
    harness.store,
    harness.openSession,
    harness.startNewSession,
    PANEL_ID,
    SURFACE_KEY,
    LOCATION_KEY,
    harness.activateSidebarTab,
    () => {},
  );
  built.bind(layout);
  harness.surface = built;
  return harness;
};

// A fresh install with nothing stored.
memory.clear();
let h = makeHarness({ syncedAt: 1700000000000 });

check('a fresh install starts on 工作', h.surface.load() === 'work', h.surface.load());

check('selecting 聊天 navigates to the panel', h.surface.select('chat') === true && h.calls.at(-1)[1] === PANEL_ID);
check('the choice is persisted', storageGet('dsh-deepseek-web-chat.surface.v1') === 'chat');

const callsAfterFirst = h.calls.length;
check('selecting 聊天 again does not re-navigate', h.surface.select('chat') === false && h.calls.length === callsAfterFirst);

check('selecting 工作 returns to the Conversation', h.surface.select('work') === true && h.calls.at(-1)[1] === null);

// Navigate first, remember second: a navigation that throws must not be
// recorded as if the surface had been reached, and a reached one is what makes
// a reload come back here.
const order = [];
const ordered = makeHarness({ syncedAt: 1700000000000 });
ordered.surface.select('chat');
order.push(memory.has('dsh-deepseek-web-chat.surface.v1') ? 'persisted' : 'missing');
check('the choice is written once the navigation has happened', order[0] === 'persisted');

// A reload: a new store instance reading the same storage.
const reloaded = makeHarness({ syncedAt: 1700000000000 });
check('a reload comes back to the surface that was chosen', reloaded.surface.load() === 'chat', reloaded.surface.load());

// The panel key is registered by a slot injection that may not have run yet.
memory.clear();
const early = makeHarness({ syncedAt: 1700000000000 });
early.failSelection = true;
let threw = false;
try {
  early.surface.select('chat');
} catch (error) {
  threw = true;
}
check('an unregistered panel key is a no-op, not an exception out of onClick', threw === false);
check(
  'a switch that never landed is not remembered as if it had',
  storageGet('dsh-deepseek-web-chat.surface.v1') === null,
  String(storageGet('dsh-deepseek-web-chat.surface.v1')),
);

// ---- the panel can move without this store asking ---------------------------
// The rail (and any other panel owner) can hand the main panel away without
// `select()` ever running. A stale `current` is exactly the bug where the
// 聊天/工作 toggle and the history rows stop responding: the guard sees
// "already there" and the switch is dropped without a trace.

const moved = makeHarness({ syncedAt: 1700000000000 });
moved.surface.load();
moved.surface.layout.panelInfo = { activePanelId: PANEL_ID };
moved.surface.select('chat');
check('the store remembers 聊天', moved.surface.current === 'chat');
moved.surface.layout.panelInfo = { activePanelId: null }; // …but the layout went back to 工作
check('the live panel is read from the layout registry', moved.surface.liveSurface() === 'work', String(moved.surface.liveSurface()));
check(
  'adopting the live panel corrects the memory',
  moved.surface.syncSurface() === 'work' && moved.surface.current === 'work',
  moved.surface.current,
);
check(
  'and the next switch is not swallowed by the guard',
  moved.surface.select('chat') === true && moved.calls.at(-1)[1] === PANEL_ID,
  JSON.stringify(moved.calls),
);
// The list moved into the sidebar's tab row, so every surface change has to
// bring that row along: 聊天 page in chat mode, 任务 in work mode. The row is
// another plugin's React state and exposes no activate(), so the plugin clicks
// its button — a stub here records which tab each change asked for.
check(
  'every surface change points the sidebar row at the matching tab',
  moved.tabs.join(',') === 'chat,work,chat',
  JSON.stringify(moved.tabs),
);

// The other direction: the layout is on 聊天 while the store still says 工作.
const ahead = makeHarness({ syncedAt: 1700000000000 });
ahead.surface.load();
ahead.surface.layout.panelInfo = { activePanelId: PANEL_ID };
check(
  'switching to the surface the layout already shows is a genuine no-op',
  ahead.surface.select('chat') === false && ahead.calls.length === 0,
  JSON.stringify(ahead.calls),
);
check(
  'a no-op switch leaves the sidebar row where the user put it',
  ahead.tabs.length === 0,
  JSON.stringify(ahead.tabs),
);
check(
  'switching away from it still works',
  ahead.surface.select('work') === true && ahead.calls.at(-1)[1] === null,
  JSON.stringify(ahead.calls),
);
check(
  'an unbound layout is no evidence at all',
  (() => {
    const bare = makeHarness({ syncedAt: 1700000000000 });
    bare.surface.bind(null);
    return bare.surface.liveSurface() === undefined;
  })(),
);

// ---- per-surface location memory --------------------------------------------

memory.clear();
h = makeHarness({ syncedAt: 1700000000000, activeId: 's9', sessions: [{ id: 's1' }] });
h.surface.remember('chat', { sessionId: 's1' });
h.surface.select('work');
h.surface.select('chat');
check('re-entering 聊天 reopens the remembered session', h.opened.at(-1) === 's1', h.opened.join(','));

// The remembered session is gone: a FRESH chat, never the stale thread.
h = makeHarness({ syncedAt: 1700000000000, activeId: 'stale', sessions: [{ id: 's1' }] });
h.surface.remember('chat', { sessionId: 'removed' });
h.surface.select('chat', { force: true });
check('a gone remembered session starts a fresh chat', h.fresh === 1 && h.opened.length === 0, `fresh=${h.fresh}`);

// Before the list exists a missing id means "unknown", not "gone" — deciding
// now would drop the user into a new chat by mistake.
h = makeHarness({ syncedAt: null, activeId: null, sessions: [] });
h.surface.remember('chat', { sessionId: 's1' });
h.surface.select('chat', { force: true });
check('the restore is deferred until the session list arrives', h.surface.pendingChatRestore === true);
check('nothing was opened or cleared on the deferred pass', h.opened.length === 0 && h.fresh === 0);
// …and it lands correctly once the list is known.
h.store.set({ sessions: [{ id: 's1' }], syncedAt: 1700000000000 });
h.surface.pendingChatRestore = false;
h.surface.restoreChatSession();
check('the deferred restore then opens the remembered session', h.opened.at(-1) === 's1', h.opened.join(','));

// Already there: no redundant refetch of a thread that is on screen.
h = makeHarness({ syncedAt: 1700000000000, activeId: 's1', sessions: [{ id: 's1' }] });
h.surface.remember('chat', { sessionId: 's1' });
h.surface.restoreChatSession();
check('restoring the session already open does not refetch it', h.opened.length === 0 && h.fresh === 0);

// ---- wiring ------------------------------------------------------------------

const openSession = lift('openSession');
check('opening a session records it as the 聊天 location', /surfaceStore\.remember\('chat',\s*\{\s*sessionId\s*\}\)/.test(openSession));

const startNewSession = lift('startNewSession');
check('an explicit new chat clears the remembered location', /surfaceStore\.remember\('chat',\s*null\)/.test(startNewSession));

const syncSessions = lift('syncSessions');
check(
  'a deferred restore is decided after the first successful sync',
  /surfaceStore\.pendingChatRestore/.test(syncSessions) && /surfaceStore\.restoreChatSession\(\)/.test(syncSessions),
);

// Every switch goes through the one owner: a raw selectPanel in a toggle path
// would bypass the guard and the persistence.
const togglePaths = source
  .split('\n')
  .filter((line) => line.includes('selectPanel') && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
const stray = togglePaths.filter((line) => !line.includes('this.layout.selectPanel'));
check(
  'only the surface owner calls layout.selectPanel',
  stray.length === 0,
  stray.map((line) => line.trim()).join(' | '),
);

const header = lift('HeaderModeSwitch');
check('the header switch goes through surfaceStore.select', /onSelect:[\s\S]{0,80}surfaceStore\.select\(/.test(header));
check(
  'the header switch reads the live surface from the panel registry',
  /active === PANEL_ID \? 'chat' : 'work'/.test(header),
);
check(
  'the header switch keeps the stored surface in step with the live one',
  /React\.useEffect\(/.test(header) && /surfaceStore\.syncSurface\(\)/.test(header),
);

const command = lift('surfaceCommand');
check('a surface command is registered for each surface', /switchToChat/.test(command) && /switchToWork/.test(command));
check('the accelerators mirror the desktop app (Alt+1 / Alt+2)', /modifiers:\s*\['alt'\]/.test(command));
check('macOS uses Control+1 / Control+2, its platform convention', /modifiers:\s*\['control'\]/.test(command));
check('the command declares the same regions as a shell-wide command', /regions:\s*\['page',\s*'editable',\s*'terminal'\]/.test(command));
check('an unbound layout reports itself blocked rather than crashing', /status:\s*'blocked'/.test(command));
check('the blocked reason is localized, never a bare literal', /i18n\('mode\.blocked'\)/.test(command));

const apply = lift('apply');
check('both surfaces register commands', /for \(const which of \['chat', 'work'\]\)/.test(apply));
// Feature-detected: a composition without the shortcuts service must still
// mount the panel and the header switch.
check('the shortcuts service is injected optionally', /ctx\.inject\(\['shortcuts'\]/.test(apply));
check('the surface is restored on boot', /surfaceStore\.restoreOnBoot\(\)/.test(apply));

const failed = results.filter((entry) => !entry.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — surface axis: ${results.length} assertions`
    : `\n${failed.length} FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
