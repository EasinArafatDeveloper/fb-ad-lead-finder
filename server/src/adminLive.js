// Admin → Overview → Live: what every account is doing right now — the search collecting (keyword, ads so far,
// which computer, scrolling or page by page), the searches waiting, its pages being read and how fast, and what
// went wrong lately. Plus a read-only look at one account's projects and leads (Admin → account page).
// Mounted inside admin.js (behind requireAdmin). Reads only — nothing here changes an account.
import { once } from 'node:events';
import express from 'express';
import { col, httpError } from './db.js';
import { getSettings } from './settings.js';
import { oid, projectStats } from './projects.js';
import { LEAD_HEADERS, buildFilter, leadRow, leadsCursor } from './leads.js';
import { serverReaderNow } from './serverReader.js';
import { pcName } from './pcs.js';
import { accountOf } from './billing.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

export const LIVE_WINDOW_MS = 2 * 3600e3; // an account counts as active with work in the last 2 hours
const ONLINE_MS = 3 * 60e3;
const CONTACT = { $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] };
const secAgo = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 1000) : null);

/** Every account with work now or in the last 2 hours, most active first. */
export async function liveActivity() {
  const now = Date.now();
  const since = new Date(now - LIVE_WINDOW_MS);
  const [s, jobs, pending, readRecent, problems, pcs, minute, five] = await Promise.all([
    getSettings(),
    col('jobs').find({ $or: [{ phase: { $in: ['queued', 'collecting'] } }, { createdAt: { $gte: since } }, { collectedAt: { $gte: since } }] }).sort({ createdAt: -1 }).toArray(),
    col('leads').aggregate([{ $match: { scrapeStatus: { $in: ['pending', 'working'] } } }, { $group: { _id: '$workspaceId', pending: { $sum: { $cond: [{ $eq: ['$scrapeStatus', 'pending'] }, 1, 0] } }, working: { $sum: { $cond: [{ $eq: ['$scrapeStatus', 'working'] }, 1, 0] } } } }]).toArray(),
    col('leads').aggregate([{ $match: { scrapedAt: { $gte: new Date(now - 5 * 60e3) } } }, { $group: { _id: '$workspaceId', n: { $sum: 1 } } }]).toArray(),
    col('activity').find({ ts: { $gte: since }, type: { $in: ['failed', 'paused'] } }).sort({ ts: -1 }).limit(200).toArray(),
    col('pcs').find({ lastSeen: { $gte: new Date(now - ONLINE_MS) } }).toArray(),
    col('pages').countDocuments({ lastAttemptAt: { $gte: new Date(now - 60e3) } }),
    col('pages').countDocuments({ lastAttemptAt: { $gte: new Date(now - 5 * 60e3) } }),
  ]);
  const wsIds = new Map();
  const add = (id) => id && wsIds.set(String(id), id);
  jobs.forEach((j) => add(j.workspaceId));
  pending.forEach((x) => add(x._id));
  readRecent.forEach((x) => add(x._id));
  pcs.forEach((p) => add(p.workspaceId));
  const ids = [...wsIds.values()];

  // per search: pages read / with a contact (the same counts as the Searches page)
  const jobIds = jobs.map((j) => String(j._id));
  const counts = new Map(
    (await col('leads').aggregate([
      { $match: { jobIds: { $in: jobIds } } },
      { $unwind: '$jobIds' },
      { $match: { jobIds: { $in: jobIds } } },
      { $group: { _id: '$jobIds', read: { $sum: { $cond: [{ $in: ['$scrapeStatus', ['done', 'failed']] }, 1, 0] } }, pending: { $sum: { $cond: [{ $in: ['$scrapeStatus', ['pending', 'working']] }, 1, 0] } }, withContact: { $sum: { $cond: [{ $or: [{ $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$whatsapp', []] } }, 0] }] }, 1, 0] } } } },
    ]).toArray()).map((x) => [x._id, x]),
  );
  const [users, workspaces, allPcs] = await Promise.all([
    col('users').find({ workspaceId: { $in: ids } }).project({ email: 1, name: 1, role: 1, workspaceId: 1, createdAt: 1 }).sort({ createdAt: 1 }).toArray(),
    col('workspaces').find({ _id: { $in: ids } }).project({ name: 1, plan: 1 }).toArray(),
    col('pcs').find({ _id: { $in: [...new Set(jobs.map((j) => j.collector).filter(Boolean))] } }).toArray(),
  ]);
  const pcOf = new Map([...allPcs, ...pcs].map((p) => [p._id, p]));
  const pcDTO = (p) => (p ? { name: pcName(p), version: p.version, ip: p.ip, mode: p.scrollCollect ? 'scroll' : 'pager', online: secAgo(p.lastSeen) < ONLINE_MS / 1000 } : null);
  const ownerOf = new Map();
  for (const u of users) if (!ownerOf.has(String(u.workspaceId))) ownerOf.set(String(u.workspaceId), u);
  const wsOf = new Map(workspaces.map((w) => [String(w._id), w]));
  const pendingOf = new Map(pending.map((x) => [String(x._id), x]));
  const readOf = new Map(readRecent.map((x) => [String(x._id), x.n]));

  const accounts = [];
  for (const id of ids) {
    const key = String(id);
    const mine = jobs.filter((j) => String(j.workspaceId) === key);
    const owner = ownerOf.get(key);
    const acc = await accountOf(id);
    const jobDTO = (j) => {
      const c = counts.get(String(j._id)) || {};
      return {
        id: String(j._id), keyword: j.keyword, country: j.country, kind: j.kind || 'search', phase: j.phase, manual: !!j.manual,
        ads: j.adsSeen || 0, maxAds: j.maxAds || null, pages: (j.pageIds || []).length, read: c.read || 0, pendingPages: c.pending || 0, withContact: c.withContact || 0,
        createdAt: j.createdAt, startedAt: j.startedAt || null, collectedAt: j.collectedAt || null, silentSec: j.phase === 'collecting' ? secAgo(j.lastActivity || j.startedAt) : null,
        tabHidden: !!j.tabHidden, note: j.stuckNote || (j.note && !['done', 'pasted links'].includes(j.note) ? j.note : ''), projectId: j.projectId ? String(j.projectId) : null,
        pc: pcDTO(pcOf.get(j.collector)),
      };
    };
    const p = pendingOf.get(key) || {};
    const issues = problems.filter((a) => String(a.workspaceId) === key).slice(0, 6).map((a) => ({ at: a.ts, type: a.type, msg: a.msg }));
    if (!acc.unlimited && acc.credits <= 0 && (p.pending || mine.some((j) => ['queued', 'collecting'].includes(j.phase)))) issues.unshift({ at: new Date(), type: 'credits', msg: `No credits left (${acc.credits}) — reading waits` });
    for (const j of mine.filter((x) => x.phase === 'collecting' && secAgo(x.lastActivity || x.startedAt) > 60)) issues.unshift({ at: new Date(), type: 'silent', msg: `"${j.keyword}" — the Ad Library tab hasn't reported for ${secAgo(j.lastActivity || j.startedAt)} s` });
    accounts.push({
      workspaceId: key, name: owner?.name || wsOf.get(key)?.name || '', email: owner?.email || '', team: owner?.role === 'admin' || wsOf.get(key)?.plan === 'internal',
      plan: acc.planName || acc.plan, credits: acc.unlimited ? null : acc.credits,
      collecting: mine.filter((j) => j.phase === 'collecting').map(jobDTO),
      queued: mine.filter((j) => j.phase === 'queued').map((j) => ({ id: String(j._id), keyword: j.keyword, country: j.country, createdAt: j.createdAt })),
      recent: mine.filter((j) => !['queued', 'collecting'].includes(j.phase)).slice(0, 5).map(jobDTO),
      reading: { pending: p.pending || 0, working: p.working || 0, last5min: readOf.get(key) || 0, perMin: Math.round(((readOf.get(key) || 0) / 5) * 10) / 10 },
      computers: pcs.filter((x) => String(x.workspaceId) === key).map(pcDTO),
      issues,
    });
  }
  const weight = (a) => (a.collecting.length ? 3 : 0) + (a.reading.working || a.reading.last5min ? 2 : 0) + (a.queued.length ? 1 : 0);
  accounts.sort((a, b) => weight(b) - weight(a) || (b.reading.last5min - a.reading.last5min));
  return {
    at: new Date(),
    engine: {
      running: s.running, pausedReason: s.pausedReason || '', cooldownUntil: s.cooldownUntil && new Date(s.cooldownUntil) > new Date() ? s.cooldownUntil : null,
      readingNow: serverReaderNow(), pagesLastMin: minute, pagesLast5min: five,
      queue: await col('pages').countDocuments({ scrapeStatus: 'pending' }),
      computersOnline: pcs.length,
    },
    accounts,
  };
}

r.get('/live', ah(() => liveActivity()));

// ---------------- one account's data, read-only ----------------
async function accountWs(id) {
  const ws = oid(id);
  const w = ws && (await col('workspaces').findOne({ _id: ws }, { projection: { name: 1, plan: 1 } }));
  if (!w) throw httpError(404, 'Account not found');
  return w;
}

r.get('/accounts/:ws', ah(async (req) => {
  const w = await accountWs(req.params.ws);
  const owner = await col('users').findOne({ workspaceId: w._id }, { sort: { createdAt: 1 }, projection: { email: 1, name: 1, role: 1, createdAt: 1, lastLoginAt: 1 } });
  const projects = await col('projects').find({ workspaceId: w._id }).sort({ createdAt: -1 }).toArray();
  return {
    account: { workspaceId: String(w._id), name: owner?.name || w.name, email: owner?.email || '', role: owner?.role || '', since: owner?.createdAt, lastLoginAt: owner?.lastLoginAt || null, ...(await accountOf(w._id)) },
    totals: {
      leads: await col('leads').countDocuments({ workspaceId: w._id }),
      withContact: await col('leads').countDocuments({ workspaceId: w._id, ...CONTACT }),
      searches: await col('jobs').countDocuments({ workspaceId: w._id }),
    },
    projects: await Promise.all(projects.map(async (p) => ({ id: String(p._id), name: p.name, country: p.country, source: p.source || 'search', createdAt: p.createdAt, ...(await projectStats(p)) }))),
  };
}));

// the leads of one account (optionally one project), with the All Leads filters — q, need, status, …
r.get('/accounts/:ws/leads', ah(async (req) => {
  const w = await accountWs(req.params.ws);
  const { projectId, page: pg, per: pp, ...q } = req.query;
  const per = Math.min(200, Math.max(1, Number(pp) || 50));
  const page = Math.max(1, Number(pg) || 1);
  const filter = buildFilter(w._id, q);
  if (projectId) filter.$and.push({ projectIds: oid(projectId) });
  const total = await col('leads').countDocuments(filter);
  const items = await col('leads').find(filter).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * per).limit(per)
    .project({ pageId: 1, pageName: 1, pageUrl: 1, category: 1, phones: 1, whatsapp: 1, emails: 1, website: 1, followers: 1, adCount: 1, status: 1, scrapeStatus: 1, keywords: 1, sources: 1, updatedAt: 1 })
    .toArray();
  return { items, total, page, per };
}));

r.get('/accounts/:ws/export.csv', ah(async (req, res) => {
  const w = await accountWs(req.params.ws);
  const { projectId, ...q } = req.query;
  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const line = (row) => row.map(csvCell).join(',') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${String(w.name || 'account').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write('﻿' + line(LEAD_HEADERS));
  const query = projectId ? { ...q } : q;
  const cursor = projectId
    ? col('leads').find({ ...buildFilter(w._id, query), projectIds: oid(projectId) }).sort({ updatedAt: -1 })
    : leadsCursor(w._id, query, { limit: 100000 });
  for await (const l of cursor) if (!res.write(line(leadRow(l)))) await once(res, 'drain');
  res.end();
}));

export default r;
