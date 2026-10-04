// Projects (one per keyword search, per workspace) → folders → sheets (Google-Sheets-like workbooks, FortuneSheet format).
import { ObjectId } from 'mongodb';
import { col } from './db.js';
import { adLink, fmtDate, pageAdsLink, pageLink } from './util.js';

export const oid = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

// ---------------- projects ----------------
const TEMPLATE = [
  {
    type: 'folder', name: 'Leads', children: [
      { type: 'sheet', name: 'All Leads', kind: 'leads', filter: 'all' },
      { type: 'sheet', name: 'With Contact', kind: 'leads', filter: 'contact' },
      { type: 'sheet', name: 'With Email', kind: 'leads', filter: 'email' },
      { type: 'sheet', name: 'No Contact', kind: 'leads', filter: 'nocontact' },
    ],
  },
  { type: 'folder', name: 'Ads', children: [{ type: 'sheet', name: 'All Ads', kind: 'ads', filter: 'all' }] },
];

async function createTemplate(ws, projectId) {
  const now = Date.now();
  let i = 0;
  const walk = async (nodes, parentId) => {
    for (const n of nodes) {
      const doc = {
        workspaceId: ws, projectId, parentId, type: n.type, name: n.name, kind: n.kind || 'custom', filter: n.filter || null, auto: true, createdAt: new Date(now + i++),
      };
      const { insertedId } = await col('items').insertOne(doc);
      if (n.children) await walk(n.children, insertedId);
    }
  };
  await walk(TEMPLATE, null);
}

/** Find the workspace's project for a keyword+country, or create it (with the default Leads/Ads folders). */
export async function ensureProject(ws, keyword, country) {
  const key = `${String(keyword).trim().toLowerCase()}|${String(country || 'ALL').toUpperCase()}`;
  const existing = await col('projects').findOne({ workspaceId: ws, key });
  if (existing) return existing._id;
  const doc = { workspaceId: ws, key, name: String(keyword).trim(), keyword: String(keyword).trim(), country: String(country || 'ALL').toUpperCase(), createdAt: new Date() };
  try {
    const { insertedId } = await col('projects').insertOne(doc);
    await createTemplate(ws, insertedId);
    return insertedId;
  } catch (e) {
    if (e.code === 11000) return (await col('projects').findOne({ workspaceId: ws, key }))._id; // created at the same moment
    throw e;
  }
}

// ---------------- data behind the auto sheets ----------------
const CONTACT = { $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] };

export function leadFilter(item) {
  const f = { workspaceId: item.workspaceId, projectIds: item.projectId };
  if (item.filter === 'contact') Object.assign(f, CONTACT);
  if (item.filter === 'email') f['emails.0'] = { $exists: true };
  if (item.filter === 'nocontact') Object.assign(f, { scrapeStatus: 'done', 'emails.0': { $exists: false }, 'phones.0': { $exists: false }, 'whatsapp.0': { $exists: false } });
  return f;
}

export async function itemCount(item) {
  if (item.type === 'folder') return col('items').countDocuments({ parentId: item._id });
  if (item.kind === 'leads') return col('leads').countDocuments(leadFilter(item));
  if (item.kind === 'ads') return col('ads').countDocuments({ projectIds: item.projectId });
  const s = await col('sheets').findOne({ _id: item._id }, { projection: { rowCount: 1 } });
  return s?.rowCount || 0;
}

export async function projectStats(p) {
  const pid = p._id;
  const ws = p.workspaceId;
  const [leads, withContact, pending, stopped, ads, jobs] = await Promise.all([
    col('leads').countDocuments({ workspaceId: ws, projectIds: pid }),
    col('leads').countDocuments({ workspaceId: ws, projectIds: pid, ...CONTACT }),
    col('leads').countDocuments({ workspaceId: ws, projectIds: pid, scrapeStatus: { $in: ['pending', 'working'] } }),
    col('leads').countDocuments({ workspaceId: ws, projectIds: pid, scrapeStatus: 'stopped' }),
    col('ads').countDocuments({ projectIds: pid }),
    col('jobs').find({ projectId: pid }).project({ phase: 1, createdAt: 1, adsSeen: 1 }).sort({ createdAt: -1 }).toArray(),
  ]);
  const phase = jobs.some((j) => j.phase === 'collecting') ? 'collecting' : jobs.some((j) => j.phase === 'queued') ? 'queued' : pending ? 'scraping' : 'done';
  return { leads, withContact, pending, stopped, ads, runs: jobs.length, phase: stopped && phase === 'done' ? 'stopped' : phase, lastRunAt: jobs[0]?.createdAt || p.createdAt };
}

// ---------------- stop / continue reading pages ----------------
/** A workspace no longer wants these pages read. Pages nobody else wants are taken out of the queue. */
export async function stopPages(ws, leadFilterExtra = {}) {
  const now = new Date();
  const pageIds = await col('leads').distinct('pageId', { workspaceId: ws, scrapeStatus: { $in: ['pending', 'working'] }, ...leadFilterExtra });
  if (!pageIds.length) return 0;
  await col('leads').updateMany({ workspaceId: ws, pageId: { $in: pageIds } }, { $set: { scrapeStatus: 'stopped', updatedAt: now } });
  await col('pages').updateMany({ pageId: { $in: pageIds } }, { $pull: { wantedBy: ws } });
  await col('pages').updateMany(
    { pageId: { $in: pageIds }, scrapeStatus: 'pending', $or: [{ wantedBy: { $size: 0 } }, { wantedBy: { $exists: false } }] },
    { $set: { scrapeStatus: 'stopped', updatedAt: now } },
  );
  return pageIds.length;
}

/** Queue pages again for a workspace (Continue / Re-scrape). */
export async function queuePages(ws, pageIds, { force = false } = {}) {
  if (!pageIds.length) return 0;
  const now = new Date();
  const statuses = force ? ['stopped', 'done', 'failed'] : ['stopped'];
  await col('pages').updateMany(
    { pageId: { $in: pageIds }, scrapeStatus: { $in: statuses } },
    { $set: { scrapeStatus: 'pending', retries: 0, lastError: '', updatedAt: now } },
  );
  await col('pages').updateMany({ pageId: { $in: pageIds } }, { $addToSet: { wantedBy: ws } });
  await col('leads').updateMany({ workspaceId: ws, pageId: { $in: pageIds }, scrapeStatus: { $in: statuses } }, { $set: { scrapeStatus: 'pending', updatedAt: now } });
  return pageIds.length;
}

// ---------------- sheet columns ----------------
const LEAD_COLS = [
  ['Page Name', 180, (l) => l.pageName || ''],
  ['Page Link', 200, (l) => pageLink(l), 'link'],
  ['Phone', 140, (l) => (l.phones || []).join(', ')],
  ['WhatsApp', 130, (l) => (l.whatsapp || []).join(', ')],
  ['Email', 200, (l) => (l.emails || []).join(', ')],
  ['Website', 170, (l) => l.website || '', 'link'],
  ['Category', 140, (l) => l.category || ''],
  ['Address', 240, (l) => l.address || ''],
  ['Followers', 80, (l) => l.followers || ''],
  ['Active Ads', 80, (l) => l.adCount || 0],
  ['Bio', 260, (l) => l.about?.bio || ''],
  ['Hours', 110, (l) => l.about?.hours || ''],
  ['Service Area', 200, (l) => l.about?.serviceArea || ''],
  ['Services', 160, (l) => l.about?.services || ''],
  ['Instagram', 170, (l) => l.instagram || '', 'link'],
  ['Other Links', 170, (l) => (l.socials || []).join(', ')],
  ['Page Ads', 160, (l) => pageAdsLink(l.pageId), 'link'],
  ['Status', 100, (l) => l.status || 'New'],
  ['Notes', 200, (l) => l.notes || ''],
  ['Scraped At', 120, (l) => fmtDate(l.scrapedAt)],
  ['Page ID', 150, (l) => l.pageId],
];
const AD_COLS = [
  ['Page Name', 170, (a) => a.pageName || ''],
  ['Ad Text', 320, (a) => a.body || ''],
  ['Headline', 180, (a) => a.title || ''],
  ['Landing Link', 200, (a) => a.linkUrl || '', 'link'],
  ['CTA', 100, (a) => a.cta || ''],
  ['Start Date', 95, (a) => a.startDate || ''],
  ['Platforms', 140, (a) => (a.platforms || []).join(', ')],
  ['Ad Link', 200, (a) => adLink(a.adId), 'link'],
  ['Page ID', 150, (a) => a.pageId],
  ['Ad ID', 150, (a) => a.adId],
];
const colsFor = (kind) => (kind === 'ads' ? { cols: AD_COLS, key: 'Ad ID' } : { cols: LEAD_COLS, key: 'Page ID' });

const HEADER_STYLE = { bl: 1, bg: '#eef2ff', fc: '#3730a3' };
const textCell = (v) => (typeof v === 'number' ? { v, m: String(v), ff: 'Arial', ct: { fa: 'General', t: 'n' } } : { v: String(v), m: String(v), ff: 'Arial', ct: { fa: '@', t: 's' } });
const isEmpty = (cell) => !cell || cell.v === undefined || cell.v === null || cell.v === '';

async function sourceRows(item) {
  if (item.kind === 'ads') return col('ads').find({ projectIds: item.projectId }).sort({ createdAt: 1 }).toArray();
  return col('leads').find(leadFilter(item)).sort({ createdAt: 1 }).toArray();
}

function blankSheet(item) {
  const { cols } = colsFor(item.kind);
  const celldata = cols.map(([h], c) => ({ r: 0, c, v: { ...textCell(h), ...HEADER_STYLE } }));
  const columnlen = Object.fromEntries(cols.map(([, w], c) => [c, w]));
  return { name: item.name, id: 'live', order: 0, status: 1, celldata, config: { columnlen }, frozen: { type: 'row' }, hyperlink: {}, row: 100, column: Math.max(26, cols.length + 4) };
}

/** Add new rows (and fill still-empty cells) from MongoDB into the live tab, keeping every user edit. */
function mergeLive(sheet, item, rows, removedKeys) {
  const { cols, key } = colsFor(item.kind);
  const cells = new Map((sheet.celldata || []).map((x) => [`${x.r}_${x.c}`, x]));
  const header = {};
  for (const x of sheet.celldata || []) if (x.r === 0 && !isEmpty(x.v)) header[String(x.v.v).trim()] = x.c;
  const keyC = header[key];
  if (keyC === undefined) return 0; // user removed the key column → don't touch the sheet

  const rowOfKey = new Map();
  let maxRow = 0;
  for (const x of sheet.celldata || []) {
    if (x.r > maxRow) maxRow = x.r;
    if (x.c === keyC && x.r > 0 && !isEmpty(x.v)) rowOfKey.set(String(x.v.v), x.r);
  }
  sheet.hyperlink = sheet.hyperlink || {};
  const removed = new Set(removedKeys || []);
  let added = 0;
  const put = (r, c, value, type) => {
    if (value === '' || value === null || value === undefined) return;
    const k = `${r}_${c}`;
    if (!isEmpty(cells.get(k)?.v)) return;
    const cell = { r, c, v: textCell(value) };
    if (type === 'link' && /^https?:\/\//.test(value)) {
      cell.v = { ...cell.v, fc: '#2563eb', un: 1 };
      sheet.hyperlink[k] = { linkType: 'webpage', linkAddress: value };
    }
    cells.set(k, cell);
  };
  for (const row of rows) {
    const rowKey = String(item.kind === 'ads' ? row.adId : row.pageId);
    if (removed.has(rowKey)) continue;
    let r = rowOfKey.get(rowKey);
    if (r === undefined) {
      r = ++maxRow;
      rowOfKey.set(rowKey, r);
      added++;
    }
    for (const [h, , fn, type] of cols) {
      const c = header[h];
      if (c !== undefined) put(r, c, fn(row), type);
    }
  }
  sheet.celldata = [...cells.values()];
  sheet.row = Math.max(sheet.row || 100, maxRow + 50);
  return added;
}

const keysOf = (sheet, key) => {
  const cells = sheet?.celldata || [];
  const keyC = cells.find((x) => x.r === 0 && x.v && String(x.v.v).trim() === key)?.c;
  if (keyC === undefined) return null;
  return cells.filter((x) => x.c === keyC && x.r > 0 && !isEmpty(x.v)).map((x) => String(x.v.v));
};

export async function loadSheet(item) {
  let doc = await col('sheets').findOne({ _id: item._id });
  if (!doc) doc = { _id: item._id, sheets: [item.kind === 'custom' ? { ...blankSheet({ ...item, kind: 'custom' }), celldata: [], config: {} } : blankSheet(item)], removedKeys: [] };
  if (item.kind === 'leads' || item.kind === 'ads') {
    const live = doc.sheets.find((s) => s.id === 'live') || doc.sheets[0];
    const added = mergeLive(live, item, await sourceRows(item), doc.removedKeys);
    if (added || !doc.updatedAt) await saveSheetDoc(item, doc.sheets, doc.removedKeys);
  }
  return doc.sheets;
}

/** Rows that have at least one non-empty cell. */
const filledRows = (sheet) => new Set((sheet?.celldata || []).filter((x) => x.r > 0 && !isEmpty(x.v)).map((x) => x.r));

async function saveSheetDoc(item, sheets, removedKeys) {
  const live = sheets.find((s) => s.id === 'live') || sheets[0];
  await col('sheets').updateOne(
    { _id: item._id },
    { $set: { workspaceId: item.workspaceId, sheets, removedKeys, rowCount: filledRows(live).size, updatedAt: new Date() } },
    { upsert: true },
  );
}

// A second column that is unique per row: if both the key AND this value are gone, the row was deleted
// (and not just a cleared Page ID cell).
const WITNESS = { leads: 'Page Link', ads: 'Ad Link' };

function valuesByRow(sheet, header) {
  const cells = sheet?.celldata || [];
  const c = cells.find((x) => x.r === 0 && x.v && String(x.v.v).trim() === header)?.c;
  const out = new Map();
  if (c === undefined) return out;
  for (const x of cells) if (x.c === c && x.r > 0 && !isEmpty(x.v)) out.set(x.r, String(x.v.v));
  return out;
}

/**
 * Save what the user edited. A row the user really deleted in a live sheet removes that lead (or ad) from
 * this workspace. Only *deleted rows* count: clearing cells (selecting a range and pressing Delete) leaves
 * the rows in place, so nothing is removed — the sheet must actually have fewer rows than before.
 */
export async function saveSheet(item, sheets) {
  const prev = await col('sheets').findOne({ _id: item._id });
  let removedKeys = prev?.removedKeys || [];
  const deleted = [];
  if (item.kind === 'leads' || item.kind === 'ads') {
    const { key } = colsFor(item.kind);
    const pick = (list) => (list || []).find((s) => s.id === 'live') || (list || [])[0];
    const beforeSheet = pick(prev?.sheets);
    const afterSheet = pick(sheets);
    const beforeKeys = valuesByRow(beforeSheet, key);
    const after = keysOf(afterSheet, key);
    // Deleting rows moves the rows below them up, so the last filled row moves up too. Clearing cells
    // in the middle leaves an empty gap and the last row stays where it was.
    const lastRow = (s) => [...filledRows(s)].reduce((a, b) => (b > a ? b : a), 0);
    const rowsRemoved = Math.min(filledRows(beforeSheet).size - filledRows(afterSheet).size, lastRow(beforeSheet) - lastRow(afterSheet));
    if (beforeKeys.size && after && rowsRemoved > 0) {
      const nowKeys = new Set(after);
      const beforeWitness = valuesByRow(beforeSheet, WITNESS[item.kind]);
      const nowWitness = new Set(valuesByRow(afterSheet, WITNESS[item.kind]).values());
      const missing = [];
      for (const [r, k] of beforeKeys) {
        if (nowKeys.has(k)) continue;
        const w = beforeWitness.get(r);
        if (!w || !nowWitness.has(w)) missing.push(k); // whole row gone
      }
      // more keys missing than rows removed = cells were cleared, not rows deleted → delete nothing
      if (missing.length <= rowsRemoved) deleted.push(...missing);
      removedKeys = [...new Set([...removedKeys, ...deleted])];
    }
  }
  await saveSheetDoc(item, sheets, removedKeys);
  if (deleted.length) {
    if (item.kind === 'ads') await removeAdsFromWorkspace(item.workspaceId, deleted);
    else await deleteLeads(item.workspaceId, deleted, { skipSheet: item._id });
  }
  return { deleted: deleted.length };
}

// ---------------- deleting (always inside one workspace) ----------------
/** Remove whole rows (by a column's values) from a stored sheet and close the gaps, like deleting rows in Excel. */
function dropRows(sheet, header, values) {
  const cells = sheet.celldata || [];
  const c = cells.find((x) => x.r === 0 && x.v && String(x.v.v).trim() === header)?.c;
  if (c === undefined) return 0;
  const gone = new Set(cells.filter((x) => x.c === c && x.r > 0 && !isEmpty(x.v) && values.has(String(x.v.v))).map((x) => x.r));
  if (!gone.size) return 0;
  const sorted = [...gone].sort((a, b) => a - b);
  const shift = (r) => {
    let n = 0;
    for (const g of sorted) if (g < r) n++;
    return r - n;
  };
  sheet.celldata = cells.filter((x) => !gone.has(x.r)).map((x) => ({ ...x, r: shift(x.r) }));
  const links = {};
  for (const [k, v] of Object.entries(sheet.hyperlink || {})) {
    const [r, cc] = k.split('_').map(Number);
    if (!gone.has(r)) links[`${shift(r)}_${cc}`] = v;
  }
  sheet.hyperlink = links;
  return gone.size;
}

async function dropRowsFromSheets(ws, header, values, skipId) {
  const set = new Set(values.map(String));
  const items = await col('items').find({ workspaceId: ws, type: 'sheet' }).project({ _id: 1 }).toArray();
  for (const it of items) {
    if (skipId && String(it._id) === String(skipId)) continue;
    const doc = await col('sheets').findOne({ _id: it._id });
    if (!doc) continue;
    let changed = 0;
    for (const s of doc.sheets || []) changed += dropRows(s, header, set);
    if (changed) {
      const live = doc.sheets.find((s) => s.id === 'live') || doc.sheets[0];
      await col('sheets').updateOne({ _id: it._id }, { $set: { sheets: doc.sheets, rowCount: filledRows(live).size, updatedAt: new Date() } });
    }
  }
}

/** Delete leads from one workspace (and their rows in its sheets). The shared page data stays for others. */
export async function deleteLeads(ws, pageIds, { skipSheet } = {}) {
  const ids = [...new Set((pageIds || []).map(String))];
  if (!ids.length) return { leads: 0 };
  await stopPages(ws, { pageId: { $in: ids } });
  const leads = await col('leads').deleteMany({ workspaceId: ws, pageId: { $in: ids } });
  await col('jobs').updateMany({ workspaceId: ws, pageIds: { $in: ids } }, { $pull: { pageIds: { $in: ids } } });
  await dropRowsFromSheets(ws, 'Page ID', ids, skipSheet);
  return { leads: leads.deletedCount };
}

/** Ads are shared — "deleting" one only detaches it from this workspace's projects. */
export async function removeAdsFromWorkspace(ws, adIds) {
  const ids = [...new Set(adIds.map(String))];
  const projectIds = await col('projects').distinct('_id', { workspaceId: ws });
  const out = await col('ads').updateMany({ adId: { $in: ids } }, { $pull: { projectIds: { $in: projectIds } } });
  await dropRowsFromSheets(ws, 'Ad ID', ids);
  return { ads: out.modifiedCount };
}

/** Delete a project and everything in it. Leads shared with another project of the same workspace stay there. */
export async function deleteProject(ws, pid) {
  const project = await col('projects').findOne({ _id: pid, workspaceId: ws });
  if (!project) return null;
  const onlyHere = await col('leads').distinct('pageId', { workspaceId: ws, projectIds: { $all: [pid], $size: 1 } });
  const removed = await deleteLeads(ws, onlyHere);
  await col('leads').updateMany({ workspaceId: ws, projectIds: pid }, { $pull: { projectIds: pid } });
  const ads = await col('ads').updateMany({ projectIds: pid }, { $pull: { projectIds: pid } });
  const jobs = await col('jobs').deleteMany({ workspaceId: ws, projectId: pid });
  const items = await col('items').find({ projectId: pid, workspaceId: ws }).project({ _id: 1 }).toArray();
  await col('sheets').deleteMany({ _id: { $in: items.map((i) => i._id) } });
  await col('items').deleteMany({ projectId: pid, workspaceId: ws });
  await col('projects').deleteOne({ _id: pid });
  return { name: project.name, leads: removed.leads, ads: ads.modifiedCount, searches: jobs.deletedCount };
}

/** Everything a workspace owns (used when an admin deletes a user). Shared pages/ads stay. */
export async function deleteWorkspaceData(ws) {
  const projectIds = await col('projects').distinct('_id', { workspaceId: ws });
  await stopPages(ws);
  await col('ads').updateMany({ projectIds: { $in: projectIds } }, { $pull: { projectIds: { $in: projectIds } } });
  const items = await col('items').find({ workspaceId: ws }).project({ _id: 1 }).toArray();
  await col('sheets').deleteMany({ _id: { $in: items.map((i) => i._id) } });
  await Promise.all([
    col('items').deleteMany({ workspaceId: ws }),
    col('projects').deleteMany({ workspaceId: ws }),
    col('leads').deleteMany({ workspaceId: ws }),
    col('jobs').deleteMany({ workspaceId: ws }),
    col('activity').deleteMany({ workspaceId: ws }),
    col('workspaces').deleteOne({ _id: ws }),
  ]);
}
