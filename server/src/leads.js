// Data model:
//   pages  — one per Facebook page, shared by everybody (scraped once)
//   ads    — one per ad, shared; `projectIds` says which projects found it
//   leads  — one per (workspace, page): the user's own copy for filtering/export + status, notes, keywords.
//            The scraped fields are copied from `pages` (syncLeads); fields the user edited by hand
//            are listed in `overrides` and never overwritten.
import { col, log, pageActivity } from './db.js';
import { getSettings } from './settings.js';
import { websiteContacts, websitePlatform } from './contacts.js';
import { limited } from './background.js';
import { payForPage } from './billing.js';
import { queueChanged } from './queueSignal.js';
import { formatName, linkKind, orderChannel, refreshPageAdFacts, refreshSiteType } from './adFacts.js';
import { insightsAfterIngest } from './insights.js';

/** A link to the Facebook (or Instagram) page itself. */
export const isPageUrl = (u) => /^https?:\/\/([a-z0-9-]+\.)*(facebook|fb|instagram)\.com\//i.test(String(u || ''));

/** Website searches for an email (one per read page without one): 4 at a time. */
export const websiteSearch = limited(4);
import {
  adLink,
  analyzeLink,
  cleanEmails,
  escapeRe,
  fmtDate,
  pageAdsLink,
  pageLink,
  parseCount,
  uniq,
  uniqPhones,
} from './util.js';

const str = (v, max = 500) => (v == null ? '' : String(v)).slice(0, max);

export const STATUSES = ['New', 'Contacted', 'Interested', 'Not Interested', 'Closed'];

function sanitizeAd(a) {
  return {
    adId: str(a.adId, 40),
    pageId: str(a.pageId, 40),
    pageName: str(a.pageName, 200),
    pageUrl: str(a.pageUrl, 300),
    body: str(a.body, 3000),
    title: str(a.title, 300),
    linkUrl: str(a.linkUrl, 1000),
    cta: str(a.cta, 80),
    ctaType: str(a.ctaType, 40), // Facebook's button type: WHATSAPP_MESSAGE, MESSAGE_PAGE, CALL_NOW, SHOP_NOW …
    format: str(a.format, 30), // VIDEO, IMAGE, CAROUSEL, MULTI_IMAGES, DPA …
    caption: str(a.caption, 200),
    startDate: str(a.startDate, 20),
    platforms: Array.isArray(a.platforms) ? a.platforms.map((p) => str(p, 30)).slice(0, 10) : [],
    versions: Number(a.versions) || 1,
  };
}

// ---------- pages → leads ----------
/** Scraped page fields that are copied into every workspace's lead. */
const SYNC_FIELDS = [
  'pageName', 'pageUrl', 'category', 'adCategory', 'likes', 'pageImage', 'adSample', 'adCount', 'lastSeenAt', 'about', 'address',
  'socials', 'followers', 'followersNum', 'phones', 'emails', 'whatsapp', 'websites', 'website', 'instagram', 'adLinks', 'adWebsites',
  'scrapeStatus', 'scrapedAt', 'lastError', 'contactSource', 'country',
  // from the ads (adFacts.js) and the advertiser's website
  'firstAdDate', 'orderVia', 'adFormats', 'siteType', 'sitePlatform',
  'ins', // ad insights without AI (insights.js)
];
/** Fields a user can correct by hand (then they are theirs and never overwritten). */
export const OVERRIDABLE = ['pageName', 'pageUrl', 'category', 'website', 'websites', 'instagram', 'phones', 'whatsapp', 'emails'];

/**
 * Copy the shared page data into every workspace's lead for these pages.
 * `touch`: the page was just read — the leads count as updated (Google Sheet sync sends them again).
 */
export async function syncLeads(pageIds, { touch = false } = {}) {
  const ids = [...new Set((pageIds || []).map(String))];
  if (!ids.length) return;
  const pages = await col('pages').find({ pageId: { $in: ids } }).toArray();
  for (const p of pages) {
    // a page read for real: each workspace pays 1 credit before it sees it (billing.js) — one that can't
    // pay keeps waiting ("waiting for credits") and sees nothing of the page yet
    const billable = p.scrapeStatus === 'done' && p.lastError !== 'Page not available';
    if (billable) await payForPage(p.pageId);
    const set = touch ? { updatedAt: '$$NOW' } : {};
    for (const f of SYNC_FIELDS) {
      if (p[f] === undefined) continue;
      const value = { $literal: p[f] };
      if (f === 'scrapeStatus') {
        // a workspace that pressed Stop keeps seeing "stopped" until the page is actually read
        set[f] = { $cond: [{ $and: [{ $eq: ['$scrapeStatus', 'stopped'] }, { $in: [p[f], ['pending', 'working']] }] }, '$scrapeStatus', value] };
      } else if (OVERRIDABLE.includes(f)) {
        set[f] = { $cond: [{ $in: [f, { $ifNull: ['$overrides', []] }] }, `$${f}`, value] };
      } else set[f] = value;
    }
    // a read page's data goes only to the leads that paid for it; the others wait and see nothing yet
    await col('leads').updateMany(billable ? { pageId: p.pageId, charged: true } : { pageId: p.pageId }, [{ $set: set }]);
    if (billable) await col('leads').updateMany({ pageId: p.pageId, charged: { $ne: true } }, { $set: { scrapeStatus: 'pending' } });
  }
}

/** Saves ads from the Ad Library, creates/updates the shared page and the workspace's lead. */
export async function ingestAds(job, rawAds) {
  const now = new Date();
  const ads = (rawAds || []).filter((a) => a && a.adId && a.pageId).slice(0, 1000).map((a) => ({ raw: a, ad: sanitizeAd(a) }));
  if (!ads.length) return { ads: 0, pages: 0 };

  await col('ads').bulkWrite(
    ads.map(({ ad }) => ({
      updateOne: {
        filter: { adId: ad.adId },
        update: {
          $set: { ...ad, updatedAt: now },
          $setOnInsert: { createdAt: now, keyword: job.keyword },
          $addToSet: { keywords: job.keyword, projectIds: { $each: job.projectId ? [job.projectId] : [] } },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const byPage = new Map();
  for (const x of ads) {
    if (!byPage.has(x.ad.pageId)) byPage.set(x.ad.pageId, []);
    byPage.get(x.ad.pageId).push(x);
  }

  for (const [pageId, list] of byPage) {
    const first = list[0].raw;
    const existing = await col('pages').findOne({ pageId });
    const links = list.map((x) => analyzeLink(x.ad.linkUrl));
    const adCount = await col('ads').countDocuments({ pageId });
    const categories = Array.isArray(first.pageCategories)
      ? [...new Set(first.pageCategories.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean))].join(', ')
      : '';

    const set = { adCount, updatedAt: now, lastSeenAt: now };
    if (!existing?.pageName && first.pageName) set.pageName = str(first.pageName, 200);
    // only a Facebook/Instagram address is the page's link — a click-to-WhatsApp ad gives a wa.me /
    // api.whatsapp.com link here, which can't be read (the page is then reached by its id instead)
    if (!existing?.pageUrl && isPageUrl(first.pageUrl)) set.pageUrl = str(first.pageUrl, 300);
    if (categories) set.adCategory = str(categories, 200); // kept separately so a scrape can never overwrite it
    if (!validCategory(existing?.category) && categories) set.category = str(categories, 200);
    if (!existing?.likes && first.pageLikes) set.likes = String(first.pageLikes);
    if (!existing?.pageImage && first.pageImage) set.pageImage = str(first.pageImage, 1000);
    if (!existing?.adSample) set.adSample = str(list.find((x) => x.ad.body)?.ad.body || '', 400);
    if (existing?.scrapeStatus === 'stopped') set.scrapeStatus = 'pending'; // somebody wants it again

    await col('pages').updateOne(
      { pageId },
      {
        $setOnInsert: {
          pageId, createdAt: now, retries: 0, phones: [], emails: [], websites: [], website: '', instagram: '', contactSource: '',
          country: job.country || '', ...(existing ? {} : { scrapeStatus: 'pending' }),
        },
        $set: set,
        $addToSet: {
          wantedBy: job.workspaceId,
          adLinks: { $each: uniq(list.map((x) => x.ad.linkUrl)).slice(0, 10) },
          adWebsites: { $each: uniq(links.map((l) => l.website)) },
          whatsapp: { $each: uniqPhones(links.map((l) => l.whatsapp)) },
        },
      },
      { upsert: true },
    );

    await col('leads').updateOne(
      { workspaceId: job.workspaceId, pageId },
      {
        $setOnInsert: { workspaceId: job.workspaceId, pageId, createdAt: now, status: 'New', notes: '', overrides: [], syncedAt: null },
        $set: { updatedAt: now },
        $addToSet: { keywords: job.keyword, jobIds: job.id, projectIds: { $each: job.projectId ? [job.projectId] : [] } },
      },
      { upsert: true },
    );
  }
  queueChanged(); // new pages may wait now — the page queue looks again at once
  await refreshPageAdFacts([...byPage.keys()]); // advertising since, order channels, ad formats, site type
  await insightsAfterIngest(ads.map((x) => x.ad.adId)); // hooks, offers, prices (insights.js — never throws)
  await syncLeads([...byPage.keys()]);
  return { ads: ads.length, pages: byPage.size };
}

// ---------- About sub-sections → business info ----------
const linesOf = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);
const ADDRESS_RE = /(road|rd\.|house|shop|floor|market|complex|plaza|tower|mall|sector|block|lane|bazar|bazaar|dhaka|chattogram|chittagong|sylhet|khulna|rajshahi|barishal|barisal|rangpur|mymensingh|cumilla|comilla|gazipur|narayanganj|savar|uttara|mirpur|dhanmondi|gulshan|banani)/i;

/**
 * Words that are Facebook menu items / headings / labels — never real values.
 * (English + common Bangla UI strings)
 */
const UI_WORDS = new Set(
  [
    'intro', 'overview', 'bio', 'about', 'category', 'categories', 'details', 'personal details', 'profile', 'links', 'communities',
    'services', 'contact info', 'contact and basic info', 'basic info', 'privacy and legal info', 'page transparency',
    'websites and social links', 'social media', 'social links', 'messenger', 'instagram', 'tiktok', 'youtube', 'twitter', 'x',
    'linkedin', 'telegram', 'email', 'email address', 'phone', 'mobile', 'phone number', 'whatsapp', 'whatsapp number', 'website',
    'websites', 'address', 'hours', 'price range', 'creation date', 'page id', 'admin info', 'see all', 'more', 'posts', 'reels',
    'photos', 'videos', 'followers', 'following', 'mentions', 'reviews', 'places lived', 'rating', 'page', 'see more',
    // header buttons
    'message', 'follow', 'search', 'like', 'liked', 'share', 'send message', 'message us', 'send whatsapp message', 'call now',
    'call', 'book now', 'shop now', 'order now', 'start order', 'contact us', 'sign up', 'learn more', 'get quote', 'send email',
    'visit website', 'see menu', 'get directions', 'apply now', 'donate', 'play game', 'use app', 'watch video', 'listen',
    'subscribe', 'join', 'invite',
    'পরিচিতি', 'বিবরণ', 'যোগাযোগের তথ্য', 'ইমেল', 'ইমেইল', 'মোবাইল', 'ফোন', 'ঠিকানা', 'ওয়েবসাইট', 'হোয়াটসঅ্যাপ', 'বিভাগ',
  ].map((w) => w.toLowerCase()),
);
const isUiWord = (s) => UI_WORDS.has(String(s || '').trim().toLowerCase());

// What a valid value looks like for each field
const PHONE_LINE = /^\+?[\d\s\-().]{7,22}$/;
const VALID = {
  phones: (v) => PHONE_LINE.test(v) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15,
  whatsapp: (v) => VALID.phones(v),
  emails: (v) => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}$/i.test(v),
  websites: (v) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v) && !/@/.test(v),
  address: (v) => v.length >= 6 && v.length <= 250 && /[a-zঀ-৿]/i.test(v) && !VALID.emails(v) && !VALID.websites(v) && !VALID.phones(v),
  hours: (v) => /(open|closed|am|pm|hours|24\/7|always)/i.test(v),
  priceRange: (v) => /^\${1,4}$/.test(v) || /\$|৳|price/i.test(v),
  created: (v) => /\b(19|20)\d{2}\b/.test(v),
  fbPageId: (v) => /^\d{8,20}$/.test(v),
};

const LABELS = [
  ['phones', /^(mobile|phone|phone number|call|telephone|মোবাইল|ফোন)$/i],
  ['whatsapp', /^(whatsapp|whatsapp number|হোয়াটসঅ্যাপ)$/i],
  ['emails', /^(email|email address|ইমেল|ইমেইল)$/i],
  ['address', /^(address|ঠিকানা)$/i],
  ['websites', /^(website|websites|ওয়েবসাইট)$/i],
  ['hours', /^hours$/i],
  ['priceRange', /^price range$/i],
  ['created', /^creation date$/i],
  ['fbPageId', /^page id$/i],
];

/**
 * Facebook shows each contact value next to a label, in two layouts:
 *   logged-out:  "01886-960921" then "Mobile"      (value → label)
 *   logged-in:   "Email" then "info@shop.com"      (label → value)
 * For every label we check the line before AND after, and only take one that looks like that field.
 */
export function labeledValues(text) {
  const out = { phones: [], whatsapp: [], emails: [], websites: [], address: '', hours: '', priceRange: '', created: '', fbPageId: '' };
  const lines = linesOf(text);
  const used = new Set();
  for (let i = 0; i < lines.length; i++) {
    const hit = LABELS.find(([, re]) => re.test(lines[i]));
    if (!hit) continue;
    const [field] = hit;
    const idx = [i - 1, i + 1].find((j) => j >= 0 && j < lines.length && !used.has(j) && !isUiWord(lines[j]) && VALID[field](lines[j]));
    if (idx === undefined) continue;
    used.add(idx);
    const value = lines[idx];
    if (Array.isArray(out[field])) out[field].push(value);
    else if (!out[field]) out[field] = value;
  }
  return out;
}

/** A category must be a real value, not a menu word like "Details". */
const ZW = /[​-‍﻿]/g;

export const validCategory = (c) => {
  // "Shopping, Electronics, Electronics" → "Shopping, Electronics"; drop button words
  const parts = [...new Set(String(c || '').replace(ZW, '').split(/\s*,\s*/).map((x) => x.trim()).filter((x) => x && !isUiWord(x)))];
  const v = parts.join(', ');
  return v.length >= 2 && v.length <= 120 && !/^\d+$/.test(v) ? v : '';
};

/**
 * Facebook categories are plain English words from a fixed list: "Computer shop", "Health/beauty",
 * "Baby goods/children's goods". Rejects prices ("$$$"), emoji / fancy-font text, usernames ("oriviorglobaltrade",
 * "GadgetVillageShop").
 */
export const looksLikeCategory = (l) => /^[A-Z][A-Za-z &/,'().-]{1,60}$/.test(String(l || '').trim()) && !/[a-z][A-Z]/.test(l);

const NOT_BIO_LINE = /^(not yet rated|\d+% recommend|\d+(\.\d)? \(|\d+ reviews?|always open|open now|closed now|opens |closes |price range)/i;

/**
 * Same idea as the extension's reader, on stored text: the Page header is
 * "<bio>" then "<category>" before the Details / Intro / Contact info box (buttons skipped).
 */
export function headerInfo(text) {
  const lines = linesOf(String(text || '').replace(ZW, ''));
  const end = lines.findIndex((l) => /^(details|intro|contact info|links)$/i.test(l) || NOT_BIO_LINE.test(l));
  const head = (end >= 0 ? lines.slice(0, end) : lines.slice(0, 6)).filter((l) => !isUiWord(l));
  const bio = head.find((l) => l.length >= 25 && !NOT_BIO_LINE.test(l)) || '';
  const pageLine = lines.map((l) => l.match(/^Page\s*[·•]\s*(.+)$/)?.[1]).find(Boolean);
  const category =
    pageLine ||
    [...head].reverse().find((l) => l !== bio && l.length <= 40 && l.split(' ').length <= 5 && looksLikeCategory(l)) ||
    '';
  return { bio, category: validCategory(category) };
}

export function parseAbout(sections = {}, r = {}) {
  const get = (...names) => {
    for (const k of Object.keys(sections)) if (names.includes(k.toLowerCase())) return sections[k];
    return '';
  };
  const drop = (lines, ...heads) => lines.filter((l) => !heads.includes(l.toLowerCase()));
  const intro = drop(linesOf(get('intro', 'overview')), 'bio', 'intro');
  const all = [r.fullText || '', ...Object.values(sections)].join('\n');
  const details = linesOf(get('details') || get('main page', 'page') || r.fullText || '');
  const lv = labeledValues(all);

  const serviceArea = details.find((l) => /division|district|nationwide|service area/i.test(l) && (l.match(/·/g) || []).length >= 1) || '';
  if (r.address && (isUiWord(r.address) || !VALID.address(r.address))) r = { ...r, address: '' };
  const address = (
    lv.address ||
    r.address ||
    details.find((l) => ADDRESS_RE.test(l) && /,/.test(l) && l !== serviceArea && !isUiWord(l) && VALID.address(l)) ||
    ''
  ).replace(/^(ঠিকানা|address)\s*[:：]\s*/i, '');
  const rating = all.match(/(\d(?:\.\d)?|\d{1,3}% recommend)\s*\(\s*([\d,]+)\s+reviews?\)/i);
  const allLines = linesOf(all);
  // Category: "Page · Clothing (Brand)" in the page header, else the line after a "Categories" heading
  // (skipping menu words — in the logged-in menu "Category" is followed by "Details")
  const headerCat = all.match(/(?:^|\n)\s*Page\s*[·•]\s*([^\n]{2,120})/)?.[1] || '';
  const catIdx = allLines.findIndex((x) => /^categor(y|ies)$/i.test(x));
  const catAfterHeading = catIdx >= 0 ? allLines.slice(catIdx + 1, catIdx + 3).map(validCategory).find(Boolean) || '' : '';
  const category =
    validCategory(drop(linesOf(get('category')), 'category').filter((x) => !isUiWord(x)).join(', ')) ||
    validCategory(headerCat) ||
    (looksLikeCategory(r.pageCategory) ? validCategory(r.pageCategory) : '') ||
    headerInfo(get('page', 'main page')).category ||
    catAfterHeading;
  // WhatsApp without a label (main tab shows icons only): Facebook writes the WhatsApp number in
  // international format ("+880 1996-546565") next to the same number in local format ("01996-546565").
  const phoneLines = allLines.filter((x) => VALID.phones(x));
  for (const p of phoneLines) {
    if (!p.startsWith('+')) continue;
    const tail = p.replace(/\D/g, '').slice(-10);
    if (phoneLines.some((o) => !o.startsWith('+') && o.replace(/\D/g, '').slice(-10) === tail)) lv.whatsapp.push(p);
  }
  // Bio: the intro section, else the text right after a "Bio" heading
  const notBio = (x) => isUiWord(x) || x.length <= 12 || NOT_BIO_LINE.test(x) || /(reels|photos|videos|see all|followers|following|'s posts)$/i.test(x);
  const bioIdx = allLines.findIndex((x) => /^bio$/i.test(x));
  const bioAfter = bioIdx >= 0 && allLines[bioIdx + 1] && !notBio(allLines[bioIdx + 1]) ? allLines[bioIdx + 1] : '';
  const introText = intro.filter((x) => !notBio(x)).join(' ');

  return {
    bio: (
      introText ||
      bioAfter ||
      (isUiWord(r.pageBio) || NOT_BIO_LINE.test(r.pageBio || '') ? '' : r.pageBio || '') ||
      headerInfo(get('page', 'main page')).bio
    )
      .replace(ZW, '')
      .trim()
      .slice(0, 1000),
    category: category.slice(0, 200),
    address,
    hours: lv.hours || details.find((l) => /(always open|open now|closed now|opens?\s|closes?\s|24\/7)/i.test(l)) || '',
    priceRange: lv.priceRange || allLines.map((l) => l.match(/^price range\s*[·•:]\s*(.+)$/i)?.[1]).find(Boolean) || details.find((l) => /^[$£৳€]{1,4}$/.test(l)) || '',
    labeled: lv,
    serviceArea,
    services: drop(linesOf(get('services')), 'services').join(', ').slice(0, 500),
    communities: drop(linesOf(get('communities')), 'communities').join(', ').slice(0, 300),
    pageInfo: drop(linesOf(get('privacy and legal info', 'page transparency')), 'privacy and legal info', 'page transparency').join(' | ').slice(0, 1000),
    pageCreated: lv.created || '',
    rating: rating ? `${rating[1]} (${rating[2]} reviews)` : /not yet rated/i.test(all) ? 'Not yet rated' : '',
  };
}

/** Merges the result the extension sends after reading a Page into the shared page, then into every lead. */
export async function applyResult(pageId, r = {}) {
  const l = await col('pages').findOne({ pageId });
  if (!l) return;
  const now = new Date();

  if (r.error) {
    const retries = (l.retries || 0) + 1;
    await col('pages').updateOne(
      { pageId },
      // a failed attempt still counts towards today's limit (Facebook saw the visit)
      { $set: { retries, lastError: str(r.error, 300), scrapeStatus: retries >= 3 ? 'failed' : 'pending', updatedAt: now, lastAttemptAt: now } },
    );
    await syncLeads([pageId], { touch: retries >= 3 });
    await log('warn', `Scrape failed (${retries}/3) ${l.pageName || pageId}: ${r.error}`);
    return;
  }

  const sections = {};
  for (const [k, v] of Object.entries(r.sections || {})) sections[str(k, 60).replace(/[.$]/g, '_')] = str(v, 4000);
  const { labeled: lv, ...about } = parseAbout(sections, r);

  const links = (r.links || []).map(analyzeLink);
  const labeledSites = lv.websites.map((w) => analyzeLink(/^https?:/.test(w) ? w : `https://${w}`));
  const pageWebsites = uniq([...(r.websites || []), ...labeledSites.map((x) => x.website), ...links.map((x) => x.website)]);
  const whatsapp = uniqPhones([...(l.whatsapp || []), ...lv.whatsapp, ...(r.whatsapp || []), ...links.map((x) => x.whatsapp)]);
  // never treat Facebook's own Page ID as a phone number
  const idDigits = new Set([lv.fbPageId, pageId].map((x) => String(x || '').replace(/\D/g, '')).filter(Boolean));
  const phones = uniqPhones([...(l.phones || []), ...lv.phones, ...(r.phones || [])]).filter((p) => !idDigits.has(p.replace(/\D/g, '')));
  const emails = cleanEmails([...(l.emails || []), ...lv.emails, ...(r.emails || [])]);
  const websites = uniq([...pageWebsites, ...(l.websites || [])]);
  const instagram = r.instagram || [...labeledSites, ...links].find((x) => x.instagram)?.instagram || l.instagram || '';
  const socials = uniq([...(l.socials || []), ...labeledSites.map((x) => x.social), ...links.map((x) => x.social)]);

  const set = {
    // the name from the Ad Library is reliable; the scraped heading is only a fallback
    pageName: l.pageName || (/^(notifications|chats|menu)$/i.test(r.pageName || '') ? '' : r.pageName) || '',
    category: about.category || validCategory(l.adCategory) || validCategory(l.category) || '',
    about,
    address: about.address || l.address || '',
    sections,
    socials,
    followers: r.followers || l.followers || '',
    followersNum: parseCount(r.followers || l.followers),
    likes: r.likes || l.likes || '',
    phones,
    emails,
    whatsapp,
    websites,
    website: websites[0] || (l.adWebsites || [])[0] || '',
    instagram,
    scrapeStatus: 'done',
    scrapedAt: now,
    lastAttemptAt: now,
    updatedAt: now,
    lastError: r.notFound ? 'Page not available' : '',
    contactSource: (r.emails || []).length || (r.phones || []).length ? 'page' : l.contactSource || 'none',
  };
  if (!l.pageUrl && r.finalUrl && !/\/(login|checkpoint)/.test(r.finalUrl)) {
    set.pageUrl = r.finalUrl.replace(/\/about.*$/, '').replace(/[?&]sk=about.*$/, '');
  }
  await col('pages').updateOne({ pageId }, { $set: set, $unset: { wantedBy: '' } });
  await refreshSiteType(pageId); // its own website may be known now
  await syncLeads([pageId], { touch: true });

  const settings = await getSettings();
  const site = set.website;
  // the platform of its own website (Shopify, WooCommerce …) — one look at the home page, once per page
  if (site && linkKind(/^https?:\/\//.test(site) ? site : `https://${site}`) === 'site' && !l.sitePlatform && !(settings.websiteFallback && !emails.length)) {
    websiteSearch(() =>
      websitePlatform(site)
        .then(async (sitePlatform) => {
          if (!sitePlatform) return;
          await col('pages').updateOne({ pageId }, { $set: { sitePlatform } });
          await col('leads').updateMany({ pageId }, { $set: { sitePlatform } });
        })
        .catch(() => {}),
    );
  }
  if (settings.websiteFallback && !emails.length && site) {
    // after the response, at most a few at a time
    websiteSearch(() =>
      websiteContacts(site)
      .then(async (extra) => {
        if (extra.platform && linkKind(/^https?:\/\//.test(site) ? site : `https://${site}`) === 'site') {
          await col('pages').updateOne({ pageId }, { $set: { sitePlatform: extra.platform } });
          await col('leads').updateMany({ pageId }, { $set: { sitePlatform: extra.platform } });
        }
        if (!extra.emails.length && !extra.phones.length) return;
        const cur = await col('pages').findOne({ pageId });
        await col('pages').updateOne(
          { pageId },
          {
            $set: {
              emails: cleanEmails([...(cur.emails || []), ...extra.emails]),
              phones: uniqPhones([...(cur.phones || []), ...extra.phones]),
              contactSource: cur.contactSource === 'page' ? 'page+website' : 'website',
              updatedAt: new Date(),
            },
          },
        );
        await syncLeads([pageId], { touch: true });
        await pageActivity(pageId, 'found', `${cur.pageName || pageId} — contact found on the website`);
      })
      .catch((e) => log('warn', `Website fallback failed for ${site}: ${e.message}`)),
    );
  }
}

// ---------- listing ----------
/** Lead list filter — always limited to one workspace. Query values are forced to strings (no `kw[$ne]=` tricks). */
export function buildFilter(ws, q = {}) {
  const s = (v) => (v == null ? '' : String(v));
  const and = [{ workspaceId: ws }];
  if (s(q.q)) {
    const re = new RegExp(escapeRe(s(q.q).slice(0, 200)), 'i');
    and.push({
      $or: [{ pageName: re }, { category: re }, { emails: re }, { phones: re }, { whatsapp: re }, { website: re }, { address: re }, { notes: re }, { keywords: re }, { pageId: s(q.q) }],
    });
  }
  if (s(q.kw)) and.push({ keywords: s(q.kw) });
  if (s(q.status)) and.push({ status: s(q.status) });
  if (s(q.jobId)) and.push({ jobIds: s(q.jobId) });
  if (q.scrape === 'pending') and.push({ scrapeStatus: { $in: ['pending', 'working'] } });
  else if (s(q.scrape)) and.push({ scrapeStatus: s(q.scrape) });
  if (q.has === 'email') and.push({ 'emails.0': { $exists: true } });
  if (q.has === 'phone') and.push({ $or: [{ 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] });
  if (q.has === 'any')
    and.push({ $or: [{ 'emails.0': { $exists: true } }, { 'phones.0': { $exists: true } }, { 'whatsapp.0': { $exists: true } }] });
  if (q.has === 'none')
    and.push({ 'emails.0': { $exists: false } }, { 'phones.0': { $exists: false } }, { 'whatsapp.0': { $exists: false } });
  // "must have" chips — each one ticked narrows the list (Phone + Email = both)
  for (const n of s(q.need).split(',')) if (NEED[n]) and.push(NEED[n]);
  if (s(q.cat)) and.push({ category: new RegExp(escapeRe(s(q.cat).slice(0, 100)), 'i') });
  if (s(q.country)) and.push({ country: s(q.country) });
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  if (num(q.minFollowers)) and.push({ followersNum: { $gte: num(q.minFollowers) } });
  if (num(q.maxFollowers)) and.push({ followersNum: { $lte: num(q.maxFollowers) } });
  if (num(q.minAds)) and.push({ adCount: { $gte: num(q.minAds) } });
  if (num(q.days)) and.push({ createdAt: { $gte: new Date(Date.now() - num(q.days) * 86400e3) } });
  // from the ads: how it takes orders, ad formats (any of the ticked ones), its website, advertising for N+ days
  const list = (v) => s(v).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
  if (list(q.via).length) and.push({ orderVia: { $in: list(q.via) } });
  if (list(q.format).length) and.push({ adFormats: { $in: list(q.format) } });
  if (list(q.site).length) and.push({ siteType: { $in: list(q.site) } });
  if (list(q.platform).length) and.push({ sitePlatform: { $in: list(q.platform) } });
  if (list(q.offer).length) and.push({ 'ins.offers': { $in: list(q.offer) } }); // insights.js
  if (num(q.minRunDays)) and.push({ firstAdDate: { $gt: '', $lte: dayOffset(-num(q.minRunDays)) } });
  return { $and: and };
}
const NEED = {
  phone: { 'phones.0': { $exists: true } },
  whatsapp: { 'whatsapp.0': { $exists: true } },
  email: { 'emails.0': { $exists: true } },
  website: { website: { $nin: ['', null] } },
  nowebsite: { website: { $in: ['', null] } },
};
/** The chip counts: how many of the leads (with every other filter) have each kind of contact. */
export const CONTACT_KINDS = {
  phone: NEED.phone,
  whatsapp: NEED.whatsapp,
  email: NEED.email,
  website: NEED.website,
  none: { 'emails.0': { $exists: false }, 'phones.0': { $exists: false }, 'whatsapp.0': { $exists: false } },
};

/** The date N days from today as YYYY-MM-DD (the ads' start dates are stored that way). */
const dayOffset = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
/** Days since a YYYY-MM-DD date (advertising for N days). */
export const runningDays = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 86400e3)) : '');

const SORTS = { running: 'firstAdDate', updatedAt: 'updatedAt', createdAt: 'createdAt', adCount: 'adCount', followers: 'followersNum', pageName: 'pageName', scrapedAt: 'scrapedAt', contacts: '_contacts' };
// "running": most days first = the earliest first ad first
export const buildSort = (sort, dir) => ({ [SORTS[sort] || 'updatedAt']: (dir === 'asc') !== (sort === 'running') ? 1 : -1, _id: 1 });

/**
 * The leads for a list or an export, sorted. "Most contacts" counts phones + WhatsApp + emails per lead,
 * which needs an aggregation; every other sort is a plain find.
 */
export function leadsCursor(ws, q, { skip = 0, limit }) {
  const filter = buildFilter(ws, q);
  const sort = buildSort(q.sort, q.dir);
  if (q.sort !== 'contacts') return col('leads').find(filter).sort(sort).skip(skip).limit(limit);
  const size = (f) => ({ $size: { $ifNull: [`$${f}`, []] } });
  return col('leads').aggregate(
    [
      { $match: filter },
      { $addFields: { _contacts: { $add: [size('phones'), size('whatsapp'), size('emails')] } } },
      { $sort: sort },
      { $skip: skip },
      { $limit: limit },
      { $project: { _contacts: 0 } },
    ],
    { allowDiskUse: true },
  );
}

// ---------- export rows (Excel / CSV / Google Sheet) ----------
export const LEAD_HEADERS = [
  'Page ID', 'Page Name', 'Page Link', 'Category', 'Phone', 'WhatsApp', 'Email', 'Website', 'Instagram',
  'Other Links', 'Address', 'Bio', 'Hours', 'Price Range', 'Service Area', 'Services', 'Rating', 'Page Info',
  'Followers', 'Likes', 'Active Ads', 'Keywords', 'Ad Landing Link', 'Sample Ad Text', 'Page Ads (Library)',
  'Status', 'Notes', 'Scrape Status', 'Scraped At',
  'Advertising Since', 'Running Days', 'Orders Via', 'Ad Formats', 'Website Type', 'Website Platform',
  'Best Ad Hook', 'Offers', 'Price Range',
];

export const leadRow = (l) => [
  l.pageId,
  l.pageName || '',
  pageLink(l),
  l.category || '',
  (l.phones || []).join(', '),
  (l.whatsapp || []).join(', '),
  (l.emails || []).join(', '),
  l.website || '',
  l.instagram || '',
  (l.socials || []).join(', '),
  l.address || '',
  l.about?.bio || '',
  l.about?.hours || '',
  l.about?.priceRange || '',
  l.about?.serviceArea || '',
  l.about?.services || '',
  l.about?.rating || '',
  l.about?.pageInfo || '',
  l.followers || '',
  l.likes || '',
  l.adCount || 0,
  (l.keywords || []).join(', '),
  (l.adLinks || [])[0] || '',
  (l.adSample || '').slice(0, 300),
  pageAdsLink(l.pageId),
  l.status || 'New',
  l.notes || '',
  l.scrapeStatus || '',
  fmtDate(l.scrapedAt),
  l.firstAdDate || '',
  runningDays(l.firstAdDate),
  (l.orderVia || []).join(', '),
  (l.adFormats || []).join(', '),
  l.siteType || '',
  l.sitePlatform || '',
  l.ins?.bestHook || '',
  (l.ins?.offers || []).join(', '),
  priceRange(l.ins),
];

/** "৳950 – ৳2,450" from the insights' price range. */
export const priceRange = (ins) => (ins?.priceMin == null ? '' : ins.priceMin === ins.priceMax ? `৳${ins.priceMin.toLocaleString('en')}` : `৳${ins.priceMin.toLocaleString('en')} – ৳${ins.priceMax.toLocaleString('en')}`);

export const AD_HEADERS = ['Ad ID', 'Page ID', 'Page Name', 'Ad Text', 'Headline', 'Landing Link', 'CTA', 'Start Date', 'Platforms', 'Keywords', 'Ad Link', 'Format', 'Order Via', 'Hook', 'Offers', 'Price'];

export const adRow = (a) => [
  a.adId,
  a.pageId,
  a.pageName || '',
  (a.body || '').slice(0, 1000),
  a.title || '',
  a.linkUrl || '',
  a.cta || '',
  a.startDate || '',
  (a.platforms || []).join(', '),
  (a.keywords || [a.keyword]).filter(Boolean).join(', '),
  adLink(a.adId),
  formatName(a.format),
  orderChannel(a),
  a.ins?.hook || '',
  (a.ins?.offers || []).join(', '),
  (a.ins?.prices || []).map((p) => `৳${p.toLocaleString('en')}`).join(', '),
];
