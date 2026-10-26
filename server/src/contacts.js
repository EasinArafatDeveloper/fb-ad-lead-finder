import dns from 'node:dns/promises';
import dnsCb from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { BD_PHONE_RE, EMAIL_RE, cleanEmails, uniqPhones } from './util.js';
import { detectPlatform } from './adFacts.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------------- only fetch public internet addresses ----------------
// Website links come from scraped Facebook pages, i.e. from strangers. Without this check a page could point
// us at this server's own databases (mongodb, postgres), the router, or a cloud metadata address.
function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
}

async function publicUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try {
    addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return null;
  }
  return addrs.length && !addrs.some(isPrivateIp) ? u : null;
}

// The address is checked again at the moment of connecting: a hostile DNS server could answer the check above
// with a public IP and the real connection with an internal one ("DNS rebinding").
function safeLookup(hostname, options, cb) {
  dnsCb.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error(`${hostname} points to a private address`), { code: 'EBLOCKED' }));
    }
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
const publicOnly = new Agent({ connect: { lookup: safeLookup } });

async function fetchText(href, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url = href;
    // follow redirects ourselves so every hop is checked
    for (let hop = 0; hop < 5; hop++) {
      const u = await publicUrl(url);
      if (!u) return '';
      const r = await fetch(u, { signal: ctrl.signal, redirect: 'manual', headers: { 'user-agent': UA }, dispatcher: publicOnly });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return '';
        url = new URL(loc, u).href;
        continue;
      }
      if (!r.ok) return '';
      const type = r.headers.get('content-type') || '';
      if (!type.includes('html') && !type.includes('text')) return '';
      return (await r.text()).slice(0, 2_000_000);
    }
    return '';
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

/** Looks for email/phone on the website's home + contact pages (fallback when the FB page has no email). */
export async function websiteContacts(site) {
  let base;
  try {
    base = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`);
  } catch {
    return { emails: [], phones: [], platform: '' };
  }
  let platform = '';
  const paths = ['/', '/contact', '/contact-us', '/pages/contact', '/about'];
  let emails = [];
  const phones = [];
  for (const p of paths) {
    const html = await fetchText(new URL(p, base.origin).href);
    if (!html) continue;
    if (p === '/') platform = detectPlatform(html); // Shopify, WooCommerce … from the home page
    emails.push(...(html.match(EMAIL_RE) || []));
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      try {
        phones.push(decodeURIComponent(m[1]));
      } catch {
        phones.push(m[1]);
      }
    }
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    phones.push(...(text.match(BD_PHONE_RE) || []));
    emails = cleanEmails(emails);
    if (emails.length) break;
  }
  return { emails: cleanEmails(emails), phones: uniqPhones(phones).slice(0, 5), platform };
}

/** Only the platform the website runs on (one look at its home page). '' = the site did not answer. */
export async function websitePlatform(site) {
  let base;
  try {
    base = new URL(/^https?:\/\//.test(site) ? site : `https://${site}`);
  } catch {
    return '';
  }
  const html = await fetchText(base.origin + '/');
  return html ? detectPlatform(html) : '';
}
