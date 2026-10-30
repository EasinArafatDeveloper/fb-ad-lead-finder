// Server-side Ad Library collector: collects ads directly on the server in the background
// through the rotating residential / static proxy pool — no Chrome tab needed.
import { ProxyAgent, fetch } from 'undici';
import { activity, col, log } from './db.js';
import { getSettings } from './settings.js';
import { ingestAds } from './leads.js';
import { parseProxyLine, proxyLines } from './proxies.js';
import { uniq } from './util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DOC_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

// Default Relay doc_id for AdLibrarySearchPaginationQuery (updated dynamically if Facebook rotates it)
let cachedDocId = '24922295957467452';

const PAGINATION_ARG_NAMES = [
  'activeStatus', 'adType', 'bylines', 'collationToken', 'contentLanguages', 'countries',
  'cursor', 'excludedIDs', 'first', 'isTargetedCountry', 'location', 'mediaType',
  'multiCountryFilterMode', 'pageIDs', 'potentialReachInput', 'publisherPlatforms',
  'queryString', 'regions', 'searchType', 'sessionID', 'sortData', 'source', 'startDate', 'v', 'viewAllPageID',
];

const PAGES_PER_SESSION = 5; // rotate to a fresh proxy session every 5 GraphQL pages (~150 ads)
const MAX_CONCURRENT_JOBS = 2; // how many searches collect in parallel on the server
const activeJobs = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (v) => (typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : '') || '';
const isTemplate = (s) => /\{\{[^}]+\}\}/.test(s);

/** Build the proxy list for Ad Library collection: Rotating Residential first, then Static IPs. */
export function adlibProxyPool(s) {
  if (!s) return [];
  const resi = proxyLines(s.resiList).map(parseProxyLine).filter(Boolean).map((p) => ({ ...p, group: 'rotating', id: `${p.host}:${p.port}:${p.user}` }));
  const stat = proxyLines(s.proxyList).map(parseProxyLine).filter(Boolean).map((p) => ({ ...p, group: 'static', id: `${p.host}:${p.port}:${p.user}` }));
  // Always prefer rotating residential proxies for Ad Library (they don't get datacenter rate-limits),
  // followed by static proxies as fallback.
  return [...resi, ...stat];
}

/** True when the server collects Ad Library searches in the background without Chrome. */
export const serverCollects = (s) => s?.running !== false && s?.serverCollector === true && adlibProxyPool(s).length > 0;

let rrIndex = 0;
function nextProxyFrom(pool, preferGroup = 'rotating') {
  const preferred = pool.filter((p) => p.group === preferGroup);
  const list = preferred.length ? preferred : pool;
  if (!list.length) return null;
  return list[rrIndex++ % list.length];
}

function makeAgent(p) {
  return new ProxyAgent({
    uri: `http://${p.host}:${p.port}`,
    token: p.user ? `Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}` : undefined,
    connect: { timeout: 15000 },
  });
}

function keepCookies(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const val = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || val === 'deleted' || !val;
    if (expired) jar.delete(name);
    else jar.set(name, val);
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Extract balanced JSON object starting at `start` (index of '{'). */
function objectAt(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function extractSearchVars(html) {
  let i = 0;
  while ((i = html.indexOf('"variables":{', i)) !== -1) {
    const o = objectAt(html, i + 12);
    i += 12;
    if (!o || !o.includes('"queryString"')) continue;
    try {
      return JSON.parse(o);
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Normalize an Ad Library GraphQL node into the shape `ingestAds` expects (same as adlibrary-hook.js). */
export function normalizeAdNode(n, searchQ = '') {
  const s = n.snapshot || {};
  const card = (Array.isArray(s.cards) && s.cards[0]) || {};
  let body = txt(s.body);
  if (!body || isTemplate(body)) body = txt(card.body) || body;
  return {
    adId: String(n.ad_archive_id),
    pageId: String(n.page_id || s.page_id || ''),
    pageName: n.page_name || s.page_name || '',
    pageUrl: s.page_profile_uri || '',
    pageLikes: s.page_like_count ?? null,
    pageCategories: s.page_categories || [],
    pageImage: s.page_profile_picture_url || '',
    body: String(body || '').slice(0, 3000),
    title: txt(s.title) || txt(card.title) || '',
    linkUrl: s.link_url || card.link_url || '',
    cta: s.cta_text || card.cta_text || '',
    ctaType: s.cta_type || card.cta_type || '',
    format: s.display_format || '',
    caption: s.caption || '',
    startDate: n.start_date ? new Date(n.start_date * 1000).toISOString().slice(0, 10) : '',
    platforms: n.publisher_platform || [],
    versions: n.collation_count || 1,
    searchQ,
  };
}

/** Walk a parsed JSON value, collecting normalized ads and the latest pagination cursor. */
function extractFromJson(o, adsMap, state, searchQ, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 80) return;
  if (Array.isArray(o)) {
    for (const x of o) extractFromJson(x, adsMap, state, searchQ, depth + 1);
    return;
  }
  const c = o.search_results_connection;
  if (c && c.page_info && 'end_cursor' in c.page_info) {
    state.cursor = c.page_info.end_cursor;
    state.hasNext = Boolean(c.page_info.has_next_page);
  }
  if (o.ad_archive_id && (o.page_id || o.snapshot)) {
    const id = String(o.ad_archive_id);
    if (!adsMap.has(id)) {
      try {
        const ad = normalizeAdNode(o, searchQ);
        if (ad.pageId) adsMap.set(id, ad);
      } catch {
        /* ignore malformed node */
      }
    }
  }
  for (const k in o) {
    const v = o[k];
    if (v && typeof v === 'object') extractFromJson(v, adsMap, state, searchQ, depth + 1);
  }
}

/** Scan script bundles for a new doc_id if Facebook ever changes AdLibrarySearchPaginationQuery. */
async function refreshDocIdFromHtml(html, agent) {
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&'));
  for (const src of srcs) {
    try {
      const r = await fetch(src, { dispatcher: agent, signal: AbortSignal.timeout(15000) });
      const st = await r.text();
      if (!st.includes('AdLibrarySearchPaginationQuery_facebookRelayOperation')) continue;
      const m = st.match(/AdLibrarySearchPaginationQuery_facebookRelayOperation"[^}]*?"(\d{15,25})"/);
      if (m?.[1]) {
        cachedDocId = m[1];
        return cachedDocId;
      }
    } catch {
      /* ignore bundle error */
    }
  }
  return cachedDocId;
}

/**
 * Open an Ad Library session through one proxy:
 * 1. GET the Ad Library search URL
 * 2. If Facebook returns the 403 `/__rd_verify_...` JS challenge, POST to it to receive `rd_challenge` cookie and reload
 * 3. Extract `_js_datr` into `datr` cookie, `LSD` token, `searchVars`, initial ads, and `end_cursor`.
 */
async function openAdlibSession(proxy, url) {
  const agent = makeAgent(proxy);
  const jar = new Map();
  let u = url;
  let html = '';
  let status = 0;

  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(u, {
      dispatcher: agent,
      headers: jar.size ? { ...DOC_HEADERS, cookie: cookieHeader(jar) } : DOC_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(22000),
    });
    keepCookies(jar, r);
    status = r.status;
    if (status >= 300 && status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel();
      if (!loc) break;
      u = new URL(loc, u).href;
      if (/\/(login|checkpoint)(\/|\.php|$|\?)/.test(new URL(u).pathname)) {
        throw new Error('redirected to login');
      }
      continue;
    }
    html = await r.text();
    break;
  }

  // Solve Facebook's lightweight `/__rd_verify_...` challenge if present
  const challengeMatch = html.match(/fetch\('(\/__rd_verify_[^']+)'/);
  if (challengeMatch) {
    const verifyUrl = new URL(challengeMatch[1], u).href;
    const vr = await fetch(verifyUrl, {
      method: 'POST',
      dispatcher: agent,
      headers: {
        ...DOC_HEADERS,
        accept: '*/*',
        origin: 'https://www.facebook.com',
        referer: u,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        ...(jar.size ? { cookie: cookieHeader(jar) } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    keepCookies(jar, vr);
    await vr.text().catch(() => {});

    const r2 = await fetch(u, {
      dispatcher: agent,
      headers: {
        ...DOC_HEADERS,
        referer: u,
        'sec-fetch-site': 'same-origin',
        ...(jar.size ? { cookie: cookieHeader(jar) } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(22000),
    });
    keepCookies(jar, r2);
    status = r2.status;
    html = await r2.text();
  }

  // Apply deferred `_js_datr` cookie so GraphQL requests pass Facebook's CSRF/datr check (avoids error 1357054)
  const datr = (html.match(/"_js_datr":\{"value":"([^"]+)"/) || [])[1];
  if (datr) {
    jar.set('_js_datr', datr);
    jar.set('datr', datr);
  }

  const lsd = (html.match(/\["LSD",\[\],\{"token":"([^"]+)"/) || [])[1];
  const vars = extractSearchVars(html);
  if (!lsd || !vars) {
    throw new Error(`Ad Library session missing token/vars (HTTP ${status}, len ${html.length})`);
  }

  return { proxy, agent, jar, lsd, vars, html, url: u };
}

/** Try opening a session using up to `maxTries` proxies from the pool. */
async function acquireSession(pool, url, maxTries = 8) {
  let lastErr = null;
  for (let i = 0; i < Math.min(maxTries, pool.length); i++) {
    const prefer = i < 6 ? 'rotating' : 'static';
    const p = nextProxyFrom(pool, prefer);
    if (!p) break;
    try {
      return await openAdlibSession(p, url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not open Ad Library session through any proxy');
}

/** Fetch one GraphQL page of ads using `sess`, `baseVars`, and `cursor`. */
async function fetchNextPage(sess, baseVars, cursor, searchQ, adsMap, state) {
  const v = {};
  for (const k of PAGINATION_ARG_NAMES) v[k] = baseVars[k] ?? null;
  Object.assign(v, {
    cursor,
    first: 30,
    activeStatus: String(baseVars.activeStatus || 'active').toUpperCase(),
    adType: String(baseVars.adType || 'all').toUpperCase(),
    mediaType: String(baseVars.mediaType || 'all').toUpperCase(),
    searchType: String(baseVars.searchType || 'keyword_unordered').toUpperCase(),
    isTargetedCountry: Boolean(baseVars.isTargetedCountry),
  });

  const body = new URLSearchParams({
    av: '0',
    __user: '0',
    __a: '1',
    lsd: sess.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'AdLibrarySearchPaginationQuery',
    variables: JSON.stringify(v),
    server_timestamps: 'true',
    doc_id: String(cachedDocId),
  });

  const r = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    dispatcher: sess.agent,
    body,
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-lsd': sess.lsd,
      'x-fb-friendly-name': 'AdLibrarySearchPaginationQuery',
      origin: 'https://www.facebook.com',
      referer: sess.url,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...(sess.jar.size ? { cookie: cookieHeader(sess.jar) } : {}),
    },
    signal: AbortSignal.timeout(22000),
  });
  keepCookies(sess.jar, r);
  const raw = await r.text();
  if (!r.ok) {
    return { ok: false, error: `HTTP ${r.status}`, rateLimit: r.status === 429 };
  }

  const clean = raw.replace(/^for \(;;\);/, '');
  const before = adsMap.size;
  const prevCursor = state.cursor;

  for (const line of clean.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      extractFromJson(j, adsMap, state, searchQ);
    } catch {
      /* ignore non-JSON line */
    }
  }

  if (state.cursor === prevCursor && state.hasNext) {
    const errMsg =
      (clean.match(/"(?:message|errorSummary|error_summary|summary)":"([^"]{1,160})/) || [])[1] ||
      (clean.match(/"error":(\d+)/) ? `Facebook error ${clean.match(/"error":(\d+)/)[1]}` : 'no cursor in GraphQL response');
    const rateLimit = /rate.?limit|too many|slow down|1675004/i.test(errMsg) || clean.includes('1675004');
    const docIdRotated = /query|doc_id|persist/i.test(errMsg);
    return { ok: false, error: errMsg, rateLimit, docIdRotated };
  }

  return { ok: true, added: adsMap.size - before };
}

/** Filter ads by `minAds` condition (only pages running at least `minAds` ads in this search). */
function filterMatchingAds(allAds, maxAds, minAds) {
  const limited = minAds <= 1 ? allAds.slice(0, maxAds) : allAds;
  const perPage = new Map();
  for (const a of limited) perPage.set(a.pageId, (perPage.get(a.pageId) || 0) + 1);
  const okPages = new Set([...perPage].filter(([, n]) => n >= minAds).map(([p]) => p));
  return {
    ads: limited.filter((a) => okPages.has(a.pageId)),
    pagesMatched: okPages.size,
    pagesTotal: perPage.size,
  };
}

/** Flush newly collected ads to MongoDB (`ingestAds`) and update job progress. */
async function flushJobAds(job, adsToFlush) {
  if (!adsToFlush.length) return { stopped: false };
  const freshJob = await col('jobs').findOne({ _id: job._id }, { projection: { phase: 1 } });
  if (!freshJob || freshJob.phase === 'stopped') return { stopped: true };

  for (let i = 0; i < adsToFlush.length; i += 100) {
    const chunk = adsToFlush.slice(i, i + 100);
    const out = await ingestAds(
      { id: String(job._id), workspaceId: job.workspaceId, keyword: job.keyword, country: job.country, projectId: job.projectId || null },
      chunk,
    );
    const pageIds = uniq(chunk.map((a) => a && a.pageId));
    await col('jobs').updateOne(
      { _id: job._id },
      { $inc: { adsSeen: out.ads }, $addToSet: { pageIds: { $each: pageIds } }, $set: { lastActivity: new Date(), stuckNote: '' } },
    );
  }
  return { stopped: false };
}

/** Run one search job from start to finish on the server through the proxy pool. */
export async function runServerCollectJob(job) {
  const jobId = String(job._id);
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  try {
    const s = await getSettings();
    const pool = adlibProxyPool(s);
    if (!pool.length) return;

    const maxAds = Math.max(1, Number(job.maxAds) || Number(s.maxAds) || 500);
    const minAds = Math.max(1, Number(job.minAds) || 1);
    const searchQ = String(job.keyword || '').trim().toLowerCase();
    const adsMap = new Map();
    const sentAdIds = new Set();
    const state = { cursor: null, hasNext: false };

    let sess;
    try {
      sess = await acquireSession(pool, job.url, 10);
    } catch (e) {
      await log('warn', `Ad Library collector could not open session for "${job.keyword}": ${e.message}`);
      // Release back to queued so next tick retries cleanly
      await col('jobs').updateOne({ _id: job._id, phase: 'collecting' }, { $set: { phase: 'queued', stuckNote: `Retrying connection (${e.message})` } });
      return;
    }

    // Parse initial ads and cursor embedded in the first HTML page
    for (const sm of sess.html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!sm[1].includes('ad_archive_id') && !sm[1].includes('search_results_connection')) continue;
      try {
        const j = JSON.parse(sm[1]);
        extractFromJson(j, adsMap, state, searchQ);
      } catch {
        /* ignore non-JSON script */
      }
    }

    const baseVars = sess.vars;

    // Flush initial HTML ads immediately when minAds <= 1 so the user sees instant results
    if (minAds <= 1 && adsMap.size > 0) {
      const batch = [...adsMap.values()].slice(0, maxAds);
      batch.forEach((a) => sentAdIds.add(a.adId));
      const { stopped } = await flushJobAds(job, batch);
      if (stopped) return;
    } else {
      await col('jobs').updateOne({ _id: job._id }, { $set: { lastActivity: new Date(), stuckNote: '' } });
    }

    let pageCount = 1;
    let emptyPages = 0;
    let consecutiveFailures = 0;

    while (state.hasNext && state.cursor && adsMap.size < maxAds) {
      const check = await col('jobs').findOne({ _id: job._id }, { projection: { phase: 1 } });
      if (!check || check.phase === 'stopped') return;

      // Proactively rotate to a fresh proxy session every PAGES_PER_SESSION pages so no single IP gets rate-limited
      if (pageCount % PAGES_PER_SESSION === 0) {
        try {
          sess = await acquireSession(pool, job.url, 6);
        } catch {
          /* keep existing session if rotation failed */
        }
      }

      let res;
      try {
        res = await fetchNextPage(sess, baseVars, state.cursor, searchQ, adsMap, state);
      } catch (e) {
        res = { ok: false, error: e.message || 'network error', rateLimit: false };
      }

      if (!res.ok) {
        consecutiveFailures++;
        if (res.docIdRotated) {
          await refreshDocIdFromHtml(sess.html, sess.agent).catch(() => {});
        }
        // Switch immediately to a fresh proxy IP and retry the exact same cursor!
        try {
          sess = await acquireSession(pool, job.url, 8);
        } catch {
          await sleep(2000);
        }
        if (consecutiveFailures >= 10) {
          await log('warn', `Ad Library collector stopped after 10 retries on "${job.keyword}" (${adsMap.size} ads collected): ${res.error}`);
          break;
        }
        await sleep(800 + consecutiveFailures * 400);
        continue;
      }

      consecutiveFailures = 0;
      pageCount++;

      if (res.added > 0) {
        emptyPages = 0;
      } else {
        emptyPages++;
        if (emptyPages >= 10) break;
      }

      if (minAds <= 1) {
        const unsent = [...adsMap.values()].filter((a) => !sentAdIds.has(a.adId)).slice(0, Math.max(0, maxAds - sentAdIds.size));
        if (unsent.length) {
          unsent.forEach((a) => sentAdIds.add(a.adId));
          const { stopped } = await flushJobAds(job, unsent);
          if (stopped) return;
        }
      } else {
        await col('jobs').updateOne(
          { _id: job._id },
          { $set: { lastActivity: new Date(), stuckNote: `Collecting in background… ${adsMap.size} ads scanned (filtering ${minAds}+ ads at the end)` } },
        );
      }

      // Gentle human-like pause (1.0 - 2.0 s) between pages
      await sleep(1000 + Math.random() * 1000);
    }

    // Final flush (especially for minAds > 1, or any remaining unsent ads)
    const allCaptured = [...adsMap.values()];
    const matched = filterMatchingAds(allCaptured, maxAds, minAds);
    const remaining = matched.ads.filter((a) => !sentAdIds.has(a.adId));
    if (remaining.length) {
      const { stopped } = await flushJobAds(job, remaining);
      if (stopped) return;
    }

    const doneSet = {
      phase: 'collected',
      collectedAt: new Date(),
      note: 'done',
      stuckNote: '',
      captured: allCaptured.length,
      pagesTotal: matched.pagesTotal,
      pagesMatched: matched.pagesMatched,
      minAds,
    };

    const updated = await col('jobs').findOneAndUpdate(
      { _id: job._id, phase: 'collecting' },
      { $set: doneSet },
      { returnDocument: 'after' },
    );
    if (updated) {
      const pages = (updated.pageIds || []).length;
      const msg =
        minAds > 1
          ? `"${updated.keyword}" collected — ${allCaptured.length} ads; ${matched.pagesMatched} of ${matched.pagesTotal} pages run ${minAds}+ ads. Only those were kept`
          : `"${updated.keyword}" collected — ${pages} pages from ${updated.adsSeen || 0} ads`;
      await activity('collected', msg, { workspaceId: updated.workspaceId, projectId: updated.projectId });
      await log('info', `Server collected "${updated.keyword}" (${updated.country}): ${updated.adsSeen || 0} ads, ${pages} pages`);
    }
  } catch (e) {
    await log('error', `Server Ad Library collector error on "${job.keyword}": ${e.message}`);
  } finally {
    activeJobs.delete(jobId);
    // Immediately check if another job is waiting in the queue
    setTimeout(() => kickAdlibCollector().catch(() => {}), 500);
  }
}

/** Reset any jobs that were mid-collection by `'server'` when the server restarted so they resume immediately. */
export async function resetServerCollects() {
  const r = await col('jobs').updateMany(
    { phase: 'collecting', collector: 'server' },
    { $set: { phase: 'queued', stuckNote: '' } },
  );
  return r.modifiedCount;
}

/** Pick up queued jobs and start collecting them in the background on the server. */
export async function kickAdlibCollector() {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) return;
  const s = await getSettings();
  if (!serverCollects(s)) return;

  while (activeJobs.size < MAX_CONCURRENT_JOBS) {
    // Avoid running two searches from the exact same workspace at the same moment so workspaces share lanes fairly
    const busyWorkspaces = await col('jobs').distinct('workspaceId', { phase: 'collecting', collector: 'server' });
    const now = new Date();
    const job = await col('jobs').findOneAndUpdate(
      { phase: 'queued', ...(busyWorkspaces.length ? { workspaceId: { $nin: busyWorkspaces } } : {}) },
      { $set: { phase: 'collecting', startedAt: now, lastActivity: now, collector: 'server', stuckNote: '' } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    // If all queued jobs belong to workspaces that already have one running and we still have free capacity, allow a second one
    const picked =
      job ||
      (await col('jobs').findOneAndUpdate(
        { phase: 'queued' },
        { $set: { phase: 'collecting', startedAt: now, lastActivity: now, collector: 'server', stuckNote: '' } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      ));
    if (!picked) break;

    await activity('collect', `Collecting from the Ad Library on the server: "${picked.keyword}"`, {
      workspaceId: picked.workspaceId,
      projectId: picked.projectId,
    });
    runServerCollectJob(picked);
  }
}
