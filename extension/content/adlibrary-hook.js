// Runs in the Ad Library page's own (MAIN) world at document_start.
// Captures ad data from Facebook's GraphQL responses + the JSON embedded in the initial HTML,
// and hands it to the isolated content script (adlibrary.js) via window.postMessage.
(() => {
  if (window.__fblfHooked) return;
  window.__fblfHooked = true;

  const ads = new Map();
  let batch = [];

  const currentQ = () => (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
  const txt = (v) => (typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : '') || '';
  const isTemplate = (s) => /\{\{[^}]+\}\}/.test(s);

  function normalize(n) {
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
      ctaType: s.cta_type || card.cta_type || '', // WHATSAPP_MESSAGE, MESSAGE_PAGE, CALL_NOW, SHOP_NOW …
      format: s.display_format || '', // VIDEO, IMAGE, CAROUSEL, MULTI_IMAGES, DPA …
      caption: s.caption || '',
      startDate: n.start_date ? new Date(n.start_date * 1000).toISOString().slice(0, 10) : '',
      platforms: n.publisher_platform || [],
      versions: n.collation_count || 1,
      searchQ: currentQ(),
    };
  }

  function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 80) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    if (o.ad_archive_id && (o.page_id || o.snapshot)) {
      const id = String(o.ad_archive_id);
      if (!ads.has(id)) {
        try {
          const ad = normalize(o);
          if (ad.pageId) {
            ads.set(id, ad);
            batch.push(ad);
          }
        } catch {
          /* ignore malformed node */
        }
      }
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  }

  function flush() {
    if (!batch.length) return;
    const out = batch;
    batch = [];
    window.postMessage({ __fblf: true, type: 'ads', ads: out }, '*');
  }

  function parseText(text) {
    if (!text || typeof text !== 'string' || text.indexOf('ad_archive_id') === -1) return;
    const clean = text.replace(/^for \(;;\);/, '');
    try {
      const j = JSON.parse(clean);
      walk(j, 0);
      if (clean.includes('search_results_connection')) takeCursor(j);
    } catch {
      for (const line of clean.split('\n')) {
        if (line.indexOf('ad_archive_id') === -1) continue;
        try {
          const j = JSON.parse(line);
          walk(j, 0);
          if (line.includes('search_results_connection')) takeCursor(j);
        } catch {
          /* not JSON */
        }
      }
    }
    flush();
  }

  // --- XHR hook ---
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fblfUrl = String(url || '');
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__fblfUrl && this.__fblfUrl.includes('graphql')) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') parseText(this.responseText);
        } catch {
          /* ignore */
        }
      });
    }
    return XS.apply(this, arguments);
  };

  // --- fetch hook ---
  const F = window.fetch;
  window.fetch = function (input) {
    const p = F.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (String(url).includes('graphql')) p.then((r) => r.clone().text()).then(parseText).catch(() => {});
    } catch {
      /* ignore */
    }
    return p;
  };

  // --- ads embedded in the initial HTML ---
  function scanScripts() {
    document.querySelectorAll('script[type="application/json"]').forEach((s) => {
      if (s.__fblf) return;
      s.__fblf = 1;
      parseText(s.textContent);
    });
  }
  document.addEventListener('DOMContentLoaded', scanScripts);
  setInterval(scanScripts, 4000);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__fblf || e.data.type !== 'replay') return;
    scanScripts();
    window.postMessage({ __fblf: true, type: 'ads', ads: [...ads.values()] }, '*');
  });

  // ---------------- the pager: the next ads WITHOUT scrolling ----------------
  // Scrolling only loads more ads while the tab is visible. Instead we ask Facebook for the next page the same
  // way the page itself does (its own AdLibrarySearchPaginationQuery, its own token) — that works in a tab in the
  // background too. Everything is read from the page at run time (query id, variable names, token, cursor), so a
  // Facebook update doesn't break it; if anything is missing, the collector falls back to scrolling.
  const pager = { cursor: null, hasNext: true, q: null, vars: null };

  /** The newest "next page" cursor in a response (Facebook's own scrolling keeps it up to date too). */
  function takeCursor(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 40) return;
    const c = o.search_results_connection;
    if (c && c.page_info && 'end_cursor' in c.page_info) {
      pager.cursor = c.page_info.end_cursor;
      pager.hasNext = !!c.page_info.has_next_page;
      return;
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') takeCursor(o[k], depth + 1);
  }
  const eachJson = (text, fn) => {
    const clean = String(text || '').replace(/^for \(;;\);/, '');
    try {
      fn(JSON.parse(clean));
    } catch {
      for (const line of clean.split('\n')) {
        try {
          fn(JSON.parse(line));
        } catch {
          /* not JSON */
        }
      }
    }
  };

  function pageScripts() {
    return [...document.querySelectorAll('script[type="application/json"]')].map((s) => s.textContent).join('\n');
  }
  /** The whole JSON object that starts at `start` (a "{"), nested objects and strings included. */
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
  /**
   * The search's own variables. They hold nested objects once a sort or a date filter is on
   * ("sortData":{…}, "startDate":{…}) — and Facebook now adds the sort to every link by itself — so they are
   * read as a whole object, not with a flat pattern (that found nothing → "no cursor" → scrolling only).
   */
  function searchVars(all) {
    let i = 0;
    while ((i = all.indexOf('"variables":{', i)) !== -1) {
      const o = objectAt(all, i + 12);
      i += 12;
      if (!o || !o.includes('"queryString"')) continue;
      try {
        return JSON.parse(o);
      } catch {
        /* not this one */
      }
    }
    return null;
  }

  /** What the page's own first search used — only if it is the search in the address bar. */
  function setupPager() {
    const all = pageScripts();
    const vars = searchVars(all);
    if (!vars || String(vars.queryString || '').trim().toLowerCase() !== currentQ()) return false;
    if (pager.q !== currentQ()) {
      pager.q = currentQ();
      pager.vars = vars;
      const pm = all.match(/"search_results_connection":\{"count":\d+[^]*?"page_info":\{"end_cursor":("[^"]*"|null),"has_next_page":(true|false)/);
      if (pm) {
        pager.cursor = JSON.parse(pm[1]);
        pager.hasNext = pm[2] === 'true';
      }
    }
    return !!pager.cursor || !pager.hasNext;
  }

  async function nextPage() {
    if (!setupPager()) return { ok: false, error: 'no cursor on this page' };
    if (!pager.hasNext) return { ok: true, hasNext: false, count: 0 };
    const all = pageScripts();
    const lsd = (all.match(/\["LSD",\[\],\{"token":"([^"]+)"/) || [])[1];
    const req = window.require;
    if (!lsd || typeof req !== 'function') return { ok: false, error: 'no token' };
    let docId;
    let names;
    try {
      docId = req('AdLibrarySearchPaginationQuery_facebookRelayOperation');
      names = req('AdLibrarySearchPaginationQuery.graphql').fragment.argumentDefinitions.map((a) => a.name);
    } catch {
      return { ok: false, error: 'query not found' };
    }
    const v = {};
    for (const k of names) v[k] = pager.vars[k] ?? null;
    // the page's own variables are lower-case in the URL style; the query wants its enum style
    Object.assign(v, {
      cursor: pager.cursor,
      first: 30,
      activeStatus: String(pager.vars.activeStatus || 'active').toUpperCase(),
      adType: String(pager.vars.adType || 'all').toUpperCase(),
      mediaType: String(pager.vars.mediaType || 'all').toUpperCase(),
      searchType: String(pager.vars.searchType || 'keyword_unordered').toUpperCase(),
      isTargetedCountry: !!pager.vars.isTargetedCountry,
    });
    // Always asked as a logged-out visitor, without this Chrome's cookies: the many page requests can never be
    // held against the person's own Facebook account (asking as the account got one account limited for hours).
    const body = new URLSearchParams({
      av: '0', __user: '0', __a: '1', lsd,
      fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: 'AdLibrarySearchPaginationQuery',
      variables: JSON.stringify(v), server_timestamps: 'true', doc_id: String(docId),
    });
    const before = ads.size;
    const was = pager.cursor;
    const ask = (credentials) =>
      F.call(window, '/api/graphql/', {
        method: 'POST', body, credentials,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-lsd': lsd, 'x-fb-friendly-name': 'AdLibrarySearchPaginationQuery' },
      });
    const nextCursorIn = (t) => /"end_cursor":"/.test(t) || /"has_next_page":false/.test(t);
    let text;
    try {
      // without cookies first; if Facebook refuses that on this computer (never worked here yet), once with the
      // browser's cookies — still as a logged-out visitor (user 0), never as the person's account
      let r = await ask(pager.mode || 'omit');
      text = await r.text();
      if (!pager.mode && (!r.ok || !nextCursorIn(text))) {
        const r2 = await ask('include');
        const t2 = await r2.text();
        if (r2.ok && nextCursorIn(t2)) {
          pager.mode = 'include';
          r = r2;
          text = t2;
        }
      } else if (!pager.mode && r.ok) pager.mode = 'omit';
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 };
    } catch (e) {
      return { ok: false, error: String(e.message || e), retry: true };
    }
    parseText(text); // the ads → the collector, like every other response
    eachJson(text, (j) => takeCursor(j));
    const got = ads.size - before;
    if (pager.cursor === was && pager.hasNext) {
      // no new cursor: an error answer (rate limit, checkpoint …)
      const msg =
        (text.match(/"(?:message|errorSummary|error_summary|summary)":"([^"]{1,160})/) || [])[1] ||
        (text.match(/"error":(\d+)/) ? `Facebook error ${text.match(/"error":(\d+)/)[1]}` : '') ||
        (/<html/i.test(text) ? 'Facebook sent a web page instead of ads (login or checkpoint)' : 'no next page in the answer');
      return { ok: false, error: msg, retry: true };
    }
    return { ok: true, hasNext: pager.hasNext, count: got };
  }

  // the collector (adlibrary.js) asks for one page at a time
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || !e.data.__fblf || e.data.type !== 'page-next') return;
    let out;
    try {
      out = await nextPage();
    } catch (err) {
      out = { ok: false, error: String(err.message || err) };
    }
    window.postMessage({ __fblf: true, type: 'page-result', id: e.data.id, ...out }, '*');
  });
})();
