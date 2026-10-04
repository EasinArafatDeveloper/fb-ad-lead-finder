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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = () => new URLSearchParams(location.search);
  const currentQ = () => (params().get('q') || '').trim().toLowerCase();
  const current = () => [...buffer.values()].filter((a) => (a.searchQ || '') === currentQ());

  /** pageId -> number of ads that page has in this search */
  function adsPerPage(list = current()) {
    const m = new Map();
    for (const a of list) m.set(a.pageId, (m.get(a.pageId) || 0) + 1);
    return m;
  }
  /** ads (and pages) that meet the condition */
  function matching(list = current()) {
    const per = adsPerPage(list);
    const okPages = new Set([...per].filter(([, n]) => n >= minAds).map(([p]) => p));
    return { ads: list.filter((a) => okPages.has(a.pageId)), pages: okPages.size, totalPages: per.size };
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { ok: false, error: 'The extension was reloaded — please refresh this page' };
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

  // ---------- collect loop ----------
  async function start(existingJob) {
    if (running) return;
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
    }
    running = true;
    stopRequested = false;
    sent = new Set();
    render();
    window.postMessage({ __fblf: true, type: 'replay' }, '*');
    await sleep(800);
    await flush(false);

    let last = -1;
    let stall = 0;
    let rounds = 0;
    while (!stopRequested) {
      // every few scrolls ask the server whether this search was stopped from the dashboard
      if (++rounds % 3 === 0) {
        const st = await send({ type: 'adlib:jobStatus', jobId: job.id });
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
      }
      if (stall >= 6) break; // no new ads after ~6 scrolls → end of results
      statusText = minAds > 1 ? `Scrolling… (${n} ads) — pages with ${minAds}+ ads are picked at the end` : `Scrolling… (${n} ads)`;
      render();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(2000 + Math.random() * 2000);
      if (stall >= 3) {
        window.scrollBy(0, -600);
        await sleep(600);
      }
    }
    await flush(true);
    const finished = job;
    const m = matching();
    const captured = current().length;
    running = false;
    job = null;
    await send({
      type: 'adlib:done',
      jobId: finished.id,
      count: sent.size,
      manual: !!finished.manual,
      stats: { captured, pagesTotal: m.totalPages, pagesMatched: minAds > 1 ? m.pages : m.totalPages, minAds },
    });
    statusText =
      minAds > 1
        ? `✓ Done — ${m.pages} of ${m.totalPages} pages run ${minAds}+ ads. Contacts will be fetched for these ${m.pages} pages only.`
        : `✓ Done — ${sent.size} ads sent to the server. Pages are queued.`;
    render();
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
      <div class="fblf-head"><b>FB Lead Finder</b><button class="fblf-min" title="Minimize">–</button></div>
      <div class="fblf-body">
        <div class="fblf-row"><span>Ads captured</span><b data-k="ads">0</b></div>
        <div class="fblf-row"><span>Unique pages</span><b data-k="pages">0</b></div>
        <div class="fblf-cond">
          <div class="fblf-cond-top">
            <span>Condition: at least</span>
            <input class="fblf-min-input" type="number" min="1" max="999" value="1" aria-label="Minimum ads per page" />
            <span>ads</span>
          </div>
          <div class="fblf-chips">
            <button data-n="1">All</button><button data-n="2">2+</button><button data-n="3">3+</button><button data-n="5">5+</button><button data-n="10">10+</button>
          </div>
          <div class="fblf-match" data-k="match"></div>
        </div>
        <div class="fblf-row fblf-hint" data-k="hint"></div>
        <div class="fblf-status" data-k="status"></div>
        <div class="fblf-actions">
          <button class="fblf-start">Collect this search</button>
          <button class="fblf-stop">Stop</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.fblf-min').onclick = () => panel.classList.toggle('fblf-collapsed');
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
    panel.querySelector('[data-k="ads"]').textContent = job ? `${sent.size} / ${list.length}` : list.length;
    panel.querySelector('[data-k="pages"]').textContent = m.totalPages;
    const input = panel.querySelector('.fblf-min-input');
    if (document.activeElement !== input) input.value = minAds;
    input.disabled = running;
    panel.querySelectorAll('.fblf-chips button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.n) === minAds);
      b.disabled = running;
    });
    panel.querySelector('[data-k="match"]').innerHTML =
      minAds > 1
        ? `Matching: <b>${m.pages} pages</b> <small>(${m.ads.length} ads) · of ${m.totalPages}</small>`
        : `All <b>${m.totalPages} pages</b> will be collected`;
    panel.querySelector('[data-k="hint"]').textContent = resultsHint;
    panel.querySelector('[data-k="status"]').textContent = statusText || (job ? '' : 'Search, then press "Collect"');
    panel.querySelector('.fblf-start').disabled = running;
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
    if (r && r.job) {
      statusText = `Job: "${r.job.keyword}" — starting auto collect…`;
      render();
      setTimeout(() => start(r.job), 4000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
