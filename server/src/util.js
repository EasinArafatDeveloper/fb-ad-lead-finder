export const uniq = (arr) => [...new Set((arr || []).filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

/** "12K" / "1.2M" / "3,456" -> number */
export function parseCount(s) {
  if (s == null || s === '') return 0;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = /k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1;
  return Math.round(n * mult);
}

// ---------- phones ----------
export const BD_PHONE_RE = /(?<!\d)(?:\+?88[\s-]?)?01[3-9]\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g;

export function normPhone(p) {
  const raw = String(p || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^01[3-9]\d{8}$/.test(digits)) return '+88' + digits;
  if (/^8801[3-9]\d{8}$/.test(digits)) return '+' + digits;
  return raw.startsWith('+') ? '+' + digits : digits;
}

export function uniqPhones(list) {
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const n = normPhone(p);
    const digits = n.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    const key = digits.slice(-10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

// ---------- emails ----------
export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;

export function cleanEmails(list) {
  return uniq(
    (list || []).map((e) => String(e).toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '')),
  ).filter(
    (e) =>
      /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e) && // must really be an email
      !/\.(png|jpe?g|gif|webp|svg|css|js|ico)$/.test(e) &&
      !/(example\.|sentry|wixpress|domain\.com|email\.com|yourmail|youremail|@2x|@3x|u003e)/.test(e),
  );
}

// ---------- links ----------
const SOCIAL_HOST = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|messenger\.com|m\.me|instagram\.com|whatsapp\.com|wa\.me|meta\.com|fbcdn\.net|fbsbx\.com)$/i;

/** Classify a URL: website / whatsapp number / instagram profile. Unwraps l.facebook.com redirects. */
export function analyzeLink(url) {
  const out = {};
  if (!url) return out;
  let u;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)l\.facebook\.com$/.test(host) || (host.endsWith('facebook.com') && u.pathname === '/l.php')) {
    const inner = u.searchParams.get('u');
    return inner ? analyzeLink(inner) : out;
  }
  if (host === 'wa.me' || host.endsWith('.wa.me')) {
    const num = u.pathname.replace(/\D/g, '');
    if (num) out.whatsapp = num;
    return out;
  }
  if (host.endsWith('whatsapp.com')) {
    const num = (u.searchParams.get('phone') || '').replace(/\D/g, '');
    if (num) out.whatsapp = num;
    return out;
  }
  const hostPath = host + u.pathname;
  if (/(^|\.)bing\.com\/maps|(^|\.)google\.[a-z.]+\/maps|^maps\.google\.|^maps\.app\.goo\.gl|^goo\.gl\/maps/.test(hostPath)) {
    out.map = url;
    return out;
  }
  if (/(^|\.)(tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|linkedin\.com|pinterest\.com|threads\.net|t\.me|telegram\.me)$/.test(host)) {
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname); // "%40Channel" → "@Channel"
    } catch {
      /* keep as is */
    }
    out.social = `${u.protocol}//${host}${pathname.replace(/\/+$/, '')}`;
    return out;
  }
  if (host.endsWith('instagram.com')) {
    const handle = u.pathname.split('/').filter(Boolean)[0];
    if (handle && !['p', 'reel', 'explore', 'stories'].includes(handle)) out.instagram = `https://www.instagram.com/${handle}/`;
    return out;
  }
  if (SOCIAL_HOST.test(host)) return out;
  if (u.protocol === 'http:' || u.protocol === 'https:') out.website = `${u.protocol}//${host}`;
  return out;
}

// ---------- facebook urls ----------
export const pageLink = (l) =>
  l.pageUrl || (/^\d+$/.test(l.pageId) ? `https://www.facebook.com/${l.pageId}` : '');

export const pageAdsLink = (pageId) =>
  /^\d+$/.test(pageId)
    ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=${pageId}&search_type=page&media_type=all`
    : '';

export const adLink = (adId) => `https://www.facebook.com/ads/library/?id=${adId}`;

export const adLibraryUrl = (keyword, country) =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(
    country || 'ALL',
  )}&is_targeted_country=false&media_type=all&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`;

export function mainUrl(lead) {
  const u = (lead.pageUrl || '').replace(/[#].*$/, '');
  if (/profile\.php/.test(u)) return `https://www.facebook.com/profile.php?id=${new URL(u).searchParams.get('id') || lead.pageId}`;
  if (u) return u.replace(/\?.*$/, '');
  return /^\d+$/.test(lead.pageId) ? `https://www.facebook.com/${lead.pageId}` : '';
}

export function aboutUrl(lead) {
  const u = (lead.pageUrl || '').replace(/[#].*$/, '');
  if (/profile\.php/.test(u)) {
    const id = new URL(u).searchParams.get('id') || lead.pageId;
    return `https://www.facebook.com/profile.php?id=${id}&sk=about`;
  }
  if (u) return u.replace(/\?.*$/, '').replace(/\/+$/, '') + '/about';
  return `https://www.facebook.com/${lead.pageId}/about`;
}
