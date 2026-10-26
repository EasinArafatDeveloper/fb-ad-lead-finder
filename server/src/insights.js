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
const tally = (list) => Object.entries(list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);

/** "allHooks": every hook (the Excel report), else the top 60 (the page). */
export async function projectInsights(projectId, { allHooks = false } = {}) {
  const ads = await col('ads')
    .find({ projectIds: projectId })
    .project({ adId: 1, pageId: 1, pageName: 1, startDate: 1, format: 1, cta: 1, ctaType: 1, linkUrl: 1, ins: 1 })
    .toArray();
  const n = ads.length;
  const withIns = ads.filter((a) => a.ins);
  const pct = (k) => (n ? Math.round((k * 100) / n) : 0);
  const longRunning = withIns.filter((a) => daysSince(a.startDate) >= 30);

  // hooks: the same opening line used in several ads counts once, ranked by how long its ads have run
  const byHook = new Map();
  for (const a of withIns) {
    if (!a.ins.hook) continue;
    const k = a.ins.hook.toLowerCase();
    const cur = byHook.get(k) || { hook: a.ins.hook, ads: 0, days: 0, pageName: a.pageName, adId: a.adId, pages: new Set() };
    cur.ads++;
    cur.pages.add(a.pageId);
    const d = daysSince(a.startDate);
    if (d > cur.days) Object.assign(cur, { days: d, pageName: a.pageName, adId: a.adId });
    byHook.set(k, cur);
  }
  const hooks = [...byHook.values()].sort((a, b) => b.days - a.days || b.ads - a.ads);

  const prices = withIns.flatMap((a) => a.ins.prices || []).sort((a, b) => a - b);
  const q = (p) => (prices.length ? prices[Math.min(prices.length - 1, Math.floor(p * prices.length))] : null);

  const pages = new Map();
  for (const a of ads) {
    const p = pages.get(a.pageId) || { pageId: a.pageId, pageName: a.pageName, ads: 0, days: 0 };
    p.ads++;
    p.days = Math.max(p.days, daysSince(a.startDate));
    pages.set(a.pageId, p);
  }
  return {
    ads: n,
    analysed: withIns.length,
    longRunning: longRunning.length,
    hooks: (allHooks ? hooks : hooks.slice(0, 60)).map(({ pages: pg, ...h }) => ({ ...h, pages: pg.size })),
    offers: OFFER_NAMES.map((o) => {
      const k = withIns.filter((a) => (a.ins.offers || []).includes(o)).length;
      return { offer: o, ads: k, pct: pct(k) };
    }).sort((a, b) => b.ads - a.ads),
    prices: prices.length ? { count: prices.length, min: prices[0], low: q(0.25), median: q(0.5), high: q(0.75), max: prices[prices.length - 1] } : null,
    formats: tally(ads.map((a) => formatName(a.format)).filter(Boolean)).map(([k, v]) => ({ name: k, ads: v, pct: pct(v) })),
    orderVia: tally(ads.map((a) => orderChannel(a)).filter(Boolean)).map(([k, v]) => ({ name: k, ads: v, pct: pct(v) })),
    languages: tally(withIns.map((a) => a.ins.lang).filter(Boolean)).map(([k, v]) => ({ name: k, ads: v, pct: pct(v) })),
    topByAds: [...pages.values()].sort((a, b) => b.ads - a.ads).slice(0, 10),
    topByDays: [...pages.values()].sort((a, b) => b.days - a.days).slice(0, 10),
  };
}
