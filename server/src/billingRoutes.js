// Billing API.
//   publicRoutes  /api/public/*   no login: the plans for the pricing page, payment webhooks
//   userRoutes    /api/billing/*  the customer: plan, credits, usage, orders, checkout
import express from 'express';
import { col, httpError, log } from './db.js';
import { CURRENCY, PERIOD_DAYS, PERKS, accountOf, billingSettings, createOrder, listPlans, markOrderPaid, perksOf } from './billing.js';
import { provider } from './payments.js';
import { oid } from './projects.js';
import { worker as workerState } from './worker-state.js';

const latestExtension = () => workerState.latest || null;

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);
const planDTO = (p) => ({
  id: p._id, name: p.name, price: p.price, credits: p.credits, searchesPerDay: p.searchesPerDay, maxAdsPerSearch: p.maxAdsPerSearch, seats: p.seats,
  features: p.features || [], popular: !!p.popular,
  // what the plan includes, in the order of PERKS — the pricing cards show each with ✓ or a lock
  perks: Object.entries(perksOf(p)).map(([key, on]) => ({ key, name: PERKS[key], on })),
});
export const orderDTO = (o) => ({
  id: String(o._id), kind: o.kind, name: o.name, credits: o.credits, amount: o.amount, currency: o.currency, status: o.status,
  provider: o.provider, invoiceNo: o.invoiceNo || null, createdAt: o.createdAt, paidAt: o.paidAt || null,
});

// ---------------- public ----------------
export const publicRoutes = express.Router();
publicRoutes.get('/plans', ah(async (req) => {
  const [plans, s] = await Promise.all([listPlans(), billingSettings()]);
  return {
    currency: CURRENCY, periodDays: PERIOD_DAYS, plans: plans.filter((p) => p.public).map(planDTO), packs: s.packs, signupOpen: s.signupOpen,
    // the visitor's country (Cloudflare tells us) — the sign-up form starts with it
    country: String(req.get('cf-ipcountry') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2),
  };
}));
// the extension to download (until it is in the Chrome Web Store): version + file
// (?v= makes every new version a new address — Cloudflare caches files, it must never hand out an old one)
publicRoutes.get('/extension', ah(async () => ({ version: latestExtension(), url: `/downloads/fb-lead-finder-extension.zip?v=${latestExtension()}`, storeUrl: process.env.EXTENSION_STORE_URL || null })));

publicRoutes.post('/payments/webhook/:provider', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req) => {
  const out = await provider(req.params.provider).webhook(req);
  if (out?.paid && out.orderId) await markOrderPaid(oid(out.orderId), { by: `webhook:${req.params.provider}`, providerRef: out.ref || null });
  return { ok: true };
}));

// ---------------- the customer ----------------
export const userRoutes = express.Router();

userRoutes.get('/billing', ah(async (req) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const used = async (since) =>
    (await col('ledger').aggregate([{ $match: { workspaceId: req.ws, kind: 'usage', at: { $gte: since } } }, { $group: { _id: null, n: { $sum: '$meta.pages' } } }]).toArray())[0]?.n || 0;
  const [account, plans, s, orders, ledger, today, month] = await Promise.all([
    accountOf(req.ws),
    listPlans(),
    billingSettings(),
    col('orders').find({ workspaceId: req.ws }).sort({ createdAt: -1 }).limit(30).toArray(),
    col('ledger').find({ workspaceId: req.ws }).sort({ at: -1 }).limit(60).toArray(),
    used(dayStart),
    used(monthStart),
  ]);
  return {
    account, currency: CURRENCY, periodDays: PERIOD_DAYS,
    plans: plans.filter((p) => p.public).map(planDTO), packs: s.packs,
    orders: orders.map(orderDTO),
    ledger: ledger.map((l) => ({ id: String(l._id), delta: l.delta, balance: l.balance, kind: l.kind, reason: l.reason, at: l.at, pages: l.meta?.pages || null })),
    usage: { today, month },
    provider: s.provider,
  };
}));

userRoutes.post('/billing/checkout', ah(async (req) => {
  const { kind, id } = req.body || {};
  const order = await createOrder({ workspaceId: req.ws, userId: req.user._id, kind, id });
  const out = await provider(order.provider).checkout(order, { user: req.user });
  await log('info', `Order: ${req.user.email} — ${order.name} (${order.amount} ${order.currency}), ${order.provider}`);
  return { order: orderDTO(order), url: out.url || null, message: out.message || null };
}));

userRoutes.post('/billing/orders/:id/cancel', ah(async (req) => {
  const r = await col('orders').updateOne({ _id: oid(req.params.id), workspaceId: req.ws, status: 'pending' }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: 'canceled by the customer' } });
  if (!r.modifiedCount) throw httpError(409, 'This order cannot be canceled');
  return { ok: true };
}));
