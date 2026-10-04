import { col } from './db.js';

export const DEFAULTS = {
  running: true,
  pausedReason: '',
  delayMin: 4,
  delayMax: 8,
  parallel: 2, // how many pages are read at the same time (worker tabs)
  fullDetails: false, // true = also open About / Details / Page transparency even when contact was found
  dailyLimit: 150,
  maxAds: 200,
  websiteFallback: true,
  closeAdTab: true,
  sheetUrl: '',
  sheetSecret: '',
  autoSync: false,
};

const NUMBER_KEYS = ['delayMin', 'delayMax', 'dailyLimit', 'maxAds', 'parallel'];
const BOOL_KEYS = ['running', 'websiteFallback', 'closeAdTab', 'autoSync', 'fullDetails'];
const STRING_KEYS = ['pausedReason', 'sheetUrl', 'sheetSecret'];

export async function getSettings() {
  const doc = await col('settings').findOne({ _id: 'main' });
  const { _id, ...rest } = doc || {};
  return { ...DEFAULTS, ...rest };
}

export async function updateSettings(patch = {}) {
  const set = {};
  for (const k of NUMBER_KEYS) if (k in patch) set[k] = Math.max(0, Number(patch[k]) || 0);
  for (const k of BOOL_KEYS) if (k in patch) set[k] = Boolean(patch[k]);
  for (const k of STRING_KEYS) if (k in patch) set[k] = String(patch[k] ?? '').trim();
  if ('running' in set && set.running) set.pausedReason = '';
  if ('parallel' in set) set.parallel = Math.min(3, Math.max(1, Math.round(set.parallel) || 1));
  if (Object.keys(set).length) {
    await col('settings').updateOne({ _id: 'main' }, { $set: set }, { upsert: true });
  }
  const s = await getSettings();
  if (s.delayMax < s.delayMin) {
    await col('settings').updateOne({ _id: 'main' }, { $set: { delayMax: s.delayMin } });
    s.delayMax = s.delayMin;
  }
  return s;
}
