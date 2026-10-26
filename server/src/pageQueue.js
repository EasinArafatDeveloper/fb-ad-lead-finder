// The page queue — the ONLY place that moves a page between states (see docs/ENGINE.md §2):
//   pending ─claim─► working ─► done | failed        release: back to pending (no fault of the page)
// Reading a page (Chrome or the server) is someone else's job; they report back through these functions.
import { activity, col, log, pageActivity } from './db.js';
import { syncLeads } from './leads.js';
import { fundedShares } from './billing.js';
import { queueVersion } from './queueSignal.js';

export const STALE_WORK_MS = 5 * 60 * 1000; // a reader that went silent this long lost its page
export const CHROME_GIVE_UP_MS = 24 * 3600e3; // a page only Chrome can read, and Chrome never did
export const MAX_SERVER_MISSES = 3; // unknown answers before Chrome gets the page
export const MAX_WALLS_POOL = 6; // login walls (each on another IP) before a page is given up
export const MAX_WALLS_SINGLE = 3; // … when there is one IP only

// ---------------- taking turns (docs/ENGINE.md §2) ----------------
// Every customer has their own line of waiting pages. A free reader serves the customer who waited longest
// for a turn, so one big search can't hold everybody else up. A paid plan reads `queueShare` pages per turn
// (default 2), the free plan 1 (billing.js fundedShares). Inside one customer's line: oldest page first.
// Weighted fair queuing: each turn moves that customer's "virtual time" on by 1/share; the lowest goes next.
// A customer coming back after a quiet spell starts at the current time — no saved-up turns.
const NO_OWNER = 'none'; // pages nobody waits for any more (still read, as one more line)
const vtime = new Map(); // line → virtual time of its next turn
let vclock = 0;
const waitingCache = new Map(); // which lines have pages, per kind of reader — refreshed every 5 s

async function waitingLines(base, kind, shares) {
  const c = waitingCache.get(kind);
  if (c && Date.now() - c.at < 5000 && c.version === queueVersion()) return c.lines;
  const version = queueVersion();
  const ids = await col('pages').distinct('wantedBy', base);
  const lines = new Set(ids.map(String).filter((k) => shares.has(k)));
  const orphan = await col('pages').findOne({ ...base, $or: [{ wantedBy: { $exists: false } }, { wantedBy: { $size: 0 } }] }, { projection: { _id: 1 } });
  if (orphan) lines.add(NO_OWNER);
  waitingCache.set(kind, { at: Date.now(), lines, version });
  return lines;
}

/** Whose turn is it? Moves that line's virtual time on (taken before the claim, so parallel readers spread). */
function nextTurn(lines, shares) {
  let best = null;
  let bestV = Infinity;
  for (const k of lines) {
    const v = Math.max(vtime.get(k) ?? vclock, vclock);
    if (v < bestV) {
      best = k;
      bestV = v;
    }
  }
  if (best === null) return null;
  vclock = bestV;
  vtime.set(best, bestV + 1 / (best === NO_OWNER ? 1 : shares.get(best)?.share || 1));
  return best;
}

/** For tests: forget the turns and the cached lines. */
export function resetTurns() {
  vtime.clear();
  vclock = 0;
  waitingCache.clear();
}

const take = async (by, filter) => {
  const p = await col('pages').findOneAndUpdate(
    filter,
    { $set: { scrapeStatus: 'working', claimedAt: new Date(), claimedBy: by } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (p) await syncLeads([p.pageId]);
  return p;
};

/**
 * Takes the next waiting page for `by` ('server' | 'chrome'): customers take turns (above). Atomic: a page is
 * only ever given to one reader. `forChrome`: true = only pages that need Chrome, false = only the others,
 * undefined = any. Only pages a customer with credits left (or an unlimited plan) waits for — the others wait
 * until that customer buys credits (billing.js: 1 page = 1 credit).
 */
export async function claimPage(by, { forChrome, wantedBy } = {}) {
  const base = { scrapeStatus: 'pending' };
  if (forChrome === true) base.needsBrowser = true;
  if (forChrome === false) base.needsBrowser = { $ne: true };
  const shares = await fundedShares();
  // a customer's own Chrome reads only the pages that customer is waiting for
  if (wantedBy) return shares.has(String(wantedBy)) ? take(by, { ...base, wantedBy }) : null;
  const kind = String(forChrome);
  const lines = new Set(await waitingLines(base, kind, shares));
  while (lines.size) {
    const k = nextTurn(lines, shares);
    if (k !== NO_OWNER && !shares.has(k)) {
      lines.delete(k);
      continue;
    }
    const own = k === NO_OWNER ? { $or: [{ wantedBy: { $exists: false } }, { wantedBy: { $size: 0 } }] } : { wantedBy: shares.get(k).id };
    const p = await take(by, { ...base, ...own });
    if (p) return p;
    // this line is empty now — skip it until the next refresh
    lines.delete(k);
    waitingCache.get(kind)?.lines.delete(k);
  }
  // nothing found: look again next time (new pages are picked up at once, not after the 5 s refresh)
  waitingCache.delete(kind);
  return null;
}

/**
 * The page goes back to the queue — it wasn't the page's fault (network, proxy, login wall on an IP …).
 * `inc` counts what happened (e.g. { loginWalls: 1 }); returns the page after the update.
 */
export async function releasePage(pageId, { inc, set } = {}) {
  const p = await col('pages').findOneAndUpdate(
    { pageId: String(pageId), scrapeStatus: 'working' },
    { $set: { scrapeStatus: 'pending', ...(set || {}) }, $unset: { claimedBy: '' }, ...(inc ? { $inc: inc } : {}) },
    { returnDocument: 'after' },
  );
  await syncLeads([String(pageId)]);
  return p;
}

/** Give up on a page: failed, with the reason shown to the user. */
export async function failPage(pageId, reason, { name } = {}) {
  await col('pages').updateOne(
    { pageId: String(pageId) },
    { $set: { scrapeStatus: 'failed', lastError: String(reason).slice(0, 300), updatedAt: new Date() }, $unset: { claimedBy: '', needsBrowser: '' } },
  );
  await syncLeads([String(pageId)], { touch: true });
  await pageActivity(String(pageId), 'failed', `${name || pageId} — ${reason}`);
}

/**
 * A login wall while reading this page: back to the queue — or given up after too many walls.
 * `count: false` = the wall came from a bad IP (it walls almost everything): not held against the page.
 */
export async function wallOnPage(pageId, { pool = 1, count = true } = {}) {
  const p = await releasePage(pageId, count ? { inc: { loginWalls: 1 } } : {});
  if (!count) return p;
  const max = pool > 1 ? MAX_WALLS_POOL : MAX_WALLS_SINGLE;
  if (p && p.loginWalls >= max) await failPage(pageId, 'Facebook only shows this page after login — skipped', { name: p.pageName });
  return p;
}

/** The server didn't recognise the answer: back to the queue; after a few times only Chrome gets it. */
export async function unknownOnPage(pageId, detail) {
  const p = await releasePage(pageId, { inc: { serverMisses: 1 } });
  if (p && p.serverMisses >= MAX_SERVER_MISSES) {
    await col('pages').updateOne({ pageId: p.pageId }, { $set: { needsBrowser: true, chromeSince: new Date() } });
    await log('warn', `${p.pageName || p.pageId}: the server can't read this page (${detail}) — Chrome will`);
  }
  return p;
}

/** Server start: pages the server was reading when it stopped go straight back (no 5-minute wait). */
export async function resetServerClaims() {
  const stuck = await col('pages').find({ scrapeStatus: 'working', claimedBy: 'server' }).project({ pageId: 1 }).toArray();
  if (!stuck.length) return 0;
  await col('pages').updateMany({ pageId: { $in: stuck.map((p) => p.pageId) } }, { $set: { scrapeStatus: 'pending' }, $unset: { claimedBy: '' } });
  await syncLeads(stuck.map((p) => p.pageId));
  return stuck.length;
}

/**
 * Self-healing, every minute (docs/ENGINE.md §4 #7, #8):
 *  - a reader that went silent (Chrome closed, a crash) → its page back to pending
 *  - a page only Chrome can read and Chrome didn't for a day → failed, with the reason
 */
export async function janitor() {
  const stale = await col('pages')
    .find({ scrapeStatus: 'working', claimedAt: { $lt: new Date(Date.now() - STALE_WORK_MS) } })
    .project({ pageId: 1 })
    .toArray();
  if (stale.length) {
    await col('pages').updateMany({ pageId: { $in: stale.map((p) => p.pageId) } }, { $set: { scrapeStatus: 'pending' }, $unset: { claimedBy: '' } });
    await syncLeads(stale.map((p) => p.pageId));
  }
  const forgotten = await col('pages')
    .find({ scrapeStatus: 'pending', needsBrowser: true, chromeSince: { $lt: new Date(Date.now() - CHROME_GIVE_UP_MS) } })
    .project({ pageId: 1, pageName: 1 })
    .toArray();
  for (const p of forgotten) await failPage(p.pageId, 'Only Chrome can read this page, and Chrome did not within a day — use Re-scrape to try again', { name: p.pageName });
  if (forgotten.length) await activity('failed', `${forgotten.length} page(s) waited a day for Chrome and were given up`);
  return { stale: stale.length, forgotten: forgotten.length };
}
