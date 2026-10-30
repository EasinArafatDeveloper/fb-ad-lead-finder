import { col, httpError } from './db.js';
import { parseProxyLine, proxyLines, proxyPool } from './proxies.js';

// ---------------- worker settings (global — one Chrome worker, one IP; admin only) ----------------
export const DEFAULTS = {
  running: true,
  pausedReason: '',
  // Pages are read without a Facebook login. Facebook shows a login wall when one IP opens pages fast
  // (measured: 26 pages in 2 minutes), so the default pace is slow and steady.
  delayMin: 15,
  delayMax: 30,
  parallel: 1, // how many pages are read at the same time (worker tabs)
  // login wall → wait, then continue by itself (see worker.js /wall)
  cooldownUntil: null,
  cooldownMin: 0,
  cooldownReason: '', // why the worker takes a break (login wall, the proxy not answering …)
  netBreaks: [], // when the server reader took a break because pages didn't load (the last 2 h decide a real pause)
  // pages read on the server: a wall in Chrome (this PC's own IP) pauses only Chrome's reading
  browserCooldownUntil: null,
  fullDetails: false,
  dailyLimit: 150,
  maxAds: 200,
  websiteFallback: true,
  insights: true, // ad insights without AI (insights.js): hooks, offers, prices
  closeAdTab: true,
  proxyEnabled: false,
  proxyHost: '',
  proxyPort: 44445,
  proxyUser: '',
  proxyPass: '',
  // several IPs, one per line "host:port:user:pass" — taken in turn, one per page (see proxies.js)
  proxyList: '',
  // two groups of proxies, each with its own on/off switch (proxies.js proxyPool):
  //   static   = proxyList (the fixed IPs)          — on unless turned off
  //   rotating = resiList (rotating residential, sticky lines "p.webshare.io:80:user-xx-1:pass", paid per GB)
  proxyStaticOn: true,
  resiList: '',
  resiOn: false,
  // with a proxy list the server reads the pages itself (serverReader.js): this many at once, each through
  // its own IP, and one IP is used at most once every ipGapSec seconds
  serverReader: true,
  serverCollector: false,
  serverParallel: 5,
  ipGapSec: 20,
};

// "Max ads per keyword": the most one search may collect. The Ad Library itself decides how many it shows —
// the extension scrolls until this many ads, or until no new ads load.
export const MAX_ADS_LIMIT = 50000;
export const clampMaxAds = (n, fallback = 200) => Math.min(MAX_ADS_LIMIT, Math.max(10, Math.round(Number(n) || fallback)));

const NUMBER_KEYS = ['delayMin', 'delayMax', 'dailyLimit', 'maxAds', 'parallel', 'proxyPort', 'serverParallel', 'ipGapSec'];
const BOOL_KEYS = ['running', 'insights', 'websiteFallback', 'closeAdTab', 'fullDetails', 'proxyEnabled', 'serverReader', 'serverCollector', 'proxyStaticOn', 'resiOn'];
const STRING_KEYS = ['pausedReason', 'proxyHost', 'proxyUser', 'proxyPass'];

export async function getSettings() {
  const doc = await col('settings').findOne({ _id: 'main' });
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (doc && k in doc) out[k] = doc[k];
  return out;
}

export async function updateSettings(patch = {}) {
  const set = {};
  for (const k of NUMBER_KEYS) if (k in patch) set[k] = Math.max(0, Number(patch[k]) || 0);
  for (const k of BOOL_KEYS) if (k in patch) set[k] = Boolean(patch[k]);
  for (const k of STRING_KEYS) if (k in patch) set[k] = String(patch[k] ?? '').trim().slice(0, 300);
  for (const [key, name] of [['proxyList', 'Static proxy list'], ['resiList', 'Rotating proxy list']]) {
    if (!(key in patch)) continue;
    const lines = proxyLines(patch[key]);
    const bad = lines.find((l) => !parseProxyLine(l));
    if (bad) throw httpError(400, `${name}: "${bad.slice(0, 60)}" is not host:port:user:pass`);
    if (lines.length > 500) throw httpError(400, `${name}: at most 500 proxies`);
    set[key] = lines.join('\n');
  }
  // with the proxy on, at least one group must be on and have lines — otherwise pages would be read from the
  // server's own IP (or by Chrome), which is never what turning a group off means
  if (Object.keys(set).some((k) => ['proxyEnabled', 'proxyStaticOn', 'resiOn', 'proxyList', 'resiList'].includes(k))) {
    const next = { ...(await getSettings()), ...set };
    if (next.proxyEnabled) {
      if (next.proxyStaticOn === false && !next.resiOn) throw httpError(400, 'Turn on at least one proxy group (Static or Rotating) — or turn the whole proxy off');
      const hadLines = proxyLines(next.proxyList).length + proxyLines(next.resiList).length > 0;
      if (hadLines && !proxyPool(next).length) throw httpError(400, 'The proxy group that is on has no proxies — paste its list or turn the other group on');
    }
  }
  if ('running' in set && set.running) {
    // Resume = start now (also ends a login-wall wait)
    set.pausedReason = '';
    set.cooldownUntil = null;
    set.cooldownReason = '';
    set.netBreaks = [];
  }
  if ('parallel' in set) set.parallel = Math.min(3, Math.max(1, Math.round(set.parallel) || 1));
  if ('serverParallel' in set) set.serverParallel = Math.min(20, Math.max(1, Math.round(set.serverParallel) || 1));
  if ('ipGapSec' in set) set.ipGapSec = Math.min(600, Math.round(set.ipGapSec));
  if ('delayMin' in set) set.delayMin = Math.max(0, set.delayMin);
  if ('maxAds' in set) set.maxAds = clampMaxAds(set.maxAds);
  if (Object.keys(set).length) await col('settings').updateOne({ _id: 'main' }, { $set: set }, { upsert: true });
  const s = await getSettings();
  if (s.delayMax < s.delayMin) {
    await col('settings').updateOne({ _id: 'main' }, { $set: { delayMax: s.delayMin } });
    s.delayMax = s.delayMin;
  }
  return s;
}

// ---------------- workspace settings (each user's own Google Sheet) ----------------
export const WS_DEFAULTS = { sheetUrl: '', sheetSecret: '', autoSync: false, lastSyncAt: null };

export async function getWsSettings(ws) {
  const w = await col('workspaces').findOne({ _id: ws }, { projection: { settings: 1 } });
  return { ...WS_DEFAULTS, ...(w?.settings || {}) };
}

/** Only Google Apps Script web apps — the server POSTs to this URL, so it must never point anywhere else. */
export function checkSheetUrl(url) {
  if (!url) return '';
  let u;
  try {
    u = new URL(url);
  } catch {
    throw httpError(400, 'The Web App URL is not a valid link');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'script.google.com' || !u.pathname.startsWith('/macros/')) {
    throw httpError(400, 'The Web App URL must look like https://script.google.com/macros/s/…/exec');
  }
  return u.href;
}

export async function updateWsSettings(ws, patch = {}) {
  const set = {};
  if ('sheetUrl' in patch) set['settings.sheetUrl'] = checkSheetUrl(String(patch.sheetUrl ?? '').trim());
  if ('sheetSecret' in patch) set['settings.sheetSecret'] = String(patch.sheetSecret ?? '').trim().slice(0, 200);
  if ('autoSync' in patch) set['settings.autoSync'] = Boolean(patch.autoSync);
  if (Object.keys(set).length) await col('workspaces').updateOne({ _id: ws }, { $set: set });
  return getWsSettings(ws);
}
