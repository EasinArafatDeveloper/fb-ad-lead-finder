import { col, log } from './db.js';
import { getSettings } from './settings.js';
import { AD_HEADERS, LEAD_HEADERS, adRow, leadRow } from './leads.js';

async function sheetRequest(payload) {
  const s = await getSettings();
  if (!s.sheetUrl) throw new Error('Google Sheet Web App URL is not set (Settings)');
  const r = await fetch(s.sheetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: s.sheetSecret, ...payload }),
    redirect: 'follow',
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('The Sheet did not send a valid response. Check that the Web App is deployed with "Anyone" access.');
  }
  if (!j.ok) throw new Error(j.error || 'Sheet error');
  return j;
}

export const testSheet = () => sheetRequest({ action: 'ping' });

let syncing = false;

/** all=false: only new/changed rows are sent. */
export async function syncSheet(all = false) {
  if (syncing) throw new Error('Sync already running');
  syncing = true;
  try {
    const leadFilter = all ? {} : { $or: [{ syncedAt: null }, { $expr: { $gt: ['$updatedAt', '$syncedAt'] } }] };
    const leads = await col('leads').find(leadFilter).sort({ createdAt: 1 }).toArray();
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < leads.length; i += 300) {
      const chunk = leads.slice(i, i + 300);
      const syncedAt = new Date();
      const r = await sheetRequest({ action: 'upsert', sheet: 'Leads', key: 'Page ID', headers: LEAD_HEADERS, rows: chunk.map(leadRow) });
      inserted += r.inserted || 0;
      updated += r.updated || 0;
      await col('leads').updateMany({ _id: { $in: chunk.map((l) => l._id) } }, { $set: { syncedAt } });
    }

    const ads = await col('ads').find(all ? {} : { syncedAt: { $exists: false } }).sort({ createdAt: 1 }).toArray();
    for (let i = 0; i < ads.length; i += 500) {
      const chunk = ads.slice(i, i + 500);
      await sheetRequest({ action: 'upsert', sheet: 'Ads', key: 'Ad ID', headers: AD_HEADERS, rows: chunk.map(adRow) });
      await col('ads').updateMany({ _id: { $in: chunk.map((a) => a._id) } }, { $set: { syncedAt: new Date() } });
    }
    await col('settings').updateOne({ _id: 'main' }, { $set: { lastSyncAt: new Date() } }, { upsert: true });
    await log('info', `Sheet sync: ${inserted} new, ${updated} updated leads, ${ads.length} ads`);
    return { inserted, updated, ads: ads.length };
  } finally {
    syncing = false;
  }
}

/** If the team changed Status/Notes in the Sheet, bring that into MongoDB (the Sheet wins). */
export async function pullSheet() {
  const r = await sheetRequest({ action: 'pull', sheet: 'Leads', fields: ['Page ID', 'Status', 'Notes'] });
  let changed = 0;
  for (const row of r.rows || []) {
    const pageId = String(row['Page ID'] || '');
    if (!pageId) continue;
    const l = await col('leads').findOne({ pageId }, { projection: { status: 1, notes: 1 } });
    if (!l) continue;
    const set = {};
    if (row.Status && row.Status !== l.status) set.status = String(row.Status);
    if ((row.Notes || '') !== (l.notes || '')) set.notes = String(row.Notes || '');
    if (Object.keys(set).length) {
      const now = new Date();
      await col('leads').updateOne({ pageId }, { $set: { ...set, updatedAt: now, syncedAt: now } });
      changed++;
    }
  }
  return { changed };
}
