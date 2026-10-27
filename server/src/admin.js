import http from 'node:http';
import tlsLib from 'node:tls';
// Admin-only API (mounted at /api/admin behind requireAdmin): users and server logs.
import express from 'express';
import { col, httpError, log } from './db.js';
import { ROLES, checkPasswordRules, createUser, hashPassword, userDTO } from './auth.js';
import { PERIOD_DAYS, PERKS, accountOf, billingSettings, changeCredits, forgetFunded, forgetOverdraft, listPlans, markOrderPaid, perksOf, queueShareOf } from './billing.js';
import { orderDTO } from './billingRoutes.js';
import { announce, notifyWorkspace } from './inbox.js';
import { providerList } from './payments.js';
import { deleteWorkspaceData, oid } from './projects.js';
import { startOfToday } from './util.js';
import { OUTDATED_LIST_DAYS, isOutdated, outdatedExtensions, worker as workerState } from './worker-state.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

async function userRow(u) {
  const [ws, leads, acc] = await Promise.all([
    col('workspaces').findOne({ _id: u.workspaceId }, { projection: { limits: 1, usage: 1 } }),
    col('leads').countDocuments({ workspaceId: u.workspaceId }),
    accountOf(u.workspaceId),
  ]);
  // the same counter the limit uses (see checkSearchQuota)
  const searchesToday = ws?.usage?.day === startOfToday().toISOString() ? ws.usage.searches || 0 : 0;
  return {
    ...userDTO(u), emailVerified: u.emailVerified !== false, workspaceId: String(u.workspaceId),
    searchesPerDay: acc.searchesPerDay, ownLimit: ws?.limits?.searchesPerDay ?? null, leads, searchesToday,
    plan: acc.plan, planName: acc.planName, planStatus: acc.planStatus, periodEnd: acc.periodEnd, credits: acc.credits, unlimited: acc.unlimited,
  };
}

const activeAdmins = (exceptId) => col('users').countDocuments({ role: 'admin', disabled: { $ne: true }, _id: { $ne: exceptId } });

r.get('/users', ah(async () => {
  const users = await col('users').find({}).sort({ createdAt: 1 }).toArray();
  return Promise.all(users.map(userRow));
}));

r.post('/users', ah(async (req) => {
  const { email, name, password, role, searchesPerDay } = req.body || {};
  const u = await createUser({ email, name, password, role: role || 'member', searchesPerDay: searchesPerDay === '' ? undefined : searchesPerDay });
  await log('info', `${req.user.email} created user ${u.email} (${u.role})`);
  return userRow(u);
}));

r.patch('/users/:id', ah(async (req) => {
  const u = await col('users').findOne({ _id: oid(req.params.id) });
  if (!u) throw httpError(404, 'User not found');
  const b = req.body || {};
  const set = {};
  if ('name' in b) set.name = String(b.name || '').trim().slice(0, 80) || u.name;
  if ('role' in b) {
    if (!ROLES.includes(b.role)) throw httpError(400, 'Unknown role');
    if (u.role === 'admin' && b.role !== 'admin' && !(await activeAdmins(u._id))) throw httpError(400, 'There must be at least one admin');
    set.role = b.role;
  }
  if ('disabled' in b) {
    if (String(u._id) === String(req.user._id) && b.disabled) throw httpError(400, 'You cannot disable your own account');
    if (u.role === 'admin' && b.disabled && !(await activeAdmins(u._id))) throw httpError(400, 'There must be at least one admin');
    set.disabled = Boolean(b.disabled);
  }
  if ('password' in b && b.password) {
    checkPasswordRules(b.password);
    set.passwordHash = await hashPassword(b.password);
  }
  if (Object.keys(set).length) await col('users').updateOne({ _id: u._id }, { $set: set });
  // a disabled user or a new password logs out every device
  if (set.disabled || set.passwordHash) await col('sessions').deleteMany({ userId: u._id });
  if ('searchesPerDay' in b) {
    // empty = back to the plan's limit
    if (b.searchesPerDay === '' || b.searchesPerDay === null) await col('workspaces').updateOne({ _id: u.workspaceId }, { $unset: { 'limits.searchesPerDay': '' } });
    else await col('workspaces').updateOne({ _id: u.workspaceId }, { $set: { 'limits.searchesPerDay': Math.max(0, Math.min(100000, Math.round(Number(b.searchesPerDay) || 0))) } });
  }
  if ('emailVerified' in b) await col('users').updateOne({ _id: u._id }, { $set: { emailVerified: Boolean(b.emailVerified) } });
  return userRow(await col('users').findOne({ _id: u._id }));
}));

r.delete('/users/:id', ah(async (req) => {
  const u = await col('users').findOne({ _id: oid(req.params.id) });
  if (!u) throw httpError(404, 'User not found');
  if (String(u._id) === String(req.user._id)) throw httpError(400, 'You cannot delete your own account');
  if (u.role === 'admin' && !(await activeAdmins(u._id))) throw httpError(400, 'There must be at least one admin');
  await col('sessions').deleteMany({ userId: u._id });
  await deleteWorkspaceData(u.workspaceId);
  await col('users').deleteOne({ _id: u._id });
  await log('info', `${req.user.email} deleted user ${u.email} and their workspace`);
  return { ok: true };
}));

// ---------------- billing (admin) ----------------
const ws4 = async (userId) => {
  const u = await col('users').findOne({ _id: oid(userId) });
  if (!u) throw httpError(404, 'User not found');
  return u;
};

/** Add or take credits by hand — with the reason, in the customer's ledger. */
r.post('/users/:id/credits', ah(async (req) => {
  const u = await ws4(req.params.id);
  const delta = Math.round(Number(req.body?.delta) || 0);
  if (!delta || Math.abs(delta) > 10000000) throw httpError(400, 'Enter how many credits to add (or take with a minus)');
  const reason = String(req.body?.reason || '').trim() || (delta > 0 ? 'Added by the team' : 'Taken by the team');
  await changeCredits(u.workspaceId, delta, { kind: 'adjust', reason, by: req.user.email });
  await notifyWorkspace(u.workspaceId, {
    kind: 'credits', level: delta > 0 ? 'success' : 'info',
    title: delta > 0 ? `+${delta.toLocaleString('en-US')} credits added to your account` : `${delta.toLocaleString('en-US')} credits taken from your account`,
    body: reason, link: '/billing',
  });
  forgetFunded();
  await log('info', `${req.user.email}: ${delta > 0 ? '+' : ''}${delta} credits for ${u.email} — ${reason}`);
  return userRow(u);
}));

/** Change a customer's plan by hand (e.g. a deal, or the team's own accounts → internal). */
r.put('/users/:id/plan', ah(async (req) => {
  const u = await ws4(req.params.id);
  const plan = await col('plans').findOne({ _id: String(req.body?.plan || '') });
  if (!plan) throw httpError(400, 'Unknown plan');
  const days = Math.max(1, Math.min(3650, Number(req.body?.days) || PERIOD_DAYS));
  const set = { plan: plan._id, planStatus: plan._id === 'free' ? 'trial' : 'active' };
  if (plan._id !== 'free' && !plan.unlimited) set.periodEnd = new Date(Date.now() + days * 86400e3);
  await col('workspaces').updateOne({ _id: u.workspaceId }, { $set: set, ...(plan._id === 'free' || plan.unlimited ? { $unset: { periodEnd: '' } } : {}) });
  if (req.body?.grantCredits && plan.credits > 0) await changeCredits(u.workspaceId, plan.credits, { kind: 'plan', reason: `${plan.name} plan (set by the team)`, by: req.user.email });
  forgetFunded();
  await log('info', `${req.user.email}: ${u.email} → ${plan.name} plan`);
  await notifyWorkspace(u.workspaceId, { kind: 'plan', level: 'success', title: `Your plan is now ${plan.name}`, body: set.periodEnd ? `Active until ${set.periodEnd.toDateString()}.` : '', link: '/billing' });
  return userRow(u);
}));

r.get('/users/:id/ledger', ah(async (req) => {
  const u = await ws4(req.params.id);
  return (await col('ledger').find({ workspaceId: u.workspaceId }).sort({ at: -1 }).limit(200).toArray()).map((l) => ({ ...l, _id: String(l._id), workspaceId: undefined }));
}));

r.get('/orders', ah(async (req) => {
  const q = req.query.status ? { status: String(req.query.status) } : {};
  const orders = await col('orders').find(q).sort({ createdAt: -1 }).limit(300).toArray();
  const users = new Map((await col('users').find({ _id: { $in: orders.map((o) => o.userId).filter(Boolean) } }).project({ email: 1, name: 1 }).toArray()).map((u) => [String(u._id), u]));
  return orders.map((o) => ({ ...orderDTO(o), email: users.get(String(o.userId))?.email || '', userName: users.get(String(o.userId))?.name || '', paidBy: o.paidBy || null, cancelReason: o.cancelReason || null }));
}));

r.post('/orders/:id/paid', ah(async (req) => {
  const o = await markOrderPaid(oid(req.params.id), { by: req.user.email, providerRef: String(req.body?.ref || '').slice(0, 100) || null });
  if (!o) throw httpError(409, 'This order is not waiting for payment');
  await log('info', `${req.user.email} marked order ${o.invoiceNo} paid (${o.name}, ${o.amount} ${o.currency})`);
  return orderDTO(o);
}));

r.post('/orders/:id/cancel', ah(async (req) => {
  const res2 = await col('orders').updateOne({ _id: oid(req.params.id), status: 'pending' }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: `canceled by ${req.user.email}` } });
  if (!res2.modifiedCount) throw httpError(409, 'This order is not waiting for payment');
  return { ok: true };
}));

r.get('/plans', ah(async () => ({ plans: (await listPlans()).map((p) => ({ ...p, perks: perksOf(p), queueShare: queueShareOf(p) })), perkNames: PERKS, ...(await billingSettings()), providers: providerList() })));

r.put('/plans/:id', ah(async (req) => {
  const p = await col('plans').findOne({ _id: req.params.id });
  if (!p) throw httpError(404, 'Plan not found');
  const b = req.body || {};
  const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const set = {};
  if ('name' in b) set.name = String(b.name || '').trim().slice(0, 40) || p.name;
  if ('price' in b) set.price = Math.max(0, Math.min(100000, Number(b.price) || 0));
  if ('credits' in b) set.credits = num(b.credits, 10000000);
  if ('searchesPerDay' in b) set.searchesPerDay = num(b.searchesPerDay, 100000);
  if ('maxAdsPerSearch' in b) set.maxAdsPerSearch = Math.max(10, num(b.maxAdsPerSearch, 50000));
  if ('seats' in b) set.seats = Math.max(1, num(b.seats, 1000));
  if ('public' in b && p._id !== 'internal') set.public = Boolean(b.public);
  if ('popular' in b) set.popular = Boolean(b.popular);
  // pages read per turn in the shared queue (pageQueue.js) — free 1, paid 2 by default
  if ('queueShare' in b) set.queueShare = Math.max(1, Math.min(10, Math.round(Number(b.queueShare) || 1)));
  if (b.perks && typeof b.perks === 'object') set.perks = Object.fromEntries(Object.keys(PERKS).map((k) => [k, Boolean(b.perks[k])]));
  if ('features' in b) set.features = (Array.isArray(b.features) ? b.features : String(b.features).split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  await col('plans').updateOne({ _id: p._id }, { $set: set });
  forgetFunded();
  return { plans: await listPlans() };
}));

r.put('/billing-settings', ah(async (req) => {
  const b = req.body || {};
  const set = {};
  if ('signupOpen' in b) set.signupOpen = Boolean(b.signupOpen);
  if ('overdraft' in b) set.overdraft = Math.max(0, Math.min(100000, Math.round(Number(b.overdraft) || 0)));
  if ('provider' in b) {
    if (!providerList().some((p) => p.id === b.provider)) throw httpError(400, 'Unknown payment provider');
    set.provider = b.provider;
  }
  if (Array.isArray(b.packs)) {
    set.packs = b.packs
      .map((x, i) => ({ id: String(x.id || `pack-${i + 1}`).slice(0, 30), name: String(x.name || `${x.credits} credits`).slice(0, 40), credits: Math.max(1, Math.round(Number(x.credits) || 0)), price: Math.max(0, Number(x.price) || 0) }))
      .filter((x) => x.credits > 0)
      .slice(0, 8);
  }
  await col('settings').updateOne({ _id: 'billing' }, { $set: set }, { upsert: true });
  forgetOverdraft();
  forgetFunded();
  return { ...(await billingSettings()), providers: providerList() };
}));

/** The admin home: who signed up, who pays, what is being used. */
r.get('/overview', ah(async () => {
  const now = Date.now();
  const since = (days) => new Date(now - days * 86400e3);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [users, verified, signups7, signups30, active7, plansCount, paidMonth, pendingOrders, usageToday, usage30, creditsOut, daily] = await Promise.all([
    col('users').countDocuments({}),
    col('users').countDocuments({ emailVerified: { $ne: false } }),
    col('users').countDocuments({ createdAt: { $gte: since(7) } }),
    col('users').countDocuments({ createdAt: { $gte: since(30) } }),
    col('jobs').distinct('workspaceId', { createdAt: { $gte: since(7) } }).then((x) => x.length),
    col('workspaces').aggregate([{ $group: { _id: { $ifNull: ['$plan', 'free'] }, n: { $sum: 1 } } }]).toArray(),
    col('orders').aggregate([{ $match: { status: 'paid', paidAt: { $gte: monthStart } } }, { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } }]).toArray(),
    col('orders').countDocuments({ status: 'pending' }),
    col('ledger').aggregate([{ $match: { kind: 'usage', at: { $gte: startOfToday() } } }, { $group: { _id: null, n: { $sum: '$meta.pages' } } }]).toArray(),
    col('ledger').aggregate([{ $match: { kind: 'usage', at: { $gte: since(30) } } }, { $group: { _id: null, n: { $sum: '$meta.pages' } } }]).toArray(),
    col('workspaces').aggregate([{ $match: { plan: { $ne: 'internal' } } }, { $group: { _id: null, n: { $sum: { $max: ['$credits', 0] } } } }]).toArray(),
    // the last 14 days: sign-ups, pages read, money in
    Promise.all(
      Array.from({ length: 14 }, (_, i) => {
        const d0 = new Date(startOfToday().getTime() - (13 - i) * 86400e3);
        const d1 = new Date(d0.getTime() + 86400e3);
        return Promise.all([
          col('users').countDocuments({ createdAt: { $gte: d0, $lt: d1 } }),
          col('ledger').aggregate([{ $match: { kind: 'usage', at: { $gte: d0, $lt: d1 } } }, { $group: { _id: null, n: { $sum: '$meta.pages' } } }]).toArray(),
          col('orders').aggregate([{ $match: { status: 'paid', paidAt: { $gte: d0, $lt: d1 } } }, { $group: { _id: null, n: { $sum: '$amount' } } }]).toArray(),
        ]).then(([s, u, m]) => ({ day: d0.toISOString().slice(0, 10), signups: s, pages: u[0]?.n || 0, revenue: m[0]?.n || 0 }));
      }),
    ),
  ]);
  const byPlan = Object.fromEntries(plansCount.map((p) => [p._id, p.n]));
  const prices = Object.fromEntries((await listPlans()).map((p) => [p._id, p.price]));
  const mrr = (await col('workspaces').find({ planStatus: 'active', plan: { $nin: ['free', 'internal'] } }).project({ plan: 1 }).toArray()).reduce((a, w) => a + (prices[w.plan] || 0), 0);
  return {
    users, verified, signups7, signups30, active7, byPlan, mrr, currency: 'USD',
    revenueMonth: paidMonth[0]?.sum || 0, ordersMonth: paidMonth[0]?.n || 0, pendingOrders,
    pagesToday: usageToday[0]?.n || 0, pages30: usage30[0]?.n || 0, creditsOutstanding: creditsOut[0]?.n || 0, daily,
  };
}));

// ---------------- notices to customers (the bell) ----------------
r.get('/notices', ah(async () => {
  const list = await col('inbox').find({ kind: 'notice' }).sort({ at: -1 }).limit(100).toArray();
  const wsIds = list.filter((x) => x.workspaceId).map((x) => x.workspaceId);
  const owners = new Map((await col('users').find({ workspaceId: { $in: wsIds } }).project({ email: 1, workspaceId: 1 }).toArray()).map((u) => [String(u.workspaceId), u.email]));
  return list.map((x) => ({ id: String(x._id), title: x.title, body: x.body, link: x.link, level: x.level, at: x.at, by: x.by, to: x.to === 'all' ? 'Everybody' : owners.get(String(x.workspaceId)) || 'one account' }));
}));
r.post('/notices', ah(async (req) => {
  const b = req.body || {};
  let workspaceId = null;
  if (b.to && b.to !== 'all') {
    const u = await col('users').findOne({ email: String(b.to).trim().toLowerCase() });
    if (!u) throw httpError(404, 'No account with this email');
    workspaceId = u.workspaceId;
  }
  const n = await announce({ title: b.title, body: b.body, link: b.link || null, level: b.level, workspaceId, by: req.user.email });
  await log('info', `${req.user.email} sent a notice to ${workspaceId ? b.to : 'everybody'}: ${n.title}`);
  return { ok: true };
}));
r.delete('/notices/:id', ah(async (req) => {
  await col('inbox').deleteOne({ _id: oid(req.params.id), kind: 'notice' });
  return { ok: true };
}));

// ---------------- extension updates: who still runs an old version, and a reminder in their bell ----------------
r.get('/extensions', ah(async () => outdatedExtensions()));

const REMINDER_GAP_MS = 60 * 60e3; // one reminder per account per hour — pressing twice doesn't spam the bell
async function remindExtension(workspaceId, by) {
  const ws = await col('workspaces').findOne({ _id: workspaceId }, { projection: { extReminderAt: 1 } });
  if (!ws) return false;
  if (ws.extReminderAt && Date.now() - new Date(ws.extReminderAt).getTime() < REMINDER_GAP_MS) return false;
  const pcs = await col('pcs').find({ workspaceId, lastSeen: { $gt: new Date(Date.now() - OUTDATED_LIST_DAYS * 864e5) } }).project({ version: 1 }).toArray();
  const old = [...new Set(pcs.filter((p) => isOutdated(p.version)).map((p) => p.version))];
  if (!old.length) return false;
  await notifyWorkspace(workspaceId, {
    kind: 'extension', level: 'warn',
    title: `Please update your Chrome extension (${old.join(', ')} → ${workerState.latest})`,
    body: 'Download the new version on the Connect extension page, put its files in the same folder as the old one, then open chrome://extensions and press Reload. Your settings and leads stay as they are.',
    link: '/connect-extension',
  });
  await col('workspaces').updateOne({ _id: workspaceId }, { $set: { extReminderAt: new Date() } });
  await log('info', `${by} sent an extension update reminder to workspace ${workspaceId} (${old.join(', ')})`);
  return true;
}
r.post('/extensions/remind', ah(async (req) => {
  const b = req.body || {};
  const ids = b.all ? (await outdatedExtensions()).accounts.map((a) => a.workspaceId) : [String(b.workspaceId || '')];
  let sent = 0;
  for (const id of ids) if (/^[0-9a-f]{24}$/.test(id) && (await remindExtension(oid(id), req.user.email))) sent++;
  return { sent, ...(await outdatedExtensions()) };
}));

// ---------------- logs ----------------
r.get('/logs', ah(() => col('logs').find({}).sort({ ts: -1 }).limit(300).toArray()));
r.delete('/logs', ah(async () => {
  await col('logs').deleteMany({});
  return { ok: true };
}));

r.post('/test-proxy', ah(async (req) => {
  const { host, port, user, pass } = req.body || {};
  const proxyHost = String(host || '').trim();
  const proxyPort = Number(port) || 44445;
  const proxyUser = String(user || '').trim();
  const proxyPass = String(pass || '').trim();

  if (!proxyHost) throw httpError(400, 'Proxy host is required');

  const auth = proxyUser ? Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64') : '';
  const CRLF = String.fromCharCode(13, 10);

  // Facebook first: a proxy can work for test sites and still refuse Facebook (Bright Data without KYC did)
  const fb = await new Promise((resolve) => {
    const c = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT', path: 'www.facebook.com:443',
      headers: { Host: 'www.facebook.com:443', ...(auth ? { 'Proxy-Authorization': `Basic ${auth}` } : {}) },
    });
    c.setTimeout(15000, () => { c.destroy(); resolve('timed out (15s)'); });
    c.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode === 200 ? 'ok' : `status ${res.statusCode} ${String(res.headers['x-brd-err-msg'] || res.statusMessage || '').slice(0, 160)}`.trim());
    });
    c.on('error', (e) => resolve(e.message));
    c.end();
  });
  if (fb !== 'ok') throw httpError(502, `The proxy refuses facebook.com: ${fb}`);

  return new Promise((resolve, reject) => {
    const r = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: 'geo.brdtest.com:443',
      headers: {
        Host: 'geo.brdtest.com:443',
        ...(auth ? { 'Proxy-Authorization': `Basic ${auth}` } : {}),
      },
    });

    r.setTimeout(15000, () => {
      r.destroy();
      reject(httpError(504, 'Proxy connection timed out (15s)'));
    });

    r.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(httpError(502, `Proxy rejected with status ${res.statusCode}`));
      }
      const tls = tlsLib.connect({ socket, servername: 'geo.brdtest.com' }, () => {
        tls.write(['GET /mygeo.json HTTP/1.1', 'Host: geo.brdtest.com', 'User-Agent: curl/8.0', 'Connection: close', '', ''].join(CRLF));
      });

      // Facebook already passed above — if the geo lookup hangs, still report success
      tls.setTimeout(15000, () => {
        tls.destroy();
        resolve({ ok: true, message: 'Proxy connected successfully' });
      });
      let data = '';
      tls.on('data', (chunk) => { data += chunk; });
      tls.on('end', () => {
        try {
          const sep = CRLF + CRLF;
          const sepIdx = data.indexOf(sep);
          const body = sepIdx >= 0 ? data.slice(sepIdx + sep.length) : data;
          const json = JSON.parse(body);
          resolve({ ok: true, ip: json.ip, country: json.country, city: json.city });
        } catch {
          resolve({ ok: true, message: 'Proxy connected successfully' });
        }
      });
      tls.on('error', (e) => reject(httpError(502, `TLS error through proxy: ${e.message}`)));
    });

    r.on('error', (e) => reject(httpError(502, `Could not connect to proxy: ${e.message}`)));
    r.end();
  });
}));

export default r;
