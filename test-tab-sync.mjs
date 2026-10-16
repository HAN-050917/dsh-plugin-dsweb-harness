/**
 * Regression: the sidebar's tab row and the 聊天/工作 surface never drift apart.
 *
 * The row belongs to @michengai/dsh-im-connect, and it moves on its own: its
 * follow effect recomputes which tab belongs to the host's current session
 * (`followSidebarTab` → `sidebarTabForSession`) on mount and on every session
 * change, and a plain session always resolves to 任务. The reported bug is the
 * result — 聊天 mode sitting next to a 任务 row, at which point this plugin's
 * page unmounts, the panel stops drawing its own column, and the conversation
 * list vanishes from the screen entirely:
 *
 *   「目前通过最左侧聊天栏历史会话点进去之后，那一栏立马又变成了『任务』栏，
 *     要求最左侧显示类别与模式相对应。是『聊天模式』就显示聊天，是『工作模式』
 *     就显示任务。」
 *
 * The row exposes no activate(), so the plugin clicks its button — but a single
 * click loses the race against a later `setTab`, which is why the rule has two
 * halves and this suite pins both:
 *
 *  - surface → row: `reconcileSidebarTab()` re-asserts the tab whenever the two
 *    disagree, and only ever about the 任务/聊天 pair;
 *  - row → surface: a click the USER makes on 任务/聊天 runs the same `select()`
 *    the header switch uses, while a synthetic click (this plugin's own) must
 *    never be read back as user intent, or the two would fight forever.
 *
 * Everything is lifted OUT of the shipped bundle, so this fails if the shipped
 * code drifts from the rule asserted here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

function lift(name, body = source) {
  const start = body.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `client.js must define ${name}()`);
  const open = body.indexOf('{', start);
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

const liftAll = (names) => names.map((name) => lift(name)).join('\n');

// The poll period is a value, not a function, so it is lifted by its own line —
// a transcription here would let the shipped constant change unnoticed.
const tabSyncMs = Number((source.match(/const TAB_SYNC_MS = (\d+);/) || [])[1]);
assert.ok(Number.isFinite(tabSyncMs) && tabSyncMs > 0, 'client.js must declare a TAB_SYNC_MS period');

const i18n = (key) => ({ 'tab.label': '聊天' })[key] || key;

// A button shaped like the row's own: role=tab, an aria-selected attribute and
// a real click target that records what happened.
const mkButton = (text, selected, clicks) => {
  const button = {
    textContent: text,
    innerText: text,
    getAttribute: (name) => (name === 'role' ? 'tab' : name === 'aria-selected' ? (selected ? 'true' : 'false') : null),
  };
  button.click = () => {
    clicks.push(text);
    // A real DOM click moves aria-selected to the clicked tab; the reconciler
    // reads that back on its next pass, so the stub has to model it.
    for (const other of currentRow) other.__selected = other === button;
    syncSelected();
  };
  button.__selected = !!selected;
  return button;
};

let currentRow = [];
const syncSelected = () => {
  for (const button of currentRow) {
    button.getAttribute = (name) => {
      if (name === 'role') return 'tab';
      if (name === 'aria-selected') return button.__selected ? 'true' : 'false';
      return null;
    };
  }
};

/** Make a row of buttons; the first is always 任务, then 频道, then extras. */
function makeRow(clicks, { selected = '任务', channels = true, chat = true } = {}) {
  currentRow = [];
  const tasks = mkButton('任务', selected === '任务', clicks);
  currentRow.push(tasks);
  if (channels) currentRow.push(mkButton('频道', selected === '频道', clicks));
  const chatButton = chat ? mkButton('聊天', selected === '聊天', clicks) : null;
  if (chatButton) currentRow.push(chatButton);
  syncSelected();
  return {
    row: { querySelectorAll: () => currentRow.slice(), contains: (node) => currentRow.includes(node) },
    buttons: currentRow.slice(),
    tasks,
    chat: chatButton,
  };
}

/**
 * Build the row helpers against a fake document.
 *
 * `surfaceStore` is lifted with them so `desiredSurface()` reads the real
 * precedence rule (the live panel wins over this store's memory) instead of a
 * transcription of it.
 */
function build({ row = null, live = 'work', current = 'work' } = {}) {
  const calls = [];
  const selects = [];
  const documentStub = {
    querySelector: (selector) => (selector === '.ima-tabs' ? row : null),
    addEventListener: (type, handler) => calls.push(['add', type, handler]),
    removeEventListener: (type, handler) => calls.push(['remove', type, handler]),
  };
  const timers = [];
  const windowStub = {
    addEventListener: (type, handler) => calls.push(['winAdd', type, handler]),
    removeEventListener: (type, handler) => calls.push(['winRemove', type, handler]),
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: (id) => calls.push(['clearInterval', id]),
  };
  const surfaceStore = {
    current,
    liveSurface: () => live,
    select: (which) => {
      selects.push(which);
      return true;
    },
  };
  const helpers = new Function(
    'i18n',
    'surfaceStore',
    'document',
    'window',
    'TAB_SYNC_MS',
    `${liftAll([
      'sidebarTabButtons',
      'sidebarTabButton',
      'activateSidebarTab',
      'sidebarTabSurface',
      'desiredSurface',
      'reconcileSidebarTab',
      'isHostNewSessionControl',
      'installSidebarTabSync',
    ])}\nreturn { activateSidebarTab, reconcileSidebarTab, sidebarTabSurface, installSidebarTabSync, isHostNewSessionControl };`,
  )(i18n, surfaceStore, documentStub, windowStub, tabSyncMs);
  return { ...helpers, calls, selects, timers, documentStub, windowStub };
}

// ---- surface → row: the row is pulled back onto the matching tab ------------
{
  const clicks = [];
  const found = makeRow(clicks, { selected: '任务' });
  const built = build({ row: found.row, live: 'chat' });
  assert.equal(built.reconcileSidebarTab(), true, 'a 任务 row under a 聊天 surface is repaired');
  assert.deepEqual(clicks, ['聊天'], JSON.stringify(clicks));

  const clicks2 = [];
  const found2 = makeRow(clicks2, { selected: '聊天' });
  assert.equal(build({ row: found2.row, live: 'work' }).reconcileSidebarTab(), true, 'a 聊天 row under a 工作 surface is repaired');
  assert.deepEqual(clicks2, ['任务'], JSON.stringify(clicks2));

  // Agreement is the common case, and a reconciler that clicked anyway would
  // re-render the peer's whole row several times a second.
  const clicks3 = [];
  const found3 = makeRow(clicks3, { selected: '聊天' });
  assert.equal(build({ row: found3.row, live: 'chat' }).reconcileSidebarTab(), false, 'an agreeing row is left alone');
  assert.deepEqual(clicks3, [], JSON.stringify(clicks3));

  // 频道 is another plugin's page: it is the user's own choice of tab, not a
  // surface, and yanking them off it would be worse than the bug being fixed.
  const clicks4 = [];
  const found4 = makeRow(clicks4, { selected: '频道' });
  assert.equal(build({ row: found4.row, live: 'chat' }).reconcileSidebarTab(), false, 'a 频道 row is never touched');
  assert.deepEqual(clicks4, [], JSON.stringify(clicks4));

  // No row at all (collapsed rail, peer absent): a silent no-op, never a throw.
  const bare = build({ row: null, live: 'chat' });
  assert.equal(bare.reconcileSidebarTab(), false, 'no row => nothing to reconcile');
  assert.deepEqual(bare.selects, [], 'and nothing is selected');
}

// ---- row → surface: only a genuine user click means anything ---------------
{
  const clicks = [];
  const found = makeRow(clicks, { selected: '任务' });
  const built = build({ row: found.row, live: 'work' });
  built.installSidebarTabSync();

  const click = (node, isTrusted) => {
    for (const call of built.calls) {
      if (call[0] === 'add' && call[1] === 'click') call[2]({ isTrusted, target: { closest: () => node } });
    }
  };

  click(found.chat, true);
  assert.deepEqual(built.selects, ['chat'], 'a user clicking 聊天 asks for the 聊天 surface');
  click(found.tasks, true);
  assert.deepEqual(built.selects, ['chat', 'work'], 'a user clicking 任务 asks for the 工作 surface');

  // The clicks this module makes itself are synthetic. Reading them as intent
  // would make every repair look like the user asking for that surface.
  built.selects.length = 0;
  click(found.chat, false);
  click(found.tasks, undefined);
  assert.deepEqual(built.selects, [], 'a synthetic click is never user intent');

  // 频道 belongs to a peer plugin.
  click(currentRow[1], true);
  assert.deepEqual(built.selects, [], '频道 is not a surface');

  // The host's own 「新会话」 means a new task, so it means 工作 — the same
  // reading @michengai/dsh-im-connect applies before it points its row at 任务.
  const newTask = { innerText: '新会话', getAttribute: () => null };
  click(newTask, true);
  assert.deepEqual(built.selects, ['work'], 'the host new-session control enters 工作');
  assert.equal(built.isHostNewSessionControl({ innerText: '新对话', getAttribute: () => null }), false, 'this plugin\'s 新对话 is not the host control');

  // …but this plugin's OWN new-chat button must never be read as the host's,
  // and the English dictionary is why the exclusion cannot be textual: there
  // `action.new` is "New chat", which that very regex matches. Treating it as
  // the host control would bounce an English install back to 工作 on the one
  // click that is unambiguously about chatting.
  const inPlugin = (label) => ({ innerText: label, getAttribute: () => null, closest: () => ({}) });
  assert.equal(built.isHostNewSessionControl(inPlugin('New chat')), false, '"New chat" inside our own page is ours, not the host\'s');
  assert.equal(built.isHostNewSessionControl(inPlugin('新对话')), false, 'so is 新对话');
  built.selects.length = 0;
  click(inPlugin('New chat'), true);
  assert.deepEqual(built.selects, [], 'and clicking it asks for no surface at all — its own handler owns that');
  // The exclusion is scoped: a host control merely NAMED like ours still counts.
  assert.equal(
    built.isHostNewSessionControl({ innerText: 'New chat', getAttribute: () => null, closest: () => null }),
    true,
    'a host-side control outside this plugin still means 工作',
  );
}

// ---- the poll, and its teardown -------------------------------------------
{
  const clicks = [];
  const found = makeRow(clicks, { selected: '任务' });
  const built = build({ row: found.row, live: 'chat' });
  const dispose = built.installSidebarTabSync();

  const interval = built.timers.find((timer) => timer.ms === tabSyncMs);
  assert.ok(interval, `the repair runs on a slow interval (${tabSyncMs}ms)`);
  assert.equal(built.timers.length, 1, 'exactly one interval, not one per render');
  interval.fn();
  assert.deepEqual(clicks, ['聊天'], 'the poll repairs the row');

  // The peer notifies on every sidebar change; that is the fast path.
  for (const call of built.calls) {
    if (call[0] === 'winAdd' && call[1] === 'dsh-native-sidebar-change') call[2]();
  }

  dispose();
  const removed = built.calls.filter((call) => call[0] === 'remove' || call[0] === 'winRemove');
  assert.equal(removed.length, 2, 'both click and peer listeners are removed');
  assert.deepEqual(
    built.calls.filter((call) => call[0] === 'clearInterval').length,
    1,
    'and the interval is cleared, so a disabled plugin stops clicking',
  );

  // An uninstalled plugin must not keep clicking: the interval is the only
  // thing that could, and it is gone.
  const before = clicks.length;
  for (const call of built.calls) {
    if (call[0] === 'add' && call[1] === 'click') call[2]({ isTrusted: true, target: { closest: () => found.chat } });
  }
  assert.equal(clicks.length, before, 'after teardown nothing clicks the row again');
}

// ---- it never guesses a tab from its position ------------------------------
{
  const clicks = [];
  const found = makeRow(clicks);
  const built = build({ row: found.row });
  assert.equal(built.sidebarTabSurface(found.tasks, found.buttons), 'work', 'the first tab is 任务');
  assert.equal(built.sidebarTabSurface(found.chat, found.buttons), 'chat', '聊天 is found by its label');
  assert.equal(built.sidebarTabSurface(currentRow[1], found.buttons), null, '频道 maps to no surface');
  assert.equal(built.sidebarTabSurface(null, found.buttons), null, 'nothing selected maps to no surface');
  assert.equal(built.sidebarTabSurface(undefined, found.buttons), null, 'an unstyled row maps to no surface');

  // A row with no 聊天 button at all: this plugin's page was never accepted
  // (the peer's registry did not take it), so there is nothing to reconcile to
  // and the panel's own column stays the list — clicking the first tab here
  // would just be a second, wrong way to ask for 任务.
  const clicks2 = [];
  const twoTab = makeRow(clicks2, { channels: false, chat: false });
  assert.equal(build({ row: twoTab.row, live: 'chat' }).reconcileSidebarTab(), false, 'no 聊天 button => no repair attempt');
  assert.deepEqual(clicks2, [], JSON.stringify(clicks2));
}

// ---- the surface store is bound before the row is registered ----------------
// `matchSession` asks which surface this plugin is on, and the peer calls it
// while rendering the row it was just handed. Binding the store afterwards
// would answer 工作 for a 聊天 install and reproduce the bug verbatim.
{
  const apply = lift('apply');
  const boundAt = apply.indexOf('surfaceStore.bind(layout)');
  const registeredAt = apply.indexOf('mountSidebarTab(ctx, t, actions, layout)');
  assert.ok(boundAt !== -1 && registeredAt !== -1, 'apply() binds the store and mounts the tab');
  assert.ok(
    boundAt < registeredAt,
    'the surface store must be bound before the sidebar tab is registered',
  );

  // The registration literal carries matchSession; find it by slicing from the
  // `registry.insert({` that follows the label it registers.
  const insertAt = source.indexOf('registry.insert({', source.indexOf('function mountSidebarTab('));
  assert.ok(insertAt !== -1, 'the tab registration is found');
  const closeAt = source.indexOf('\n        });', insertAt);
  assert.ok(closeAt > insertAt, 'the tab registration literal is closed');
  const registration = source.slice(insertAt, closeAt);
  assert.ok(
    /matchSession:\s*\(sessionId\)\s*=>\s*desiredSurface\(\)\s*===\s*'chat'/.test(registration),
    'the tab claims the host session exactly while this plugin is in 聊天, so the peer\'s own '
      + 'follow rule cannot walk the row back to 任务 underneath it',
  );
  assert.ok(
    /!peerClaimsSession\(registry,\s*sessionId\)/.test(registration),
    'and yields to any peer tab that claims the session first (频道 owns `im:` ones, and ours '
      + 'is consulted at order 10, ahead of channels at 20)',
  );

  const sync = apply.match(/installSidebarTabSync/);
  assert.ok(sync, 'apply() installs the both-directions sync');
  assert.ok(
    /ctx\.effect\(installSidebarTabSync/.test(apply),
    'and installs it through ctx.effect so a disable removes the listeners and the interval',
  );
}

// ---- the claim never steals a session a peer tab owns -----------------------
// `sidebarTabForSession` resolves the current session to the FIRST tab (by
// order) whose matchSession agrees. Ours is order 10, 频道 is order 20, so
// without an explicit yield a 频道 session would resolve to OUR page and the
// user would be thrown off the channel they just clicked.
{
  const TAB_ID = 'deepseek-web-chat-tab';
  // `peerClaimsSession` takes the registry itself, so the lifted body is bound
  // to one here — the parameter names are injected, the rule is not copied.
  const claim = (tabId, registry, surface) =>
    new Function(
      'TAB_ID',
      'registry',
      'desiredSurface',
      `${lift('peerClaimsSession')}\nreturn (sessionId) => peerClaimsSession(registry, sessionId);`,
    )(tabId, registry, surface);

  const channels = {
    id: 'channels',
    order: 20,
    matchSession: (id) => String(id).startsWith('im:'),
  };
  const chatTab = { id: TAB_ID, order: 10, matchSession: () => true };

  const withChannels = (tabs) => ({ getTabs: () => tabs });

  // A 频道 session belongs to 频道 even though our surface is 聊天.
  const claimed = claim(TAB_ID, withChannels([chatTab, channels]), () => 'chat');
  assert.equal(
    claimed('im:room-42'),
    true,
    'a 频道 session is recognised as belonging to a peer tab',
  );
  assert.equal(
    claimed('task-abc'),
    false,
    'an ordinary session belongs to nobody else, so our tab may claim it',
  );

  // Our own entry must not count as a peer claim, or the yield would veto us
  // unconditionally and the original bug would return.
  const onlyUs = {
    getTabs: () => [{ id: TAB_ID, matchSession: () => true }],
  };
  assert.equal(
    claim(TAB_ID, onlyUs, () => 'chat')('task-abc'),
    false,
    'this plugin\'s own tab is not a peer and must never veto the claim',
  );

  // A peer without an opinion does not claim anything.
  assert.equal(
    claim(TAB_ID, withChannels([{ id: 'schedule', order: 5 }]), () => 'chat')('task-abc'),
    false,
    'a tab with no matchSession claims nothing',
  );

  // Hostile / absent registries degrade to "no claim" rather than throwing
  // while the row renders.
  assert.equal(claim(TAB_ID, null, () => 'chat')('task-abc'), false, 'no registry => no peer claim');
  assert.equal(claim(TAB_ID, {}, () => 'chat')('task-abc'), false, 'no getTabs => no peer claim');
  assert.equal(
    claim(TAB_ID, { getTabs: () => 'nope' }, () => 'chat')('task-abc'),
    false,
    'a non-array getTabs => no peer claim',
  );
  assert.equal(
    claim(TAB_ID, { getTabs: () => { throw new Error('boom'); } }, () => 'chat')('task-abc'),
    false,
    'a throwing getTabs => no peer claim',
  );
  const throwsOnMatch = {
    getTabs: () => [{ id: 'channels', matchSession: () => { throw new Error('boom'); } }],
  };
  assert.equal(
    claim(TAB_ID, throwsOnMatch, () => 'chat')('im:x'),
    false,
    'a peer whose matchSession throws does not claim the session',
  );
}

console.log('ALL PASS — sidebar tab / surface stay in step');
