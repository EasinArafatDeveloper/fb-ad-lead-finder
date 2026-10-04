import express from 'express';
import ExcelJS from 'exceljs';
import { ObjectId } from 'mongodb';
import { activity, col, log } from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { AD_HEADERS, LEAD_HEADERS, adRow, applyResult, buildFilter, buildSort, ingestAds, leadRow } from './leads.js';
import { pullSheet, syncSheet, testSheet } from './sheets.js';
import { deleteLeadsEverywhere, ensureProject } from './projects.js';
import { workerInfo } from './worker-state.js';
import { aboutUrl, mainUrl, adLibraryUrl, cleanEmails, startOfToday, uniq, uniqPhones } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

const STATUSES = ['New', 'Contacted', 'Interested', 'Not Interested', 'Closed'];
const jobDTO = (j) => ({ ...j, id: String(j._id), _id: undefined, pageIds: undefined, pageCount: (j.pageIds || []).length });
const oid = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

// ---------------- stats / meta ----------------
r.get('/stats', ah(async () => {
  const L = col('leads');
  const today = startOfToday();
  const [total, withEmail, withPhone, pending, failed, scrapedToday, contacted, queuedJobs, collecting, settings] = await Promise.all([
    L.countDocuments({}),
    L.countDocuments({ 'emails.0': { $exists: true } }),
    L.countDocuments({ $or: [{ 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] }),
    L.countDocuments({ scrapeStatus: { $in: ['pending', 'working'] } }),
    L.countDocuments({ scrapeStatus: 'failed' }),
    L.countDocuments({ scrapedAt: { $gte: today } }),
    L.countDocuments({ status: { $nin: ['New', null] } }),
    col('jobs').countDocuments({ phase: 'queued' }),
    col('jobs').countDocuments({ phase: 'collecting' }),
    getSettings(),
  ]);
  // is any project being worked on? (drives the Running / Paused / Stop control)
  const active = collecting + queuedJobs + pending > 0;
  let activeName = '';
  if (active) {
    const job = await col('jobs').findOne({ phase: { $in: ['collecting', 'queued'] } }, { sort: { phase: 1, createdAt: 1 } });
    if (job) activeName = job.keyword;
    else {
      const lead = await L.findOne({ scrapeStatus: { $in: ['working', 'pending'] } }, { sort: { scrapeStatus: -1, createdAt: 1 }, projection: { projectIds: 1 } });
      const p = lead?.projectIds?.[0] ? await col('projects').findOne({ _id: lead.projectIds[0] }, { projection: { name: 1 } }) : null;
      activeName = p?.name || '';
    }
  }
  return {
    total, withEmail, withPhone, pending, failed, scrapedToday, contacted, queuedJobs, collecting, active, activeName,
    worker: await workerInfo(),
    running: settings.running, pausedReason: settings.pausedReason, dailyLimit: settings.dailyLimit, lastSyncAt: settings.lastSyncAt || null,
  };
}));

/** Stop: cancel what hasn't happened yet (queued searches, pages not read). Everything already found stays. */
r.post('/runner/stop', ah(async () => {
  const now = new Date();
  const jobs = await col('jobs').updateMany({ phase: { $in: ['queued', 'collecting'] } }, { $set: { phase: 'stopped', stoppedAt: now } });
  const pages = await col('leads').updateMany({ scrapeStatus: { $in: ['pending', 'working'] } }, { $set: { scrapeStatus: 'stopped', updatedAt: now } });
  await updateSettings({ running: true });
  await activity('stopped', `Stopped — ${jobs.modifiedCount} searches and ${pages.modifiedCount} pages cancelled. Everything found so far is kept.`);
  return { searches: jobs.modifiedCount, pages: pages.modifiedCount };
}));

r.get('/meta', ah(async () => ({ keywords: (await col('leads').distinct('keywords')).filter(Boolean).sort(), statuses: STATUSES })));

// ---------------- leads ----------------
r.get('/leads', ah(async (req) => {
  const per = Math.min(200, Math.max(1, Number(req.query.per) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = buildFilter(req.query);
  const [items, total] = await Promise.all([
    col('leads').find(filter).sort(buildSort(req.query.sort, req.query.dir)).skip((page - 1) * per).limit(per).toArray(),
    col('leads').countDocuments(filter),
  ]);
  return { items, total, page, per };
}));

r.get('/leads/:id', ah(async (req, res) => {
  const lead = await col('leads').findOne({ pageId: req.params.id });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const ads = await col('ads').find({ pageId: req.params.id }).sort({ startDate: -1 }).limit(200).toArray();
  return { lead, ads };
}));

function contactFields(b) {
  const out = {};
  for (const k of ['pageName', 'pageUrl', 'category', 'website', 'instagram', 'notes']) if (k in b) out[k] = String(b[k] ?? '').trim();
  if ('status' in b) out.status = STATUSES.includes(b.status) ? b.status : 'New';
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/));
  if ('phones' in b) out.phones = uniqPhones(list(b.phones));
  if ('whatsapp' in b) out.whatsapp = uniqPhones(list(b.whatsapp));
  if ('emails' in b) out.emails = cleanEmails(list(b.emails));
  if ('website' in out) out.websites = out.website ? [out.website] : [];
  return out;
}

r.post('/leads', ah(async (req) => {
  const f = contactFields(req.body || {});
  const now = new Date();
  const hasContact = (f.phones || []).length || (f.emails || []).length || (f.whatsapp || []).length;
  const lead = {
    pageId: `manual-${Date.now()}`,
    status: 'New', notes: '', phones: [], emails: [], whatsapp: [], websites: [], website: '', keywords: ['manual'], jobIds: [],
    adCount: 0, retries: 0, contactSource: 'manual', syncedAt: null,
    ...f,
    scrapeStatus: f.pageUrl && !hasContact ? 'pending' : 'done',
    createdAt: now, updatedAt: now,
  };
  await col('leads').insertOne(lead);
  return lead;
}));

r.patch('/leads/:id', ah(async (req, res) => {
  const set = { ...contactFields(req.body || {}), updatedAt: new Date() };
  const out = await col('leads').findOneAndUpdate({ pageId: req.params.id }, { $set: set }, { returnDocument: 'after' });
  if (!out) return res.status(404).json({ error: 'Lead not found' });
  return out;
}));

r.post('/leads/bulk', ah(async (req) => {
  const { ids = [], action, value } = req.body || {};
  const filter = { pageId: { $in: ids.map(String) } };
  const now = new Date();
  if (action === 'status') return col('leads').updateMany(filter, { $set: { status: STATUSES.includes(value) ? value : 'New', updatedAt: now } });
  if (action === 'rescrape') return col('leads').updateMany(filter, { $set: { scrapeStatus: 'pending', retries: 0, lastError: '', updatedAt: now } });
  if (action === 'delete') {
    const out = await deleteLeadsEverywhere(ids);
    await activity('delete', `${out.leads} leads deleted — removed from every project and sheet`);
    return out;
  }
  throw new Error('Unknown bulk action');
}));

// ---------------- jobs ----------------
r.get('/jobs', ah(async () => {
  const jobs = await col('jobs').find({}).sort({ createdAt: -1 }).limit(300).toArray();
  return Promise.all(
    jobs.map(async (j) => {
      const ids = j.pageIds || [];
      const [done, withContact, pending] = ids.length
        ? await Promise.all([
            col('leads').countDocuments({ pageId: { $in: ids }, scrapeStatus: { $in: ['done', 'failed'] } }),
            col('leads').countDocuments({ pageId: { $in: ids }, $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] }),
            col('leads').countDocuments({ pageId: { $in: ids }, scrapeStatus: { $in: ['pending', 'working'] } }),
          ])
        : [0, 0, 0];
      return { ...jobDTO(j), scraped: done, withContact, pending };
    }),
  );
}));

r.post('/jobs', ah(async (req) => {
  const b = req.body || {};
  const s = await getSettings();
  const keywords = uniq(Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,\n]/));
  if (!keywords.length) throw new Error('Enter at least one keyword');
  const country = String(b.country || 'BD').toUpperCase();
  const maxAds = Number(b.maxAds) || s.maxAds;
  const minAds = Math.max(1, Math.round(Number(b.minAds) || 1)); // condition: pages with at least this many ads
  const now = Date.now();
  const docs = [];
  for (const [i, keyword] of keywords.entries()) {
    docs.push({
      keyword, country, maxAds, minAds, url: adLibraryUrl(keyword, country), phase: 'queued', manual: false,
      adsSeen: 0, pageIds: [], projectId: await ensureProject(keyword, country), createdAt: new Date(now + i),
    });
  }
  await col('jobs').insertMany(docs);
  await updateSettings({ running: true });
  await log('info', `New jobs: ${keywords.join(', ')} (${country})`);
  for (const d of docs) await activity('queued', `Search queued: "${d.keyword}" (${country})`, { projectId: d.projectId });
  return { created: docs.length };
}));

r.delete('/jobs/:id', ah(async (req) => {
  await col('jobs').deleteOne({ _id: oid(req.params.id) });
  return { ok: true };
}));

r.post('/jobs/:id/requeue', ah(async (req) => {
  await col('jobs').updateOne({ _id: oid(req.params.id) }, { $set: { phase: 'queued', createdAt: new Date() } });
  await updateSettings({ running: true });
  return { ok: true };
}));

// ---------------- settings ----------------
r.get('/settings', ah(() => getSettings()));
r.put('/settings', ah(async (req) => {
  const before = await getSettings();
  const s = await updateSettings(req.body || {});
  if ('running' in (req.body || {}) && before.running !== s.running) await activity(s.running ? 'resumed' : 'paused', s.running ? 'Resumed' : 'Paused');
  return s;
}));

// ---------------- pipeline (dashboard: what happened, what's happening now) ----------------
r.get('/pipeline', ah(async () => {
  const s = await getSettings();
  const today = startOfToday();
  const [collecting, working, queuedJobs, activityList, doneToday, pendingAll] = await Promise.all([
    col('jobs').findOne({ phase: 'collecting' }, { sort: { startedAt: -1 } }),
    col('leads').findOne({ scrapeStatus: 'working' }, { projection: { pageName: 1, pageId: 1, claimedAt: 1, projectIds: 1 } }),
    col('jobs').find({ phase: 'queued' }).sort({ createdAt: 1 }).project({ keyword: 1, country: 1 }).toArray(),
    col('activity').find({}).sort({ ts: -1 }).limit(40).toArray(),
    col('leads').countDocuments({ scrapedAt: { $gte: today } }),
    col('leads').countDocuments({ scrapeStatus: { $in: ['pending', 'working'] } }),
  ]);
  // the project shown in the step-by-step view: the one being worked on, else the newest
  const focusId =
    collecting?.projectId ||
    working?.projectIds?.[0] ||
    (await col('jobs').findOne({ projectId: { $exists: true } }, { sort: { createdAt: -1 } }))?.projectId;
  let focus = null;
  const p = focusId ? await col('projects').findOne({ _id: focusId }) : null;
  if (p) {
    const withContact = { $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] };
    const [leads, pending, failed, contact, ads, lastJob] = await Promise.all([
      col('leads').countDocuments({ projectIds: p._id }),
      col('leads').countDocuments({ projectIds: p._id, scrapeStatus: { $in: ['pending', 'working'] } }),
      col('leads').countDocuments({ projectIds: p._id, scrapeStatus: 'failed' }),
      col('leads').countDocuments({ projectIds: p._id, ...withContact }),
      col('ads').countDocuments({ projectId: p._id }),
      col('jobs').findOne({ projectId: p._id }, { sort: { createdAt: -1 } }),
    ]);
    focus = {
      id: String(p._id), name: p.name, country: p.country, leads, pending, failed, withContact: contact, ads,
      jobPhase: lastJob?.phase || 'collected', jobAds: lastJob?.adsSeen || 0, maxAds: lastJob?.maxAds || s.maxAds,
      queuedAt: lastJob?.createdAt, startedAt: lastJob?.startedAt, collectedAt: lastJob?.collectedAt,
    };
  }
  // seconds per page: delay + ~5s to open the Page link (images blocked), divided over the parallel tabs
  const perPage = ((s.delayMin + s.delayMax) / 2 + 5) / Math.max(1, s.parallel);
  const left = Math.max(0, Math.min(pendingAll, s.dailyLimit - doneToday));
  // real pace: time between the last pages that were finished (ignore long breaks)
  const lastDone = await col('leads').find({ scrapedAt: { $gte: new Date(Date.now() - 60 * 60e3) } }).sort({ scrapedAt: -1 }).limit(16).project({ scrapedAt: 1 }).toArray();
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
    collecting: collecting ? { keyword: collecting.keyword, ads: collecting.adsSeen || 0, pages: (collecting.pageIds || []).length, maxAds: collecting.maxAds } : null,
    working: working ? { name: working.pageName || working.pageId, since: working.claimedAt } : null,
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
    activity: activityList.map(({ _id, projectId, ...a }) => a),
  };
}));

// ---------------- worker (Chrome extension) ----------------
const STALE_COLLECT_MS = 10 * 60 * 1000;
const STALE_WORK_MS = 5 * 60 * 1000;

r.get('/worker/next-collect', ah(async () => {
  const s = await getSettings();
  if (!s.running) return { job: null, reason: s.pausedReason || 'paused' };
  const now = new Date();
  await col('jobs').updateMany(
    { phase: 'collecting', lastActivity: { $lt: new Date(Date.now() - STALE_COLLECT_MS) } },
    { $set: { phase: 'collected', collectedAt: now, note: 'timeout' } },
  );
  if (await col('jobs').findOne({ phase: 'collecting', manual: { $ne: true } })) return { job: null, reason: 'busy' };
  const j = await col('jobs').findOneAndUpdate(
    { phase: 'queued' },
    { $set: { phase: 'collecting', startedAt: now, lastActivity: now } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!j) return { job: null, reason: 'no-jobs' };
  await activity('collect', `Opened the Ad Library: "${j.keyword}" — collecting ads`, { projectId: j.projectId });
  return { job: { id: String(j._id), keyword: j.keyword, country: j.country, maxAds: j.maxAds || s.maxAds, minAds: j.minAds || 1, url: j.url }, closeAdTab: s.closeAdTab };
}));

r.post('/worker/manual-job', ah(async (req) => {
  const b = req.body || {};
  const s = await getSettings();
  const now = new Date();
  const keyword = String(b.keyword || '').trim() || '(page search)';
  const country = String(b.country || 'ALL').toUpperCase();
  const doc = {
    keyword, country, maxAds: Number(b.maxAds) || s.maxAds, minAds: Math.max(1, Number(b.minAds) || 1), projectId: await ensureProject(keyword, country),
    url: String(b.url || ''), phase: 'collecting', manual: true, adsSeen: 0, pageIds: [], createdAt: now, startedAt: now, lastActivity: now,
  };
  const { insertedId } = await col('jobs').insertOne(doc);
  await updateSettings({ running: true });
  await activity('collect', `Manual collect from the Ad Library: "${keyword}"`, { projectId: doc.projectId });
  return { job: { id: String(insertedId), keyword: doc.keyword, country: doc.country, maxAds: doc.maxAds, minAds: doc.minAds, url: doc.url, manual: true } };
}));

r.post('/worker/ads', ah(async (req, res) => {
  const { jobId, ads } = req.body || {};
  const job = await col('jobs').findOne({ _id: oid(jobId) });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.phase === 'stopped') return res.status(409).json({ error: 'stopped', stopped: true });
  const out = await ingestAds({ id: String(job._id), keyword: job.keyword, country: job.country, projectId: job.projectId || null }, ads);
  const pageIds = uniq((ads || []).map((a) => a && a.pageId));
  await col('jobs').updateOne(
    { _id: job._id },
    { $inc: { adsSeen: out.ads }, $addToSet: { pageIds: { $each: pageIds } }, $set: { lastActivity: new Date() } },
  );
  return out;
}));

r.get('/worker/job/:id', ah(async (req) => {
  // the extension asks this every few scrolls — also counts as "still working" (with a condition
  // no ads are sent until the scroll ends, so /worker/ads alone would look like a stuck job)
  const j = await col('jobs').findOneAndUpdate(
    { _id: oid(req.params.id) },
    [{ $set: { lastActivity: { $cond: [{ $eq: ['$phase', 'collecting'] }, '$$NOW', '$lastActivity'] } } }],
    { projection: { phase: 1 }, returnDocument: 'after' },
  );
  return { phase: j ? j.phase : 'stopped' };
}));

r.post('/worker/collect-done', ah(async (req) => {
  const { jobId, reason, stats } = req.body || {};
  const set = { phase: 'collected', collectedAt: new Date(), note: reason || '' };
  if (stats && typeof stats === 'object') {
    set.captured = Number(stats.captured) || 0; // ads seen while scrolling
    set.pagesTotal = Number(stats.pagesTotal) || 0; // pages among them
    set.pagesMatched = Number(stats.pagesMatched) || 0; // pages that met the condition
    set.minAds = Math.max(1, Number(stats.minAds) || 1);
  }
  const r = await col('jobs').findOneAndUpdate({ _id: oid(jobId), phase: 'collecting' }, { $set: set }, { returnDocument: 'after' });
  if (r) {
    const pages = (r.pageIds || []).length;
    const closed = reason === 'tab closed' ? ' (tab was closed)' : '';
    const msg =
      r.minAds > 1
        ? `"${r.keyword}" collected — ${r.captured} ads; ${r.pagesMatched} of ${r.pagesTotal} pages run ${r.minAds}+ ads. Only those were kept${closed}`
        : `"${r.keyword}" collected — ${pages} pages from ${r.adsSeen || 0} ads${closed}`;
    await activity('collected', msg, { projectId: r.projectId });
  }
  return { ok: true };
}));

r.get('/worker/next-scrape', ah(async (req) => {
  const s = await getSettings();
  if (!s.running) return { lead: null, reason: s.pausedReason || 'paused', parallel: s.parallel };
  // extra worker tabs beyond the "parallel" setting stay idle
  if (Number(req.query.slot) >= s.parallel) return { lead: null, reason: 'slot-off', parallel: s.parallel };
  const doneToday = await col('leads').countDocuments({ scrapedAt: { $gte: startOfToday() } });
  if (doneToday >= s.dailyLimit) return { lead: null, reason: 'daily-limit', doneToday, parallel: s.parallel };
  await col('leads').updateMany(
    { scrapeStatus: 'working', claimedAt: { $lt: new Date(Date.now() - STALE_WORK_MS) } },
    { $set: { scrapeStatus: 'pending' } },
  );
  const l = await col('leads').findOneAndUpdate(
    { scrapeStatus: 'pending' },
    { $set: { scrapeStatus: 'working', claimedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!l) return { lead: null, reason: 'queue-empty', doneToday, parallel: s.parallel };
  return { lead: { pageId: l.pageId, pageName: l.pageName, url: mainUrl(l) || aboutUrl(l), mainUrl: mainUrl(l) }, delayMin: s.delayMin, delayMax: s.delayMax, parallel: s.parallel, fullDetails: s.fullDetails, doneToday, dailyLimit: s.dailyLimit };
}));

r.post('/worker/result', ah(async (req) => {
  const { pageId, result } = req.body || {};
  await applyResult(String(pageId), result || {});
  const l = await col('leads').findOne({ pageId: String(pageId) }, { projection: { pageName: 1, phones: 1, emails: 1, whatsapp: 1, scrapeStatus: 1, lastError: 1, projectIds: 1 } });
  if (l) {
    const found = [l.phones?.length && `${l.phones.length} phone`, l.whatsapp?.length && 'WhatsApp', l.emails?.length && `${l.emails.length} email`].filter(Boolean);
    const name = l.pageName || pageId;
    if (l.scrapeStatus === 'done') await activity(found.length ? 'found' : 'empty', found.length ? `${name} — found ${found.join(', ')}` : `${name} — no contact info`, { projectId: l.projectIds?.[0] });
    else if (l.scrapeStatus === 'failed') await activity('failed', `${name} — could not be read after 3 tries (${l.lastError})`, { projectId: l.projectIds?.[0] });
  }
  return { ok: true };
}));

r.post('/worker/blocked', ah(async (req) => {
  const { pageId, reason } = req.body || {};
  if (pageId) await col('leads').updateOne({ pageId: String(pageId) }, { $set: { scrapeStatus: 'pending' } });
  await updateSettings({ running: false, pausedReason: reason || 'blocked' });
  await log('error', `Paused: ${reason || 'blocked'}`);
  await activity('paused', `Paused: ${reason || 'blocked'}`);
  return { ok: true };
}));

// ---------------- export ----------------
async function exportData(query) {
  const leads = await col('leads').find(buildFilter(query)).sort(buildSort(query.sort, query.dir)).toArray();
  const ads = await col('ads').find({ pageId: { $in: leads.map((l) => l.pageId) } }).sort({ pageId: 1 }).toArray();
  return { leads, ads };
}

const stamp = () => new Date().toISOString().slice(0, 10);

r.get('/export.xlsx', ah(async (req, res) => {
  const { leads, ads } = await exportData(req.query);
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

r.get('/export.csv', ah(async (req, res) => {
  const { leads } = await exportData(req.query);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [LEAD_HEADERS, ...leads.map(leadRow)].map((row) => row.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fb-leads-${stamp()}.csv"`);
  res.send('﻿' + csv);
}));

// ---------------- google sheet ----------------
r.post('/sheet/test', ah(() => testSheet()));
r.post('/sheet/sync', ah((req) => syncSheet(Boolean(req.body?.all))));
r.post('/sheet/pull', ah(() => pullSheet()));

// ---------------- logs ----------------
r.get('/logs', ah(() => col('logs').find({}).sort({ ts: -1 }).limit(300).toArray()));
r.delete('/logs', ah(async () => {
  await col('logs').deleteMany({});
  return { ok: true };
}));

export default r;
