import { col, httpError } from './db.js';

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
  fullDetails: false,
  dailyLimit: 150,
  maxAds: 200,
  websiteFallback: true,
  closeAdTab: true,
};

const NUMBER_KEYS = ['delayMin', 'delayMax', 'dailyLimit', 'maxAds', 'parallel'];
const BOOL_KEYS = ['running', 'websiteFallback', 'closeAdTab', 'fullDetails'];
const STRING_KEYS = ['pausedReason'];

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
  if ('running' in set && set.running) {
    // Resume = start now (also ends a login-wall wait)
    set.pausedReason = '';
    set.cooldownUntil = null;
  }
  if ('parallel' in set) set.parallel = Math.min(3, Math.max(1, Math.round(set.parallel) || 1));
  if ('delayMin' in set) set.delayMin = Math.max(1, set.delayMin);
  if ('maxAds' in set) set.maxAds = Math.min(5000, Math.max(10, set.maxAds));
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
