/**
 * Regression: exactly one surface owns the conversation list.
 *
 * The user asked for the panel's own column to disappear once 聊天 lives in the
 * sidebar row ("有最左边那一栏了就不需要中间这一栏了"), so the rule behind it is
 * load-bearing in both directions: get it wrong and the same list is drawn
 * twice, or it disappears from the screen entirely.
 *
 * The rule is not "the page is registered" — that alone is not enough, because
 * the row belongs to another plugin and that plugin renders the OFFICIAL tree
 * instead of the tab row while the sidebar is collapsed to its 56px rail
 * (`@michengai/dsh-im-connect/lib/client.js:3546` — `if (props.wide === false)
 * return Official ? h(Official, officialProps) : null;`). Our page is unmounted
 * in that state, so a registration-time flag would hide the panel's column
 * while the sidebar showed nothing. So: registered → the sidebar owns the list
 * (in every tab state, which is what the user asked for); no page on screen and
 * no row to click → the panel draws it again (`panelList`).
 *
 * The predicate is lifted OUT of the shipped bundle, so this fails if the
 * shipped code drifts from the rule asserted here.
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

const showSessionColumn = new Function(`${lift('showSessionColumn')}\nreturn showSessionColumn;`)();
const hasFileDrag = new Function(`${lift('hasFileDrag')}\nreturn hasFileDrag;`)();
const hasDroppedDirectory = new Function(`${lift('hasDroppedDirectory')}\nreturn hasDroppedDirectory;`)();
const installFileDropGuard = new Function(
  `${lift('hasFileDrag')}\n${lift('hasDroppedDirectory')}\n${lift('installFileDropGuard')}\nreturn installFileDropGuard;`,
)();
const uploadDroppedFiles = new Function(`${lift('uploadDroppedFiles')}\nreturn uploadDroppedFiles;`)();
const dragCopy = source.includes('data-dragging=\"true\"') && source.includes('className: \'dswc-drop-overlay\'');
assert.ok(dragCopy, 'the root drag state has a visible overlay style and renderer');
assert.match(
  source,
  /\.dswc-drop-overlay\s*\{[^}]*position:\s*fixed/,
  'the drop overlay covers the viewport, not just the panel box',
);

// The sidebar page is registered: the leftmost column owns the list, whatever
// the row currently shows (聊天 page, 任务, or the official tree).
assert.equal(showSessionColumn({ tabInstalled: true }), false, 'registered page => panel column hidden');
assert.equal(
  showSessionColumn({ tabInstalled: true, tabLive: false }),
  false,
  'the list stays in the sidebar even while the row shows 任务',
);
assert.equal(
  showSessionColumn({ tabInstalled: true, tabLive: true }),
  false,
  'the page being on screen is the strongest reason to hide the panel column',
);
// …unless there is no row to click at all (collapsed rail, owner gone). The
// hint's button asks for the page, fails, and flips this flag so the panel
// draws the list — the button must never be a dead end.
assert.equal(
  showSessionColumn({ tabInstalled: true, tabLive: false, panelList: true }),
  true,
  'an unreachable row falls back to the panel list',
);
assert.equal(
  showSessionColumn({ tabInstalled: true, tabLive: true, panelList: true }),
  false,
  'and the fallback yields again the moment the page is really on screen',
);
// No host at all (no @michengai/dsh-im-connect, or its owner unwrapped): the
// panel is the only place a list could live.
assert.equal(showSessionColumn({ tabInstalled: false, tabLive: false }), true, 'no page => panel column shown');

// The rule must be driven by the registration flag: the user asked for a single
// leftmost column in every state, so "the row is on 任务 right now" must NOT
// bring a second copy of the list back into the middle.
assert.ok(
  /function showSessionColumn\(state\)\s*\{[\s\S]{0,320}?state\.tabInstalled[\s\S]{0,320}?state\.tabLive[\s\S]{0,320}?state\.panelList/.test(
    source,
  ),
  'showSessionColumn must weigh tabInstalled, the live mount and the fallback flag',
);

// The column must be routed through the predicate, not test a flag inline.
assert.ok(
  /showSessionColumn\(state\)\s*\n?\s*\?\s*h\('div',\s*\{ className: 'dswc-side'/.test(source),
  'ChatPanel must render the dswc-side column through showSessionColumn(state)',
);

// …and when the list is NOT on screen the panel must say where it went, with
// the one click that brings it back, instead of leaving the user without a list.
const hint = source.match(/state\.tabInstalled && !state\.tabLive[\s\S]{0,900}/);
assert.ok(hint, 'ChatPanel must point at the sidebar when its page is not on screen');
assert.ok(/t\('side\.hint'\)/.test(hint[0]), 'the pointer names where the list lives');
assert.ok(/activateSidebarTab\('chat'\)/.test(hint[0]), 'and offers to show it');
assert.ok(
  /store\.set\(\{ panelList: true \}\)/.test(hint[0]),
  'and falls back to the panel list when there is no row to click',
);

// The sidebar row has no API for selecting a tab, so the plugin clicks the rows
// button; the helper must bail out (not throw) when that row is absent.
const activateSidebarTab = new Function(
  'i18n',
  `${lift('activateSidebarTab')}\nreturn activateSidebarTab;`,
)((key) => ({ 'tab.label': '聊天' })[key] || key);
const savedDocument = globalThis.document;
try {
  delete globalThis.document;
  assert.equal(activateSidebarTab('chat'), false, 'no document => a silent no-op');
  globalThis.document = { querySelector: () => null };
  assert.equal(activateSidebarTab('chat'), false, 'no row => a silent no-op');
  const clicks = [];
  const row = {
    querySelectorAll: () => [
      { getAttribute: () => 'tab', textContent: '任务', click: () => clicks.push('tasks') },
      { getAttribute: () => 'tab', textContent: '聊天', click: () => clicks.push('chat') },
    ],
  };
  globalThis.document = { querySelector: () => row };
  assert.equal(activateSidebarTab('chat'), true, 'chat mode clicks the 聊天 tab');
  assert.equal(activateSidebarTab('work'), true, 'work mode clicks the first (任务) tab');
  assert.deepEqual(clicks, ['chat', 'tasks'], JSON.stringify(clicks));
} finally {
  globalThis.document = savedDocument;
}

// The page itself must publish the mount, and clear it on unmount.
const tab = lift('ChatTab');
assert.ok(/store\.set\(\{ tabLive: true \}\)/.test(tab), 'ChatTab must set tabLive on mount');
assert.ok(/return \(\) => store\.set\(\{ tabLive: false \}\)/.test(tab), 'ChatTab must clear tabLive on unmount');

const drag = { dataTransfer: { types: ['Files'] } };
assert.equal(hasFileDrag(drag), true, 'file drags are recognized');
assert.equal(hasFileDrag({ dataTransfer: { types: ['text/plain'] } }), false, 'text drags do not activate file overlay');
const uploaded = [];
uploadDroppedFiles([{ name: 'a.txt' }, { name: 'b.png' }], (file) => uploaded.push(file.name));
assert.deepEqual(uploaded, ['a.txt', 'b.png'], 'all dropped files are passed to the upload action');

// Folders carry no bytes: refusing them beats uploading an empty "file".
assert.equal(hasDroppedDirectory(undefined), false, 'a missing transfer is not a folder');
assert.equal(hasDroppedDirectory({ items: [] }), false, 'a plain transfer is not a folder');
const asEntry = (entry) => ({ items: [{ kind: 'file', webkitGetAsEntry: () => entry }] });
assert.equal(hasDroppedDirectory(asEntry({ isDirectory: false })), false, 'a dropped file is not a folder');
assert.equal(hasDroppedDirectory(asEntry(null)), false, 'an unreadable entry is not treated as a folder');
assert.equal(hasDroppedDirectory(asEntry({ isDirectory: true })), true, 'a dropped folder is refused');
assert.equal(
  hasDroppedDirectory({ items: [{ kind: 'string', webkitGetAsEntry: () => ({ isDirectory: true }) }] }),
  false,
  'non-file items are ignored',
);

const chatPanel = lift('ChatPanel');
assert.match(chatPanel, /installFileDropGuard\(\{/, 'ChatPanel installs the document-wide drop guard');
assert.match(
  chatPanel,
  /uploadDroppedFiles\(files, actions\.uploadAttachment\)/,
  'the guard hands dropped files to the upload action',
);
assert.match(chatPanel, /hasDroppedDirectory\(dataTransfer\)/, 'folders are refused with a message, not silently');
assert.ok(!/onDragEnter:/.test(chatPanel), 'the panel no longer relies on its own box for drag handling');
assert.match(chatPanel, /upload\.drop/, 'dragging shows localized drop target hint');

// --- A file released OUTSIDE the panel box must never reach the browser's
// default action: that navigation is the blank, frozen page users reported.
// It must still reach the upload action exactly once.
const railTarget = { name: 'rail' };
const added = [];
const removed = [];
const fakeDocument = {
  documentElement: { name: 'html' },
  body: { name: 'body' },
  addEventListener(type, handler, capture) {
    added.push({ type, handler, capture });
  },
  removeEventListener(type, handler, capture) {
    removed.push({ type, handler, capture });
  },
};
const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type, handler) {
    added.push({ type, handler, capture: false });
  },
  removeEventListener(type, handler) {
    removed.push({ type, handler, capture: false });
  },
};
const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
globalThis.document = fakeDocument;
globalThis.window = fakeWindow;
try {
  const active = [];
  const dropped = [];
  const dispose = installFileDropGuard({
    setActive: (value) => active.push(value),
    onFiles: (transfer) => dropped.push(transfer),
  });
  const handlerFor = (type) => added.find((entry) => entry.type === type).handler;
  const fileEvent = (target, extra = {}) =>
    Object.assign(
      {
        target,
        clientX: 100,
        clientY: 100,
        dataTransfer: { types: ['Files'], files: [{ name: 'doc.docx' }], dropEffect: '' },
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
      },
      extra,
    );

  const enter = fileEvent(railTarget);
  handlerFor('dragenter')(enter);
  assert.equal(enter.prevented, true, 'a file dragged over the rail is claimed, so the browser cannot open it');
  assert.equal(enter.stopped, true, 'the guard runs before the shell can attach the same file itself');
  assert.deepEqual(active, [true], 'the drop affordance turns on for a drag anywhere in the window');

  const over = fileEvent(railTarget);
  handlerFor('dragover')(over);
  assert.equal(over.dataTransfer.dropEffect, 'copy', 'the drag shows a copy cursor');

  const drop = fileEvent(railTarget);
  handlerFor('drop')(drop);
  assert.equal(drop.prevented, true, 'the drop is claimed outside the panel box too');
  assert.equal(dropped.length, 1, 'the dropped transfer reaches the upload action');
  assert.deepEqual(active, [true, true, false], 'the affordance clears on drop');
  assert.equal(added.filter((entry) => entry.capture).length, 4, 'all four claim points listen in the capture phase');

  const text = fileEvent(railTarget, { dataTransfer: { types: ['text/plain'], files: [], dropEffect: '' } });
  handlerFor('drop')(text);
  assert.equal(text.prevented, false, 'non-file drags keep their default behaviour');
  assert.equal(dropped.length, 1, 'a non-file drag is not uploaded');

  dispose();
  assert.equal(removed.length, added.length, 'leaving the chat surface removes every listener');
} finally {
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
}

console.log('ALL PASS — one-list ownership and file drag/drop');
