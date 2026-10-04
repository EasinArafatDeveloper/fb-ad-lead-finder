import { BD_PHONE_RE, EMAIL_RE, cleanEmails, uniqPhones } from './util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    if (!r.ok) return '';
    const type = r.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text')) return '';
    return (await r.text()).slice(0, 2_000_000);
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
    return { emails: [], phones: [] };
  }
  const paths = ['/', '/contact', '/contact-us', '/pages/contact', '/about'];
  let emails = [];
  let phones = [];
  for (const p of paths) {
    const html = await fetchText(new URL(p, base.origin).href);
    if (!html) continue;
    emails.push(...(html.match(EMAIL_RE) || []));
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) phones.push(decodeURIComponent(m[1]));
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    phones.push(...(text.match(BD_PHONE_RE) || []));
    emails = cleanEmails(emails);
    if (emails.length) break;
  }
  return { emails: cleanEmails(emails), phones: uniqPhones(phones).slice(0, 5) };
}
