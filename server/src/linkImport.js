// Paste links: a list of Facebook Page links → their pages are read like a search's pages, into a project of
// its own (source: 'links'), kept apart from the keyword searches (Projects → Pasted links, All Leads → Source).
//
// No Ad Library is involved: the pasted Pages go straight into the page queue (pageQueue.js) and are read by the
// same readers, with the same rules and the same credits (1 page = 1 credit, billing.js). A page that was read in
// the last FRESH_DAYS days (by an earlier search or paste) is handed over at once instead of being read again.
import { activity, col, httpError } from './db.js';
import { parseLinks } from './fbLinks.js';
import { createLinksProject, queuePages } from './projects.js';
import { syncLeads } from './leads.js';
import { queueChanged } from './queueSignal.js';
import { accountOf } from './billing.js';
import { escapeRe } from './util.js';

export const LINKS_MAX = 500;
export const FRESH_DAYS = 30;

const fresh = (p) => p?.scrapeStatus === 'done' && p.scrapedAt && Date.now() - new Date(p.scrapedAt).getTime() < FRESH_DAYS * 864e5;

/**
 * The pages we already have for the pasted ones: by number, by "@username" (pasted before), or — for a username —
 * a page found by a search whose link has that username. Returns parsed pageId → existing page.
 */
async function existingPages(pages) {
  const proj = { pageId: 1, pageUrl: 1, scrapeStatus: 1, scrapedAt: 1 };
  const found = new Map();
  const direct = pages.map((p) => p.pageId);
  for (const p of await col('pages').find({ pageId: { $in: direct } }).project(proj).toArray()) found.set(p.pageId, p);
  // a number that is not a known page id: many Pages' links carry their profile number, which is not the id the
  // Ad Library gives them (facebook.com/100095…/ for page 1097…) — found by that number in their link
  const numbers = pages.filter((p) => !p.username && !found.has(p.pageId)).map((p) => p.pageId);
  for (let i = 0; i < numbers.length; i += 100) {
    const chunk = numbers.slice(i, i + 100);
    const re = new RegExp(`^https?://([a-z0-9-]+\\.)?facebook\\.com/(?:profile\\.php\\?id=)?(${chunk.join('|')})(?:/|&|$)`, 'i');
    for (const p of await col('pages').find({ pageUrl: re, pageId: { $not: /^@/ } }).project(proj).toArray()) {
      const n = String(p.pageUrl).match(re)?.[2];
      if (n && !found.has(n)) found.set(n, p);
    }
  }
  const names = pages.filter((p) => p.username && !found.has(p.pageId)).map((p) => p.username);
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100);
    const re = new RegExp(`^https?://([a-z0-9-]+\\.)?facebook\\.com/(${chunk.map(escapeRe).join('|')})/?$`, 'i');
    for (const p of await col('pages').find({ pageUrl: re, pageId: { $not: /^@/ } }).project(proj).toArray()) {
      const name = String(p.pageUrl).replace(/\/+$/, '').split('/').pop().toLowerCase();
      if (!found.has(`@${name}`)) found.set(`@${name}`, p);
    }
  }
  return found;
}

/** What a paste would do — shown while typing, before anything is saved. */
export async function previewLinks(ws, text) {
  const parsed = parseLinks(text, LINKS_MAX);
  const found = await existingPages(parsed.pages);
  const ids = parsed.pages.map((p) => found.get(p.pageId)?.pageId || p.pageId);
  const inLeads = ids.length ? await col('leads').countDocuments({ workspaceId: ws, pageId: { $in: ids } }) : 0;
  const alreadyRead = parsed.pages.filter((p) => fresh(found.get(p.pageId))).length;
  const acc = await accountOf(ws);
  return {
    valid: parsed.pages.length, duplicates: parsed.duplicates, tooMany: parsed.tooMany, max: LINKS_MAX,
    invalidCount: parsed.invalid.length, invalid: parsed.invalid.slice(0, 50),
    inLeads, alreadyRead, toRead: parsed.pages.length - alreadyRead,
    credits: acc.unlimited ? null : acc.credits,
  };
}

/** The paste, checked: throws the reason when it can't be used (called before a search of the day is used up). */
export function checkLinks(text) {
  const parsed = parseLinks(text, LINKS_MAX);
  if (parsed.tooMany) throw httpError(400, `At most ${LINKS_MAX} Pages at a time — you pasted ${parsed.pages.length + parsed.tooMany}. Split them into smaller lists.`);
  if (!parsed.pages.length) throw httpError(400, parsed.invalid.length ? `No Facebook Page link found — ${parsed.invalid[0].reason}` : 'Paste at least one Facebook Page link');
  return parsed;
}

/** Saves a paste: a new project, a "links" search, the pages (queued unless read lately) and the leads. */
export async function importLinks({ ws, userId, text, name }) {
  const parsed = checkLinks(text);
  const now = new Date();
  const title = String(name || '').trim().slice(0, 120) || `Links — ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: process.env.TZ || 'Asia/Dhaka' })}`;
  const found = await existingPages(parsed.pages);
  const rows = parsed.pages.map((p) => ({ ...p, page: found.get(p.pageId) || null, pageId: found.get(p.pageId)?.pageId || p.pageId }));
  const ids = [...new Set(rows.map((r) => r.pageId))];

  const projectId = await createLinksProject(ws, title);
  const { insertedId: jobId } = await col('jobs').insertOne({
    workspaceId: ws, userId, kind: 'links', keyword: title, country: 'ALL', phase: 'collected', manual: false, adsSeen: 0, pageIds: ids, projectId,
    createdAt: now, startedAt: now, collectedAt: now, note: 'pasted links',
    linkStats: { valid: parsed.pages.length, invalid: parsed.invalid.length, duplicates: parsed.duplicates },
  });

  // the pages: new ones go into the queue for this workspace; known ones are wanted by it too
  await col('pages').bulkWrite(
    rows.map((r) => ({
      updateOne: {
        filter: { pageId: r.pageId },
        update: {
          $setOnInsert: {
            pageId: r.pageId, pageUrl: r.pageUrl, pageName: r.username || '', createdAt: now, retries: 0, phones: [], emails: [], websites: [], website: '',
            instagram: '', contactSource: '', country: '', scrapeStatus: 'pending', source: 'link',
          },
          $addToSet: { wantedBy: ws },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  // the leads: leads this workspace already had (from its searches) keep that origin, and get "links" too
  await col('leads').updateMany({ workspaceId: ws, pageId: { $in: ids }, sources: { $exists: false } }, { $set: { sources: ['search'] } });
  await col('leads').bulkWrite(
    ids.map((pageId) => ({
      updateOne: {
        filter: { workspaceId: ws, pageId },
        update: {
          $setOnInsert: { workspaceId: ws, pageId, createdAt: now, status: 'New', notes: '', overrides: [], syncedAt: null, scrapeStatus: 'pending' },
          $set: { updatedAt: now },
          $addToSet: { jobIds: String(jobId), projectIds: projectId, sources: 'links' },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  // known pages not read lately (or that failed / were stopped) are read again; the fresh ones are handed over now
  const stale = rows.filter((r) => r.page && !fresh(r.page) && ['done', 'failed', 'stopped'].includes(r.page.scrapeStatus)).map((r) => r.pageId);
  if (stale.length) await queuePages(ws, stale, { force: true });
  queueChanged();
  await syncLeads(ids);

  const alreadyRead = rows.filter((r) => fresh(r.page)).length;
  await activity('queued', `Pasted links: "${title}" — ${ids.length} Pages (${alreadyRead} already read, ${ids.length - alreadyRead} to read)`, { workspaceId: ws, projectId });
  return {
    projectId: String(projectId), jobId: String(jobId), name: title, pages: ids.length, alreadyRead, toRead: ids.length - alreadyRead,
    invalid: parsed.invalid.length, duplicates: parsed.duplicates,
  };
}
