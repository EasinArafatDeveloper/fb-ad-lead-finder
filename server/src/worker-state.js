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
 * `viewerWs`: the admin looking. Only the team's own computers count for the warning (the WORKER_KEY ones and
 * the ones connected to the viewer's own account) — another account's old extension is that account's to
 * update: it sees its own warning, and the admin gets a list with a "send a reminder" button (outdatedExtensions).
 */
export async function workerInfo(viewerWs = null) {
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
  const ours = (p) => !p.workspaceId || (viewerWs && String(p.workspaceId) === String(viewerWs));
  const myOld = pcs.filter((p) => ours(p) && isOutdated(p.version));
  const othersOld = new Set(pcs.filter((p) => !ours(p) && isOutdated(p.version)).map((p) => String(p.workspaceId))).size;
  const names = new Map((await col('workspaces').find({ _id: { $in: pcs.map((p) => p.workspaceId).filter(Boolean) } }).project({ name: 1 }).toArray()).map((w) => [String(w._id), w.name]));
  const oldCopies = myOld
    .map((p) => {
      const browser = String(p.ua || '').match(/(Edg|OPR|Chrome)\/\d+/)?.[0]?.replace('Edg', 'Edge').replace('OPR', 'Opera') || 'Chrome';
      const acc = p.workspaceId ? names.get(String(p.workspaceId)) || 'a customer' : 'team key';
      return `v${p.version} — ${p.name ? `${p.name}, ` : ''}IP ${p.ip || '?'}, ${browser}, ${acc}`;
    });
  return {
    oldCopies,
    othersOld, // other accounts running an old extension right now (admin: Overview → Extension updates)
    version: myOld[0]?.version || (old[0] || running[0])?.version || doc.version || 'old',
    // computers known: only ours decide; none known (very old extensions): the versions seen, as before
    outdated: pcs.length ? myOld.length > 0 : running.length ? old.length > 0 : isOutdated(doc.version),
    running: running.map((x) => (x.via ? `${x.version} on ${x.via}` : x.version)),
    latest: worker.latest,
    seenAgo: Math.round((now - new Date(doc.at).getTime()) / 1000),
  };
}

/** How long a computer counts for the admin's "not updated yet" list. */
export const OUTDATED_LIST_DAYS = 14;

/**
 * Admin → Overview → Extension updates: every account with a computer on an old extension (seen in the last
 * OUTDATED_LIST_DAYS days), with its computers and when the team last sent it a reminder.
 */
export async function outdatedExtensions() {
  const since = new Date(Date.now() - OUTDATED_LIST_DAYS * 864e5);
  const pcs = (await col('pcs').find({ lastSeen: { $gt: since } }).sort({ lastSeen: -1 }).toArray()).filter((p) => isOutdated(p.version));
  const wsIds = [...new Set(pcs.map((p) => p.workspaceId).filter(Boolean).map(String))];
  const [workspaces, owners] = await Promise.all([
    col('workspaces').find({ _id: { $in: pcs.map((p) => p.workspaceId).filter(Boolean) } }).project({ name: 1, plan: 1, extReminderAt: 1 }).toArray(),
    col('users').find({ workspaceId: { $in: pcs.map((p) => p.workspaceId).filter(Boolean) } }).project({ email: 1, name: 1, workspaceId: 1 }).sort({ createdAt: 1 }).toArray(),
  ]);
  const wsOf = new Map(workspaces.map((w) => [String(w._id), w]));
  const ownerOf = new Map();
  for (const u of owners) if (!ownerOf.has(String(u.workspaceId))) ownerOf.set(String(u.workspaceId), u);
  const pcDTO = (p) => ({
    id: p._id, name: p.name || '', version: p.version, ip: p.ip || '', lastSeen: p.lastSeen,
    online: Date.now() - new Date(p.lastSeen).getTime() < RUNNING_MS,
    browser: String(p.ua || '').match(/(Edg|OPR|Chrome)\/\d+/)?.[0]?.replace('Edg', 'Edge').replace('OPR', 'Opera') || 'Chrome',
  });
  const rows = wsIds.map((id) => {
    const w = wsOf.get(id);
    const u = ownerOf.get(id);
    const list = pcs.filter((p) => String(p.workspaceId) === id);
    return { workspaceId: id, account: w?.name || '', email: u?.email || '', name: u?.name || '', team: w?.plan === 'internal', remindedAt: w?.extReminderAt || null, pcs: list.map(pcDTO) };
  });
  // computers on the team's WORKER_KEY have no account to remind — listed so the team updates them itself
  const teamKey = pcs.filter((p) => !p.workspaceId).map(pcDTO);
  return { latest, days: OUTDATED_LIST_DAYS, accounts: rows, teamKey };
}
