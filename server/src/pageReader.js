// Reads a Facebook Page on the server — no Chrome — through one proxy IP of the pool.
// The logged-out Page HTML already carries the Intro card ("profile_tile_items": category, address, phone,
// WhatsApp, email, websites, hours, rating) as JSON, so one request of ~200 KB is enough. The result has the
// same shape as the extension's, so leads.js/applyResult handles both.
import { ProxyAgent, fetch } from 'undici';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
// without the browser's navigation headers Facebook answers 400 or sends the visitor to the login page
const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

const agents = new Map();
function agentFor(p) {
  const key = `${p.host}:${p.port}:${p.user}:${p.pass}`;
  if (!agents.has(key)) {
    if (agents.size > 600) agents.clear();
    agents.set(
      key,
      new ProxyAgent({
        uri: `http://${p.host}:${p.port}`,
        token: p.user ? `Basic ${Buffer.from(`${p.user}:${p.pass}`).toString('base64')}` : undefined,
        connect: { timeout: 15000 },
      }),
    );
  }
  return agents.get(key);
}

const isLoginUrl = (u) => /\/(login|checkpoint)(\/|\.php|$|\?)/.test(new URL(u).pathname);

// Each IP keeps its Facebook cookies (datr …) like a real browser would: a returning visitor, not a brand-new
// one on every page — strangers without cookies hit the login wall much sooner.
const jars = new Map();
function jarFor(proxy) {
  if (!jars.has(proxy.id)) jars.set(proxy.id, new Map());
  return jars.get(proxy.id);
}
function keepCookies(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = c.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || value === 'deleted' || !value;
    if (expired) jar.delete(name);
    else if (jar.size < 30 || jar.has(name)) jar.set(name, value);
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** GET the page through the proxy, following up to 4 redirects ourselves (a redirect to /login = wall). */
async function getHtml(url, proxy) {
  let u = url;
  const jar = jarFor(proxy);
  for (let hop = 0; hop < 5; hop++) {
    const headers = jar.size ? { ...HEADERS, cookie: cookieHeader(jar) } : HEADERS;
    const r = await fetch(u, { dispatcher: agentFor(proxy), headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    keepCookies(jar, r);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel();
      if (!loc) return { status: r.status, url: u, html: '' };
      u = new URL(loc, u).href;
      if (isLoginUrl(u)) return { login: true, url: u };
      continue;
    }
    return { status: r.status, url: u, html: await r.text() };
  }
  return { status: 0, url: u, html: '' };
}

// ---------------- the Intro card out of the page's JSON ----------------
/** Every renderer under a "timeline_context_item" in the page's embedded JSON. */
function introItems(html) {
  const items = [];
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 120) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    const r = o.timeline_context_item?.renderer;
    if (r && r.__typename) {
      const key = JSON.stringify(r).slice(0, 400);
      if (!seen.has(key)) {
        seen.add(key);
        items.push(r);
      }
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!m[1].includes('timeline_context_item')) continue;
    try {
      walk(JSON.parse(m[1]), 0);
    } catch {
      /* not JSON */
    }
  }
  return items;
}

/** The first string under `key` inside an object (depth-first). */
function deep(o, test, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 12) return undefined;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && test(k, v)) return v;
  }
  for (const v of Object.values(o)) {
    const x = typeof v === 'object' ? deep(v, test, depth + 1) : undefined;
    if (x !== undefined) return x;
  }
  return undefined;
}
const itemText = (r) => r.context_item?.title?.text ?? deep(r, (k) => k === 'text');
const itemLinks = (r) => {
  const out = [];
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 12) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^(url|uri|wa_link)$/.test(k) && /^https?:\/\//.test(v) && !/fbcdn\.net\/rsrc|static\.xx\.fbcdn/.test(v)) out.push(v);
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(r, 0);
  return out;
};

const PHONE = /^\+?[\d\s\-().]{7,22}$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const metaContent = (html, prop) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`))?.[1] || '';
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const jsonText = (html, re) => {
  const m = html.match(re);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return '';
  }
};

/** Turn the page HTML into the same result object the extension sends. */
export function parsePageHtml(html, finalUrl) {
  const items = introItems(html);
  const lines = ['Intro'];
  const links = [];
  const phones = [];
  const emails = [];
  const whatsapp = [];
  let address = '';
  let category = '';
  for (const r of items) {
    const t = String(itemText(r) || '').trim();
    const type = r.__typename;
    for (const l of itemLinks(r)) links.push(l);
    if (type === 'WhatsappNumberIntroCardItemRenderer') {
      const wa = itemLinks(r).map((l) => new URL(l).searchParams.get('phone')).find(Boolean);
      if (wa) whatsapp.push(wa);
      continue; // its text is the next item's (Facebook reuses the title) — not a value of its own
    }
    if (!t) continue;
    if (type === 'InfluencerCategoryContextItemRenderer') category = t.replace(/^Page\s*[·•]\s*/, '');
    if (type === 'AddressContextItemRenderer' && !PHONE.test(t)) address = t;
    if (PHONE.test(t)) phones.push(t);
    emails.push(...(t.match(EMAIL) || []));
    lines.push(t);
  }
  const bio = jsonText(html, /"best_description":\{"text":"((?:[^"\\]|\\.)*)"/);
  const followers = html.match(/"text":"([\d.,]+\s*[KkMm]?) followers"/)?.[1] || '';
  const likes = html.match(/"text":"([\d.,]+\s*[KkMm]?) likes"/)?.[1] || '';
  const text = lines.join('\n');
  return {
    finalUrl,
    pageName: decodeEntities(metaContent(html, 'og:title')),
    pageCategory: category,
    pageBio: bio,
    followers,
    likes,
    address,
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
    whatsapp: [...new Set(whatsapp)],
    links: [...new Set(links)].slice(0, 80),
    sections: { Page: text },
    fullText: text,
    via: 'server',
    introItems: items.length,
  };
}

/**
 * What Facebook's answer means — one of five kinds (docs/ENGINE.md §3). Pure: no network, easy to test.
 *   ok          a Page: `result` is the extension-style result (no Intro card = no public contact, still ok)
 *   unavailable "This content isn't available" / 404 — a browser sees the same; `result` marks it done
 *   wall        Facebook wants a login from this IP
 *   neterror    the page never arrived (proxy, network, 407, 5xx)
 *   unknown     an answer we don't recognise (maybe Facebook changed its pages)
 */
export function classify({ status = 0, url = '', html = '', login = false, error = '' }) {
  if (error) return { kind: 'neterror', detail: error };
  if (login) return { kind: 'wall', detail: 'redirect to login' };
  if (status === 407) return { kind: 'neterror', detail: 'proxy login refused (407)' };
  if (status === 0 || status >= 500) return { kind: 'neterror', detail: `HTTP ${status}` };
  // a real Page always carries its profile header; without it Facebook sent something else
  const isProfile = html.includes('ProfileCometHeaderQuery') || html.includes('profile_tile_items');
  if (status === 404 || (!isProfile && html.includes('CometErrorRoot'))) {
    return { kind: 'unavailable', result: { notFound: true, finalUrl: url, via: 'server' } };
  }
  if (!isProfile && /id="login_form"/.test(html)) return { kind: 'wall', detail: 'login form' };
  if (!isProfile) return { kind: 'unknown', detail: `HTTP ${status}, ${html.length} bytes, no profile` };
  return { kind: 'ok', result: parsePageHtml(html, url) };
}

/** Read one page through one proxy IP → { kind, result?, detail? } (see classify). Never throws. */
export async function readPage(url, proxy) {
  let res;
  try {
    res = await getHtml(url, proxy);
  } catch (e) {
    // an AbortSignal timeout is a DOMException whose code is the number 23 — say what it means
    const error = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError' ? 'timeout — no answer within 30 s' : e.cause?.code || e.code || e.message || e;
    return classify({ error: String(error).slice(0, 100) });
  }
  const out = classify(res);
  if (out.kind === 'wall') jars.delete(proxy.id); // after its rest this IP starts over as a fresh visitor
  return out;
}
