// API for logged-in users. Everything is limited to the user's own workspace (req.ws).
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import ExcelJS from 'exceljs';
import { activity, col, httpError } from './db.js';
import { createExtensionKey, isAdmin } from './auth.js';
import { clampMaxAds, getSettings, getWsSettings, updateSettings, updateWsSettings } from './settings.js';
import { AD_HEADERS, CONTACT_KINDS, LEAD_HEADERS, OVERRIDABLE, STATUSES, adRow, buildFilter, ingestAds, leadRow, leadsCursor, syncLeads } from './leads.js';
import { pullSheet, syncSheet, testSheet } from './sheets.js';
import { deleteLeads, ensureProject, oid, queuePages, stopPages } from './projects.js';
import { isOutdated, worker as workerState, workerInfo } from './worker-state.js';
import { allProxies, forgetOldProxies, isBadIp, proxyGroups, proxyPool, proxyStatus } from './proxies.js';
import { getPc, listPcs, pcName, pcNames, updatePc } from './pcs.js';
import { accountOf, hasCredits, requirePerk } from './billing.js';
import { listInbox, markRead, unreadCount } from './inbox.js';
import { getSmtp, parseRecipients, prefsOf, saveSmtp, sendTest, smtpPublic, smtpReady, vapidKeys } from './notify.js';
import { MIN_COLLECT_VERSION, canCollect, serverReads } from './worker.js';
import { serverReaderLanes, serverReaderNow } from './serverReader.js';
import { engineHealth } from './health.js';
import { adLibraryUrl, cleanAdFilters, cleanEmails, startOfToday, uniq, uniqPhones } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

const jobDTO = (j) => ({ ...j, id: String(j._id), _id: undefined, workspaceId: undefined, userId: undefined, pageIds: undefined, pageCount: (j.pageIds || []).length });
const withContact = { $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] };
const visitsToday = () => col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } });
/** When the worker is taking a break after a Facebook login wall: the time it continues, else null. */
const activeCooldown = (s) => (s.cooldownUntil && new Date(s.cooldownUntil) > new Date() ? s.cooldownUntil : null);

/**
 * Daily search limit per workspace (admins have none). Uses up `n` searches of today's allowance in one
 * atomic step — a counter on the workspace, so deleting searches doesn't give them back and parallel
 * requests can't slip past the limit.
 */
export async function checkSearchQuota(req, n) {
  if (isAdmin(req)) return;
  // the plan decides (billing.js): an email to verify first, credits left, searches per day
  if (req.user && req.user.emailVerified === false) throw httpError(403, 'Verify your email address first — we sent you a link (Settings → Account to send it again).');
  const acc = await accountOf(req.ws);
  if (!hasCredits(acc)) throw httpError(402, 'You have no credits left. Buy credits or upgrade your plan (Billing) to search again.');
  const day = startOfToday().toISOString();
  await col('workspaces').updateOne({ _id: req.ws, 'usage.day': { $ne: day } }, { $set: { usage: { day, searches: 0 } } });
  const limit = acc.searchesPerDay;
  const ok = await col('workspaces').findOneAndUpdate(
    { _id: req.ws, 'usage.day': day, $expr: { $lte: [{ $add: ['$usage.searches', n] }, limit] } },
    { $inc: { 'usage.searches': n } },
  );
  if (!ok) {
    const used = (await col('workspaces').findOne({ _id: req.ws }, { projection: { usage: 1 } }))?.usage?.searches || 0;
    throw httpError(429, `Daily search limit of your plan reached (${used} of ${limit} used today). Try again tomorrow, or upgrade your plan.`);
  }
}

// ---------------- stats ----------------
// "Pages read today" opened up: the same pages, split by the search (keyword) they came from. Each page counts
// for the newest search that found it, so the rows add up to exactly the total in the sidebar.
r.get('/stats/today', ah(async (req) => {
  const today = startOfToday();
  if (!isAdmin(req)) {
    // a customer: the pages read for them today (each one = 1 credit), by keyword
    const rows = await col('leads')
      .aggregate([
        { $match: { workspaceId: req.ws, chargedAt: { $gte: today } } },
        {
          $group: {
            _id: { $arrayElemAt: ['$keywords', 0] },
            pages: { $sum: 1 },
            contacts: { $sum: { $cond: [{ $or: [{ $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$whatsapp', []] } }, 0] }] }, 1, 0] } },
            projectId: { $first: { $arrayElemAt: ['$projectIds', 0] } },
          },
        },
        { $sort: { pages: -1 } },
      ])
      .toArray();
    return {
      total: rows.reduce((a, x) => a + x.pages, 0),
      keywords: rows.map((x) => ({ keyword: x._id || '—', country: '', projectId: x.projectId ? String(x.projectId) : null, pages: x.pages, contacts: x.contacts, failed: 0 })),
      other: null,
    };
  }
  const pages = await col('pages')
    .find({ lastAttemptAt: { $gte: today } })
    .project({ pageId: 1, scrapeStatus: 1, phones: 1, emails: 1, whatsapp: 1 })
    .toArray();
  const jobs = await col('jobs')
    .find({ createdAt: { $gte: new Date(today.getTime() - 14 * 86400e3) }, ...(isAdmin(req) ? {} : { workspaceId: req.ws }) })
    .sort({ createdAt: 1 })
    .project({ keyword: 1, country: 1, pageIds: 1, workspaceId: 1, projectId: 1 })
    .toArray();
  const owner = new Map(); // pageId → job (the newest one wins)
  for (const j of jobs) for (const p of j.pageIds || []) owner.set(p, j);
  const rows = new Map();
  const other = { pages: 0, contacts: 0 };
  for (const p of pages) {
    const has = (p.phones?.length || p.emails?.length || p.whatsapp?.length) ? 1 : 0;
    const j = owner.get(p.pageId);
    if (!j) {
      other.pages++;
      other.contacts += has;
      continue;
    }
    const key = `${j.keyword.trim().toLowerCase()}|${j.country}`;
    if (!rows.has(key)) rows.set(key, { keyword: j.keyword.trim(), country: j.country, projectId: j.projectId ? String(j.projectId) : null, pages: 0, contacts: 0, failed: 0 });
    const r2 = rows.get(key);
    r2.pages++;
    r2.contacts += has;
    if (p.scrapeStatus === 'failed') r2.failed++;
  }
  const list = [...rows.values()].sort((a, b) => b.pages - a.pages);
  return { total: pages.length, keywords: list, other: other.pages ? other : null };
}));

// The big totals (all leads, with email, with phone, contacted) read every lead of the account. The dashboard
// asks for /stats every few seconds from every open tab, so they are counted at most once a minute per account.
const bigCounts = new Map();
async function slowTotals(ws) {
  const hit = bigCounts.get(String(ws));
  if (hit && Date.now() - hit.at < 60e3) return hit.value;
  const L = col('leads');
  const [total, withEmail, withPhone, contacted] = await Promise.all([
    L.countDocuments({ workspaceId: ws }),
    L.countDocuments({ workspaceId: ws, 'emails.0': { $exists: true } }),
    L.countDocuments({ workspaceId: ws, $or: [{ 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] }),
    L.countDocuments({ workspaceId: ws, status: { $nin: ['New', null] } }),
  ]);
  const value = { total, withEmail, withPhone, contacted };
  bigCounts.set(String(ws), { at: Date.now(), value });
  if (bigCounts.size > 5000) bigCounts.clear();
  return value;
}

r.get('/stats', ah(async (req) => {
  const ws = req.ws;
  const L = col('leads');
  const today = startOfToday();
  const [{ total, withEmail, withPhone, contacted }, pending, failed, scrapedToday, queuedJobs, collecting, visits, settings] = await Promise.all([
    slowTotals(ws),
    L.countDocuments({ workspaceId: ws, scrapeStatus: { $in: ['pending', 'working'] } }),
    L.countDocuments({ workspaceId: ws, scrapeStatus: 'failed' }),
    L.countDocuments({ workspaceId: ws, scrapedAt: { $gte: today } }),
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
  const admin = isAdmin(req);
  // a customer: pages read for THEM today (= credits used today), and their own extension
  const myToday = admin ? 0 : await L.countDocuments({ workspaceId: ws, chargedAt: { $gte: today } });
  const myPc = admin ? null : await col('pcs').findOne({ workspaceId: ws }, { sort: { lastSeen: -1 } });
  // the extension that would take this account's searches is too old to get any (worker.js MIN_COLLECT_VERSION)
  const pcOwner = admin ? { $or: [{ workspaceId: ws }, { workspaceId: null }] } : { workspaceId: ws };
  const latestPcs = await col('pcs').find({ ...pcOwner, lastSeen: { $gt: new Date(Date.now() - 5 * 60e3) } }).project({ version: 1, waitWhy: 1, waitUntil: 1, takeQueue: 1 }).toArray();
  // the computer that runs this account's searches is taking a break (worker.js: gap between searches / rest)
  const waiting = latestPcs.find((p) => p.takeQueue !== false && p.waitWhy && p.waitUntil && new Date(p.waitUntil) > new Date());
  const updateNeeded = latestPcs.length > 0 && !latestPcs.some((p) => canCollect(p.version));
  // a customer's own computer on an older extension than the latest (it still works) — their own reminder
  const myOld = admin ? [] : latestPcs.filter((p) => isOutdated(p.version));
  return {
    total, withEmail, withPhone, pending, failed, scrapedToday, contacted, queuedJobs, collecting, active, activeName,
    worker: admin ? await workerInfo(ws) : myPc ? { version: myPc.version, seenAgo: Math.round((Date.now() - new Date(myPc.lastSeen).getTime()) / 1000), mine: true } : null,
    account: await accountOf(ws),
    queueWait: waiting ? { why: waiting.waitWhy, until: waiting.waitUntil } : null,
    extensionUpdate: updateNeeded ? { min: MIN_COLLECT_VERSION, running: [...new Set(latestPcs.map((p) => p.version))].join(', ') } : null,
    extensionOld: myOld.length ? { running: [...new Set(myOld.map((p) => p.version))].join(', '), latest: workerState.latest } : null,
    inboxUnread: await unreadCount(req.user), // the bell's red number
    // the team: the shared daily page limit for the whole server; a customer: their own pages today
    workerVisitsToday: admin ? visits : myToday,
    running: settings.running, pausedReason: settings.pausedReason, dailyLimit: admin ? settings.dailyLimit : null,
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
  countries: (await col('leads').distinct('country', { workspaceId: req.ws })).filter(Boolean).sort(),
  statuses: STATUSES,
})));

// ---------------- leads ----------------
r.get('/leads', ah(async (req) => {
  const per = Math.min(200, Math.max(1, Number(req.query.per) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const [items, total] = await Promise.all([
    leadsCursor(req.ws, req.query, { skip: (page - 1) * per, limit: per }).toArray(),
    col('leads').countDocuments(buildFilter(req.ws, req.query)),
  ]);
  return { items, total, page, per };
}));

// the numbers on the filter chips: with every other filter applied, how many have a phone, an email…
r.get('/leads/counts', ah(async (req) => {
  const { need, has, ...rest } = req.query;
  const base = buildFilter(req.ws, rest);
  const counts = await Promise.all(Object.values(CONTACT_KINDS).map((c) => col('leads').countDocuments({ $and: [...base.$and, c] })));
  return Object.fromEntries(Object.keys(CONTACT_KINDS).map((k, i) => [k, counts[i]]));
}));

r.get('/leads/:id', ah(async (req, res) => {
  const lead = await col('leads').findOne({ workspaceId: req.ws, pageId: String(req.params.id) });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const ads = await col('ads').find({ pageId: lead.pageId }).sort({ startDate: -1 }).limit(200).toArray();
  // ads are shared: show only this workspace's own keywords, never what other users searched for
  const mine = new Set(lead.keywords || []);
  const own = (a) => {
    const { keywords = [], keyword, projectIds, ...rest } = a;
    return { ...rest, keyword: [keyword, ...keywords].find((k) => mine.has(k)) || '' };
  };
  return { lead, ads: ads.map(own) };
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
  const names = await pcNames();
  return jobs.map((j) => {
    const c = counts.get(String(j._id)) || {};
    return {
      ...jobDTO(j), projectId: j.projectId ? String(j.projectId) : null, scraped: c.scraped || 0, withContact: c.withContact || 0, pending: c.pending || 0,
      // which computer collected it: for the team only (a customer sees what was found, not where)
      pc: isAdmin(req) && j.collector ? names.get(j.collector) || null : null,
      ...(isAdmin(req) ? {} : { stuckNote: j.stuckNote ? 'stuck' : '', collector: undefined }),
    };
  });
}));

// ---------------- the computers running the extension (pcs.js) ----------------
// the team sees every computer; a customer only the ones connected to their account
const pcScope = (req) => (isAdmin(req) ? null : req.ws);
const ownPc = async (req) => {
  const pc = await getPc(String(req.params.id));
  if (!pc || (!isAdmin(req) && String(pc.workspaceId) !== String(req.ws))) throw httpError(404, 'Computer not found');
  return pc;
};
r.get('/pcs', ah(async (req) => listPcs(pcScope(req))));
r.put('/pcs/:id', ah(async (req) => {
  await ownPc(req);
  await updatePc(req.params.id, req.body || {});
  return listPcs(pcScope(req));
}));
r.delete('/pcs/:id', ah(async (req) => {
  await ownPc(req);
  await col('pcs').deleteOne({ _id: String(req.params.id) });
  return listPcs(pcScope(req));
}));

// ---------------- the customer's own extension keys (auth.js: requireWorker) ----------------
r.get('/extension/keys', ah(async (req) =>
  (await col('extokens').find({ userId: req.user._id }).sort({ createdAt: -1 }).toArray()).map((t) => ({ id: t._id.slice(0, 16), label: t.label, hint: t.hint, createdAt: t.createdAt, lastUsed: t.lastUsed })),
));
r.post('/extension/keys', ah(async (req) => {
  if ((await col('extokens').countDocuments({ userId: req.user._id })) >= 10) throw httpError(400, 'At most 10 connected extensions — remove an old one first');
  return { key: await createExtensionKey(req.user, req.body?.label || String(req.get('user-agent') || '').match(/(Chrome|Edg|Firefox)\/[\d]+/)?.[0] || 'Chrome') };
}));
r.delete('/extension/keys/:id', ah(async (req) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{16}$/.test(id)) throw httpError(400, 'Bad key');
  await col('extokens').deleteOne({ userId: req.user._id, _id: { $regex: `^${id}` } });
  return { ok: true };
}));

r.post('/jobs', ah(async (req) => {
  const b = req.body || {};
  const s = await getSettings();
  const asked = uniq(Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,\n]/)).map((k) => k.slice(0, 200)).slice(0, 50);
  if (!asked.length) throw httpError(400, 'Enter at least one keyword');
  const country = String(b.country || 'BD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'BD';
  // a keyword that is already waiting or collecting (same country) is not added again — pressing Start twice
  // used to collect the same ads twice and push every other search back
  const running = await col('jobs')
    .find({ workspaceId: req.ws, country, phase: { $in: ['queued', 'collecting'] } })
    .project({ keyword: 1 })
    .toArray();
  const busy = new Set(running.map((j) => j.keyword.trim().toLowerCase()));
  const keywords = asked.filter((k) => !busy.has(k.trim().toLowerCase()));
  const skipped = asked.filter((k) => busy.has(k.trim().toLowerCase()));
  if (!keywords.length) return { created: 0, skipped };
  await checkSearchQuota(req, keywords.length);
  // the plan's ceiling — and "only pages with N+ ads" only on a plan that has it
  const acc = await accountOf(req.ws);
  const maxAds = Math.min(clampMaxAds(b.maxAds, acc.unlimited ? s.maxAds : acc.maxAdsPerSearch), acc.maxAdsPerSearch);
  const minAds = acc.minAdsFilter ? Math.max(1, Math.round(Number(b.minAds) || 1)) : 1;
  const filters = cleanAdFilters(b.filters); // the Ad Library's own filters and sort — built into its link
  const now = Date.now();
  const docs = [];
  for (const [i, keyword] of keywords.entries()) {
    docs.push({
      workspaceId: req.ws, userId: req.user._id, keyword, country, maxAds, minAds, filters, url: adLibraryUrl(keyword, country, filters), phase: 'queued', manual: false,
      adsSeen: 0, pageIds: [], projectId: await ensureProject(req.ws, keyword, country), createdAt: new Date(now + i),
    });
  }
  await col('jobs').insertMany(docs);
  for (const d of docs) await activity('queued', `Search queued: "${d.keyword}" (${country})`, { workspaceId: req.ws, projectId: d.projectId });
  return { created: docs.length, skipped };
}));

r.delete('/jobs/:id', ah(async (req) => {
  await col('jobs').deleteOne({ _id: oid(req.params.id), workspaceId: req.ws, phase: { $ne: 'collecting' } });
  return { ok: true };
}));

// stop one search: waiting → never starts; collecting → the extension sees "stopped" within a few scrolls.
// Ads and pages already found stay (and their pages are still read).
r.post('/jobs/:id/stop', ah(async (req) => {
  const r2 = await col('jobs').findOneAndUpdate(
    { _id: oid(req.params.id), workspaceId: req.ws, phase: { $in: ['queued', 'collecting'] } },
    { $set: { phase: 'stopped', stoppedAt: new Date() } },
  );
  if (!r2) throw httpError(409, 'This search is not waiting or collecting any more');
  await activity('stopped', `Stopped the search "${r2.keyword}"`, { workspaceId: req.ws, projectId: r2.projectId });
  return { ok: true };
}));

r.post('/jobs/:id/requeue', ah(async (req) => {
  const j = await col('jobs').findOne({ _id: oid(req.params.id), workspaceId: req.ws });
  if (!j) throw httpError(404, 'Search not found');
  if (['queued', 'collecting'].includes(j.phase)) throw httpError(409, 'This search is already running');
  await checkSearchQuota(req, 1);
  await col('jobs').updateOne({ _id: j._id }, { $set: { phase: 'queued', createdAt: new Date(), adsSeen: 0 }, $unset: { collectedAt: '', stoppedAt: '', note: '', notifiedAt: '' } });
  return { ok: true };
}));

// ---------------- settings ----------------
const workerPublic = (s) => ({ running: s.running, pausedReason: s.pausedReason, dailyLimit: s.dailyLimit, maxAds: s.maxAds, cooldownUntil: activeCooldown(s), proxyEnabled: Boolean(s.proxyEnabled) });

const settingsDTO = async (req, s) => ({
  workspace: await getWsSettings(req.ws),
  worker: isAdmin(req) ? s : workerPublic(s),
  isAdmin: isAdmin(req),
  ...(isAdmin(req) ? { proxyStatus: await proxyStatus(s), proxyGroups: await proxyGroups(s) } : {}),
});

r.get('/settings', ah(async (req) => settingsDTO(req, await getSettings())));

// ---------------- the bell: the in-app notification box (inbox.js) ----------------
r.get('/inbox', ah(async (req) => {
  const user = await col('users').findOne({ _id: req.user._id });
  return { items: await listInbox(user), unread: await unreadCount(user) };
}));
r.post('/inbox/read', ah(async (req) => {
  await markRead(req.user);
  return { ok: true };
}));

// ---------------- notifications: "your search is ready" by email + push (notify.js) ----------------
const notifyDTO = async (req) => {
  const s = await getSmtp();
  const u = await col('users').findOne({ _id: req.user._id });
  return {
    prefs: prefsOf(u),
    loginEmail: u.email,
    emailReady: smtpReady(s),
    vapidPublicKey: (await vapidKeys()).publicKey,
    devices: await col('pushsubs').countDocuments({ userId: req.user._id }),
    isAdmin: isAdmin(req),
    ...(isAdmin(req) ? { smtp: smtpPublic(s) } : {}),
  };
};
r.get('/notify', ah(async (req) => notifyDTO(req)));
r.put('/notify/prefs', ah(async (req) => {
  const b = req.body || {};
  const to = parseRecipients(b.to);
  await col('users').updateOne({ _id: req.user._id }, { $set: { notify: { email: b.email !== false, push: b.push !== false, to } } });
  return notifyDTO(req);
}));
r.put('/notify/smtp', ah(async (req) => {
  if (!isAdmin(req)) throw httpError(403, 'Only an admin can set up email');
  await saveSmtp(req.body || {});
  return notifyDTO(req);
}));
// a browser that allowed notifications: remember where to push
r.post('/notify/subscribe', ah(async (req) => {
  await requirePerk(req.ws, 'notifications');
  const sub = req.body?.subscription || {};
  const endpoint = String(sub.endpoint || '');
  if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw httpError(400, 'Not a push subscription');
  await col('pushsubs').updateOne(
    { endpoint },
    { $set: { endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, userId: req.user._id, workspaceId: req.ws, ua: String(req.get('user-agent') || '').slice(0, 200), at: new Date() } },
    { upsert: true },
  );
  return notifyDTO(req);
}));
r.post('/notify/unsubscribe', ah(async (req) => {
  await col('pushsubs').deleteOne({ endpoint: String(req.body?.endpoint || ''), userId: req.user._id });
  return notifyDTO(req);
}));
r.post('/notify/test', ah(async (req) => {
  await requirePerk(req.ws, 'notifications');
  return sendTest(await col('users').findOne({ _id: req.user._id }));
}));

r.put('/settings', ah(async (req) => {
  const b = req.body || {};
  if (b.worker && Object.keys(b.worker).length) {
    if (!isAdmin(req)) throw httpError(403, 'Only an admin can change the worker settings');
    const before = await getSettings();
    const s = await updateSettings(b.worker);
    // a new proxy list: forget the IPs that are in neither list any more (their counts would only confuse) —
    // a group that is only switched off keeps its counts
    const all = allProxies(s);
    if (('proxyList' in b.worker || 'resiList' in b.worker) && all.length) await forgetOldProxies(all);
    if ('running' in b.worker && before.running !== s.running) await activity(s.running ? 'resumed' : 'paused', s.running ? 'Resumed' : 'Paused');
  }
  if (b.workspace) await updateWsSettings(req.ws, b.workspace);
  return settingsDTO(req, await getSettings());
}));

// ---------------- pipeline (dashboard: what happened, what's happening now) ----------------
r.get('/pipeline', ah(async (req) => {
  const ws = req.ws;
  const s = await getSettings();
  const [collecting, working, queuedJobs, activityList, doneToday, pendingAll] = await Promise.all([
    col('jobs').findOne({ workspaceId: ws, phase: 'collecting' }, { sort: { startedAt: -1 } }),
    col('leads').findOne({ workspaceId: ws, scrapeStatus: 'working' }, { projection: { pageName: 1, pageId: 1, projectIds: 1 } }),
    col('jobs').find({ workspaceId: ws, phase: 'queued' }).sort({ createdAt: 1 }).project({ keyword: 1, country: 1 }).toArray(),
    // engine-wide lines (proxy, breaks …) are for the team only
    col('activity').find({ workspaceId: isAdmin(req) ? { $in: [ws, null] } : ws }).sort({ ts: -1 }).limit(40).toArray(),
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
  // who reads the pages: the server through the proxy list, or Chrome
  const pool = proxyPool(s);
  const ipStates = await col('proxystate').find({ _id: { $in: pool.map((p) => p.id) } }).toArray();
  const ipRest = ipStates.filter((x) => x.wallUntil && new Date(x.wallUntil) > new Date());
  // bad IPs rest 12 h at a time — counted apart from the short, normal rests (see the dashboard's IP bar)
  const ipBad = ipStates.filter(isBadIp).length;
  const ipRestingGood = ipRest.filter((x) => !isBadIp(x)).length;
  const server = serverReads(s, pool)
    ? {
        lanes: serverReaderLanes(),
        ips: pool.length,
        resting: ipRest.length,
        bad: ipBad,
        restingGood: ipRestingGood,
        nextIpAt: ipRest.length ? new Date(Math.min(...ipRest.map((x) => new Date(x.wallUntil).getTime()))) : null,
        forChrome: await col('pages').countDocuments({ scrapeStatus: 'pending', needsBrowser: true }),
        chromeWaitUntil: s.browserCooldownUntil && new Date(s.browserCooldownUntil) > new Date() ? s.browserCooldownUntil : null,
      }
    : null;
  // the live board: who reads what right now, the last pages read (this workspace), and the pace
  const [recentLeads, last5] = await Promise.all([
    col('leads')
      .find({ workspaceId: ws, scrapedAt: { $gte: new Date(Date.now() - 30 * 60e3) } })
      .sort({ scrapedAt: -1 })
      .limit(10)
      .project({ pageName: 1, pageId: 1, phones: 1, emails: 1, whatsapp: 1, scrapeStatus: 1, lastError: 1, scrapedAt: 1, category: 1 })
      .toArray(),
    col('leads').countDocuments({ workspaceId: ws, scrapedAt: { $gte: new Date(Date.now() - 5 * 60e3) } }),
  ]);
  const live = {
    lanes: server ? serverReaderNow() : working ? [{ lane: 1, page: working.pageName || working.pageId, ip: 'Chrome', sec: null }] : [],
    perMin: Math.round((last5 / 5) * 10) / 10,
    recent: recentLeads.map((l) => ({
      id: l.pageId,
      name: l.pageName || l.pageId,
      category: l.category || '',
      phones: (l.phones || []).length,
      emails: (l.emails || []).length,
      whatsapp: (l.whatsapp || []).length,
      outcome: l.scrapeStatus === 'failed' ? 'failed' : l.lastError === 'Page not available' ? 'unavailable' : (l.phones || []).length || (l.emails || []).length || (l.whatsapp || []).length ? 'contact' : 'none',
      at: l.scrapedAt,
    })),
  };
  // a customer sees only their own work: no proxy IPs, no other customers' pages being read, no engine health —
  // instead what THEY can act on (credits, email, their extension)
  const admin = isAdmin(req);
  const account = await accountOf(ws);
  const myPcs = admin ? [] : await col('pcs').find({ workspaceId: ws, lastSeen: { $gte: new Date(Date.now() - 2 * 60e3) } }).project({ _id: 1 }).toArray();
  const customerHealth = [];
  if (!admin) {
    if (!account.unlimited && account.credits <= -account.overdraft) {
      customerHealth.push({ level: 'warn', key: 'no-credits', title: `Your balance is ${account.credits} — reading has stopped`, detail: pendingAll ? `${pendingAll} pages are waiting and will be read as soon as you add credits (the minus is paid back first).` : 'New searches start again once you add credits.', fix: 'Billing → buy credits or upgrade your plan' });
    } else if (!hasCredits(account)) {
      customerHealth.push({ level: 'warn', key: 'overdraft', title: account.credits < 0 ? `Your balance is ${account.credits} — running on credit` : 'You have no credits left', detail: `A search that is already running goes on down to -${account.overdraft}, then stops. New searches need credits. The minus is paid back from your next credits.`, fix: 'Billing → buy credits or upgrade your plan' });
    }
    else if (account.credits < 50 && !account.unlimited) customerHealth.push({ level: 'info', key: 'low-credits', title: `Only ${account.credits} credits left`, detail: '1 credit = 1 page read.', fix: 'Billing → buy credits' });
    if (req.user.emailVerified === false) customerHealth.push({ level: 'warn', key: 'verify', title: 'Confirm your email address', detail: 'We sent you a link. Searches start once your email is confirmed.', fix: 'Settings → Account → send the link again' });
    const myOldPcs = await col('pcs').find({ workspaceId: ws, lastSeen: { $gte: new Date(Date.now() - 5 * 60e3) } }).project({ version: 1 }).toArray();
    const oldVersions = [...new Set(myOldPcs.filter((p) => isOutdated(p.version)).map((p) => p.version))];
    if (oldVersions.length) customerHealth.push({ level: 'warn', key: 'extension-old', title: `Your Chrome extension is out of date (${oldVersions.join(', ')})`, detail: `The latest is ${workerState.latest}. It still works, but update it to get the latest fixes.`, fix: 'Connect extension page → download the new ZIP → put it in the same folder → chrome://extensions → Reload' });
    if ((queuedJobs.length || collecting) && !myPcs.length) customerHealth.push({ level: 'warn', key: 'no-extension', title: 'Your Chrome extension is not connected', detail: 'Your searches run in your own Chrome — they wait until the extension is installed and connected.', fix: 'Settings → Extension → connect' });
  }
  return {
    server: admin ? server : null,
    live: admin ? live : { ...live, lanes: [] },
    health: admin ? await engineHealth(s, ws) : customerHealth,
    account,
    extensionConnected: admin ? true : myPcs.length > 0,
    running: s.running,
    pausedReason: s.pausedReason,
    cooldownUntil: activeCooldown(s),
    cooldownReason: activeCooldown(s) ? s.cooldownReason || '' : '',
    collecting: collecting
      ? {
          keyword: collecting.keyword, ads: collecting.adsSeen || 0, pages: (collecting.pageIds || []).length, maxAds: collecting.maxAds,
          silentSec: Math.round((Date.now() - new Date(collecting.lastActivity || collecting.startedAt || Date.now()).getTime()) / 1000),
          pc: isAdmin(req) && collecting.collector ? pcName(await getPc(collecting.collector)) : null,
          tabHidden: !!collecting.tabHidden,
        }
      : null,
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
    worker: admin ? await workerInfo(ws) : null,
    activity: activityList.map(({ _id, projectId, workspaceId, ...a }) => a),
  };
}));

// ---------------- export ----------------
// Streamed row by row (a big workspace must not have to fit in the server's memory).
const EXPORT_MAX = 100000;
const leadCursor = (ws, query) => leadsCursor(ws, query, { limit: EXPORT_MAX });

const stamp = () => new Date().toISOString().slice(0, 10);

r.get('/export.xlsx', ah(async (req, res) => {
  await requirePerk(req.ws, 'excelExport'); // CSV is for every plan, Excel for the paid ones
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="fb-leads-${stamp()}.xlsx"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  wb.creator = 'FB Ad Lead Finder';
  const addSheet = (name, headers, widths) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = headers.map((_, i) => ({ width: widths[i] || 16 }));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    const head = ws.addRow(headers);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    head.commit();
    return (row) => {
      const added = ws.addRow(row);
      added.eachCell((cell) => {
        if (typeof cell.value === 'string' && /^https?:\/\//.test(cell.value) && !cell.value.includes(', ')) {
          cell.value = { text: cell.value, hyperlink: cell.value };
          cell.font = { color: { argb: 'FF0563C1' }, underline: true };
        }
      });
      added.commit();
    };
  };
  const addLead = addSheet('Leads', LEAD_HEADERS, [18, 28, 36, 22, 22, 18, 30, 30, 30, 30, 40, 50, 18, 10, 30, 30, 16, 40, 11, 11, 10, 20, 40, 50, 40, 14, 30, 12, 17]);
  const pageIds = [];
  for await (const l of leadCursor(req.ws, req.query)) {
    addLead(leadRow(l));
    pageIds.push(l.pageId);
  }
  const addAd = addSheet('Ads', AD_HEADERS, [18, 18, 28, 60, 30, 40, 16, 12, 20, 16, 40]);
  for (let i = 0; i < pageIds.length; i += 1000) {
    for await (const a of col('ads').find({ pageId: { $in: pageIds.slice(i, i + 1000) } }).sort({ pageId: 1 })) addAd(adRow(a));
  }
  await wb.commit();
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
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fb-leads-${stamp()}.csv"`);
  const line = (row) => row.map(csvCell).join(',') + '\r\n';
  res.write('﻿' + line(LEAD_HEADERS));
  for await (const l of leadCursor(req.ws, req.query)) {
    if (!res.write(line(leadRow(l)))) await once(res, 'drain');
  }
  res.end();
}));

// ---------------- google sheet ----------------
// Google Sheet sync — a perk of the bigger plans
r.post('/sheet/test', ah(async (req) => (await requirePerk(req.ws, 'sheetSync'), testSheet(req.ws))));
r.post('/sheet/sync', ah(async (req) => (await requirePerk(req.ws, 'sheetSync'), syncSheet(req.ws, Boolean(req.body?.all)))));
r.post('/sheet/pull', ah(async (req) => (await requirePerk(req.ws, 'sheetSync'), pullSheet(req.ws))));

// used by the dev tools only: ingest from a JSON file of ads (admin)
r.post('/dev/ingest', ah(async (req) => {
  if (!isAdmin(req)) throw httpError(403, 'Only an admin can do this');
  const { keyword = 'test', country = 'BD', ads = [] } = req.body || {};
  const projectId = await ensureProject(req.ws, keyword, country);
  return ingestAds({ id: 'dev', workspaceId: req.ws, keyword, country, projectId }, ads);
}));

export default r;
