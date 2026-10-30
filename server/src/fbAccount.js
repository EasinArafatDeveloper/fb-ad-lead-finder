// The team's own Facebook account, used ONLY for reading comments of posts / videos / reels
// (Facebook hides comments from logged-out visitors). The session cookies are stored server-side
// (settings doc `_id: 'fbAccount'`), never sent to the browser, and every request goes out from this
// server's own home connection — never through the proxy pool, so the account always sees one stable IP.
import { fetch } from 'undici';
import { col, httpError, log } from './db.js';

const DOC_ID = 'fbAccount';
export const FB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const FB_DOC_HEADERS = {
  'user-agent': FB_UA,
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

const KEEP = ['c_user', 'xs', 'datr', 'fr', 'sb', 'wd', 'presence', 'ps_l', 'ps_n', 'locale', 'dpr'];

/** Accepts "c_user=1; xs=2; …" or the JSON array exported by a cookie extension (Cookie-Editor / EditThisCookie). */
export function parseCookieInput(raw) {
  const text = String(raw || '').trim();
  const jar = new Map();
  if (!text) return jar;
  if (text.startsWith('[') || text.startsWith('{')) {
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      throw httpError(400, 'The cookie JSON could not be read — paste it exactly as exported');
    }
    if (!Array.isArray(arr)) arr = arr.cookies || [];
    for (const c of arr) if (c?.name && c.value != null && (!c.domain || /facebook\.com$/.test(String(c.domain).replace(/^\./, '')))) jar.set(String(c.name), String(c.value));
  } else {
    for (const part of text.replace(/^cookie:\s*/i, '').split(/;\s*|\n/)) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  for (const k of [...jar.keys()]) if (!KEEP.includes(k)) jar.delete(k);
  return jar;
}

export const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

export function keepCookies(jar, res) {
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

async function doc() {
  return (await col('settings').findOne({ _id: DOC_ID })) || null;
}

/** What the admin page may see — never the cookies themselves. */
export async function fbAccountPublic() {
  const d = await doc();
  if (!d?.cookies) return { connected: false };
  return {
    connected: true,
    userId: d.userId || null,
    name: d.name || '',
    status: d.status || 'unknown', // ok | logged_out | checkpoint | error
    statusNote: d.statusNote || '',
    checkedAt: d.checkedAt || null,
    savedAt: d.savedAt || null,
    lastUsedAt: d.lastUsedAt || null,
  };
}

/** Open facebook.com with the account's cookies and read who is logged in + the tokens GraphQL needs. */
export async function openFbSession(url = 'https://www.facebook.com/') {
  const d = await doc();
  if (!d?.cookies) throw httpError(400, 'No Facebook account connected — Settings → Proxy → Facebook account');
  const jar = new Map(Object.entries(d.cookies));
  let u = url;
  let html = '';
  let status = 0;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(u, { headers: { ...FB_DOC_HEADERS, cookie: cookieHeader(jar) }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    keepCookies(jar, r);
    status = r.status;
    if (status >= 300 && status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel();
      if (!loc) break;
      u = new URL(loc, u).href;
      continue;
    }
    html = await r.text();
    break;
  }
  const path = new URL(u).pathname;
  const userId = (html.match(/"USER_ID":"(\d+)"/) || [])[1] || (html.match(/"actorID":"(\d+)"/) || [])[1] || null;
  const name = (html.match(/"NAME":"([^"]+)"/) || [])[1] || (html.match(/"SHORT_NAME":"([^"]+)"/) || [])[1] || '';
  const dtsg = (html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || [])[1] || (html.match(/"dtsg":\{"token":"([^"]+)"/) || [])[1] || '';
  const lsd = (html.match(/\["LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || '';
  let state = 'ok';
  let note = '';
  if (/\/checkpoint/.test(path) || /checkpoint/.test(u)) {
    state = 'checkpoint';
    note = 'Facebook asks this account to confirm something (checkpoint). Log in to it in a normal browser, finish the check, then paste fresh cookies.';
  } else if (!userId || userId === '0' || /\/login/.test(path)) {
    state = 'logged_out';
    note = 'The cookies no longer log in (expired or logged out). Paste fresh cookies.';
  }
  // persist refreshed cookies so the session keeps living like a normal browser
  await col('settings').updateOne(
    { _id: DOC_ID },
    { $set: { cookies: Object.fromEntries(jar), status: state, statusNote: note, checkedAt: new Date(), ...(userId && state === 'ok' ? { userId, name: decodeJsonStr(name) } : {}) } },
  );
  return { jar, html, url: u, status, state, note, userId, name: decodeJsonStr(name), dtsg, lsd };
}

function decodeJsonStr(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

export async function saveFbCookies(raw) {
  const jar = parseCookieInput(raw);
  if (!jar.get('c_user') || !jar.get('xs')) throw httpError(400, 'The cookies must contain at least c_user and xs (copy them while logged in to the account)');
  await col('settings').updateOne(
    { _id: DOC_ID },
    { $set: { cookies: Object.fromEntries(jar), savedAt: new Date(), status: 'unknown', statusNote: '', userId: jar.get('c_user'), name: '' } },
    { upsert: true },
  );
  const s = await openFbSession();
  await log(s.state === 'ok' ? 'info' : 'warn', `Facebook account for comments: ${s.state === 'ok' ? `connected as ${s.name || s.userId}` : s.note}`);
  return fbAccountPublic();
}

export async function removeFbAccount() {
  await col('settings').deleteOne({ _id: DOC_ID });
  return { connected: false };
}

export async function markFbUsed() {
  await col('settings').updateOne({ _id: DOC_ID }, { $set: { lastUsedAt: new Date() } });
}
