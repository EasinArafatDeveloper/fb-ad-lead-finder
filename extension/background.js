// Background worker: takes jobs from the server, opens Ad Library tabs, scrapes Page About tabs,
// and sends everything back to the server. All data lives in MongoDB (via the server).

const DEFAULT_CFG = { serverUrl: 'http://localhost:3002', apiKey: '', enabled: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCfg() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return { ...DEFAULT_CFG, ...(cfg || {}) };
}
const getSess = async (k, d) => (await chrome.storage.session.get(k))[k] ?? d;
const setSess = (k, v) => chrome.storage.session.set({ [k]: v });

async function setStatus(patch) {
  const cur = await getSess('status', {});
  await setSess('status', { ...cur, ...patch, at: Date.now() });
}

/** This computer's own id — made once, so the dashboard can tell the PCs apart (and name them). */
async function pcId() {
  const { pcId: id } = await chrome.storage.local.get('pcId');
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ pcId: fresh });
  return fresh;
}

async function api(path, { method = 'GET', body } = {}) {
  const c = await getCfg();
  if (!c.apiKey) throw new Error('Worker key is not set (extension popup)');
  const r = await fetch(c.serverUrl.replace(/\/+$/, '') + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey, 'x-ext-version': chrome.runtime.getManifest().version, 'x-ext-pc': await pcId() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}

// keeps the MV3 service worker alive during long waits
async function sleepAlive(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(10000, end - Date.now()));
    chrome.runtime.getPlatformInfo(() => {});
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2 });
}

// ---------------- proxy configuration ----------------
// The proxy is only for reading Facebook Pages — never for the Ad Library or the user's own Facebook.
// Chrome can't tell them apart: one proxy setting for the whole browser, and for https a PAC script only
// sees "https://www.facebook.com/" (no path); web./m.facebook.com just redirect to www. So the proxy is on
// ONLY while a worker tab is loading/reading a page (a few seconds), and off the rest of the time —
// between pages, while idle or paused, and while an Ad Library tab collects (page reading waits for that).
let serverProxy = null; // Settings → Proxy, as the server last sent it
let appliedKey = null; // what Chrome is using now
let readingPages = 0; // worker tabs reading a page right now

const normProxy = (p) => ({
  id: String(p.id || ''), // which IP of the pool (sent back with the result / login wall)
  enabled: Boolean(p.enabled),
  host: String(p.host || '').trim().replace(/[^a-z0-9.-]/gi, ''),
  port: Number(p.port) || 44445,
  user: String(p.user || '').trim(),
  pass: String(p.pass || '').trim(),
});

/** An Ad Library tab is collecting (or about to open) → no proxy, no page reading. */
const isCollecting = async () => Object.keys(await getSess('tabJobs', {})).length > 0 || (await getSess('collectStarting', false));

async function syncProxy(proxy) {
  if (!proxy) return;
  serverProxy = normProxy(proxy);
  await chrome.storage.local.set({ activeProxy: serverProxy }).catch(() => {});
  await applyProxy();
}

/**
 * The Chrome Web Store build has no "proxy" permission (pages are read on the server, through the proxy list):
 * there chrome.proxy doesn't exist and Chrome always goes direct. See scripts/build-extension.sh.
 */
const CAN_PROXY = !!chrome.proxy?.settings;

/** Puts Chrome on the proxy or direct, whichever fits right now. */
async function applyProxy() {
  if (!CAN_PROXY) return;
  const p = serverProxy;
  const collecting = await isCollecting();
  const want = p && p.enabled && p.host && readingPages > 0 && !collecting ? p : null;
  const key = want ? `${want.host}:${want.port}:${want.user}:${want.pass}` : 'direct';
  if (key === appliedKey) return;
  appliedKey = key;

  if (!want) {
    try {
      await chrome.proxy.settings.clear({ scope: 'regular' });
      await setStatus({ proxyActive: false, proxyHost: p?.enabled ? 'off — only on while a page is being read' : '' });
      console.log('[Proxy] Direct');
    } catch (e) {
      console.warn('Proxy clear error:', e);
    }
    return;
  }

  // Facebook (and its CDN) through the proxy; localhost, private IPs and every other site direct.
  const pac = `
    function FindProxyForURL(url, host) {
      if (host === "localhost" || host === "127.0.0.1" || isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "172.16.0.0", "255.240.0.0") || isInNet(host, "192.168.0.0", "255.255.0.0")) {
        return "DIRECT";
      }
      if (shExpMatch(host, "*.facebook.com") || host === "facebook.com" || shExpMatch(host, "*.fbcdn.net") || host === "fbcdn.net") {
        return "PROXY ${want.host}:${want.port}";
      }
      return "DIRECT";
    }
  `;
  try {
    await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' });
    await setStatus({ proxyActive: true, proxyHost: `${want.host}:${want.port}` });
    console.log(`[Proxy] On: ${want.host}:${want.port} (Facebook only)`);
  } catch (e) {
    appliedKey = null;
    console.warn('Proxy set error:', e);
  }
}

// Proxy login. A wrong user/password makes Chrome ask again and again — give up after 10 tries per request
// (not fewer: every redirect of a page and every new connection to the proxy asks again under the same request).
const authTries = new Map();
if (CAN_PROXY && chrome.webRequest?.onAuthRequired) chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) return callback({});
    const n = (authTries.get(details.requestId) || 0) + 1;
    if (authTries.size > 500) authTries.clear();
    authTries.set(details.requestId, n);
    if (n > 10) {
      setStatus({ error: `Proxy login failed (${serverProxy?.user || 'no user'} @ ${details.challenger?.host || '?'}) — check the proxy username/password in Settings` });
      return callback({ cancel: true });
    }
    const answer = (p) => {
      if (!p?.user) setStatus({ error: 'The proxy asked for a login but no proxy username is known yet' });
      callback(p?.user ? { authCredentials: { username: p.user, password: p.pass } } : {});
    };
    // right after the service worker wakes up serverProxy is still empty — read the saved copy
    if (serverProxy) answer(serverProxy);
    else chrome.storage.local.get('activeProxy').then(({ activeProxy }) => answer(activeProxy), () => callback({}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

chrome.storage.local.get('activeProxy').then(({ activeProxy }) => {
  if (activeProxy && !serverProxy) syncProxy(activeProxy);
}).catch(() => {});


// ---------------- Ad Library collection ----------------
// tabJobs: { [tabId]: job }  — Ad Library tabs that are collecting for a server job
let collectBusy = false;

async function collectorTick() {
  if (collectBusy) return;
  collectBusy = true;
  try {
    const c = await getCfg();
    if (!c.enabled || !c.apiKey) return;
    const tabJobs = await getSess('tabJobs', {});
    for (const tabId of Object.keys(tabJobs)) {
      try {
        await chrome.tabs.get(Number(tabId));
      } catch {
        await finishJob(Number(tabId), 'tab closed');
      }
    }
    const fresh = await getSess('tabJobs', {});
    if (Object.values(fresh).some((j) => !j.manual)) return; // one auto job at a time
    const r = await api('/worker/next-collect');
    await setStatus({ collector: r.job ? `collecting "${r.job.keyword}"` : r.reason, error: '' });
    if (!r.job) return;
    // page reading stops, the pages being read finish, then the proxy goes off — the Ad Library is never proxied
    await setSess('collectStarting', true);
    try {
      await waitSlotsIdle(120000);
      await applyProxy();
      const tab = await chrome.tabs.create({ url: r.job.url, active: true });
      const jobs = await getSess('tabJobs', {});
      jobs[tab.id] = { ...r.job, closeTab: r.closeAdTab !== false };
      await setSess('tabJobs', jobs);
    } finally {
      await setSess('collectStarting', false);
    }
  } catch (e) {
    await setStatus({ error: e.message });
  } finally {
    collectBusy = false;
  }
}

async function finishJob(tabId, reason, stats) {
  const tabJobs = await getSess('tabJobs', {});
  const job = tabJobs[tabId];
  if (!job) return;
  delete tabJobs[tabId];
  await setSess('tabJobs', tabJobs);
  await applyProxy(); // collecting done → proxy back on (if no other Ad Library tab is still collecting)
  await api('/worker/collect-done', { method: 'POST', body: { jobId: job.id, reason, stats } }).catch(() => {});
  return job;
}

/** Wait until no page is being read (slots stop by themselves while collecting). */
async function waitSlotsIdle(maxMs) {
  const end = Date.now() + maxMs;
  while (runningSlots.size && Date.now() < end) await sleep(1000);
}

// ---------------- Page About scraping ----------------
// Several worker slots can run at once (Settings → "Pages read at the same time"); each slot has its own background tab
// and asks the server for the next page (the server hands each page to exactly one slot).
const runningSlots = new Set();
let netErrorsInARow = 0;

async function getWorkerTab(slot) {
  const tabs = await getSess('workerTabs', {});
  const id = tabs[slot];
  if (id) {
    try {
      await chrome.tabs.get(id);
      return id;
    } catch {
      /* closed by user */
    }
  }
  const t = await chrome.tabs.create({ url: 'about:blank', active: false });
  tabs[slot] = t.id;
  await setSess('workerTabs', tabs);
  await updateBlockRules();
  return t.id;
}

/**
 * Worker tabs don't need pictures: block images, video and fonts there (only there — the user's own
 * Facebook tabs are untouched). Pages load several times faster; the text is the same.
 */
async function updateBlockRules() {
  const tabIds = Object.values(await getSess('workerTabs', {})).filter(Boolean);
  const old = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: old,
    addRules: tabIds.length
      ? [{ id: 1, priority: 1, action: { type: 'block' }, condition: { tabIds, resourceTypes: ['image', 'media', 'font'] } }]
      : [],
  });
}

/**
 * Wait only until the new page has *started* (URL committed) — not for Facebook to finish loading every
 * resource, which can take 10–30 s. executeScript itself waits for the document to be ready, and the reader
 * then waits for the text to appear.
 */
async function waitCommitted(tabId, prevUrl, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(300);
    const t = await chrome.tabs.get(tabId);
    if (t.pendingUrl || !t.url || t.url.startsWith('about:')) continue;
    if (t.url !== prevUrl || (t.status === 'complete' && Date.now() - start > 1500)) return true;
  }
  return false;
}

/** Load a URL in a worker tab and read it (no clicking). */
async function readUrl(slot, url) {
  const tabId = await getWorkerTab(slot);
  const prevUrl = (await chrome.tabs.get(tabId)).url;
  // Chrome's own error for this load (net::ERR_TUNNEL_CONNECTION_FAILED …) — the page itself never came
  let netError = '';
  const onError = (d) => {
    if (d.tabId === tabId && d.frameId === 0 && d.error !== 'net::ERR_ABORTED') netError = d.error;
  };
  chrome.webNavigation.onErrorOccurred.addListener(onError);
  try {
    await chrome.tabs.update(tabId, { url });
    const committed = await waitCommitted(tabId, prevUrl);
    if (netError) return { netError };
    if (!committed) return { error: 'Page load timeout' };
    // Facebook sometimes redirects right after load, which wipes the injected script — retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-about.js'] });
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__fblfRead() });
        if (res && res.result) return res.result;
      } catch (e) {
        if (netError) return { netError };
        if (attempt) return { error: String(e.message || e) };
      }
      await sleep(2000);
    }
    return netError ? { netError } : { error: 'No result from page' };
  } finally {
    chrome.webNavigation.onErrorOccurred.removeListener(onError);
    // leave the page: Facebook keeps polling in the background, and once the proxy is off that would go out direct
    await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
  }
}

/** Merge several page reads into the result the server expects. */
function combine(snaps) {
  const NL = String.fromCharCode(10);
  const linesOf = (t) => [...new Set(String(t || '').split(NL).map((x) => x.trim()).filter(Boolean))];
  const sets = snaps.map((s) => new Set(linesOf(s.text)));
  // lines on every screen are menus/headers — but keep long ones (the Bio shows on every About screen)
  const common = new Set(snaps.length >= 2 ? [...sets[0]].filter((l) => l.length < 50 && sets.every((x) => x.has(l))) : []);
  const sections = {};
  for (const s of snaps) {
    const lines = linesOf(s.text).filter((l) => !common.has(l));
    if (lines.length) sections[s.label] = lines.join(NL).slice(0, 4000);
  }
  const fullText = [...new Set(snaps.flatMap((s) => linesOf(s.text)))].join(NL);

  const linkMap = new Map();
  for (const s of snaps) for (const [h, t] of s.links || []) if (!linkMap.has(h)) linkMap.set(h, t);
  const emails = [];
  const phones = [];
  const links = [];
  let address = '';
  for (const [h, text] of linkMap) {
    if (h.startsWith('mailto:')) emails.push(h.slice(7));
    else if (h.startsWith('tel:')) phones.push(h.slice(4));
    else if (/^https?:/.test(h)) {
      try {
        const u = new URL(h);
        const target = u.hostname === 'l.facebook.com' ? u.searchParams.get('u') || h : h;
        if (/(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(new URL(target).hostname)) continue;
        if (!address && text && /(bing\.com\/maps|google\.[a-z.]+\/maps|maps\.google|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(target)) address = text;
        links.push(h);
      } catch {
        /* bad url */
      }
    }
  }
  emails.push(...(fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi) || []));
  phones.push(...(fullText.match(/(?<!\d)(?:\+?88[\s-]?)?01[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g) || []));
  for (const line of fullText.split(NL)) {
    if (!/^\+?[\d(][\d\s\-().]{6,20}$/.test(line)) continue;
    const digits = line.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) phones.push(line);
  }
  const first = snaps[0] || {};
  return {
    finalUrl: first.finalUrl,
    pageBio: snaps.map((s) => s.pageBio).find(Boolean) || '',
    pageCategory: snaps.map((s) => s.pageCategory).find(Boolean) || '',
    pageName: snaps.map((s) => s.pageName).find(Boolean) || '',
    followers: snaps.map((s) => s.followers).find(Boolean) || '',
    likes: snaps.map((s) => s.likes).find(Boolean) || '',
    address,
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
    links: [...new Set(links)].slice(0, 80),
    sections,
    fullText: fullText.slice(0, 12000),
    visited: snaps.map((s) => s.label),
  };
}

/**
 * Open ONLY the Page's own link (e.g. facebook.com/laptopgadgetbd). Its Intro / Details / Contact info box
 * already has bio, category, address, phone, WhatsApp, email, website, hours, rating — no /about or other
 * routes are ever opened.
 */
async function scrapePage(slot, lead) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 10000);
  try {
    const url = lead.mainUrl || lead.url;
    const r = await readUrl(slot, url);
    if (r.error || r.netError || r.notFound || r.blocked || r.loggedOut) return r;
    // only the Page's own info box counts (posts below it can contain other people's numbers)
    return combine([{ label: 'Page', ...r, text: r.intro || r.text }]);
  } finally {
    clearInterval(keepAlive);
  }
}

async function scraperLoop(slot) {
  if (runningSlots.has(slot)) return;
  runningSlots.add(slot);
  try {
    for (;;) {
      const c = await getCfg();
      if (!c.enabled || !c.apiKey) break;
      if (await isCollecting()) {
        await setStatus({ scraper: 'waiting — the Ad Library is collecting', error: '' });
        break;
      }
      const r = await api(`/worker/next-scrape?slot=${slot}`);
      if (r.proxy) await syncProxy(r.proxy);
      // there is work: slot 0 wakes the other slots (a few seconds apart so the tabs don't hit
      // Facebook at the same moment); a slot that's already running ignores this
      if (r.lead && slot === 0) {
        for (let s = 1; s < Math.min(MAX_SLOTS, Number(r.parallel) || 1); s++) setTimeout(() => scraperLoop(s), s * 4000);
      }
      if (!r.lead) {
        if (r.reason !== 'slot-off') await setStatus({ scraper: r.reason, doneToday: r.doneToday ?? null, error: '' });
        break;
      }
      await setStatus({ scraper: `scraping ${r.lead.pageName || r.lead.pageId}`, doneToday: r.doneToday, dailyLimit: r.dailyLimit, error: '' });
      let res;
      readingPages++;
      try {
        await applyProxy(); // proxy on for this page only
        res = await scrapePage(slot, r.lead);
      } catch (e) {
        res = { error: String(e.message || e) };
      } finally {
        readingPages--;
        await applyProxy(); // and off again — the user's own Facebook stays direct
      }
      const proxyId = r.proxy?.enabled ? r.proxy.id : '';
      if (!res.netError) netErrorsInARow = 0;
      if (res.netError) {
        // the page never loaded (proxy down, no internet …) — not the page's fault: it goes back in the queue
        // untouched; through a proxy that IP rests a few minutes and the next IP takes over
        if (++netErrorsInARow >= 3) {
          // 3 different IPs in a row: it isn't the IPs (proxy login refused in this Chrome, two copies of the
          // extension fighting over the proxy, internet down …) — stop and say so instead of resting every IP
          netErrorsInARow = 0;
          const reason = `Pages don't load through the proxy (${res.netError}, 3 times in a row). Check the proxy login in Settings and that only ONE copy of the extension is installed.`;
          await api('/worker/blocked', { method: 'POST', body: { pageId: r.lead.pageId, reason } });
          await setStatus({ scraper: 'paused', error: reason });
          break;
        }
        await api('/worker/net-error', { method: 'POST', body: { pageId: r.lead.pageId, proxyId, error: res.netError } });
        await setStatus({ scraper: `network error (${res.netError})${proxyId ? ' — next IP' : ''}`, error: '' });
        if (!proxyId) break;
        await sleepAlive(3000);
        continue;
      }
      // logged out, every block is about the IP — through a proxy pool only that IP rests
      if (res.blocked && proxyId) res.loggedOut = true;
      if (res.loggedOut) {
        // Facebook's login wall: the server rests that IP (proxy pool) or the whole worker, then it continues by itself
        const w = await api('/worker/wall', { method: 'POST', body: { pageId: r.lead.pageId, proxyId } });
        if (!w.until) {
          await setStatus({ scraper: 'login wall on one IP — next IP', error: '' });
          await sleepAlive(3000);
          continue;
        }
        await setStatus({ scraper: `waiting (login wall) until ${new Date(w.until).toLocaleTimeString()}`, error: '' });
        break;
      }
      if (res.blocked) {
        const reason = 'Facebook checkpoint / temporary block';
        await api('/worker/blocked', { method: 'POST', body: { pageId: r.lead.pageId, reason } });
        await setStatus({ scraper: 'paused', error: reason });
        notify('FB Lead Finder paused', reason + ' — check Facebook in this browser, then press Resume in the dashboard.');
        break;
      }
      await api('/worker/result', { method: 'POST', body: { pageId: r.lead.pageId, result: res, proxyId } });
      const min = Number(r.delayMin) || 15;
      const max = Math.max(min, Number(r.delayMax) || 30);
      await sleepAlive((min + Math.random() * (max - min)) * 1000);
    }
  } catch (e) {
    await setStatus({ error: e.message });
  } finally {
    runningSlots.delete(slot);
    if (!runningSlots.size) closeIdleWorkerTabs();
  }
}

/** When no slot is working, close the extra worker tabs (keep slot 0's tab). */
async function closeIdleWorkerTabs() {
  const tabs = await getSess('workerTabs', {});
  for (const [slot, id] of Object.entries(tabs)) {
    if (slot === '0') continue;
    await chrome.tabs.remove(id).catch(() => {});
    delete tabs[slot];
  }
  await setSess('workerTabs', tabs);
  await updateBlockRules();
}

const MAX_SLOTS = 3;
function tick() {
  // proxy on/off/changed in Settings reaches Chrome within a minute while nothing is being read
  // (while reading, every page brings its own proxy IP — switching here would change it mid-page)
  if (!runningSlots.size) api('/worker/status').then((s) => !runningSlots.size && syncProxy(s.proxy)).catch(() => {});
  collectorTick();
  // Only slot 0 asks the server when idle (few requests — matters on Vercel's free plan).
  // As soon as it gets a page it starts the other slots itself (see scraperLoop).
  scraperLoop(0);
}

// ---------------- messages ----------------
const handlers = {
  'adlib:hello': async (msg, sender) => {
    const tabJobs = await getSess('tabJobs', {});
    const st = await api('/worker/status').catch(() => ({}));
    return { job: tabJobs[sender.tab?.id] || null, maxAds: st.maxAds || 0 };
  },
  // the tab was reloaded during a search (e.g. after this extension was updated): take the search up again
  'adlib:resume': async (msg, sender) => {
    const r = await api(`/worker/job/${encodeURIComponent(msg.jobId)}/resume`, { method: 'POST' });
    const tabJobs = await getSess('tabJobs', {});
    tabJobs[sender.tab.id] = { ...r.job, closeTab: false };
    await setSess('tabJobs', tabJobs);
    await applyProxy(); // proxy off while an Ad Library tab collects
    return { job: r.job };
  },
  'adlib:startManual': async (msg, sender) => {
    const r = await api('/worker/manual-job', { method: 'POST', body: msg });
    const tabJobs = await getSess('tabJobs', {});
    tabJobs[sender.tab.id] = { ...r.job, manual: true, closeTab: false };
    await setSess('tabJobs', tabJobs);
    await applyProxy(); // proxy off while this Ad Library tab collects
    return { job: r.job };
  },
  'adlib:ads': async (msg) => api('/worker/ads', { method: 'POST', body: { jobId: msg.jobId, ads: msg.ads } }),
  // after collecting: how many of this search's pages the server has read
  'adlib:progress': async (msg) => api(`/worker/job/${encodeURIComponent(msg.jobId)}/progress`),
  // "Open in Dashboard": that project in the dashboard (the panel doesn't know the server address)
  'adlib:openDashboard': async (msg) => {
    const c = await getCfg();
    const base = c.serverUrl.replace(/\/+$/, '');
    await chrome.tabs.create({ url: msg.projectId ? `${base}/projects/${encodeURIComponent(msg.projectId)}` : `${base}/` });
    return { ok: true };
  },
  // the pause between two pages, counted here: Chrome slows a background tab's own timers to once a minute
  'adlib:wait': async (msg) => {
    await sleepAlive(Math.min(120000, Math.max(0, Number(msg.ms) || 0))); // keeps the background awake meanwhile
    return { ok: true };
  },
  'adlib:jobStatus': async (msg) => {
    const q = new URLSearchParams();
    if (msg.hidden) q.set('hidden', '1');
    if (msg.note) q.set('note', String(msg.note).slice(0, 200));
    return api(`/worker/job/${encodeURIComponent(msg.jobId)}${q.toString() ? `?${q}` : ''}`);
  },
  // the Ad Library tab went to the background: Facebook loads no more ads there — tell the person once
  'adlib:hidden': async (msg) => {
    notify('FB Lead Finder — collecting is waiting', `"${msg.keyword}": bring the Ad Library tab to the front. Facebook only loads more ads while it is visible.`);
    return { ok: true };
  },
  'adlib:done': async (msg, sender) => {
    const job = await finishJob(sender.tab.id, 'done', msg.stats);
    if (job && job.closeTab && !job.manual) setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 2500);
    setTimeout(tick, 3000);
    return { ok: true };
  },
  // /connect-extension on the dashboard: this computer now works for that account (its own key)
  'ext:connect': async (msg, sender) => {
    const origin = sender?.origin || (sender?.url ? new URL(sender.url).origin : '');
    const allowed = /^https:\/\/([a-z0-9-]+\.)*specter\.monster$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!allowed || origin !== msg.server || !/^ext_[A-Za-z0-9_-]{20,}$/.test(String(msg.key || ''))) return { ok: false, error: 'Not allowed' };
    const cfg = { ...(await getCfg()), apiKey: msg.key, serverUrl: origin, enabled: true };
    await chrome.storage.local.set({ cfg });
    await api('/worker/status').catch(() => {}); // the dashboard sees this computer at once
    tick();
    return { ok: true };
  },
  'popup:status': async () => ({ cfg: await getCfg(), status: await getSess('status', {}) }),
  'popup:saveCfg': async (msg) => {
    const cfg = { ...(await getCfg()), ...msg.cfg };
    await chrome.storage.local.set({ cfg });
    const stats = await api('/worker/status');
    if (stats?.proxy) await syncProxy(stats.proxy);
    tick();
    return { ok: true, stats };
  },
  'popup:stats': async () => api('/worker/status'),
  'popup:kick': async () => {
    tick();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return;
  Promise.resolve(h(msg, sender)).then(
    (r) => sendResponse(r ?? { ok: true }),
    (e) => sendResponse({ ok: false, error: String(e.message || e) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const workerTabs = await getSess('workerTabs', {});
  for (const [slot, id] of Object.entries(workerTabs)) if (id === tabId) delete workerTabs[slot];
  await setSess('workerTabs', workerTabs);
  await updateBlockRules();
  const tabJobs = await getSess('tabJobs', {});
  if (tabJobs[tabId]) await finishJob(tabId, 'tab closed');
});

// When idle, check the server for new work every 30 s (the shortest alarm Chrome allows). A search started
// in the dashboard on this PC wakes the extension at once (content/dashboard.js → 'popup:kick').
chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'tick' && tick());
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
