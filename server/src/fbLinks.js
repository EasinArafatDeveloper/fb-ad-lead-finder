// Pasted Facebook links → the Pages they point to (Paste links, linkImport.js).
//
// A Page is known either by its number (the id the Ad Library uses — pageId "123…") or, when the link only has
// its username, by "@username" until it is read. Every way people copy a link is understood:
//   facebook.com/ShopName · m./web./mbasic. · fb.com · profile.php?id=123 · /p/Shop-Name-123/ · /people/Name/123/
//   /pages/Name/123 · /Shop-Name-123/ · /ShopName/posts/… (the Page part) · a bare username or number
// Links that are not a Page (groups, events, share/short links, Marketplace …) are refused with the reason.

const HOSTS = /^(?:(?:www|m|web|mbasic|touch|free|mobile|business|beta)\.)?(?:facebook|fb)\.com$/i;
const SHORT = /^(?:fb\.me|on\.fb\.me|l\.facebook\.com|lm\.facebook\.com|fb\.watch)$/i;
// first path parts that are never a Page
const NOT_A_PAGE = {
  groups: 'a group link — only Pages can be read', events: 'an event link', share: 'a share link — open it and copy the Page link instead',
  watch: 'a video link', reel: 'a reel link', reels: 'a reel link', stories: 'a story link', 'story.php': 'a story link', marketplace: 'a Marketplace link',
  gaming: 'a gaming link', hashtag: 'a hashtag link', search: 'a search link', ads: 'an Ad Library link — use New search for keywords',
  login: 'a login link', 'login.php': 'a login link', help: 'a help link', messages: 'a messages link', friends: 'a friends link',
  notifications: 'a notifications link', 'home.php': 'the home page', 'l.php': 'a redirect link', 'sharer.php': 'a share link', sharer: 'a share link',
  'dialog': 'a share link', business: 'a Business Suite link', latest: 'a Business Suite link', media: 'a photo album link', photo: 'a photo link',
  'photo.php': 'a photo link', photos: 'a photo link', video: 'a video link', videos: 'a video link', 'video.php': 'a video link', notes: 'a note link',
  'permalink.php': 'a post link without the Page', 'groups.php': 'a group link', 'policies': 'a Facebook help link', privacy: 'a Facebook help link',
  bookmarks: 'a bookmarks link', settings: 'a settings link', 'profile': 'a profile link without an id', me: 'a link to your own profile',
};

const isId = (s) => /^\d{5,20}$/.test(String(s || ''));
/** "Shop-Name-100064123456789" → the number at its end (new-style Page links carry the id there). */
const trailingId = (s) => (String(s || '').match(/(?:^|-)(\d{8,20})\/?$/) || [])[1] || '';
const USERNAME = /^[a-z0-9][a-z0-9.\-_]{1,79}$/i;

const byId = (id) => ({ pageId: String(id), pageUrl: '' });
const byName = (name) => {
  const u = String(name).replace(/\/+$/, '').toLowerCase();
  return { pageId: `@${u}`, pageUrl: `https://www.facebook.com/${u}/`, username: u };
};

/** One pasted line → { pageId, pageUrl } or { error }. */
export function parseFbLink(input) {
  let s = String(input || '').trim().replace(/^[<"'([]+|[>"')\],;]+$/g, '').trim();
  if (!s) return { error: 'empty' };
  if (isId(s)) return byId(s);
  // a bare username (no dot-com, no slash) — one word: a Page name with spaces is not a link
  if (!/[/:]/.test(s) && !/\.(com|me|net)\b/i.test(s)) {
    if (/\s/.test(s)) return { error: 'not a link (a name, not a Facebook link)' };
    s = s.replace(/^@/, '');
    return USERNAME.test(s) && /[a-z]/i.test(s) ? byName(s) : { error: 'not a Facebook link' };
  }
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'not a valid link' };
  }
  const host = u.hostname.toLowerCase();
  if (SHORT.test(host)) return { error: 'a short/redirect link — open it and copy the Page link instead' };
  if (!HOSTS.test(host)) return { error: /instagram\.com$/i.test(host) ? 'an Instagram link — only Facebook Pages' : 'not a Facebook link' };
  const parts = u.pathname.split('/').map((p) => decodeURIComponentSafe(p)).filter(Boolean);
  const q = (k) => u.searchParams.get(k) || '';
  // any link that names the Page by ?id= (profile.php, permalink.php?story_fbid=…&id=…)
  if (isId(q('id')) && (!parts.length || /\.php$/i.test(parts[0]))) return byId(q('id'));
  if (!parts.length) return { error: 'a link to Facebook itself, not a Page' };
  const first = parts[0].toLowerCase();
  if (first === 'profile.php') return { error: 'a profile link without an id' };
  if (first === 'p' && parts[1]) return trailingId(parts[1]) ? byId(trailingId(parts[1])) : { error: 'a Page link without its number' };
  if (first === 'people' || first === 'pages') {
    const id = [...parts].reverse().map((p) => (isId(p) ? p : trailingId(p))).find(Boolean);
    return id ? byId(id) : { error: 'a Page link without its number' };
  }
  if (NOT_A_PAGE[first]) return { error: NOT_A_PAGE[first] };
  if (isId(parts[0])) return byId(parts[0]);
  if (trailingId(parts[0]) && parts[0].includes('-')) return byId(trailingId(parts[0]));
  return USERNAME.test(parts[0]) && /[a-z]/i.test(parts[0]) ? byName(parts[0]) : { error: 'not a Page link' };
}

function decodeURIComponentSafe(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Many pasted links (text with one per line, or commas/spaces between them) → unique Pages + what was wrong.
 * { pages: [{ pageId, pageUrl, input }], invalid: [{ input, reason }], duplicates, total }
 */
// a link somewhere in a line ("Shop Name - https://facebook.com/shop" or several links on one line)
const URL_IN_TEXT = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:facebook|fb)\.(?:com|me)\/[^\s,;"'<>()]*/gi;

/** A pasted text → one entry per link: the links found in each line, else the line's comma-separated words. */
export function splitLinks(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const urls = line.match(URL_IN_TEXT);
    if (urls) out.push(...urls);
    else out.push(...line.split(/[,;]/));
  }
  return out.map((l) => l.trim()).filter(Boolean);
}

export function parseLinks(textOrList, max = Infinity) {
  const lines = (Array.isArray(textOrList) ? textOrList.flatMap(splitLinks) : splitLinks(textOrList)).slice(0, 5000);
  const seen = new Set();
  const pages = [];
  const invalid = [];
  let duplicates = 0;
  for (const input of lines) {
    const r = parseFbLink(input);
    if (r.error) {
      invalid.push({ input: input.slice(0, 200), reason: r.error });
      continue;
    }
    if (seen.has(r.pageId)) {
      duplicates++;
      continue;
    }
    seen.add(r.pageId);
    if (pages.length < max) pages.push({ ...r, input: input.slice(0, 300) });
  }
  return { pages, invalid, duplicates, total: lines.length, tooMany: Math.max(0, seen.size - max) };
}
