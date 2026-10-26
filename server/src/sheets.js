// Google Sheet sync — each workspace has its own Sheet (Apps Script Web App).
import { col, httpError, log } from './db.js';
import { checkSheetUrl, getWsSettings } from './settings.js';
import { accountOf } from './billing.js';
import { AD_HEADERS, LEAD_HEADERS, STATUSES, adRow, leadRow } from './leads.js';

/** Columns the team edits in the Sheet: written for new rows only, never overwritten on existing rows. */
const TEAM_COLUMNS = ['Status', 'Notes'];

async function sheetRequest(ws, payload) {
  const s = await getWsSettings(ws);
  if (!s.sheetUrl) throw httpError(400, 'Google Sheet Web App URL is not set (Settings)');
  const url = checkSheetUrl(s.sheetUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: s.sheetSecret, ...payload }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw httpError(502, `Could not reach the Sheet: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw httpError(502, 'The Sheet did not send a valid response. Check that the Web App is deployed with "Anyone" access.');
  }
  if (!j.ok) throw httpError(400, j.error || 'Sheet error');
  return j;
}

export const testSheet = (ws) => sheetRequest(ws, { action: 'ping' });

const syncing = new Set();

/** all=false: only new/changed rows are sent. */
export async function syncSheet(ws, all = false) {
  const key = String(ws);
  if (syncing.has(key)) throw httpError(409, 'Sync already running');
  syncing.add(key);
  try {
    const base = { workspaceId: ws };
    const leadFilter = all ? base : { ...base, $or: [{ syncedAt: null }, { $expr: { $gt: ['$updatedAt', '$syncedAt'] } }] };
    const leads = await col('leads').find(leadFilter).sort({ createdAt: 1 }).toArray();
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < leads.length; i += 300) {
      const chunk = leads.slice(i, i + 300);
      const syncedAt = new Date();
      const r = await sheetRequest(ws, { action: 'upsert', sheet: 'Leads', key: 'Page ID', headers: LEAD_HEADERS, rows: chunk.map(leadRow), keep: TEAM_COLUMNS });
      inserted += r.inserted || 0;
      updated += r.updated || 0;
      await col('leads').updateMany({ _id: { $in: chunk.map((l) => l._id) } }, { $set: { syncedAt } });
    }

    // ads are shared, so "already synced" is remembered per workspace as a time
    const s = await getWsSettings(ws);
    const startedAt = new Date();
    const projectIds = await col('projects').distinct('_id', { workspaceId: ws });
    const adFilter = { projectIds: { $in: projectIds }, ...(all || !s.adsSyncedAt ? {} : { updatedAt: { $gt: new Date(s.adsSyncedAt) } }) };
    const ads = await col('ads').find(adFilter).sort({ createdAt: 1 }).toArray();
    for (let i = 0; i < ads.length; i += 500) {
      const chunk = ads.slice(i, i + 500);
      await sheetRequest(ws, { action: 'upsert', sheet: 'Ads', key: 'Ad ID', headers: AD_HEADERS, rows: chunk.map(adRow) });
    }
    await col('workspaces').updateOne({ _id: ws }, { $set: { 'settings.lastSyncAt': new Date(), 'settings.adsSyncedAt': startedAt } });
    return { inserted, updated, ads: ads.length };
  } finally {
    syncing.delete(key);
  }
}

/** If the team changed Status/Notes in the Sheet, bring that into the dashboard (the Sheet wins). */
export async function pullSheet(ws) {
  const r = await sheetRequest(ws, { action: 'pull', sheet: 'Leads', fields: ['Page ID', 'Status', 'Notes'] });
  let changed = 0;
  for (const row of r.rows || []) {
    const pageId = String(row['Page ID'] || '');
    if (!pageId) continue;
    const l = await col('leads').findOne({ workspaceId: ws, pageId }, { projection: { status: 1, notes: 1 } });
    if (!l) continue;
    const set = {};
    // only a real status (a typo in the Sheet would otherwise become a status nobody can filter by)
    const status = STATUSES.find((s) => s.toLowerCase() === String(row.Status || '').trim().toLowerCase());
    if (status && status !== l.status) set.status = status;
    if ((row.Notes || '') !== (l.notes || '')) set.notes = String(row.Notes || '').slice(0, 5000);
    if (Object.keys(set).length) {
      const now = new Date();
      await col('leads').updateOne({ _id: l._id }, { $set: { ...set, updatedAt: now, syncedAt: now } });
      changed++;
    }
  }
  return { changed };
}

/** Background auto-sync for every workspace that turned it on. */
export async function autoSyncAll() {
  const wss = await col('workspaces').find({ 'settings.autoSync': true, 'settings.sheetUrl': { $nin: ['', null] } }).project({ _id: 1 }).toArray();
  for (const w of wss) {
    try {
      if (!(await accountOf(w._id)).perks.sheetSync) continue; // the plan no longer includes Sheet sync
      await syncSheet(w._id, false);
    } catch (e) {
      log('warn', `Auto-sync (${w._id}): ${e.message}`);
    }
  }
}
