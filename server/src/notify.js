// "Your search is ready": when a search has collected its ads AND every one of its pages has been read, the
// people of that workspace get an email and a push notification (phone / desktop) — so nobody has to watch
// the dashboard. Checked every 30 s (index.js); each search is announced once (jobs.notifiedAt).
//
// Email: SMTP set by an admin (Settings → Notifications), e.g. Gmail with an App Password.
// Push:  Web Push with this server's own VAPID keys (generated once, kept in settings `vapid`).
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { col, log } from './db.js';
import { accountOf } from './billing.js';
import { notifyWorkspace } from './inbox.js';

const SMTP_ID = 'smtp';
const VAPID_ID = 'vapid';
const SINCE_ID = 'notify';
export const DEFAULT_PREFS = { email: true, push: true, to: [] };
export const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
/** "a@x.com, b@y.com" or ['a@x.com'] → clean unique list (throws on a bad address). */
export function parseRecipients(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const bad = list.find((x) => !EMAIL_RE.test(x) || x.length > 200);
  if (bad) throw Object.assign(new Error(`"${bad.slice(0, 60)}" is not a valid email address`), { status: 400 });
  const uniq = [...new Set(list)];
  if (uniq.length > MAX_RECIPIENTS) throw Object.assign(new Error(`At most ${MAX_RECIPIENTS} email addresses`), { status: 400 });
  return uniq;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// ---------------- settings ----------------
export async function getSmtp() {
  const d = (await col('settings').findOne({ _id: SMTP_ID })) || {};
  return { host: d.host || '', port: Number(d.port) || 465, user: d.user || '', pass: d.pass || '', from: d.from || '', appUrl: d.appUrl || 'https://specter.monster' };
}
export const smtpReady = (s) => !!(s.host && s.user && s.pass);
/** For the dashboard: everything but the password. */
export const smtpPublic = (s) => ({ host: s.host, port: s.port, user: s.user, from: s.from, appUrl: s.appUrl, hasPass: !!s.pass });

export async function saveSmtp(b = {}) {
  const cur = await getSmtp();
  const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
  const next = {
    host: 'host' in b ? str(b.host) : cur.host,
    port: 'port' in b ? Math.min(65535, Math.max(1, Number(b.port) || 465)) : cur.port,
    user: 'user' in b ? str(b.user) : cur.user,
    // an empty password field keeps the saved one (the dashboard never gets it back)
    pass: b.pass ? str(b.pass, 300).replace(/\s+/g, '') : cur.pass,
    from: 'from' in b ? str(b.from) : cur.from,
    appUrl: 'appUrl' in b ? str(b.appUrl).replace(/\/+$/, '') || cur.appUrl : cur.appUrl,
  };
  await col('settings').updateOne({ _id: SMTP_ID }, { $set: next }, { upsert: true });
  return next;
}

/** This server's Web Push keys — made once. */
export async function vapidKeys() {
  let d = await col('settings').findOne({ _id: VAPID_ID });
  if (!d?.publicKey) {
    const k = webpush.generateVAPIDKeys();
    await col('settings').updateOne({ _id: VAPID_ID, publicKey: { $exists: false } }, { $set: k }, { upsert: true }).catch(() => {});
    d = await col('settings').findOne({ _id: VAPID_ID });
  }
  return { publicKey: d.publicKey, privateKey: d.privateKey };
}

export function prefsOf(u) {
  const p = { ...DEFAULT_PREFS, ...(u?.notify || {}) };
  // older saves kept one address as a string
  p.to = Array.isArray(p.to) ? p.to : p.to ? [p.to] : [];
  return p;
}
/** Where this user's emails go: their list, or their login email when the list is empty. */
const recipientsOf = (u) => {
  const p = prefsOf(u);
  return p.to.length ? p.to : [u.email];
};

// ---------------- sending ----------------
let transport = null;
let transportKey = '';
function mailer(s) {
  const key = `${s.host}|${s.port}|${s.user}|${s.pass}`;
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.port === 465, auth: { user: s.user, pass: s.pass }, connectionTimeout: 15000 });
    transportKey = key;
  }
  return transport;
}

export async function sendEmail(to, subject, html, text) {
  const s = await getSmtp();
  if (!smtpReady(s)) throw new Error('Email is not set up (Settings → Notifications)');
  await mailer(s).sendMail({ from: s.from || `FB Lead Finder <${s.user}>`, to, subject, html, text });
}

/** Push to every browser this user turned notifications on in. Dead subscriptions are removed. */
export async function sendPush(userId, payload) {
  const subs = await col('pushsubs').find({ userId }).toArray();
  if (!subs.length) return 0;
  const { publicKey, privateKey } = await vapidKeys();
  const s = await getSmtp();
  const opts = { vapidDetails: { subject: s.appUrl.startsWith('https://') ? s.appUrl : 'mailto:notifications@example.com', publicKey, privateKey }, TTL: 24 * 3600 };
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), opts);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await col('pushsubs').deleteOne({ _id: sub._id });
      else log('warn', `Push: ${e.statusCode || ''} ${e.message}`.trim());
    }
  }
  return sent;
}

// ---------------- the message ----------------
function message(items, appUrl) {
  const one = items.length === 1 ? items[0] : null;
  const total = items.reduce((a, x) => a + x.withContact, 0);
  // plain subject (no emoji) — new senders with emoji subjects land in spam more often
  const subject = one ? `Search ready: ${one.keyword} (${fmt(one.withContact)} leads with contact)` : `${items.length} searches ready (${fmt(total)} leads with contact)`;
  const url = (x) => `${appUrl}${x.projectId ? `/projects/${x.projectId}` : '/search'}`;
  const rows = items
    .map(
      (x) => `
      <tr><td style="padding:16px 20px;border-top:1px solid #eef2f7">
        <div style="font-size:16px;font-weight:700;color:#0f172a">${esc(x.keyword)} <span style="font-weight:500;color:#64748b;font-size:13px">· ${esc(x.country)}</span></div>
        <div style="margin-top:6px;font-size:14px;color:#334155">
          <b style="color:#047857">${fmt(x.withContact)}</b> with contact &nbsp;·&nbsp; 📞 ${fmt(x.phones)} &nbsp;·&nbsp; ✉ ${fmt(x.emails)} &nbsp;·&nbsp; ${fmt(x.pages)} pages from ${fmt(x.ads)} ads
        </div>
        <a href="${esc(url(x))}" style="display:inline-block;margin-top:12px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:9px 16px;border-radius:10px">Open the leads →</a>
      </td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <tr><td style="padding:22px 20px;background:linear-gradient(135deg,#4338ca,#2563eb);color:#fff">
        <div style="font-size:13px;opacity:.85">FB Lead Finder</div>
        <div style="font-size:21px;font-weight:800;margin-top:4px">${one ? 'Your search is ready' : `${items.length} searches are ready`}</div>
        <div style="font-size:14px;opacity:.9;margin-top:4px">Every page has been read — the leads are waiting in your dashboard.</div>
      </td></tr>
      ${rows}
      <tr><td style="padding:14px 20px;border-top:1px solid #eef2f7;font-size:12px;color:#94a3b8">You get this because email notifications are on — turn them off in Settings → Notifications.</td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = `${subject}\n\n${items.map((x) => `${x.keyword} (${x.country}): ${x.withContact} with contact — ${x.phones} phones, ${x.emails} emails, ${x.pages} pages. ${url(x)}`).join('\n')}`;
  const push = {
    title: one ? `✅ "${one.keyword}" is ready` : `✅ ${items.length} searches are ready`,
    body: one ? `${fmt(one.withContact)} leads with contact from ${fmt(one.pages)} pages` : `${fmt(total)} leads with contact — ${items.map((x) => x.keyword).join(', ')}`.slice(0, 180),
    url: one ? url(one) : `${appUrl}/search`,
    tag: one ? `search-${one.id}` : 'searches',
  };
  return { subject, html, text, push };
}

/** Tell the people of one workspace. Returns what went out. */
async function announce(workspaceId, items) {
  // alerts are a perk of the paid plans — a free account just sees the search done in the dashboard
  if (!(await accountOf(workspaceId)).perks.notifications) return { emails: 0, pushes: 0, skipped: 'plan' };
  const s = await getSmtp();
  const users = await col('users').find({ workspaceId, disabled: { $ne: true } }).toArray();
  const m = message(items, s.appUrl);
  const out = { emails: 0, pushes: 0 };
  const sentTo = new Set(); // one email per address, even if two users list the same one
  for (const u of users) {
    const p = prefsOf(u);
    if (p.email && smtpReady(s)) {
      for (const to of recipientsOf(u)) {
        if (sentTo.has(to)) continue;
        sentTo.add(to);
        try {
          await sendEmail(to, m.subject, m.html, m.text);
          out.emails++;
        } catch (e) {
          log('warn', `Email to ${to}: ${e.message}`);
        }
      }
    }
    if (p.push) out.pushes += await sendPush(u._id, m.push);
  }
  return out;
}

// ---------------- the check (every 30 s) ----------------
/** Searches finished since notifications were turned on: ads collected and no page of it left to read. */
export async function notifyFinishedSearches() {
  // only searches that finish from now on — never a flood about old ones
  let since = (await col('settings').findOne({ _id: SINCE_ID }))?.since;
  if (!since) {
    since = new Date();
    await col('settings').updateOne({ _id: SINCE_ID }, { $setOnInsert: { since } }, { upsert: true });
  }
  const jobs = await col('jobs')
    .find({ phase: 'collected', notifiedAt: { $exists: false }, collectedAt: { $gte: since } })
    .project({ keyword: 1, country: 1, workspaceId: 1, projectId: 1, adsSeen: 1, pageIds: 1 })
    .limit(100)
    .toArray();
  const byWs = new Map();
  for (const j of jobs) {
    const id = String(j._id);
    const left = await col('leads').countDocuments({ workspaceId: j.workspaceId, jobIds: id, scrapeStatus: { $in: ['pending', 'working'] } });
    if (left) continue;
    // claim it — two servers (or two ticks) never announce the same search twice
    const claimed = await col('jobs').findOneAndUpdate({ _id: j._id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: new Date() } });
    if (!claimed) continue;
    const [c] = await col('leads')
      .aggregate([
        { $match: { workspaceId: j.workspaceId, jobIds: id } },
        {
          $group: {
            _id: null,
            withContact: { $sum: { $cond: [{ $or: [{ $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] }, { $gt: [{ $size: { $ifNull: ['$whatsapp', []] } }, 0] }] }, 1, 0] } },
            phones: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] }, 1, 0] } },
            emails: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    const item = {
      id, keyword: j.keyword, country: j.country || '', projectId: j.projectId ? String(j.projectId) : null,
      ads: j.adsSeen || 0, pages: (j.pageIds || []).length, withContact: c?.withContact || 0, phones: c?.phones || 0, emails: c?.emails || 0,
    };
    // the bell (every plan): the search is ready
    await notifyWorkspace(j.workspaceId, {
      kind: 'search', level: 'success', title: `"${j.keyword}" is ready`,
      body: `${item.withContact.toLocaleString('en-US')} leads with a phone or email, from ${item.pages.toLocaleString('en-US')} pages.`, link: item.projectId ? `/projects/${item.projectId}` : '/search',
    });
    const k = String(j.workspaceId);
    if (!byWs.has(k)) byWs.set(k, { workspaceId: j.workspaceId, items: [] });
    byWs.get(k).items.push(item);
  }
  let sent = 0;
  for (const { workspaceId, items } of byWs.values()) {
    const r = await announce(workspaceId, items);
    sent += items.length;
    log('info', `Search ready: ${items.map((x) => `"${x.keyword}"`).join(', ')} — ${r.emails} email(s), ${r.pushes} push(es)`);
  }
  return sent;
}

/** "Send a test" from Settings: to this user only. */
export async function sendTest(user) {
  const s = await getSmtp();
  const m = message([{ id: 'test', keyword: 'Test — organic food', country: 'BD', projectId: null, ads: 1240, pages: 412, withContact: 281, phones: 260, emails: 190 }], s.appUrl);
  const out = { email: null, emails: [], push: 0 };
  if (smtpReady(s)) {
    for (const to of recipientsOf(user)) {
      try {
        await sendEmail(to, `[Test] ${m.subject}`, m.html, m.text);
        out.emails.push(to);
      } catch (e) {
        out.emailError = `${to}: ${e.message}`;
      }
    }
    out.email = out.emails.join(', ') || null;
  } else out.emailError = 'Email is not set up yet';
  out.push = await sendPush(user._id, { ...m.push, title: `[Test] ${m.push.title}` });
  return out;
}
