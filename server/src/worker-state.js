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

/** A version counts as "running" when it contacted the server this recently (the extension asks every minute). */
const RUNNING_MS = 3 * 60 * 1000;

/**
 * What the dashboard shows about the extension. Several PCs can run it, so every version's last contact is
 * kept: "outdated" only when an old version is actually running now — not because it ran some time ago.
 */
export async function workerInfo() {
  const doc = await col('settings').findOne({ _id: 'worker' });
  if (!doc?.at) return null;
  const now = Date.now();
  const running = Object.entries(doc.seen || {})
    .map(([v, at]) => ({ version: v.replace(/_/g, '.'), at: new Date(at).getTime(), via: doc.via?.[v] || '' }))
    .filter((x) => now - x.at < RUNNING_MS)
    .sort((a, b) => b.at - a.at);
  const old = running.filter((x) => isOutdated(x.version));
  // which copies exactly: version, IP, account, browser — "an old version is running" alone didn't say where
  // (often a second copy of the extension left in the same Chrome next to the new one)
  const pcs = await col('pcs').find({ lastSeen: { $gt: new Date(now - RUNNING_MS) } }).toArray();
  const names = new Map((await col('workspaces').find({ _id: { $in: pcs.map((p) => p.workspaceId).filter(Boolean) } }).project({ name: 1 }).toArray()).map((w) => [String(w._id), w.name]));
  const oldCopies = pcs
    .filter((p) => isOutdated(p.version))
    .map((p) => {
      const browser = String(p.ua || '').match(/(Edg|OPR|Chrome)\/\d+/)?.[0]?.replace('Edg', 'Edge').replace('OPR', 'Opera') || 'Chrome';
      const acc = p.workspaceId ? names.get(String(p.workspaceId)) || 'a customer' : 'team key';
      return `v${p.version} — ${p.name ? `${p.name}, ` : ''}IP ${p.ip || '?'}, ${browser}, ${acc}`;
    });
  return {
    oldCopies,
    version: (old[0] || running[0])?.version || doc.version || 'old',
    outdated: running.length ? old.length > 0 : isOutdated(doc.version),
    running: running.map((x) => (x.via ? `${x.version} on ${x.via}` : x.version)),
    latest: worker.latest,
    seenAgo: Math.round((now - new Date(doc.at).getTime()) / 1000),
  };
}
