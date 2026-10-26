// Server reader: reads the queued Facebook Pages on the server, several at once ("lanes"), each through its own
// proxy IP. A lane only takes an IP (proxies.js), takes a page (pageQueue.js), reads it (pageReader.js) and
// reports the outcome — every rule lives in those modules. See docs/ENGINE.md.
import { activity, col, log } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { proxyPool, takeProxy } from './proxies.js';
import { claimPage, releasePage, unknownOnPage } from './pageQueue.js';
import { recordNetError, recordResult, recordWall, serverReads } from './worker.js';
import { readPage as realReadPage } from './pageReader.js';
import { aboutUrl, mainUrl, startOfToday } from './util.js';

// A break is taken when most of the recent reads failed to load (the proxy account / internet, not single IPs).
// "Recent" grows with the lanes: with 20 lanes, 6 dead IPs in a row are normal noise, not an outage.
export const NET_ERRORS_TO_PAUSE = 6; // the smallest window
export const NET_WINDOW_MAX = 20;
export const NET_FAIL_SHARE = 0.8; // this share of the window failed to load → break
export const netWindow = (lanes) => Math.max(NET_ERRORS_TO_PAUSE, Math.min(NET_WINDOW_MAX, 2 * lanes));
export const UNKNOWN_TO_WARN = 10; // in a row: Facebook probably changed its pages

let readPage = realReadPage;
/** Tests replace the network with a fake reader. */
export const setReaderForTests = (fn) => {
  readPage = fn || realReadPage;
};

const lanes = new Set();
/** What every lane is reading right now — for the Dashboard's live board. */
const laneNow = new Map();
const streak = { recent: [], unknown: 0, warned: false }; // recent: true = failed to load, newest last
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visitsToday = () => col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } });
/** Pages read at the same time: Settings, never more than there are IPs. */
export const laneCount = (s, pool) => Math.max(1, Math.min(pool.length, Number(s.serverParallel) || 5));

/** Why the server reader shouldn't read now (null = go). */
async function stopReason(s, pool, id) {
  if (!serverReads(s, pool)) return 'off';
  if (id >= laneCount(s, pool)) return 'lane not needed';
  if (!s.running) return 'paused';
  if (s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) return 'cooldown';
  if ((await visitsToday()) >= s.dailyLimit) return 'daily limit';
  if (!(await col('pages').countDocuments({ scrapeStatus: 'pending', needsBrowser: { $ne: true } }, { limit: 1 }))) return 'queue empty';
  return null;
}

async function pause(why) {
  await updateSettings({ running: false, pausedReason: why });
  await log('error', `Paused: ${why}`);
  await activity('paused', `Paused: ${why}`);
}

export const NET_BREAK_MIN = 10;
export const NET_BREAK_STEPS = [10, 20, 30]; // 1st, 2nd, 3rd+ break within 2 hours
export const NET_BREAKS_TO_PAUSE = 3; // within 2 hours — only when the proxy refuses the login (407)
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const loginRefused = (detail) => /\b407\b|login refused/i.test(String(detail || ''));

/**
 * Most recent pages failed to load through the proxy. Usually a short outage — the internet, the proxy provider
 * or Facebook: take a break (10, then 20, then 30 min) and go on by itself — reading never stops for good
 * because of an outage. Only when the proxy keeps REFUSING THE LOGIN (407 — wrong password, plan expired,
 * 3 times within 2 hours) does it pause and wait for a person, since waiting can't fix that.
 */
async function netBreak(detail, failed, window) {
  const s = await getSettings();
  const recent = (s.netBreaks || []).filter((d) => Date.now() - new Date(d).getTime() < 2 * 3600e3);
  const why = `Pages don't load through the proxy (${detail}, ${failed} of the last ${window} pages on different IPs)`;
  if (loginRefused(detail) && recent.length + 1 >= NET_BREAKS_TO_PAUSE) {
    await pause(`${why} — ${NET_BREAKS_TO_PAUSE} times within 2 hours: check the proxy account and list in Settings, then Resume`);
    return;
  }
  const min = NET_BREAK_STEPS[Math.min(recent.length, NET_BREAK_STEPS.length - 1)];
  const until = new Date(Date.now() + min * 60e3);
  await col('settings').updateOne(
    { _id: 'main' },
    { $set: { cooldownUntil: until, cooldownReason: why, netBreaks: [...recent, new Date()] } },
    { upsert: true },
  );
  await log('warn', `${why} — ${min} min break, continues by itself at ${hhmm(until)}`);
  await activity('paused', `${why} — taking a ${min} min break, continuing by itself at ${hhmm(until)}`);
}

/** One outcome of readPage → the queue / the proxy pool. Returns 'stop' when this lane should stop. */
async function report(page, proxy, out, pool) {
  const window = netWindow(laneCount(await getSettings(), pool));
  streak.recent.push(out.kind === 'neterror');
  if (streak.recent.length > window) streak.recent.splice(0, streak.recent.length - window);
  if (out.kind === 'neterror') {
    streak.unknown = 0;
    await recordNetError(page.pageId, proxy.id, out.detail);
    const failed = streak.recent.filter(Boolean).length;
    if (streak.recent.length >= window && failed >= Math.ceil(window * NET_FAIL_SHARE)) {
      streak.recent = [];
      await netBreak(out.detail, failed, window);
      return 'stop';
    }
    return 'next';
  }
  if (out.kind === 'wall') {
    streak.unknown = 0;
    const w = await recordWall(page.pageId, proxy.id);
    return w.until ? 'stop' : 'next'; // until = every IP is resting
  }
  if (out.kind === 'unknown') {
    await unknownOnPage(page.pageId, out.detail);
    if (++streak.unknown >= UNKNOWN_TO_WARN && !streak.warned) {
      streak.warned = true;
      const msg = `Facebook changed its page format? ${UNKNOWN_TO_WARN} pages in a row were not recognised (${out.detail}). They go to Chrome; the server reader needs an update.`;
      await log('error', msg);
      await activity('failed', msg);
    }
    return 'next';
  }
  streak.unknown = 0;
  streak.warned = false;
  await recordResult(page.pageId, out.result, proxy.id); // ok | unavailable
  return 'next';
}

async function lane(id) {
  lanes.add(id);
  let page = null;
  try {
    for (;;) {
      const s = await getSettings();
      const pool = proxyPool(s);
      if (await stopReason(s, pool, id)) return;

      const pick = await takeProxy(pool, Math.max(0, Number(s.ipGapSec) || 0) * 1000);
      if (!pick.proxy) {
        if (!pick.busy) return; // every IP is resting (login walls) — the kicker restarts us later
        await sleep(1000); // every free IP was used a moment ago — wait for the first one
        continue;
      }
      page = await claimPage('server', { forChrome: false });
      if (!page) return;
      laneNow.set(id, { page: page.pageName || page.pageId, ip: pick.proxy.user || pick.proxy.host, since: Date.now() });
      const out = await readPage(mainUrl(page) || aboutUrl(page), pick.proxy);
      const next = await report(page, pick.proxy, out, pool);
      laneNow.delete(id);
      page = null;
      if (next === 'stop') return;

      const min = Math.max(0, Number(s.delayMin) || 0);
      const max = Math.max(min, Number(s.delayMax) || 0);
      await sleep((min + Math.random() * (max - min)) * 1000);
    }
  } catch (e) {
    await log('error', `Server reader: ${e.message}`);
    // whatever broke, the page we held must not stay "working"
    if (page) await releasePage(page.pageId).catch(() => {});
    await sleep(5000);
  } finally {
    lanes.delete(id);
    laneNow.delete(id);
  }
}

/** Lanes reading right now: [{ lane, page, ip, sec }]. */
export const serverReaderNow = () =>
  [...laneNow.entries()].sort((a, b) => a[0] - b[0]).map(([lane, x]) => ({ lane: lane + 1, page: x.page, ip: x.ip, sec: Math.round((Date.now() - x.since) / 1000) }));

/** Called every few seconds: starts the lanes that should run and aren't running (each stops by itself when done). */
let kicking = false;
export async function kickServerReader({ stagger = 700 } = {}) {
  if (kicking) return;
  kicking = true;
  try {
    const s = await getSettings();
    const pool = proxyPool(s);
    if (!serverReads(s, pool) || !s.running) return;
    for (let i = 0; i < laneCount(s, pool); i++) {
      if (!lanes.has(i)) {
        lane(i);
        await sleep(stagger); // don't hit Facebook with every IP in the same second
      }
    }
  } finally {
    kicking = false;
  }
}

export const serverReaderLanes = () => lanes.size;
/** Tests: wait until every lane has stopped. */
export async function lanesIdle(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (lanes.size && Date.now() < end) await sleep(50);
  return lanes.size === 0;
}
export const resetStreaksForTests = () => Object.assign(streak, { recent: [], unknown: 0, warned: false });
