// Proxy pool: several proxy IPs taken in turn, one per page. A login wall rests only the IP that got it;
// the worker waits only when every IP is resting. State per IP lives in `proxystate` (_id = proxy id).
import { col } from './db.js';

const FIRST_WAIT_MIN = 30;
const MAX_WAIT_MIN = 240;

/** "host:port:user:pass" → proxy, or null. The password may itself contain ":". */
export function parseProxyLine(line) {
  const [host = '', port = '', user = '', ...pass] = String(line).trim().split(':');
  const p = { host: host.trim(), port: Number(port), user: user.trim(), pass: pass.join(':').trim() };
  return /^[a-z0-9.-]+$/i.test(p.host) && p.port > 0 && p.port < 65536 ? p : null;
}

export const proxyLines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

// Two groups, each switched on/off in Settings → Proxy: the fixed "static" IPs and the "rotating" residential
// lines (paid per GB). Both are used the same way; the group only says where an IP comes from.
export const GROUPS = { static: 'Static IPs', rotating: 'Rotating residential' };

/** Every proxy of one group, whether the group is on or not. */
function groupLines(s, group) {
  if (group === 'rotating') return proxyLines(s.resiList).map(parseProxyLine).filter(Boolean).slice(0, 500);
  const list = proxyLines(s.proxyList).map(parseProxyLine).filter(Boolean);
  if (!list.length && s.proxyHost) list.push({ host: s.proxyHost, port: Number(s.proxyPort) || 44445, user: s.proxyUser || '', pass: s.proxyPass || '' });
  return list.slice(0, 500);
}
const withIds = (list, group) => list.map((p) => ({ ...p, group, id: `${p.host}:${p.port}:${p.user}` }));
const uniqueIds = (list) => [...new Map(list.map((p) => [p.id, p])).values()];

/** Every proxy in both lists, on or off — their counts are kept while a group is switched off. */
export const allProxies = (s) => uniqueIds([...withIds(groupLines(s, 'static'), 'static'), ...withIds(groupLines(s, 'rotating'), 'rotating')]);

/** The proxies to use now: the groups that are on (static: the list, else the single Host/Port/Username/Password). */
export function proxyPool(s) {
  if (!s.proxyEnabled) return [];
  const out = [];
  if (s.proxyStaticOn !== false) out.push(...withIds(groupLines(s, 'static'), 'static'));
  if (s.resiOn) out.push(...withIds(groupLines(s, 'rotating'), 'rotating'));
  return uniqueIds(out);
}

const forWorker = (p) => (p ? { enabled: true, id: p.id, host: p.host, port: p.port, user: p.user, pass: p.pass } : { enabled: false });

async function states(pool) {
  const rows = await col('proxystate').find({ _id: { $in: pool.map((p) => p.id) } }).toArray();
  return new Map(rows.map((r) => [r._id, r]));
}
const resting = (st) => st?.wallUntil && new Date(st.wallUntil) > new Date();

/**
 * The IP for the next page: not resting, used longest ago. `take` marks it as used now.
 * Returns { proxy } — or { waitUntil } when every IP is resting.
 */
export async function pickProxy(pool, { take = false } = {}) {
  if (!pool.length) return { proxy: forWorker(null) };
  const st = await states(pool);
  const free = pool.filter((p) => !resting(st.get(p.id)));
  if (!free.length) return { waitUntil: new Date(Math.min(...pool.map((p) => new Date(st.get(p.id).wallUntil).getTime()))) };
  const at = (p) => new Date(st.get(p.id)?.lastUsedAt || 0).getTime();
  const p = free.reduce((a, b) => (at(b) < at(a) ? b : a));
  if (take) await col('proxystate').updateOne({ _id: p.id }, { $set: { lastUsedAt: new Date() } }, { upsert: true });
  return { proxy: forWorker(p) };
}

/**
 * For the server reader (several pages at once): takes an IP that isn't resting and wasn't used in the last
 * `gapMs`, atomically — two lanes never get the same IP. Returns { proxy } | { busy } | { waitUntil }.
 */
export async function takeProxy(pool, gapMs) {
  if (!pool.length) return { waitUntil: null };
  const st = await states(pool);
  const now = Date.now();
  const free = pool.filter((p) => !resting(st.get(p.id)));
  if (!free.length) return { waitUntil: (await pickProxy(pool)).waitUntil };
  const at = (p) => new Date(st.get(p.id)?.lastUsedAt || 0).getTime();
  for (const p of free.filter((x) => now - at(x) >= gapMs).sort((a, b) => at(a) - at(b))) {
    const cutoff = new Date(now - gapMs);
    try {
      const ok = await col('proxystate').findOneAndUpdate(
        { _id: p.id, $and: [{ $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lte: cutoff } }] }, { $or: [{ wallUntil: { $exists: false } }, { wallUntil: { $lte: new Date() } }] }] },
        { $set: { lastUsedAt: new Date() } },
        { upsert: !st.has(p.id) },
      );
      if (ok || !st.has(p.id)) return { proxy: forWorker(p) };
    } catch (e) {
      if (e.code !== 11000) throw e; // another lane created it at the same moment
    }
  }
  return { busy: true };
}

// ---------------- IP quality ----------------
// Some IPs are "burnt": Facebook shows them the login wall almost every time (in real use 30 of 100 IPs got
// a wall on more than half of their tries). Each IP keeps a recent wall rate (each try moves it 15% toward
// 1 = wall or 0 = page read); a bad IP rests 12 h instead of 30 min, and its walls are not held against
// the pages it was reading (docs/ENGINE.md §3).
export const BAD_RATE = 0.5;
export const BAD_MIN_TRIES = 8;
export const QUARANTINE_MIN = 12 * 60;
const STEP = 0.15;

/** The wall rate of an IP — for IPs from before it was tracked, taken from its totals. */
const wallRate = (x = {}) => (typeof x.wallRate === 'number' ? x.wallRate : (x.walls || 0) / Math.max(1, (x.walls || 0) + (x.pages || 0)));
const tries = (x = {}) => (typeof x.tries === 'number' ? x.tries : (x.walls || 0) + (x.pages || 0));
export const isBadIp = (x) => tries(x) >= BAD_MIN_TRIES && wallRate(x) >= BAD_RATE;

/**
 * A login wall on this IP: it rests 30 min, then 60, 120 … up to 4 h if it keeps happening — a bad IP rests
 * 12 h (quarantine). `wasBad`: the IP was already bad before this wall (then the wall says nothing about the page).
 */
export async function restProxy(pool, id) {
  const cur = (await col('proxystate').findOne({ _id: id })) || {};
  const wasBad = isBadIp(cur);
  const rate = wallRate(cur) * (1 - STEP) + STEP;
  const nowBad = tries(cur) + 1 >= BAD_MIN_TRIES && rate >= BAD_RATE;
  const wait = nowBad ? QUARANTINE_MIN : Math.min(MAX_WAIT_MIN, cur.wallMin ? cur.wallMin * 2 : FIRST_WAIT_MIN);
  await col('proxystate').updateOne(
    { _id: id },
    {
      $set: { wallUntil: new Date(Date.now() + wait * 60e3), wallMin: nowBad ? cur.wallMin || 0 : wait, lastWallAt: new Date(), wallRate: rate, tries: tries(cur) + 1, bad: nowBad },
      $inc: { walls: 1 },
    },
    { upsert: true },
  );
  const st = await states(pool);
  const left = pool.filter((p) => !resting(st.get(p.id))).length;
  return { wait, wasBad, nowBad, left, allResting: left === 0, waitUntil: left ? null : (await pickProxy(pool)).waitUntil };
}

/**
 * The IP didn't connect (proxy down / refused): rest it a few minutes — not counted as a login wall.
 * Failing again and again without one page read in between (`netStreak`) = the IP is dead: it rests 12 h
 * instead of being tried every 10 minutes forever (3 dead IPs made 300 failed tries in 3 days).
 */
export const DEAD_AFTER = 10;
export async function restProxyBriefly(id, minutes = 10) {
  const cur = await col('proxystate').findOneAndUpdate(
    { _id: id },
    { $inc: { netErrors: 1, netStreak: 1 } },
    { upsert: true, returnDocument: 'after', projection: { netStreak: 1 } },
  );
  const dead = (cur?.netStreak || 0) >= DEAD_AFTER;
  await col('proxystate').updateOne({ _id: id }, { $set: { wallUntil: new Date(Date.now() + (dead ? QUARANTINE_MIN : minutes) * 60e3), dead } });
  return { dead };
}

/** A page read fine through this IP → its next wall starts again with the shortest rest; its wall rate drops. */
export async function proxyWorked(id) {
  const cur = (await col('proxystate').findOne({ _id: id })) || {};
  const rate = wallRate(cur) * (1 - STEP);
  await col('proxystate').updateOne(
    { _id: id },
    { $set: { wallMin: 0, wallRate: rate, tries: tries(cur) + 1, bad: tries(cur) + 1 >= BAD_MIN_TRIES && rate >= BAD_RATE, netStreak: 0, dead: false }, $inc: { pages: 1 } },
    { upsert: true },
  );
}

/**
 * Forget the IPs that are in neither list any more (called when a list is saved). Pass allProxies(s) — never
 * just the groups that are on, or switching a group off would wipe its counts.
 */
export const forgetOldProxies = (all) => col('proxystate').deleteMany({ _id: { $nin: all.map((p) => p.id) } });

/** For the Settings page (admin): every IP in use and how it's doing. Passwords are not included. */
export async function proxyStatus(s) {
  const pool = proxyPool(s);
  const st = await states(pool);
  return pool.map((p) => {
    const x = st.get(p.id) || {};
    return {
      label: `${p.host}:${p.port} · ${p.user}`,
      group: p.group,
      pages: x.pages || 0,
      walls: x.walls || 0,
      wallRate: Math.round(wallRate(x) * 100),
      bad: isBadIp(x),
      restingUntil: resting(x) ? x.wallUntil : null,
      lastUsedAt: x.lastUsedAt || null,
    };
  });
}

/**
 * Static vs Rotating side by side (Settings → Proxy): per group its switch, how many lines, and what its IPs did —
 * pages read, login walls, connection errors. "recentWallRate" = the average of each IP's recent wall rate
 * (moves with the last tries), "wallRate" = all time.
 */
export async function proxyGroups(s) {
  const all = allProxies(s);
  const st = await states(all);
  const now = new Date();
  return Object.entries(GROUPS).map(([group, label]) => {
    const list = all.filter((p) => p.group === group);
    const rows = list.map((p) => st.get(p.id) || {});
    const pages = rows.reduce((a, x) => a + (x.pages || 0), 0);
    const walls = rows.reduce((a, x) => a + (x.walls || 0), 0);
    const tried = rows.filter((x) => tries(x) > 0);
    return {
      group,
      label,
      on: Boolean(s.proxyEnabled) && (group === 'rotating' ? Boolean(s.resiOn) : s.proxyStaticOn !== false),
      lines: list.length,
      pages,
      walls,
      netErrors: rows.reduce((a, x) => a + (x.netErrors || 0), 0),
      wallRate: pages + walls ? Math.round((walls / (pages + walls)) * 1000) / 10 : null,
      recentWallRate: tried.length ? Math.round((tried.reduce((a, x) => a + wallRate(x), 0) / tried.length) * 1000) / 10 : null,
      bad: rows.filter(isBadIp).length,
      resting: rows.filter((x) => x.wallUntil && new Date(x.wallUntil) > now).length,
      lastUsedAt: rows.reduce((m, x) => (x.lastUsedAt && (!m || new Date(x.lastUsedAt) > m) ? new Date(x.lastUsedAt) : m), null),
    };
  });
}

/** How many IPs of the list are bad right now. */
export async function badIpCount(pool) {
  const st = await states(pool);
  return pool.filter((p) => isBadIp(st.get(p.id))).length;
}
