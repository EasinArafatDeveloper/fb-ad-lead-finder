import express from 'express';
import ExcelJS from 'exceljs';
import { activity, col, httpError } from './db.js';
import { adLibraryUrl } from './util.js';
import { getSettings } from './settings.js';
import { checkSearchQuota } from './routes.js';
import { deleteProject, itemCount, loadSheet, oid, projectStats, queuePages, saveSheet } from './projects.js';

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
  return Promise.all(projects.map(async (p) => ({ id: String(p._id), name: p.name, keyword: p.keyword, country: p.country, createdAt: p.createdAt, ...(await projectStats(p)) })));
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

/** "Collect more" — run the same keyword search again; new pages land in the same project. */
r.post('/projects/:id/search', ah(async (req, res) => {
  const p = await projectOf(req, req.params.id);
  if (!p) return notFound(res, 'Project');
  await checkSearchQuota(req, 1);
  const s = await getSettings();
  const last = await col('jobs').findOne({ projectId: p._id }, { sort: { createdAt: -1 }, projection: { minAds: 1 } });
  await col('jobs').insertOne({
    workspaceId: req.ws, userId: req.user._id, keyword: p.keyword, country: p.country,
    maxAds: Math.min(5000, Math.max(10, Number(req.body?.maxAds) || s.maxAds)), minAds: Math.max(1, Number(req.body?.minAds) || last?.minAds || 1),
    url: adLibraryUrl(p.keyword, p.country), phase: 'queued', manual: false, adsSeen: 0, pageIds: [], projectId: p._id, createdAt: new Date(),
  });
  await activity('queued', `"${p.name}" — queued to search again`, { workspaceId: req.ws, projectId: p._id });
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
    project: { id: String(p._id), name: p.name, keyword: p.keyword, country: p.country, createdAt: p.createdAt, ...(await projectStats(p)) },
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
  await col('sheets').deleteMany({ _id: { $in: ids } });
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
  return { item: await itemDTO(it), project: { id: String(p?._id), name: p?.name }, path: await breadcrumb(it), sheets: await loadSheet(it) };
}));

r.put('/sheets/:id', ah(async (req, res) => {
  const it = await getSheetItem(req, res);
  if (!it) return;
  const sheets = req.body?.sheets;
  if (!Array.isArray(sheets) || !sheets.length) throw httpError(400, 'Empty workbook');
  const out = await saveSheet(it, sheets);
  if (out.deleted) await activity('delete', `${out.deleted} ${it.kind === 'ads' ? 'ad(s)' : 'lead(s)'} deleted from "${it.name}"`, { workspaceId: req.ws });
  return { ok: true, savedAt: new Date(), deleted: out.deleted };
}));

const argb = (hex) => {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  return m ? 'FF' + m[1].toUpperCase() : null;
};

/** Excel file of exactly what the user sees in the sheet (values, bold/italic, font size & colour, fill, widths, links). */
r.get('/sheets/:id/export.xlsx', ah(async (req, res) => {
  const it = await getSheetItem(req, res);
  if (!it) return;
  const sheets = await loadSheet(it);
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
