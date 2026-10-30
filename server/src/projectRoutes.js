import express from 'express';
import ExcelJS from 'exceljs';
import { activity, col, httpError } from './db.js';
import { adLibraryUrl, cleanAdFilters } from './util.js';
import { insightsList, insightsView, projectInsights } from './insights.js';
import { sendInsightsWorkbook } from './insightsExcel.js';
import { clampMaxAds, getSettings } from './settings.js';
import { accountOf, requirePerk } from './billing.js';
import { checkSearchQuota } from './routes.js';
import { kickAdlibCollector } from './adlibCollector.js';
import { deleteProject, deleteSheetDocs, itemCount, loadSheet, oid, projectStats, queuePages, saveSheet } from './projects.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });

const itemDTO = async (it) => ({
  id: String(it._id), projectId: String(it.projectId), parentId: it.parentId ? String(it.parentId) : null,
  type: it.type, name: it.name, kind: it.kind, filter: it.filter, auto: !!it.auto, createdAt: it.createdAt, count: await itemCount(it),
});
const projectOf = (req, id) => col('projects').findOne({ _id: oid(id), workspaceId: req.ws });
const itemOf = (req, id, extra = {}) => col('items').findOne({ _id: oid(id), workspaceId: req.ws, ...extra });

// ---------------- projects ----------------
r.get('/projects', ah(async (req) => {
  const projects = await col('projects').find({ workspaceId: req.ws }).sort({ createdAt: -1 }).toArray();
  // source: 'search' (a keyword in the Ad Library) or 'links' (pasted Page links) — the Projects page tabs
  return Promise.all(projects.map(async (p) => ({ id: String(p._id), name: p.name, keyword: p.keyword, country: p.country, source: p.source || 'search', createdAt: p.createdAt, ...(await projectStats(p)) })));
}));

/**
 * Projects with nothing in them: 0 leads — and not a search waiting or running (its leads are still coming),
 * and no sheet of the user's own with something typed in it. These go with "Remove empty projects".
 */
export async function emptyProjects(ws) {
  const [projects, withLeads, running, customSheets] = await Promise.all([
    col('projects').find({ workspaceId: ws }).project({ name: 1, country: 1, createdAt: 1 }).sort({ createdAt: -1 }).toArray(),
    col('leads').distinct('projectIds', { workspaceId: ws }),
    col('jobs').distinct('projectId', { workspaceId: ws, phase: { $in: ['queued', 'collecting'] } }),
    col('items').find({ workspaceId: ws, type: 'sheet', kind: 'custom' }).project({ projectId: 1 }).toArray(),
  ]);
  const filled = new Set(
    (await col('sheets').find({ _id: { $in: customSheets.map((i) => i._id) }, rowCount: { $gt: 0 } }).project({ _id: 1 }).toArray()).map((s) => String(s._id)),
  );
  const keep = new Set([...withLeads, ...running, ...customSheets.filter((i) => filled.has(String(i._id))).map((i) => i.projectId)].map(String));
  return projects.filter((p) => !keep.has(String(p._id)));
}

/** The empty projects with what is (not) in them, so the user can check before removing them. */
r.get('/projects/empty', ah(async (req) => {
  const list = await emptyProjects(req.ws);
  const ids = list.map((p) => p._id);
  const [ads, runs] = await Promise.all([
    col('ads').aggregate([{ $match: { projectIds: { $in: ids } } }, { $unwind: '$projectIds' }, { $match: { projectIds: { $in: ids } } }, { $group: { _id: '$projectIds', n: { $sum: 1 } } }]).toArray(),
    col('jobs').aggregate([{ $match: { workspaceId: req.ws, projectId: { $in: ids } } }, { $group: { _id: '$projectId', n: { $sum: 1 }, last: { $max: '$createdAt' } } }]).toArray(),
  ]);
  const adsOf = new Map(ads.map((x) => [String(x._id), x.n]));
  const runsOf = new Map(runs.map((x) => [String(x._id), x]));
  return {
    count: list.length,
    names: list.map((p) => p.name),
    projects: list.map((p) => ({
      id: String(p._id), name: p.name, country: p.country, createdAt: p.createdAt,
      leads: 0, ads: adsOf.get(String(p._id)) || 0, searches: runsOf.get(String(p._id))?.n || 0, lastRunAt: runsOf.get(String(p._id))?.last || null,
    })),
  };
}));

/** Removes the empty projects — all of them, or only the `ids` the user ticked. Each one is checked again here. */
r.post('/projects/delete-empty', ah(async (req) => {
  const wanted = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
  const list = (await emptyProjects(req.ws)).filter((p) => !wanted || wanted.has(String(p._id)));
  for (const p of list) await deleteProject(req.ws, p._id);
  if (list.length) await activity('delete', `${list.length} empty project${list.length > 1 ? 's' : ''} removed (0 leads)`, { workspaceId: req.ws });
  return { deleted: list.length };
}));

r.patch('/projects/:id', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Please enter a name');
  const out = await col('projects').findOneAndUpdate({ _id: oid(req.params.id), workspaceId: req.ws }, { $set: { name } }, { returnDocument: 'after' });
  return out ? { ok: true } : notFound(res, 'Project');
}));

r.get('/projects/:id/impact', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  const pid = p._id;
  const [leads, shared, ads, searches, items] = await Promise.all([
    col('leads').countDocuments({ workspaceId: req.ws, projectIds: { $all: [pid], $size: 1 } }),
    col('leads').countDocuments({ workspaceId: req.ws, projectIds: pid, 'projectIds.1': { $exists: true } }),
    col('ads').countDocuments({ projectIds: pid }),
    col('jobs').countDocuments({ projectId: pid }),
    col('items').countDocuments({ projectId: pid }),
  ]);
  return { leads, shared, ads, searches, items };
}));

r.delete('/projects/:id', ah(async (req, res) => {
  const out = await deleteProject(req.ws, oid(req.params.id));
  if (!out) return notFound(res, 'Project');
  await activity('delete', `Project "${out.name}" deleted — ${out.leads} leads removed`, { workspaceId: req.ws });
  return out;
}));

/** The project's ad insights (insights.js): hooks of long-running ads, offers, prices, formats — no AI. */
r.get('/projects/:id/insights', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  return { project: { id: String(p._id), name: p.name, keyword: p.keyword, country: p.country }, ...insightsView(await projectInsights(p._id)) };
}));

/** More of a long list (every hook / every advertiser), page by page: ?kind=hooks|advertisers&page&per&find&minDays&sort */
r.get('/projects/:id/insights/list', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  const { kind, page, per, find, minDays, sort } = req.query;
  return insightsList(await projectInsights(p._id), String(kind), { page, per, q: find, minDays, sort });
}));

/** The Insights report as an Excel file: a summary and every hook, offer, price, format and top advertiser. */
r.get('/projects/:id/insights.xlsx', ah(async (req, res) => {
  await requirePerk(req.ws, 'excelExport');
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  const d = await projectInsights(p._id);
  await sendInsightsWorkbook(res, d, [['Project', p.name], ['Keyword', `${p.keyword} (${p.country})`]], `${p.name} - ad insights.xlsx`);
}));

/** "Collect more" — run the same keyword search again; new pages land in the same project. */
r.post('/projects/:id/search', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  if (p.source === 'links') throw httpError(400, 'This project was made from pasted links — paste more links instead (Hunt → Paste links)');
  await checkSearchQuota(req, 1);
  const s = await getSettings();
  const last = await col('jobs').findOne({ projectId: p._id }, { sort: { createdAt: -1 }, projection: { minAds: 1, maxAds: 1, filters: 1 } });
  const acc = await accountOf(req.ws); // the plan's limits
  // the same Ad Library filters as last time, unless new ones are sent
  const filters = cleanAdFilters(req.body?.filters || last?.filters);
  await col('jobs').insertOne({
    workspaceId: req.ws, userId: req.user._id, keyword: p.keyword, country: p.country, filters,
    maxAds: Math.min(clampMaxAds(req.body?.maxAds, last?.maxAds || (acc.unlimited ? s.maxAds : acc.maxAdsPerSearch)), acc.maxAdsPerSearch),
    minAds: acc.minAdsFilter ? Math.max(1, Number(req.body?.minAds) || last?.minAds || 1) : 1,
    url: adLibraryUrl(p.keyword, p.country, filters), phase: 'queued', manual: false, adsSeen: 0, pageIds: [], projectId: p._id, createdAt: new Date(),
  });
  await activity('queued', `"${p.name}" — queued to search again`, { workspaceId: req.ws, projectId: p._id });
  kickAdlibCollector().catch(() => {});
  return { ok: true };
}));

/** Continue the pages that were cancelled with Stop. */
r.post('/projects/:id/continue', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  const pageIds = await col('leads').distinct('pageId', { workspaceId: req.ws, projectIds: p._id, scrapeStatus: 'stopped' });
  const n = await queuePages(req.ws, pageIds);
  await activity('resumed', `"${p.name}" — ${n} stopped pages queued again`, { workspaceId: req.ws, projectId: p._id });
  return { pages: n };
}));

// ---------------- explorer ----------------
async function breadcrumb(item) {
  const path = [];
  const seen = new Set();
  let cur = item;
  while (cur && !seen.has(String(cur._id)) && path.length < 50) {
    seen.add(String(cur._id));
    path.unshift({ id: String(cur._id), name: cur.name, type: cur.type });
    cur = cur.parentId ? await col('items').findOne({ _id: cur.parentId }) : null;
  }
  return path;
}

r.get('/projects/:id/items', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  const parent = req.query.parent ? await itemOf(req, req.query.parent, { projectId: p._id }) : null;
  if (req.query.parent && !parent) return notFound(res, 'Folder');
  const items = await col('items').find({ projectId: p._id, parentId: parent ? parent._id : null }).sort({ type: -1, createdAt: 1 }).toArray();
  return {
    project: { id: String(p._id), name: p.name, keyword: p.keyword, country: p.country, source: p.source || 'search', createdAt: p.createdAt, ...(await projectStats(p)) },
    path: parent ? await breadcrumb(parent) : [],
    items: await Promise.all(items.map(itemDTO)),
  };
}));

/** A folder can't be moved into itself or into one of its own sub-folders. */
async function checkParent(req, item, parentId) {
  if (!parentId) return null;
  const parent = await itemOf(req, parentId, { projectId: item.projectId, type: 'folder' });
  if (!parent) throw httpError(400, 'Folder not found');
  for (let cur = parent, i = 0; cur && i < 50; i++) {
    if (item._id && String(cur._id) === String(item._id)) throw httpError(400, 'A folder cannot be moved inside itself');
    cur = cur.parentId ? await col('items').findOne({ _id: cur.parentId }) : null;
  }
  return parent._id;
}

r.post('/items', ah(async (req) => {
  const b = req.body || {};
  const p = await projectOf(req, b.projectId);
  if (!p) throw httpError(404, 'Project not found');
  const type = b.type === 'sheet' ? 'sheet' : 'folder';
  const doc = {
    workspaceId: req.ws, projectId: p._id, parentId: await checkParent(req, { projectId: p._id }, b.parentId), type,
    name: String(b.name || '').trim().slice(0, 120) || (type === 'sheet' ? 'Untitled sheet' : 'New folder'),
    kind: 'custom', filter: null, auto: false, createdAt: new Date(),
  };
  const { insertedId } = await col('items').insertOne(doc);
  return itemDTO({ ...doc, _id: insertedId });
}));

r.patch('/items/:id', ah(async (req, res) => {
  const item = await itemOf(req, req.params.id);
  if (!item) return notFound(res, 'Item');
  const set = {};
  if (req.body?.name !== undefined) set.name = String(req.body.name).trim().slice(0, 120) || 'Untitled';
  if (req.body?.parentId !== undefined) set.parentId = await checkParent(req, item, req.body.parentId);
  const out = await col('items').findOneAndUpdate({ _id: item._id }, { $set: set }, { returnDocument: 'after' });
  return itemDTO(out);
}));

r.delete('/items/:id', ah(async (req, res) => {
  const root = await itemOf(req, req.params.id);
  if (!root) return notFound(res, 'Item');
  const ids = [];
  const walk = async (id) => {
    ids.push(id);
    for (const c of await col('items').find({ parentId: id }).project({ _id: 1 }).toArray()) await walk(c._id);
  };
  await walk(root._id);
  await deleteSheetDocs(ids);
  await col('items').deleteMany({ _id: { $in: ids } });
  return { deleted: ids.length };
}));

// ---------------- sheets ----------------
async function getSheetItem(req, res) {
  const it = await itemOf(req, req.params.id, { type: 'sheet' });
  if (!it) notFound(res, 'Sheet');
  return it;
}

r.get('/sheets/:id', ah(async (req, res) => {
  const it = await getSheetItem(req, res);
  if (!it) return;
  const p = await col('projects').findOne({ _id: it.projectId });
  const { sheets, version } = await loadSheet(it);
  return { item: await itemDTO(it), project: { id: String(p?._id), name: p?.name }, path: await breadcrumb(it), sheets, version };
}));

r.put('/sheets/:id', ah(async (req, res) => {
  const it = await getSheetItem(req, res);
  if (!it) return;
  const sheets = req.body?.sheets;
  if (!Array.isArray(sheets) || !sheets.length) throw httpError(400, 'Empty workbook');
  const out = await saveSheet(it, sheets, req.body?.version);
  if (out.deleted) await activity('delete', `${out.deleted} ${it.kind === 'ads' ? 'ad(s)' : 'lead(s)'} deleted from "${it.name}"`, { workspaceId: req.ws });
  return { ok: true, savedAt: new Date(), deleted: out.deleted, version: out.version, stale: out.stale };
}));

const argb = (hex) => {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  return m ? 'FF' + m[1].toUpperCase() : null;
};

/** Excel file of exactly what the user sees in the sheet (values, bold/italic, font size & colour, fill, widths, links). */
r.get('/sheets/:id/export.xlsx', ah(async (req, res) => {
  await requirePerk(req.ws, 'excelExport');
  const it = await getSheetItem(req, res);
  if (!it) return;
  const { sheets } = await loadSheet(it);
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(String(s.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet');
    for (const [c, w] of Object.entries(s.config?.columnlen || {})) ws.getColumn(Number(c) + 1).width = Math.max(6, Math.round(Number(w) / 7));
    for (const x of s.celldata || []) {
      const v = x.v || {};
      const cell = ws.getCell(x.r + 1, x.c + 1);
      const rawLink = s.hyperlink?.[`${x.r}_${x.c}`]?.linkAddress;
      const link = /^https?:\/\//i.test(String(rawLink || '')) ? rawLink : null;
      const val = v.v ?? v.m ?? '';
      cell.value = link ? { text: String(val), hyperlink: link } : val;
      const font = {};
      if (v.bl) font.bold = true;
      if (v.it) font.italic = true;
      if (v.cl) font.strike = true;
      if (v.un || link) font.underline = true;
      if (v.fs) font.size = Number(v.fs);
      if (argb(v.fc)) font.color = { argb: argb(v.fc) };
      if (Object.keys(font).length) cell.font = font;
      if (argb(v.bg)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(v.bg) } };
    }
    if (s.frozen?.type === 'row') ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const name = encodeURIComponent(`${it.name}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
  await wb.xlsx.write(res);
  res.end();
}));

export default r;
