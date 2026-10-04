import fs from 'node:fs';
import { col } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The extension version in this repo — what the user's Chrome should be running. */
let latest = '';
try {
  latest = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'extension', 'manifest.json'), 'utf8')).version;
} catch {
  /* repo layout changed — no version check */
}

export const worker = { latest, seen: null };

const num = (v) => String(v || '0').split('.').map((x) => Number(x) || 0);
export function isOutdated(v) {
  if (!latest) return false;
  if (!v) return true;
  const [a, b] = [num(v), num(latest)];
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

/** What the dashboard shows about the extension (last seen version, outdated?). Stored in MongoDB. */
export async function workerInfo() {
  const seen = await col('settings').findOne({ _id: 'worker' });
  if (!seen?.at) return null;
  return {
    version: seen.version || 'old',
    outdated: isOutdated(seen.version),
    latest: worker.latest,
    seenAgo: Math.round((Date.now() - new Date(seen.at).getTime()) / 1000),
  };
}
