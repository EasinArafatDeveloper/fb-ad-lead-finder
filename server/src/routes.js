// API for logged-in users. Everything is limited to the user's own workspace (req.ws).
import crypto from 'node:crypto';
import express from 'express';
import ExcelJS from 'exceljs';
import { activity, col, httpError } from './db.js';
import { isAdmin } from './auth.js';
import { getSettings, getWsSettings, updateSettings, updateWsSettings } from './settings.js';
import { AD_HEADERS, LEAD_HEADERS, OVERRIDABLE, adRow, buildFilter, buildSort, ingestAds, leadRow, syncLeads } from './leads.js';
import { pullSheet, syncSheet, testSheet } from './sheets.js';
import { deleteLeads, ensureProject, oid, queuePages, stopPages } from './projects.js';
import { workerInfo } from './worker-state.js';
import { adLibraryUrl, cleanEmails, startOfToday, uniq, uniqPhones } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

const STATUSES = ['New', 'Contacted', 'Interested', 'Not Interested', 'Closed'];
const jobDTO = (j) => ({ ...j, id: String(j._id), _id: undefined, workspaceId: undefined, userId: undefined, pageIds: undefined, pageCount: (j.pageIds || []).length });
const withContact = { $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] };
const visitsToday = () => col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } });
/** When the worker is taking a break after a Facebook login wall: the time it continues, else null. */
const activeCooldown = (s) => (s.cooldownUntil && new Date(s.cooldownUntil) > new Date() ? s.cooldownUntil : null);

/** Daily search limit per workspace (admins have none). */
export async function checkSearchQuota(req, n) {
  if (isAdmin(req)) return;
  const w = await col('workspaces').findOne({ _id: req.ws }, { projection: { limits: 1 } });
  const limit = w?.limits?.searchesPerDay ?? 20;
  const used = await col('jobs').countDocuments({ workspaceId: req.ws, manual: { $ne: true }, createdAt: { $gte: startOfToday() } });
  if (used + n > limit) throw httpError(429, `Daily search limit reached (${used} of ${limit} used today). Try again tomorrow.`);
}

// ---------------- stats ----------------
r.get('/stats', ah(async (req) => {
  const ws = req.ws;
  const L = col('leads');
  const today = startOfToday();
  const [total, withEmail, withPhone, pending, failed, scrapedToday, contacted, queuedJobs, collecting, visits, settings] = await Promise.all([
    L.countDocuments({ workspaceId: ws }),
    L.countDocuments({ workspaceId: ws, 'emails.0': { $exists: true } }),
    L.countDocuments({ workspaceId: ws, $or: [{ 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] }),
    L.countDocuments({ workspaceId: ws, scrapeStatus: { $in: ['pending', 'working'] } }),
    L.countDocuments({ workspaceId: ws, scrapeStatus: 'failed' }),
    L.countDocuments({ workspaceId: ws, scrapedAt: { $gte: today } }),
    L.countDocuments({ workspaceId: ws, status: { $nin: ['New', null] } }),
    col('jobs').countDocuments({ workspaceId: ws, phase: 'queued' }),
    col('jobs').countDocuments({ workspaceId: ws, phase: 'collecting' }),
    visitsToday(),
    getSettings(),
  ]);
  const active = collecting + queuedJobs + pending > 0;
  let activeName = '';
  if (active) {
    const job = await col('jobs').findOne({ workspaceId: ws, phase: { $in: ['collecting', 'queued'] } }, { sort: { phase: 1, createdAt: 1 } });
    if (job) activeName = job.keyword;
    else {
      const lead = await L.findOne({ workspaceId: ws, scrapeStatus: { $in: ['working', 'pending'] } }, { sort: { scrapeStatus: -1, createdAt: 1 }, projection: { projectIds: 1 } });
      const p = lead?.projectIds?.[0] ? await col('projects').findOne({ _id: lead.projectIds[0] }, { projection: { name: 1 } }) : null;
      activeName = p?.name || '';
    }
  }
  return {
    total, withEmail, withPhone, pending, failed, scrapedToday, contacted, queuedJobs, collecting, active, activeName,
    worker: await workerInfo(),
    // the shared worker: one daily page limit for the whole server
    workerVisitsToday: visits,
    running: settings.running, pausedReason: settings.pausedReason, dailyLimit: settings.dailyLimit,
    cooldownUntil: activeCooldown(settings),
    lastSyncAt: (await getWsSettings(ws)).lastSyncAt || null,
  };
}));

/** Stop: cancel this workspace's work that hasn't happened yet. Everything already found stays. */
r.post('/runner/stop', ah(async (req) => {
  const now = new Date();
  const jobs = await col('jobs').updateMany({ workspaceId: req.ws, phase: { $in: ['queued', 'collecting'] } }, { $set: { phase: 'stopped', stoppedAt: now } });
  const pages = await stopPages(req.ws);
  await activity('stopped', `Stopped — ${jobs.modifiedCount} searches and ${pages} pages cancelled. Everything found so far is kept.`, { workspaceId: req.ws });
  return { searches: jobs.modifiedCount, pages };
}));

r.get('/meta', ah(async (req) => ({
  keywords: (await col('leads').distinct('keywords', { workspaceId: req.ws })).filter(Boolean).sort(),
  statuses: STATUSES,
})));

// ---------------- leads ----------------
r.get('/leads', ah(async (req) => {
  const per = Math.min(200, Math.max(1, Number(req.query.per) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = buildFilter(req.ws, req.query);
  const [items, total] = await Promise.all([
    col('leads').find(filter).sort(buildSort(req.query.sort, req.query.dir)).skip((page - 1) * per).limit(per).toArray(),
    col('leads').countDocuments(filter),
  ]);
  return { items, total, page, per };
}));

r.get('/leads/:id', ah(async (req, res) => {
  const lead = await col('leads').findOne({ workspaceId: req.ws, pageId: String(req.params.id) });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const ads = await col('ads').find({ pageId: lead.pageId }).sort({ startDate: -1 }).limit(200).toArray();
  return { lead, ads };
}));

/** A link typed by a user must be a web link (no javascript: and the like). */
function webLink(v) {
  const s = String(v ?? '').trim().slice(0, 500);
  if (!s) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* fall through */
  }
  throw httpError(400, `"${s}" is not a valid web link`);
}

function contactFields(b) {
  const out = {};
  for (const k of ['pageName', 'category', 'notes']) if (k in b) out[k] = String(b[k] ?? '').trim().slice(0, k === 'notes' ? 5000 : 200);
  for (const k of ['pageUrl', 'website', 'instagram']) if (k in b) out[k] = webLink(b[k]);
  if ('status' in b) out.status = STATUSES.includes(b.status) ? b.status : 'New';
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).slice(0, 50);
  if ('phones' in b) out.phones = uniqPhones(list(b.phones));
  if ('whatsapp' in b) out.whatsapp = uniqPhones(list(b.whatsapp));
  if ('emails' in b) out.emails = cleanEmails(list(b.emails));
  if ('website' in out) out.websites = out.website ? [out.website] : [];
  return out;
}

r.post('/leads', ah(async (req) => {
  const f = contactFields(req.body || {});
  const now = new Date();
  const ws = req.ws;
  const pageId = `manual-${crypto.randomBytes(8).toString('hex')}`;
  const hasContact = (f.phones || []).length || (f.emails || []).length || (f.whatsapp || []).length;
  const { status = 'New', notes = '', ...contact } = f;
  // the shared page: only read later if a Facebook link was given and no contact yet
  await col('pages').insertOne({
    pageId, phones: [], emails: [], whatsapp: [], websites: [], website: '', instagram: '', adCount: 0, retries: 0, contactSource: 'manual',
    ...contact, scrapeStatus: f.pageUrl && !hasContact ? 'pending' : 'done', wantedBy: [ws], createdAt: now, updatedAt: now,
  });
  const lead = {
    workspaceId: ws, pageId, status, notes, keywords: ['manual'], jobIds: [], projectIds: [], overrides: Object.keys(contact).filter((k) => OVERRIDABLE.includes(k)),
    syncedAt: null, createdAt: now, updatedAt: now,
  };
  await col('leads').insertOne(lead);
  await syncLeads([pageId]);
  return col('leads').findOne({ workspaceId: ws, pageId });
}));

r.patch('/leads/:id', ah(async (req, res) => {
  const set = { ...contactFields(req.body || {}), updatedAt: new Date() };
  const edited = Object.keys(set).filter((k) => OVERRIDABLE.includes(k));
  const out = await col('leads').findOneAndUpdate(
    { workspaceId: req.ws, pageId: String(req.params.id) },
    { $set: set, ...(edited.length ? { $addToSet: { overrides: { $each: edited } } } : {}) },
    { returnDocument: 'after' },
  );
  if (!out) return res.status(404).json({ error: 'Lead not found' });
  return out;
}));

r.post('/leads/bulk', ah(async (req) => {
  const { ids, action, value } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Select at least one lead');
  const pageIds = ids.slice(0, 5000).map(String);
  const filter = { workspaceId: req.ws, pageId: { $in: pageIds } };
  const now = new Date();
  if (action === 'status') {
    const out = await col('leads').updateMany(filter, { $set: { status: STATUSES.includes(value) ? value : 'New', updatedAt: now } });
    return { updated: out.modifiedCount };
  }
  if (action === 'rescrape') {
    const mine = await col('leads').distinct('pageId', filter);
    return { queued: await queuePages(req.ws, mine, { force: true }) };
  }
  if (action === 'delete') {
    const out = await deleteLeads(req.ws, pageIds);
    await activity('delete', `${out.leads} leads deleted`, { workspaceId: req.ws });
    return out;
  }
  throw httpError(400, 'Unknown bulk action');
}));

// ---------------- searches (jobs) ----------------
r.get('/jobs', ah(async (req) => {
  const jobs = await col('jobs').find({ workspaceId: req.ws }).sort({ createdAt: -1 }).limit(200).toArray();
  // one query for the numbers of every job (instead of three per job)
  const ids = jobs.map((j) => String(j._id));
  const counts = new Map();
  if (ids.length) {
    const rows = await col('leads').aggregate([
      { $match: { workspaceId: req.ws, jobIds: { $in: ids } } },
      { $unwind: '$jobIds' },
      { $match: { jobIds: { $in: ids } } },
      {
        $group: {
          _id: '$jobIds',
          scraped: { $sum: { $cond: [{ $in: ['$scrapeStatus', ['done', 'failed']] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $in: ['$scrapeStatus', ['pending', 'working']] }, 1, 0] } },
          withContact: {
            $sum: { $cond: [{ $or: [{ $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$whatsapp', []] } }, 0] }] }, 1, 0] },
          },
        },
      },
    ]).toArray();
    for (const x of rows) counts.set(x._id, x);
  }
  return jobs.map((j) => {
    const c = counts.get(String(j._id)) || {};
    return { ...jobDTO(j), projectId: j.projectId ? String(j.projectId) : null, scraped: c.scraped || 0, withContact: c.withContact || 0, pending: c.pending || 0 };
  });
}));

r.post('/jobs', ah(async (req) => {
  const b = req.body || {};
  const s = await getSettings();
  const keywords = uniq(Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,\n]/)).map((k) => k.slice(0, 200)).slice(0, 50);
  if (!keywords.length) throw httpError(400, 'Enter at least one keyword');
  await checkSearchQuota(req, keywords.length);
  const country = String(b.country || 'BD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'BD';
  const maxAds = Math.min(5000, Math.max(10, Number(b.maxAds) || s.maxAds));
  const minAds = Math.max(1, Math.round(Number(b.minAds) || 1));
  const now = Date.now();
  const docs = [];
  for (const [i, keyword] of keywords.entries()) {
    docs.push({
      workspaceId: req.ws, userId: req.user._id, keyword, country, maxAds, minAds, url: adLibraryUrl(keyword, country), phase: 'queued', manual: false,
      adsSeen: 0, pageIds: [], projectId: await ensureProject(req.ws, keyword, country), createdAt: new Date(now + i),
    });
  }
  await col('jobs').insertMany(docs);
  for (const d of docs) await activity('queued', `Search queued: "${d.keyword}" (${country})`, { workspaceId: req.ws, projectId: d.projectId });
  return { created: docs.length };
}));

r.delete('/jobs/:id', ah(async (req) => {
  await col('jobs').deleteOne({ _id: oid(req.params.id), workspaceId: req.ws, phase: { $ne: 'collecting' } });
  return { ok: true };
}));

r.post('/jobs/:id/requeue', ah(async (req) => {
  const j = await col('jobs').findOne({ _id: oid(req.params.id), workspaceId: req.ws });
  if (!j) throw httpError(404, 'Search not found');
  if (['queued', 'collecting'].includes(j.phase)) throw httpError(409, 'This search is already running');
  await checkSearchQuota(req, 1);
  await col('jobs').updateOne({ _id: j._id }, { $set: { phase: 'queued', createdAt: new Date(), adsSeen: 0 }, $unset: { collectedAt: '', stoppedAt: '', note: '' } });
  return { ok: true };
}));

// ---------------- settings ----------------
const workerPublic = (s) => ({ running: s.running, pausedReason: s.pausedReason, dailyLimit: s.dailyLimit, maxAds: s.maxAds, cooldownUntil: activeCooldown(s) });

r.get('/settings', ah(async (req) => {
  const s = await getSettings();
  return { workspace: await getWsSettings(req.ws), worker: isAdmin(req) ? s : workerPublic(s), isAdmin: isAdmin(req) };
}));

r.put('/settings', ah(async (req) => {
  const b = req.body || {};
  if (b.worker && Object.keys(b.worker).length) {
    if (!isAdmin(req)) throw httpError(403, 'Only an admin can change the worker settings');
    const before = await getSettings();
    const s = await updateSettings(b.worker);
    if ('running' in b.worker && before.running !== s.running) await activity(s.running ? 'resumed' : 'paused', s.running ? 'Resumed' : 'Paused');
  }
  if (b.workspace) await updateWsSettings(req.ws, b.workspace);
  const s = await getSettings();
  return { workspace: await getWsSettings(req.ws), worker: isAdmin(req) ? s : workerPublic(s), isAdmin: isAdmin(req) };
}));

// ---------------- pipeline (dashboard: what happened, what's happening now) ----------------
r.get('/pipeline', ah(async (req) => {
  const ws = req.ws;
  const s = await getSettings();
  const [collecting, working, queuedJobs, activityList, doneToday, pendingAll] = await Promise.all([
    col('jobs').findOne({ workspaceId: ws, phase: 'collecting' }, { sort: { startedAt: -1 } }),
    col('leads').findOne({ workspaceId: ws, scrapeStatus: 'working' }, { projection: { pageName: 1, pageId: 1, projectIds: 1 } }),
    col('jobs').find({ workspaceId: ws, phase: 'queued' }).sort({ createdAt: 1 }).project({ keyword: 1, country: 1 }).toArray(),
    col('activity').find({ workspaceId: { $in: [ws, null] } }).sort({ ts: -1 }).limit(40).toArray(),
    visitsToday(),
    col('leads').countDocuments({ workspaceId: ws, scrapeStatus: { $in: ['pending', 'working'] } }),
  ]);
  const focusId =
    collecting?.projectId ||
    working?.projectIds?.[0] ||
    (await col('jobs').findOne({ workspaceId: ws, projectId: { $exists: true } }, { sort: { createdAt: -1 } }))?.projectId;
  let focus = null;
  const p = focusId ? await col('projects').findOne({ _id: focusId, workspaceId: ws }) : null;
  if (p) {
    const [leads, pending, failed, contact, ads, lastJob] = await Promise.all([
      col('leads').countDocuments({ workspaceId: ws, projectIds: p._id }),
      col('leads').countDocuments({ workspaceId: ws, projectIds: p._id, scrapeStatus: { $in: ['pending', 'working'] } }),
      col('leads').countDocuments({ workspaceId: ws, projectIds: p._id, scrapeStatus: 'failed' }),
      col('leads').countDocuments({ workspaceId: ws, projectIds: p._id, ...withContact }),
      col('ads').countDocuments({ projectIds: p._id }),
      col('jobs').findOne({ projectId: p._id }, { sort: { createdAt: -1 } }),
    ]);
    focus = {
      id: String(p._id), name: p.name, country: p.country, leads, pending, failed, withContact: contact, ads,
      jobPhase: lastJob?.phase || 'collected', jobAds: lastJob?.adsSeen || 0, maxAds: lastJob?.maxAds || s.maxAds,
      queuedAt: lastJob?.createdAt, startedAt: lastJob?.startedAt, collectedAt: lastJob?.collectedAt,
    };
  }
  // seconds per page: delay + ~5s to open the page, divided over the parallel tabs
  const perPage = ((s.delayMin + s.delayMax) / 2 + 5) / Math.max(1, s.parallel);
  const left = Math.max(0, Math.min(pendingAll, s.dailyLimit - doneToday));
  const lastDone = await col('pages').find({ scrapedAt: { $gte: new Date(Date.now() - 60 * 60e3) } }).sort({ scrapedAt: -1 }).limit(16).project({ scrapedAt: 1 }).toArray();
  const gaps = [];
  for (let i = 1; i < lastDone.length; i++) {
    const g = (lastDone[i - 1].scrapedAt - lastDone[i].scrapedAt) / 1000;
    if (g > 0 && g < 300) gaps.push(g);
  }
  const measured = gaps.length >= 3 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const secPerPage = measured || perPage;
  return {
    running: s.running,
    pausedReason: s.pausedReason,
    cooldownUntil: activeCooldown(s),
    collecting: collecting ? { keyword: collecting.keyword, ads: collecting.adsSeen || 0, pages: (collecting.pageIds || []).length, maxAds: collecting.maxAds } : null,
    working: working ? { name: working.pageName || working.pageId } : null,
    queued: queuedJobs.map((j) => ({ keyword: j.keyword, country: j.country })),
    focus,
    doneToday,
    dailyLimit: s.dailyLimit,
    pendingAll,
    etaMinutes: Math.max(left ? 1 : 0, Math.round((left * secPerPage) / 60)),
    secPerPage: Math.round(secPerPage),
    paceMeasured: !!measured,
    todayLeft: left,
    tomorrow: Math.max(0, pendingAll - left),
    worker: await workerInfo(),
    activity: activityList.map(({ _id, projectId, workspaceId, ...a }) => a),
  };
}));

// ---------------- export ----------------
async function exportData(ws, query) {
  const leads = await col('leads').find(buildFilter(ws, query)).sort(buildSort(query.sort, query.dir)).limit(100000).toArray();
  const ads = await col('ads').find({ pageId: { $in: leads.map((l) => l.pageId) } }).sort({ pageId: 1 }).toArray();
  return { leads, ads };
}

const stamp = () => new Date().toISOString().slice(0, 10);

r.get('/export.xlsx', ah(async (req, res) => {
  const { leads, ads } = await exportData(req.ws, req.query);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FB Ad Lead Finder';
  const addSheet = (name, headers, rows, widths) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((h, i) => ({ header: h, width: widths[i] || 16 }));
    for (const row of rows) {
      const added = ws.addRow(row);
      added.eachCell((cell) => {
        if (typeof cell.value === 'string' && /^https?:\/\//.test(cell.value) && !cell.value.includes(', ')) {
          cell.value = { text: cell.value, hyperlink: cell.value };
          cell.font = { color: { argb: 'FF0563C1' }, underline: true };
        }
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  };
  addSheet('Leads', LEAD_HEADERS, leads.map(leadRow), [18, 28, 36, 22, 22, 18, 30, 30, 30, 30, 40, 50, 18, 10, 30, 30, 16, 40, 11, 11, 10, 20, 40, 50, 40, 14, 30, 12, 17]);
  addSheet('Ads', AD_HEADERS, ads.map(adRow), [18, 18, 28, 60, 30, 40, 16, 12, 20, 16, 40]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="fb-leads-${stamp()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

/**
 * CSV cell. Text starting with = + - @ (or tab / CR) is run as a formula by Excel — ad texts and page names
 * come from strangers, so such cells get a leading apostrophe (shown as plain text).
 */
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

r.get('/export.csv', ah(async (req, res) => {
  const { leads } = await exportData(req.ws, req.query);
  const csv = [LEAD_HEADERS, ...leads.map(leadRow)].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fb-leads-${stamp()}.csv"`);
  res.send('﻿' + csv);
}));

// ---------------- google sheet ----------------
r.post('/sheet/test', ah((req) => testSheet(req.ws)));
r.post('/sheet/sync', ah((req) => syncSheet(req.ws, Boolean(req.body?.all))));
r.post('/sheet/pull', ah((req) => pullSheet(req.ws)));

// used by the dev tools only: ingest from a JSON file of ads (admin)
r.post('/dev/ingest', ah(async (req) => {
  if (!isAdmin(req)) throw httpError(403, 'Only an admin can do this');
  const { keyword = 'test', country = 'BD', ads = [] } = req.body || {};
  const projectId = await ensureProject(req.ws, keyword, country);
  return ingestAds({ id: 'dev', workspaceId: req.ws, keyword, country, projectId }, ads);
}));

export default r;
