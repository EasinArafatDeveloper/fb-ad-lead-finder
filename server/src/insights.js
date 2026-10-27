// Ad insights WITHOUT AI — read from the ads' own text, nothing estimated:
//   per ad   (ads.ins):   hook (the opening line), offers, prices, language, length, emojis
//   per page (pages.ins → leads.ins): its longest-running ad's hook, all its offers, its price range
//   per project: the Insights page (projectInsights) — hooks of the long-running ads, offers, prices, formats …
//
// Kept apart from the engine on purpose: one call from leads.js (ingestAds), wrapped so an error here can
// never stop ads from being saved; everything is stored under one field `ins`; Settings → Worker can turn it
// off. Removing the feature = delete this file, that call, the `ins` fields and the Insights page.
import { col, log } from './db.js';
import { getSettings } from './settings.js';
import { formatName, orderChannel } from './adFacts.js';

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const latinDigits = (s) => String(s || '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** The opening line of the ad — what makes people stop scrolling. '' if there is no real text. */
export function hookOf(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((l) => l.replace(/^[\s\p{Extended_Pictographic}‍️*•✅✔️👉➡️▶️🔥⭐-]+/u, '').trim())
    .filter((l) => l.length >= 6 && /[\p{L}]/u.test(l) && !/\{\{.*\}\}/.test(l));
  // hashtag-style lines (#Big_Sale_Today) read as words
  let h = (lines[0] || '').replace(/#/g, '').replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (h.length > 160) {
    // a long first line: up to its last sentence end within 160 characters, else cut with "…"
    let cut = -1;
    for (const m of h.slice(0, 160).matchAll(/[।!?.](\s|$)/gu)) cut = m.index;
    h = cut > 30 ? h.slice(0, cut + 1) : `${h.slice(0, 157).trimEnd()}…`;
  }
  return h;
}

// what the advertiser offers — each pattern in Bangla and English
const OFFERS = [
  ['Free delivery', /(ফ্রি|ফ্রী|free)\s*(হোম\s*)?(ডেলিভারি|ডেলিভারী|ডেলিভারী|delivery|shipping)/i],
  ['Cash on delivery', /cash\s*on\s*delivery|ক্যাশ\s*অন\s*ডেলিভারি|\bCOD\b|(পণ্য|প্রোডাক্ট)\s*(হাতে\s*)?(পেয়ে|বুঝে)\s*(টাকা|মূল্য|পেমেন্ট|পরিশোধ)/i],
  ['Discount', /\d{1,2}\s*%\s*(পর্যন্ত\s*)?(ছাড়|ছাড়|off|discount|ডিসকাউন্ট)|ডিসকাউন্ট|discount|ছাড়ে|ছাড়ে|\bsale\b|সেল(?![\u0980-\u09FF])/i],
  ['EMI', /\bEMI\b|কিস্তি/i],
  ['Warranty', /warranty|ওয়ারেন্টি|ওয়ারেন্টি|গ্যারান্টি|গ্যারান্টি|guarantee/i],
  ['Buy 1 get 1', /buy\s*(1|one)\s*get\s*(1|one)|১\s*টা?\s*কিনলে|একটি\s*কিনলে|একটা\s*কিনলে/i],
  ['Gift', /\bgift\b|গিফট|উপহার/i],
  ['Limited time', /সীমিত\s*সময়|সীমিত সময়|limited\s*(time|offer|stock)|আজই\s*শেষ|last\s*day|স্টক\s*সীমিত|অফার\s*চলবে/i],
];
export const OFFER_NAMES = OFFERS.map(([n]) => n);
// Bangla letters like ড় / য় can be written two ways (one character, or letter + dot): compare both sides in
// the same form, and with Latin digits (৩০% = 30%)
const same = (s) => latinDigits(String(s || '')).normalize('NFD');
const OFFER_RES = OFFERS.map(([n, re]) => [n, new RegExp(re.source.normalize('NFD'), re.flags)]);

/** Offers named in the ad. */
export const offersOf = (text) => {
  const t = same(text);
  return OFFER_RES.filter(([, re]) => re.test(t)).map(([n]) => n);
};

/** Prices written in the ad (৳ 950, 1,250 টাকা, Tk 500, 990/-) — not phone numbers, not delivery charges. */
export function pricesOf(text) {
  const t = latinDigits(text);
  const out = [];
  const re = /(?:৳|tk\.?|টাকা|bdt)\s*([\d][\d,]*)|([\d][\d,]*)\s*(?:৳|tk\b|টাকা|bdt|\/-)/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(String(m[1] || m[2]).replace(/,/g, ''));
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    if (!n || n < 20 || n > 10_000_000) continue;
    if (/ডেলিভারি|ডেলিভারী|delivery|charge|চার্জ|শিপিং/i.test(before)) continue; // a delivery charge, not the price
    out.push(n);
  }
  return [...new Set(out)].slice(0, 10);
}

/** Bangla, English or both. */
export function languageOf(text) {
  const t = String(text || '');
  const bn = (t.match(/[ঀ-৿]/g) || []).length;
  const en = (t.match(/[A-Za-z]/g) || []).length;
  if (!bn && !en) return '';
  if (bn > en * 4) return 'Bangla';
  if (en > bn * 4) return 'English';
  return 'Mixed';
}

/** Everything for one ad. */
export function adInsight(ad) {
  const text = [ad.body, ad.title].filter(Boolean).join('\n');
  return {
    hook: hookOf(ad.body) || hookOf(ad.title),
    offers: offersOf(text),
    prices: pricesOf(text),
    lang: languageOf(text),
    length: String(ad.body || '').length,
    emojis: (String(ad.body || '').match(EMOJI_RE) || []).length,
  };
}

let enabledCache = { at: 0, on: true };
export async function insightsEnabled() {
  if (Date.now() - enabledCache.at < 10000) return enabledCache.on;
  enabledCache = { at: Date.now(), on: (await getSettings()).insights !== false };
  return enabledCache.on;
}

/** Work out the insights of these ads, then of their pages (and copy those into every workspace's lead). */
export async function annotateAds(adIds) {
  const ids = [...new Set((adIds || []).map(String))];
  if (!ids.length) return 0;
  const ads = await col('ads').find({ adId: { $in: ids } }).project({ adId: 1, pageId: 1, body: 1, title: 1 }).toArray();
  if (!ads.length) return 0;
  await col('ads').bulkWrite(ads.map((a) => ({ updateOne: { filter: { adId: a.adId }, update: { $set: { ins: adInsight(a) } } } })), { ordered: false });
  await refreshPageInsights(ads.map((a) => a.pageId));
  return ads.length;
}

/** A page's insights from all its ads: the hook of its longest-running ad, its offers, its price range. */
export async function refreshPageInsights(pageIds) {
  const ids = [...new Set((pageIds || []).map(String))];
  for (const pageId of ids) {
    const ads = await col('ads').find({ pageId, ins: { $exists: true } }).project({ startDate: 1, ins: 1 }).toArray();
    if (!ads.length) continue;
    const withHook = ads.filter((a) => a.ins.hook);
    // the longest-running ad = the earliest start — an advertiser keeps paying only for an ad that works
    const best = withHook.sort((a, b) => String(a.startDate || '9').localeCompare(String(b.startDate || '9')))[0];
    const prices = ads.flatMap((a) => a.ins.prices || []).sort((a, b) => a - b);
    const ins = {
      bestHook: best?.ins.hook || '',
      bestHookSince: best?.startDate || '',
      hooks: new Set(withHook.map((a) => a.ins.hook)).size,
      offers: OFFER_NAMES.filter((n) => ads.some((a) => (a.ins.offers || []).includes(n))),
      priceMin: prices[0] ?? null,
      priceMax: prices[prices.length - 1] ?? null,
    };
    await col('pages').updateOne({ pageId }, { $set: { ins } });
    await col('leads').updateMany({ pageId }, { $set: { ins } });
  }
}

/** The one entry point from the engine: never throws, does nothing when switched off. */
export async function insightsAfterIngest(adIds) {
  try {
    if (!(await insightsEnabled())) return;
    await annotateAds(adIds);
  } catch (e) {
    await log('warn', `Ad insights skipped: ${e.message}`).catch(() => {});
  }
}

// ---------------- the project's Insights page ----------------
const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 86400e3)) : 0);

const AD_FIELDS = { adId: 1, pageId: 1, pageName: 1, startDate: 1, format: 1, cta: 1, ctaType: 1, linkUrl: 1, ins: 1 };
const HOOK_PAGES_MAX = 100000; // "used by N advertisers" per hook (a cap only so one hook can't hold everything)

/**
 * Insights over any number of ads, added one at a time (a project's few hundred, or every ad of all the leads —
 * hundreds of thousands, read from the database in parts). `add(ad)` for each, then `result()`.
 */
function adTally() {
  let n = 0;
  let analysed = 0;
  let longRunning = 0;
  let adsWithOffer = 0;
  let adsWithPrice = 0;
  const byHook = new Map();
  const prices = [];
  const offers = new Map(OFFER_NAMES.map((o) => [o, 0]));
  const formats = new Map();
  const orderVia = new Map();
  const languages = new Map();
  const pages = new Map();
  const bump = (m, k) => k && m.set(k, (m.get(k) || 0) + 1);
  return {
    add(a) {
      n++;
      const d = daysSince(a.startDate);
      const p = pages.get(a.pageId) || { pageId: a.pageId, pageName: a.pageName, ads: 0, days: 0 };
      p.ads++;
      p.days = Math.max(p.days, d);
      pages.set(a.pageId, p);
      bump(formats, formatName(a.format));
      bump(orderVia, orderChannel(a));
      if (!a.ins) return;
      analysed++;
      if (d >= 30) longRunning++;
      bump(languages, a.ins.lang);
      if (a.ins.offers?.length) adsWithOffer++;
      if (a.ins.prices?.length) adsWithPrice++;
      for (const o of a.ins.offers || []) if (offers.has(o)) offers.set(o, offers.get(o) + 1);
      for (const x of a.ins.prices || []) prices.push(x);
      // hooks: the same opening line used in several ads counts once, ranked by how long its ads have run
      if (a.ins.hook) {
        const k = a.ins.hook.toLowerCase();
        const cur = byHook.get(k) || { hook: a.ins.hook, ads: 0, days: -1, pageName: a.pageName, adId: a.adId, pages: new Set() };
        cur.ads++;
        if (cur.pages.size < HOOK_PAGES_MAX) cur.pages.add(a.pageId);
        if (d > cur.days) Object.assign(cur, { days: d, pageName: a.pageName, adId: a.adId });
        byHook.set(k, cur);
      }
    },
    /** Everything — every hook, every advertiser; nothing cut. The page shows parts of the long lists (insightsView). */
    result() {
      const pct = (k) => (n ? Math.round((k * 100) / n) : 0);
      const share = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, ads: v, pct: pct(v) }));
      const hooks = [...byHook.values()].sort((a, b) => b.days - a.days || b.ads - a.ads).map(({ pages: pg, ...h }) => ({ ...h, days: Math.max(0, h.days), pages: pg.size }));
      prices.sort((a, b) => a - b);
      const q = (p) => (prices.length ? prices[Math.min(prices.length - 1, Math.floor(p * prices.length))] : null);
      return {
        ads: n,
        analysed,
        longRunning,
        adsWithOffer,
        adsWithPrice,
        hooks,
        // each offer: share of all the ads, and of the ads that name any offer at all
        offers: OFFER_NAMES.map((o) => ({ offer: o, ads: offers.get(o), pct: pct(offers.get(o)), pctOfOffers: adsWithOffer ? Math.round((offers.get(o) * 100) / adsWithOffer) : 0 })).sort((a, b) => b.ads - a.ads),
        prices: prices.length ? { count: prices.length, min: prices[0], low: q(0.25), median: q(0.5), high: q(0.75), max: prices[prices.length - 1] } : null,
        formats: share(formats),
        orderVia: share(orderVia),
        languages: share(languages),
        advertisers: [...pages.values()].sort((a, b) => b.ads - a.ads || b.days - a.days),
      };
    },
  };
}

/** A project's insights, complete (every hook and advertiser). */
export async function projectInsights(projectId) {
  const t = adTally();
  for await (const a of col('ads').find({ projectIds: projectId }).project(AD_FIELDS)) t.add(a);
  return t.result();
}

// ---------------- what the page gets: everything, the two long lists in pages ----------------
export const FIRST_ROWS = 25;

/**
 * The insights for the page: every number and every short list (offers, formats, categories …) whole; of the two
 * long lists (hooks, advertisers) the first rows and how many there are — the rest come with insightsList.
 */
export function insightsView(full) {
  const { hooks, advertisers, ...rest } = full;
  return {
    ...rest,
    hookCount: hooks.length,
    hooks: hooks.slice(0, FIRST_ROWS),
    longHookCount: hooks.filter((h) => h.days >= 30).length,
    advertiserCount: advertisers.length,
    advertisers: advertisers.slice(0, FIRST_ROWS),
  };
}

/**
 * One part of a long list: kind 'hooks' (newest-running first; minDays 30 = only the long-running ones) or
 * 'advertisers' (sort 'ads' | 'days'); q searches the text / name. Returns { rows, total, page, per }.
 */
export function insightsList(full, kind, { page = 1, per = 50, q = '', minDays = 0, sort = 'ads' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  let rows;
  if (kind === 'hooks') {
    rows = full.hooks.filter((h) => h.days >= (Number(minDays) || 0) && (!needle || h.hook.toLowerCase().includes(needle) || String(h.pageName || '').toLowerCase().includes(needle)));
  } else if (kind === 'advertisers') {
    rows = full.advertisers.filter((a) => !needle || String(a.pageName || a.pageId).toLowerCase().includes(needle));
    if (sort === 'days') rows = [...rows].sort((a, b) => b.days - a.days || b.ads - a.ads);
  } else return { rows: [], total: 0, page: 1, per };
  const size = Math.min(200, Math.max(1, Number(per) || 50));
  const p = Math.max(1, Number(page) || 1);
  return { rows: rows.slice((p - 1) * size, p * size), total: rows.length, page: p, per: size };
}

// ---------------- All Leads: the same insights over every ad of the leads in view ----------------
const LEAD_CHUNK = 5000;
const leadCache = new Map(); // workspace + filter → { at, data } — a big workspace takes a few seconds
export const LEADS_INSIGHTS_TTL_MS = 10 * 60e3;
const LEAD_CACHE_MAX = 6; // the complete results are big (every hook): only the last few filters are kept

/**
 * The ad insights of the leads matching `filter` (leads.js buildFilter — always one workspace): every ad of them,
 * plus what the leads themselves say (how many have ads at all, every category). Complete — nothing cut.
 * Kept 10 minutes per filter (the page and its "show more" read the same result); `fresh` recalculates.
 */
export async function leadsInsights(ws, filter, { fresh = false } = {}) {
  const key = `${ws}|${JSON.stringify(filter)}`;
  const hit = leadCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < LEADS_INSIGHTS_TTL_MS) {
    leadCache.delete(key);
    leadCache.set(key, hit); // most recently used last
    return { ...hit.data, cached: true };
  }
  const t = adTally();
  const categories = new Map();
  let leads = 0;
  let withAds = 0;
  let chunk = [];
  const flush = async () => {
    if (!chunk.length) return;
    const seen = new Set();
    for await (const a of col('ads').find({ pageId: { $in: chunk } }).project(AD_FIELDS)) {
      seen.add(a.pageId);
      t.add(a);
    }
    withAds += seen.size;
    chunk = [];
  };
  for await (const l of col('leads').find(filter).project({ pageId: 1, category: 1 })) {
    leads++;
    const cat = String(l.category || '').split(',')[0].trim();
    if (cat) categories.set(cat, (categories.get(cat) || 0) + 1);
    chunk.push(l.pageId);
    if (chunk.length >= LEAD_CHUNK) await flush();
  }
  await flush();
  const data = {
    ...t.result(),
    leads,
    leadsWithAds: withAds,
    // every category, biggest first
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, leads: n, pct: leads ? Math.round((n * 100) / leads) : 0 })),
    at: new Date(),
  };
  leadCache.delete(key);
  leadCache.set(key, { at: Date.now(), data });
  while (leadCache.size > LEAD_CACHE_MAX) leadCache.delete(leadCache.keys().next().value);
  return data;
}
