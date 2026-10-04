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

async function api(path, { method = 'GET', body } = {}) {
  const c = await getCfg();
  if (!c.apiKey) throw new Error('Worker key is not set (extension popup)');
  const r = await fetch(c.serverUrl.replace(/\/+$/, '') + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey, 'x-ext-version': chrome.runtime.getManifest().version },
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
let cachedProxy = null;

async function syncProxy(proxy) {
  if (!proxy) return;
  const cfg = {
    enabled: Boolean(proxy.enabled),
    host: String(proxy.host || '').trim(),
    port: Number(proxy.port) || 44445,
    user: String(proxy.user || '').trim(),
    pass: String(proxy.pass || '').trim(),
  };

  const key = `${cfg.enabled}:${cfg.host}:${cfg.port}:${cfg.user}:${cfg.pass}`;
  if (cachedProxy && cachedProxy._key === key) return;
  cfg._key = key;
  cachedProxy = cfg;
  await chrome.storage.local.set({ activeProxy: cfg }).catch(() => {});

  if (!cfg.enabled || !cfg.host || !cfg.port) {
    try {
      await chrome.proxy.settings.clear({ scope: 'regular' });
      await setStatus({ proxyActive: false });
      console.log('[Proxy] Cleared (Direct mode)');
    } catch (e) {
      console.warn('Proxy clear error:', e);
    }
    return;
  }

  // PAC script: route *.facebook.com, facebook.com, *.fbcdn.net, fbcdn.net through the proxy.
  // Localhost, 127.0.0.1 and private IPs go DIRECT so local server communication is untouched.
  const pac = `
    function FindProxyForURL(url, host) {
      if (shExpMatch(host, "localhost") || host === "127.0.0.1" || isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "172.16.0.0", "255.240.0.0") || isInNet(host, "192.168.0.0", "255.255.0.0")) {
        return "DIRECT";
      }
      // Meta Ad Library is public & free ? keep it direct so it never lags or drains proxy data
      if (shExpMatch(url, "*facebook.com/ads/library*")) {
        return "DIRECT";
      }
      if (shExpMatch(host, "*.facebook.com") || host === "facebook.com" || shExpMatch(host, "*.fbcdn.net") || host === "fbcdn.net") {
        return "PROXY ${cfg.host}:${cfg.port}";
      }
      return "DIRECT";
    }
  `;

  try {
    await chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        pacScript: { data: pac },
      },
      scope: 'regular',
    });
    await setStatus({ proxyActive: true, proxyHost: `${cfg.host}:${cfg.port}` });
    console.log(`[Proxy] Active: ${cfg.host}:${cfg.port} (Facebook only)`);
  } catch (e) {
    console.warn('Proxy set error:', e);
  }
}

// Proxy Authentication
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy && cachedProxy?.enabled && cachedProxy?.user) {
      callback({
        authCredentials: {
          username: cachedProxy.user,
          password: cachedProxy.pass,
        },
      });
      return;
    }
    callback({});
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.storage.local.get('activeProxy').then(({ activeProxy }) => {
  if (activeProxy) syncProxy(activeProxy);
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
    const tab = await chrome.tabs.create({ url: r.job.url, active: true });
    fresh[tab.id] = { ...r.job, closeTab: r.closeAdTab !== false };
    await setSess('tabJobs', fresh);
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
  await api('/worker/collect-done', { method: 'POST', body: { jobId: job.id, reason, stats } }).catch(() => {});
  return job;
}

// ---------------- Page About scraping ----------------
// Several worker slots can run at once (Settings → "Pages read at the same time"); each slot has its own background tab
// and asks the server for the next page (the server hands each page to exactly one slot).
const runningSlots = new Set();

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
  await chrome.tabs.update(tabId, { url });
  if (!(await waitCommitted(tabId, prevUrl))) return { error: 'Page load timeout' };
  // Facebook sometimes redirects right after load, which wipes the injected script — retry once
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-about.js'] });
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__fblfRead() });
      if (res && res.result) return res.result;
    } catch (e) {
      if (attempt) return { error: String(e.message || e) };
    }
    await sleep(2000);
  }
  return { error: 'No result from page' };
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
    if (r.error || r.notFound || r.blocked || r.loggedOut) return r;
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
      try {
        res = await scrapePage(slot, r.lead);
      } catch (e) {
        res = { error: String(e.message || e) };
      }
      if (res.loggedOut) {
        // Facebook's login wall: the server decides how long to wait, then the worker continues by itself
        const w = await api('/worker/wall', { method: 'POST', body: { pageId: r.lead.pageId } });
        await setStatus({ scraper: `waiting (login wall) until ${w.until ? new Date(w.until).toLocaleTimeString() : 'later'}`, error: '' });
        break;
      }
      if (res.blocked) {
        const reason = 'Facebook checkpoint / temporary block';
        await api('/worker/blocked', { method: 'POST', body: { pageId: r.lead.pageId, reason } });
        await setStatus({ scraper: 'paused', error: reason });
        notify('FB Lead Finder paused', reason + ' — check Facebook in this browser, then press Resume in the dashboard.');
        break;
      }
      await api('/worker/result', { method: 'POST', body: { pageId: r.lead.pageId, result: res } });
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
  collectorTick();
  // Only slot 0 asks the server when idle (few requests — matters on Vercel's free plan).
  // As soon as it gets a page it starts the other slots itself (see scraperLoop).
  scraperLoop(0);
}

// ---------------- messages ----------------
const handlers = {
  'adlib:hello': async (msg, sender) => {
    const tabJobs = await getSess('tabJobs', {});
    return { job: tabJobs[sender.tab?.id] || null };
  },
  'adlib:startManual': async (msg, sender) => {
    const r = await api('/worker/manual-job', { method: 'POST', body: msg });
    const tabJobs = await getSess('tabJobs', {});
    tabJobs[sender.tab.id] = { ...r.job, manual: true, closeTab: false };
    await setSess('tabJobs', tabJobs);
    return { job: r.job };
  },
  'adlib:ads': async (msg) => api('/worker/ads', { method: 'POST', body: { jobId: msg.jobId, ads: msg.ads } }),
  'adlib:jobStatus': async (msg) => api(`/worker/job/${encodeURIComponent(msg.jobId)}`),
  'adlib:done': async (msg, sender) => {
    const job = await finishJob(sender.tab.id, 'done', msg.stats);
    if (job && job.closeTab && !job.manual) setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 2500);
    setTimeout(tick, 3000);
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

// every 30s: pick up new jobs / resume scraping (the server decides what to do)
// when idle, check the server for new work once a minute (starting a search in the dashboard
// is picked up within a minute; while pages are being read the loop runs on its own)
chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'tick' && tick());
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
