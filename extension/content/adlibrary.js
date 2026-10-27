// Isolated content script on the Ad Library: floating panel, auto-scroll, sends ads to the server (via background).
// Condition: "at least N ads" — only pages running at least N ads in this search are collected.
(() => {
  const buffer = new Map(); // adId -> ad (everything captured on this tab)
  let sent = new Set(); // adIds already sent for the current job
  let job = null;
  let running = false;
  let stopRequested = false;
  let flushTimer = null;
  let statusText = '';
  let resultsHint = '';
  let minAds = 1; // condition: pages with at least this many ads
  let defaultMaxAds = 0; // Settings → max ads per search (known once the background answered)
  let disconnected = false; // the extension was reloaded/updated: this page can't reach it any more
  let lastJob = null; // the search this panel worked for (kept after it finished, for "Open in Dashboard")
  let progress = null; // { pages, read, withContact } — the server reading this search's pages

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = () => new URLSearchParams(location.search);
  const currentQ = () => (params().get('q') || '').trim().toLowerCase();
  const current = () => [...buffer.values()].filter((a) => (a.searchQ || '') === currentQ());
  const maxAds = () => Number(job?.maxAds) || defaultMaxAds || Infinity;

  /** pageId -> number of ads that page has in this search */
  function adsPerPage(list = current()) {
    const m = new Map();
    for (const a of list) m.set(a.pageId, (m.get(a.pageId) || 0) + 1);
    return m;
  }
  /** ads (and pages) that meet the condition — within the max-ads limit, which is what the server gets */
  function matching(list = current()) {
    const limited = minAds <= 1 ? list.slice(0, maxAds()) : list;
    const per = adsPerPage(limited);
    const okPages = new Set([...per].filter(([, n]) => n >= minAds).map(([p]) => p));
    return { ads: limited.filter((a) => okPages.has(a.pageId)), pages: okPages.size, totalPages: adsPerPage(list).size };
  }

  // The search this tab works for survives a page reload (sessionStorage is per tab), so after the extension
  // was updated the user reloads and collecting goes on — without sending the same ads twice.
  const SAVE_KEY = 'fblf-collect';
  const saveState = () => {
    try {
      if (job) sessionStorage.setItem(SAVE_KEY, JSON.stringify({ job, sent: [...sent] }));
      else sessionStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage full / blocked — resuming just resends a few ads */
    }
  };
  const savedState = () => {
    try {
      return JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null');
    } catch {
      return null;
    }
  };

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      // "Extension context invalidated": the extension was reloaded or updated while this page was open
      disconnected = true;
      running = false;
      stopRequested = true;
      render();
      return { ok: false, error: 'disconnected' };
    }
  }

  // ---------- capture ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__fblf || e.data.type !== 'ads') return;
    for (const ad of e.data.ads || []) if (ad && ad.adId) buffer.set(ad.adId, ad);
    render();
    if (running && !flushTimer) flushTimer = setTimeout(() => ((flushTimer = null), flush(false)), 1500);
  });

  /**
   * Send ads to the server. Without a condition they go out while scrolling.
   * With a condition (2+ ads …) we can only know which pages qualify once scrolling is finished,
   * so everything is held back and only the matching pages' ads are sent at the end.
   */
  async function flush(final) {
    if (!job) return;
    let list;
    if (minAds <= 1) {
      const room = job.maxAds - sent.size;
      if (room <= 0) return;
      list = current().filter((a) => !sent.has(a.adId)).slice(0, room);
    } else {
      if (!final) return;
      list = matching().ads.filter((a) => !sent.has(a.adId));
    }
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      chunk.forEach((a) => sent.add(a.adId));
      const r = await send({ type: 'adlib:ads', jobId: job.id, ads: chunk });
      if (disconnected) {
        chunk.forEach((a) => sent.delete(a.adId));
        return;
      }
      saveState();
      if (r && r.error === 'stopped') {
        stopRequested = true;
        statusText = 'Stopped from the dashboard';
        render();
        return;
      }
      if (r && r.ok === false) {
        chunk.forEach((a) => sent.delete(a.adId));
        statusText = '⚠ ' + (r.error || 'server error');
        render();
        return;
      }
    }
  }

  // ---------- collect page by page (no scrolling, the tab may be in the background) ----------
  let pageReqId = 0;
  /** One page of ads from the pager in the page's own world. */
  function pageNext() {
    const id = ++pageReqId;
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source !== window || !e.data || !e.data.__fblf || e.data.type !== 'page-result' || e.data.id !== id) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(e.data);
      };
      // no answer in 60 s (the page is frozen) → treat as a failed try
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'no answer', retry: true });
      }, 60000);
      window.addEventListener('message', onMsg);
      window.postMessage({ __fblf: true, type: 'page-next', id }, '*');
    });
  }
  /**
   * The pause between two pages is counted by the extension's background (Chrome slows the timers of a tab in
   * the background to once a minute; the background's timers are not slowed).
   */
  const waitOnce = (ms) => send({ type: 'adlib:wait', ms }).then((r) => (r && r.ok === false ? sleep(ms) : null));
  // A long wait checks in with the server every 30 s: 3 minutes without a word and the server closes the
  // search as "tab stopped responding" (worker.js STALE_COLLECT_MS) — retries and breaks could wait longer.
  const pause = async (ms) => {
    for (let left = ms; left > 0; left -= 30000) {
      await waitOnce(Math.min(30000, left));
      if (left > 30000 && job && !disconnected) {
        const st = await send({ type: 'adlib:jobStatus', jobId: job.id });
        if (st && st.phase === 'stopped') {
          stopRequested = true; // pressed Stop on the dashboard during a long wait
          return;
        }
      }
    }
  };

  // why the page-by-page way did not work (Facebook's own words) — shown on the panel and saved on the search
  let pagerError = '';

  /** Facebook's own "See more" bar under the results (it shows up when its scrolling did not load the next ads). */
  function seeMoreButton() {
    const want = /^(see more|আরও দেখুন|show more)$/i;
    const els = [...document.querySelectorAll('div[role="button"], a[role="button"], button')].filter(
      (el) => want.test((el.textContent || '').trim()) && el.getBoundingClientRect().width > window.innerWidth * 0.4,
    );
    return els[els.length - 1] || null;
  }

  /** 'done' (end of the results / max reached / stopped) or 'fallback' (the pager can't work here → scroll). */
  async function collectByPages() {
    let fails = 0;
    let pages = 0;
    // Deep in a big search Facebook keeps saying "there is a next page" but sends pages with no new ads.
    // Without a limit the collector asked forever (it looked frozen). A few empty pages: wait a minute and try
    // again (sometimes it is a short slow-down); still nothing: that is as far as Facebook goes — finish.
    let empty = 0;
    const EMPTY_PAUSE_AT = 8;
    const EMPTY_STOP_AT = 16;
    // "Rate limit exceeded": Facebook wants a break (it says so sooner to server/datacenter IPs). Scrolling
    // would hit the same limit AND needs the tab visible (a closed remote-desktop window = hidden) — so wait
    // longer and longer and go on in the background, for up to about an hour.
    // Gentle mode (a server/datacenter computer, set by the admin): fewer, longer waits - then the search ends
    const pace = job.pace || {};
    const LIMIT_WAITS = pace.limitWaits || [2, 4, 8, 15, 15, 15]; // minutes
    let limited = 0;
    const isRateLimit = (e) => /rate.?limit|too many|try again later|slow down/i.test(String(e || ''));
    while (!stopRequested) {
      const n = current().length;
      if (n >= job.maxAds) return 'done';
      statusText = minAds > 1 ? `Collecting… ${n} ads — pages with ${minAds}+ ads are picked at the end` : `Collecting… ${n} ads (works in the background too)`;
      render();
      const r = await pageNext();
      if (disconnected) return 'done';
      if (!r.ok) pagerError = String(r.error || 'unknown').slice(0, 160);
      if (r.ok) {
        fails = 0;
        limited = 0;
        pages++;
        await flush(false); // send this page's ads now (the tab's own timers may be slowed in the background)
        if (!r.hasNext) {
          resultsHint = '';
          if (!current().length) {
            // nothing at all — if every keyword shows this, Facebook is limiting this browser for a while
            statusText = '⚠ Facebook shows no ads for this search. If every keyword shows none, Facebook has limited this browser for a while — use a Chrome profile without a Facebook login, or wait a few hours.';
            render();
            await send({ type: 'adlib:jobStatus', jobId: job.id, note: 'Facebook showed no ads for this search (if every search shows none: this browser is limited by Facebook for a while)' });
          }
          return 'done';
        }
        empty = r.count > 0 ? 0 : empty + 1;
        if (empty >= EMPTY_STOP_AT) {
          statusText = `Facebook gives no more new ads for this search (stopped at ${n} ads)`;
          await send({ type: 'adlib:jobStatus', jobId: job.id, note: `Facebook gave no new ads after ${n} — finished there` });
          return 'done';
        }
        if (empty === EMPTY_PAUSE_AT) {
          statusText = `Facebook sends no new ads right now (${n} so far) — waiting 1 minute, then trying again`;
          render();
          await send({ type: 'adlib:jobStatus', jobId: job.id, note: `Facebook sends no new ads after ${n} — waiting` });
          await pause(60000);
        }
      } else if (isRateLimit(r.error) && limited < LIMIT_WAITS.length) {
        const mins = LIMIT_WAITS[limited++];
        statusText = `Facebook asks to slow down — waiting ${mins} min, then going on (keeps working in the background; ${n} ads so far)`;
        render();
        await send({ type: 'adlib:jobStatus', jobId: job.id, note: `Facebook rate limit after ${n} ads — waiting ${mins} min, then going on` });
        await pause(mins * 60000);
        continue;
      } else if (isRateLimit(r.error)) {
        // still "slow down" after every wait: respect it - finish this search with what arrived
        statusText = `Facebook keeps asking to slow down — finished with ${n} ads`;
        render();
        await send({ type: 'adlib:jobStatus', jobId: job.id, note: `Facebook rate limit after ${n} ads — finished there` });
        return 'done';
      } else if (r.retry && pages > 0 && ++fails <= 5) {
        // Facebook said "slow down" or the network hiccuped: wait longer each time, then go on
        statusText = `Facebook is slow to answer — trying again in ${fails * 20} s (${n} ads so far)`;
        render();
        await pause(fails * 20000);
        continue;
      } else {
        return pages > 0 && fails > 5 ? 'done' : 'fallback';
      }
      // heartbeat + "stopped from the dashboard?" every 3 pages
      if (pages % 3 === 0) {
        const st = await send({ type: 'adlib:jobStatus', jobId: job.id });
        if (disconnected) return 'done';
        if (st && st.phase === 'stopped') {
          statusText = 'Stopped from the dashboard';
          return 'done';
        }
      }
      // like a person reading: 3–6 s between pages, and a longer break every 40 pages — asking much faster got a
      // browser limited by Facebook for hours
      const between = (r) => r[0] + Math.random() * (r[1] - r[0]);
      if (pages % (pace.breakEvery || 40) === 0) {
        statusText = `Short break so Facebook doesn't limit this browser (${n} ads so far)`;
        render();
        await pause(between(pace.breakMs || [60000, 90000]));
      } else await pause(between(pace.pageDelay || [3000, 6000]));
    }
    return 'done';
  }

  // ---------- collect loop ----------
  async function start(existingJob, { keepSent = [] } = {}) {
    if (running || disconnected) return;
    if (existingJob) {
      job = existingJob;
      if (Number(job.minAds) >= 1) setMinAds(Number(job.minAds), false);
    } else {
      statusText = 'Starting…';
      render();
      const r = await send({
        type: 'adlib:startManual',
        keyword: params().get('q') || '',
        country: params().get('country') || 'ALL',
        url: location.href,
        minAds,
      });
      if (!r || !r.job) {
        statusText = '⚠ ' + ((r && r.error) || 'Could not connect to the server (check Server URL / API key in the popup)');
        render();
        return;
      }
      job = r.job;
      // the server decides the condition by the account's plan (the free plan collects every page)
      if (Number(job.minAds) >= 1 && Number(job.minAds) !== minAds) setMinAds(Number(job.minAds), false);
    }
    running = true;
    stopRequested = false;
    sent = new Set(keepSent);
    lastJob = job;
    progress = null;
    saveState();
    render();
    window.postMessage({ __fblf: true, type: 'replay' }, '*');
    await sleep(800);
    await flush(false);

    // 1) page by page, without scrolling — works with the tab in the background (adlibrary-hook.js: the pager).
    //    A computer the admin set to "Collect by scrolling" (server: worker.js collectModeFor) skips this.
    const scrollOnly = job.collectMode === 'scroll';
    const byPages = scrollOnly ? 'scroll' : await collectByPages();
    // tell the team why background collecting could not work on this computer (shown in the admin panel)
    if (byPages === 'fallback') await send({ type: 'adlib:jobStatus', jobId: job.id, note: `Background collecting not possible here (${pagerError || 'unknown'}) — scrolling instead` });
    // 2) scroll like a person (needs the tab in front): on a "Collect by scrolling" computer, or when the pager
    //    can't work on this page. The ads Facebook loads while scrolling are taken by adlibrary-hook.js.
    let last = -1;
    let stall = 0;
    let lastNewAt = Date.now();
    let rounds = 0;
    let hiddenToldAt = 0;
    while ((byPages === 'fallback' || byPages === 'scroll') && !stopRequested) {
      // Facebook loads more ads only while this tab is visible. In the background nothing new arrives — that is
      // NOT the end of the results: wait (keep the heartbeat going) instead of finishing with what we have.
      if (document.hidden) {
        statusText = 'Waiting — bring this tab to the front. Facebook only loads more ads while it is visible.';
        render();
        const st = await send({ type: 'adlib:jobStatus', jobId: job.id, hidden: true });
        if (disconnected) break;
        if (st && st.phase === 'stopped') {
          statusText = 'Stopped from the dashboard';
          break;
        }
        if (Date.now() - hiddenToldAt > 10 * 60e3) {
          hiddenToldAt = Date.now();
          send({ type: 'adlib:hidden', keyword: job.keyword });
        }
        await sleep(3000);
        stall = 0;
        lastNewAt = Date.now();
        continue;
      }
      // every few scrolls ask the server whether this search was stopped from the dashboard
      if (++rounds % 3 === 0) {
        // also the heartbeat: the server knows this tab is alive (silent 1 min = "not responding" on the Dashboard)
        const note = stall >= 3 ? `Facebook loads no more ads here — ${pagerError || 'See more does nothing'}` : '';
        const st = await send({ type: 'adlib:jobStatus', jobId: job.id, note });
        if (disconnected) break;
        if (st && st.phase === 'stopped') {
          statusText = 'Stopped from the dashboard';
          break;
        }
      }
      const n = current().length;
      if (n >= job.maxAds) break;
      if (n === last) stall++;
      else {
        stall = 0;
        last = n;
        lastNewAt = Date.now();
      }
      // the end of the results: no new ads after 8 scrolls AND for 45 s, with the tab in front the whole time
      // (Facebook is sometimes slow — 6 quick scrolls used to end big searches early)
      if (stall >= 8 && Date.now() - lastNewAt > 45000) break;
      statusText =
        stall >= 3
          ? `⚠ Facebook is not loading more ads on this connection (${n} so far). Reason: ${pagerError || 'its "See more" does nothing'}. ` +
            'Log in to Facebook in this Chrome, or use a home/residential internet IP — Facebook often blocks server (datacenter) IPs.'
          : minAds > 1
            ? `Scrolling… (${n} ads) — pages with ${minAds}+ ads are picked at the end`
            : `Scrolling… (${n} ads)`;
      render();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
      // Facebook shows a "See more" bar instead of loading by itself → press it like a person would
      const more = seeMoreButton();
      if (more) {
        more.scrollIntoView({ block: 'center' });
        more.click();
      }
      await sleep(1500 + Math.random() * 2000);
      if (stall >= 3) {
        window.scrollBy(0, -600);
        await sleep(600);
      }
    }
    if (disconnected) return; // keep job + sent saved: after a page reload collecting goes on
    await flush(true);
    if (disconnected) return;
    const finished = job;
    const m = matching();
    const captured = current().length;
    running = false;
    job = null;
    saveState();
    await send({
      type: 'adlib:done',
      jobId: finished.id,
      count: sent.size,
      manual: !!finished.manual,
      stats: { captured, pagesTotal: m.totalPages, pagesMatched: minAds > 1 ? m.pages : m.totalPages, minAds },
    });
    statusText =
      minAds > 1
        ? `✓ Collected — ${m.pages} of ${m.totalPages} pages run ${minAds}+ ads. Contacts are read for these ${m.pages} pages only.`
        : `✓ Collected — ${sent.size} ads sent to the server.`;
    render();
    watchProgress(finished.id);
  }

  /** After collecting: follow the server reading this search's pages, until all are read (max ~15 min). */
  async function watchProgress(jobId) {
    for (let i = 0; i < 300 && !disconnected && lastJob?.id === jobId; i++) {
      const r = await send({ type: 'adlib:progress', jobId });
      if (r && typeof r.pages === 'number') {
        progress = r;
        if (r.projectId && lastJob) lastJob.projectId = r.projectId;
        render();
        if (r.pages && r.read >= r.pages) return;
      }
      await sleep(3000);
    }
  }

  // ---------- condition ----------
  function setMinAds(n, save = true) {
    minAds = Math.max(1, Math.min(999, Math.round(Number(n) || 1)));
    if (save) chrome.storage?.local.set({ fblfMinAds: minAds }).catch?.(() => {});
    render();
  }

  // ---------- panel ----------
  let panel;
  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.id = 'fblf-panel';
    panel.innerHTML = `
      <div class="fblf-head">
        <span class="fblf-logo" aria-hidden="true">AL</span>
        <div class="fblf-title"><b>FB Lead Finder</b><small data-k="state">Ready</small></div>
        <button class="fblf-min" title="Minimize" aria-label="Minimize">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="fblf-body">
        <div class="fblf-alert" data-k="alert" hidden>
          <b>The extension was updated</b>
          <span>This page lost its connection — nothing reaches the server.</span>
          <button class="fblf-reload">Reload this page</button>
          <small>Collecting continues where it stopped.</small>
        </div>
        <div class="fblf-stats">
          <div class="fblf-stat"><b data-k="seen">0</b><span>On screen</span></div>
          <div class="fblf-stat"><b data-k="pages">0</b><span>Pages</span></div>
          <div class="fblf-stat fblf-stat-sent"><b data-k="ads">–</b><span data-k="adsLabel">Sent</span></div>
        </div>
        <div class="fblf-cond">
          <div class="fblf-cond-top">
            <span>Pages with at least</span>
            <input class="fblf-min-input" type="number" min="1" max="999" value="1" aria-label="Minimum ads per page" />
            <span>ads</span>
          </div>
          <div class="fblf-chips">
            <button data-n="1">All</button><button data-n="2">2+</button><button data-n="3">3+</button><button data-n="5">5+</button><button data-n="10">10+</button>
          </div>
          <div class="fblf-match" data-k="match"></div>
        </div>
        <div class="fblf-progress" data-k="progress" hidden>
          <div class="fblf-progress-top"><span>Contacts from pages</span><b data-k="ptext"></b></div>
          <div class="fblf-bar"><i data-k="pbar"></i></div>
          <div class="fblf-progress-sub" data-k="psub"></div>
        </div>
        <div class="fblf-status" data-k="status"></div>
        <div class="fblf-hint" data-k="hint"></div>
        <button class="fblf-open" data-k="open" hidden>Open in Dashboard <span aria-hidden="true">→</span></button>
        <div class="fblf-actions">
          <button class="fblf-start">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Collect this search
          </button>
          <button class="fblf-stop">Stop</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.fblf-min').onclick = () => panel.classList.toggle('fblf-collapsed');
    panel.querySelector('.fblf-reload').onclick = () => location.reload();
    panel.querySelector('.fblf-open').onclick = () => send({ type: 'adlib:openDashboard', projectId: lastJob?.projectId || null });
    panel.querySelector('.fblf-start').onclick = () => start(null);
    panel.querySelector('.fblf-stop').onclick = () => {
      stopRequested = true;
      statusText = 'Stopping…';
      render();
    };
    const input = panel.querySelector('.fblf-min-input');
    input.oninput = () => setMinAds(input.value);
    panel.querySelectorAll('.fblf-chips button').forEach((b) => (b.onclick = () => setMinAds(b.dataset.n)));
    render();
  }

  function render() {
    if (!panel) return;
    const list = current();
    const m = matching(list);
    const limit = maxAds();
    panel.querySelector('[data-k="alert"]').hidden = !disconnected;
    panel.querySelector('[data-k="seen"]').textContent = list.length;
    panel.querySelector('[data-k="ads"]').textContent = job || sent.size ? sent.size : '–';
    panel.querySelector('[data-k="adsLabel"]').textContent = limit < Infinity ? `Sent · max ${limit}` : 'Sent';
    panel.querySelector('[data-k="pages"]').textContent = m.totalPages;
    const done = progress && progress.pages > 0 && progress.read >= progress.pages;
    panel.querySelector('[data-k="state"]').textContent = disconnected
      ? 'Disconnected — reload the page'
      : running
        ? 'Collecting ads…'
        : progress && !done
          ? 'Reading contacts on the server…'
          : done
            ? 'Done ✓'
            : 'Ready';
    panel.classList.toggle('fblf-error', disconnected);
    const input = panel.querySelector('.fblf-min-input');
    if (document.activeElement !== input) input.value = minAds;
    input.disabled = running;
    panel.querySelectorAll('.fblf-chips button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.n) === minAds);
      b.disabled = running;
    });
    const capped = minAds <= 1 && list.length > limit;
    panel.querySelector('[data-k="match"]').innerHTML =
      minAds > 1
        ? `Matching: <b>${m.pages} pages</b> <small>(${m.ads.length} ads) · of ${m.totalPages}</small>`
        : capped
          ? `<b>${m.pages} pages</b> will be collected <small>(the first ${limit} ads — "max ads" limit in Settings; ${m.totalPages} pages on screen)</small>`
          : `All <b>${m.totalPages} pages</b> will be collected`;
    panel.querySelector('[data-k="hint"]').textContent = resultsHint;
    panel.querySelector('[data-k="status"]').textContent = disconnected ? '' : statusText || (job ? '' : 'Search, then press "Collect"');
    panel.querySelector('.fblf-start').disabled = running || disconnected;
    // the server reading this search's pages (after collecting) + a way to the results
    const pBox = panel.querySelector('[data-k="progress"]');
    pBox.hidden = !progress || disconnected;
    if (progress) {
      const all = progress.pages > 0 && progress.read >= progress.pages;
      panel.querySelector('[data-k="ptext"]').textContent = `${progress.read}/${progress.pages}`;
      panel.querySelector('[data-k="pbar"]').style.width = `${progress.pages ? Math.round((progress.read / progress.pages) * 100) : 0}%`;
      panel.querySelector('[data-k="psub"]').textContent = all
        ? `✓ All pages read — ${progress.withContact} with phone/email/WhatsApp`
        : `${progress.withContact} with contact so far — reading on the server…`;
      pBox.classList.toggle('fblf-done', all);
    }
    panel.querySelector('[data-k="open"]').hidden = !lastJob || disconnected;
    panel.querySelector('.fblf-stop').disabled = !running;
    panel.classList.toggle('fblf-running', running);
  }

  // "~1,200 results" text from the page
  setInterval(() => {
    const m = (document.body && document.body.innerText.match(/~?\s?[\d,.]+\s?[KkMm]?\s+results?/)) || null;
    resultsHint = m ? `Facebook shows: ${m[0].trim()}` : '';
    render();
  }, 3000);

  async function init() {
    try {
      const { fblfMinAds } = await chrome.storage.local.get('fblfMinAds');
      if (fblfMinAds) minAds = Number(fblfMinAds) || 1;
    } catch {
      /* storage unavailable — keep 1 */
    }
    buildPanel();
    let r = await send({ type: 'adlib:hello' });
    if (!r || !r.job) {
      // the background may still be registering this tab as a job tab
      await sleep(2500);
      r = await send({ type: 'adlib:hello' });
    }
    if (r?.maxAds) defaultMaxAds = Number(r.maxAds) || 0;
    if (r && r.job) {
      statusText = `Job: "${r.job.keyword}" — starting auto collect…`;
      render();
      const saved = savedState();
      setTimeout(() => start(r.job, { keepSent: saved?.job?.id === r.job.id ? saved.sent : [] }), 4000);
      return;
    }
    // this tab was collecting before a reload (e.g. the extension was updated): go on with that search
    const saved = savedState();
    if (saved?.job?.id) {
      statusText = `Continuing "${saved.job.keyword}" after the reload…`;
      render();
      const back = await send({ type: 'adlib:resume', jobId: saved.job.id });
      if (back?.job) {
        setTimeout(() => start(back.job, { keepSent: saved.sent || [] }), 2000);
      } else {
        statusText = `"${saved.job.keyword}" has ended — press "Collect this search" to collect again.`;
        job = null;
        saveState();
        render();
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
