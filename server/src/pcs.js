// The computers that run the Chrome extension. Several PCs can run it (e.g. the boss's and the developer's);
// each one is told apart by an id the extension makes once (x-ext-pc, v3.2+) — older versions by their
// internet address. An admin names them ("Sir's PC") and decides which ones take the Dashboard's searches
// from the queue (takeQueue) — so a search never opens on a computer nobody is looking at.
import { col } from './db.js';

const ONLINE_MS = 2 * 60 * 1000;
const lastWrite = new Map();

export function pcIdOf(req) {
  const h = String(req.get('x-ext-pc') || '').toLowerCase();
  if (/^[0-9a-f-]{20,40}$/.test(h)) return h;
  return `ip-${String(req.get('cf-connecting-ip') || req.ip || 'unknown').slice(0, 60)}`;
}

/** Remember this computer (at most every 20 s each). */
export function touchPc(req, version) {
  const id = pcIdOf(req);
  if (Date.now() - (lastWrite.get(id) || 0) < 20000) return id;
  lastWrite.set(id, Date.now());
  const now = new Date();
  col('pcs')
    .updateOne(
      { _id: id },
      {
        $set: { ip: String(req.get('cf-connecting-ip') || req.ip || '').slice(0, 60), ua: String(req.get('user-agent') || '').slice(0, 200), version, lastSeen: now, local: !req.get('cf-connecting-ip'), workspaceId: req.workerWs || null },
        $setOnInsert: { name: '', takeQueue: true, firstSeen: now },
      },
      { upsert: true },
    )
    .catch(() => {});
  return id;
}

export const getPc = (id) => col('pcs').findOne({ _id: id });
export const pcName = (pc) => (pc ? pc.name || `PC ${pc.ip || pc._id.slice(0, 8)}` : '');

/** id → name, for the lists in the dashboard. */
export async function pcNames() {
  const all = await col('pcs').find({}).project({ name: 1, ip: 1 }).toArray();
  return new Map(all.map((p) => [p._id, pcName(p)]));
}

/** The computers — all of them for the team, only its own for a customer (workspaceId). */
export async function listPcs(workspaceId = null) {
  const [all, running] = await Promise.all([
    col('pcs').find(workspaceId ? { workspaceId } : {}).sort({ lastSeen: -1 }).toArray(),
    col('jobs').find({ phase: 'collecting' }).project({ keyword: 1, collector: 1 }).toArray(),
  ]);
  return all.map((p) => ({
    id: p._id,
    name: p.name || '',
    label: pcName(p),
    ip: p.ip,
    version: p.version,
    browser: /Edg\//.test(p.ua) ? 'Edge' : /Chrome\//.test(p.ua) ? 'Chrome' : 'Browser',
    lastSeen: p.lastSeen,
    online: Date.now() - new Date(p.lastSeen).getTime() < ONLINE_MS,
    takeQueue: p.takeQueue !== false,
    // Gentle mode (worker.js GENTLE): fewer, slower searches - for a server/datacenter IP that Facebook limits sooner
    gentle: p.gentle === true,
    restingUntil: p.gentle && p.limitedAt && Date.now() - new Date(p.limitedAt).getTime() < 60 * 60e3 ? new Date(new Date(p.limitedAt).getTime() + 60 * 60e3) : null,
    collecting: running.filter((j) => j.collector === p._id).map((j) => j.keyword),
    oldVersion: p._id.startsWith('ip-'),
    team: !p.workspaceId,
  }));
}

export async function updatePc(id, b = {}) {
  const set = {};
  if ('name' in b) set.name = String(b.name || '').trim().slice(0, 40);
  if ('takeQueue' in b) set.takeQueue = Boolean(b.takeQueue);
  if ('gentle' in b) set.gentle = Boolean(b.gentle);
  if (Object.keys(set).length) await col('pcs').updateOne({ _id: String(id) }, { $set: set });
}
