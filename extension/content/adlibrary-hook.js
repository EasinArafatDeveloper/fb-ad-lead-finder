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
      walk(JSON.parse(clean), 0);
    } catch {
      for (const line of clean.split('\n')) {
        if (line.indexOf('ad_archive_id') === -1) continue;
        try {
          walk(JSON.parse(line), 0);
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
})();
