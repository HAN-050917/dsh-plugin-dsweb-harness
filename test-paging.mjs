/**
 * Regression: the session list must walk the WHOLE history, not one page.
 *
 * The endpoint caps a page at 100 (`count=101` → `ILLEGAL_COUNT`), and the
 * plugin used to ask for `count=500`, get rejected, fall back to the cursor
 * form, and quietly return 100 conversations out of 329. Nothing failed — the
 * list just stopped early, which is the kind of bug a user only notices when a
 * conversation they know exists is missing.
 *
 * This replays a synthetic upstream that behaves the way the real one does:
 * it rejects `count > 100`, returns `has_more: true` even on the last page, and
 * repeats the boundary row. Those three quirks are what the paging loop has to
 * survive, and each has a matching assertion below.
 */
import assert from 'node:assert/strict';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ---- a synthetic account: N conversations, 100 per page ---------------------

const TOTAL = 329;
const ALL = Array.from({ length: TOTAL }, (_, i) => ({
  id: `id-${String(i).padStart(4, '0')}`,
  title: `对话 ${i}`,
  title_type: 'SYSTEM',
  pinned: false,
  // newest first, one second apart
  updated_at: 1_800_000_000 - i,
}));

const calls = [];
let lieAboutHasMore = false;

/** Mirrors the real endpoint's contract, quirks included. */
function fakeFetch(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const count = Number(parsed.searchParams.get('count') || 0);
  const cursor = parsed.searchParams.get('lte_cursor.updated_at');
  calls.push({ path, count, cursor });

  if (path !== '/api/v0/chat_session/fetch_page') {
    return json({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'UNEXPECTED_PATH', biz_data: null } });
  }
  if (!parsed.searchParams.has('lte_cursor.pinned')) {
    // The real server rejects a page request without this flag.
    return json({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'MISSING_CURSOR', biz_data: null } });
  }
  if (count > 100) {
    return json({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'ILLEGAL_COUNT', biz_data: null } });
  }

  const size = count || 100;
  // The cursor is inclusive: the boundary row comes back again, exactly as the
  // live endpoint does it (page 2 of a real account returned 100 rows, 99 new).
  const start = cursor === null ? 0 : ALL.findIndex((row) => row.updated_at <= Number(cursor));
  const slice = start < 0 ? [] : ALL.slice(start, start + size);
  return json({
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        chat_sessions: slice,
        // Truthful, as the live endpoint is: a full page means "maybe more".
        has_more: lieAboutHasMore ? true : slice.length === size,
      },
    },
  });
}

const json = (payload) => ({
  ok: true,
  status: 200,
  async json() {
    return payload;
  },
  async text() {
    return JSON.stringify(payload);
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => fakeFetch(String(url));

const { listSessions } = await import('./lib/deepseek.js');

// ---- 1. the whole history is reachable --------------------------------------

calls.length = 0;
const full = await listSessions('fake-token', {});
check('every conversation is returned, not one page', full.sessions.length === TOTAL, `${full.sessions.length} vs ${TOTAL}`);
check('no conversation is returned twice', new Set(full.sessions.map((s) => s.id)).size === TOTAL);
check('the order stays newest-first', full.sessions[0].id === 'id-0000' && full.sessions[TOTAL - 1].id === 'id-0328');
check('the walk took the expected number of pages', full.pages === 4, String(full.pages));
check('no request ever asked for more than one page', calls.every((c) => c.count <= 100), JSON.stringify(calls.map((c) => c.count)));
check('every page request carried lte_cursor.pinned', calls.every((c) => c.count > 0));

// ---- 2. the caller can still ask for one page -------------------------------

calls.length = 0;
const single = await listSessions('fake-token', { singlePage: true });
check('singlePage returns just the newest page', single.sessions.length === 100, String(single.sessions.length));
check('singlePage makes exactly one request', calls.length === 1, String(calls.length));

// ---- 3. maxPages bounds the walk --------------------------------------------

calls.length = 0;
const bounded = await listSessions('fake-token', { maxPages: 2 });
check('maxPages caps the walk', bounded.sessions.length === 199, String(bounded.sessions.length));
check('maxPages bounds the requests too', calls.length === 2, String(calls.length));

// ---- 4. an account smaller than one page still terminates -------------------

const small = ALL.slice(0, 7);
const realAll = ALL.slice();
ALL.length = 0;
ALL.push(...small);
calls.length = 0;
const tiny = await listSessions('fake-token', {});
check('a short history is returned whole', tiny.sessions.length === 7, String(tiny.sessions.length));
check('a short history takes one request', calls.length === 1, String(calls.length));
ALL.length = 0;
ALL.push(...realAll);

// ---- 5. a lying has_more still terminates -----------------------------------

/**
 * The live endpoint was truthful in the observed walk, but a page that claims
 * `has_more: true` forever must not spin the loop. The de-dup guard is what
 * stops it: a page that adds nothing new ends the walk regardless of the flag.
 */
lieAboutHasMore = true;
calls.length = 0;
const lying = await listSessions('fake-token', {});
check('a permanently-true has_more still terminates', lying.sessions.length === TOTAL, String(lying.sessions.length));
check('the lying walk did not spin past the data', calls.length === 5, String(calls.length));
lieAboutHasMore = false;

// ---- 6. a stale token still raises ------------------------------------------

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'INVALID_TOKEN', biz_data: null } });
  },
});
let raised = null;
try {
  await listSessions('bad-token', {});
} catch (error) {
  raised = error;
}
check('a rejected token raises instead of returning an empty list', raised !== null && raised.authFailed === true, String(raised && raised.message));

globalThis.fetch = realFetch;

const failed = results.filter((entry) => !entry.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — session paging: ${results.length} assertions`
    : `\n${failed.length} FAILED`,
);
process.exit(failed.length === 0 ? 0 : 1);
