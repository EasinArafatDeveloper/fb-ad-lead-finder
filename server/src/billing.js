// Billing: plans, credits and orders — the money side of the SaaS (docs/SAAS.md).
//
//   1 credit = 1 Facebook page read for a workspace (its lead becomes "done"). A page that could not be read
//   (failed / "page not available") costs nothing. A page another customer already had read is still a page
//   delivered — it costs 1 credit too, and costs us nothing.
//
//   Every change to a balance is one line in the ledger (`ledger`), so a balance can always be explained.
//   The balance itself lives on the workspace (`credits`) and only ever changes with an atomic $inc.
//
//   Payments: an order is made first (pending), a payment provider marks it paid later. Until a gateway is
//   connected the only provider is "manual" — an admin marks the order paid in the admin panel (payments.js).
import { col, log } from './db.js';
import { notifyWorkspace } from './inbox.js';

// ---------------- plans ----------------
// The defaults; an admin edits them in the admin panel (stored in `plans`).
// What a plan includes besides credits and limits — each one is checked on the server (requirePerk), and the
// dashboard shows a lock where a plan doesn't have it. CSV export and the lead filters are for everybody.
export const PERKS = {
  excelExport: 'Excel export',
  notifications: 'Email & phone alerts',
  minAdsFilter: 'Bigger-advertisers filter (2+, 5+ ads)',
  sheetSync: 'Google Sheet sync',
};
const ALL_PERKS = Object.fromEntries(Object.keys(PERKS).map((k) => [k, true]));
const DEFAULT_PERKS = {
  free: {},
  starter: { excelExport: true, notifications: true, minAdsFilter: true },
  pro: ALL_PERKS,
  agency: ALL_PERKS,
  internal: ALL_PERKS,
};
/** A plan's perks: what the admin set, else the defaults (an older plan document may have none yet). */
export function perksOf(plan) {
  const base = DEFAULT_PERKS[plan?._id] || {};
  const legacy = plan?.minAdsFilter === undefined ? {} : { minAdsFilter: plan.minAdsFilter };
  const set = { ...base, ...legacy, ...(plan?.perks || {}) };
  return Object.fromEntries(Object.keys(PERKS).map((k) => [k, !!set[k]]));
}

export const DEFAULT_PLANS = [
  { _id: 'free', name: 'Free trial', price: 0, credits: 50, searchesPerDay: 3, maxAdsPerSearch: 500, seats: 1, order: 0, public: true, perks: DEFAULT_PERKS.free, features: ['50 pages, once'] },
  { _id: 'starter', name: 'Starter', price: 19, credits: 2000, searchesPerDay: 20, maxAdsPerSearch: 5000, seats: 1, order: 1, public: true, perks: DEFAULT_PERKS.starter, features: ['2,000 pages a month'] },
  { _id: 'pro', name: 'Pro', price: 49, credits: 7500, searchesPerDay: 100, maxAdsPerSearch: 10000, seats: 3, order: 2, public: true, popular: true, perks: DEFAULT_PERKS.pro, features: ['7,500 pages a month'] },
  { _id: 'agency', name: 'Agency', price: 149, credits: 30000, searchesPerDay: 1000, maxAdsPerSearch: 20000, seats: 10, order: 3, public: true, perks: DEFAULT_PERKS.agency, features: ['30,000 pages a month'] },
  // the team that runs the service — no limits, no charges
  { _id: 'internal', name: 'Internal', price: 0, credits: 0, searchesPerDay: 100000, maxAdsPerSearch: 50000, seats: 100, order: 9, public: false, unlimited: true, perks: ALL_PERKS, features: [] },
];
// one-off credit packs (never expire while the account exists)
export const DEFAULT_PACKS = [
  { id: 'pack-1k', name: '1,000 credits', credits: 1000, price: 10 },
  { id: 'pack-5k', name: '5,000 credits', credits: 5000, price: 40 },
  { id: 'pack-20k', name: '20,000 credits', credits: 20000, price: 120 },
];
export const CURRENCY = 'USD';
// how far below 0 a search that is already running may go (it isn't cut off half-way); then everything stops.
// New searches need a balance above 0. An admin sets it (Admin → Plans & prices).
export const DEFAULT_OVERDRAFT = 50;
const overdraftOf = (s) => Math.max(0, Math.min(100000, Math.round(Number(s?.overdraft ?? DEFAULT_OVERDRAFT))));
let overdraftCache = { at: 0, v: DEFAULT_OVERDRAFT };
export async function overdraft() {
  if (Date.now() - overdraftCache.at < 10000) return overdraftCache.v;
  overdraftCache = { at: Date.now(), v: overdraftOf(await col('settings').findOne({ _id: 'billing' })) };
  return overdraftCache.v;
}
export const forgetOverdraft = () => (overdraftCache = { at: 0, v: DEFAULT_OVERDRAFT });
export const PERIOD_DAYS = 30;

export async function ensurePlans() {
  for (const p of DEFAULT_PLANS) await col('plans').updateOne({ _id: p._id }, { $setOnInsert: p }, { upsert: true });
  // plans saved before perks existed: give them their perks, and drop the old feature lines the perks now show
  // (and promises the app doesn't keep yet: team members, priority reading)
  const OLD_LINES = ['CSV export', 'Excel & CSV export', 'Email alerts', 'Google Sheet sync', '3 team members', '10 team members', 'Priority reading'];
  for (const p of await col('plans').find({ perks: { $exists: false } }).toArray()) {
    await col('plans').updateOne({ _id: p._id }, { $set: { perks: perksOf(p), features: (p.features || []).filter((x) => !OLD_LINES.includes(x)) }, $unset: { minAdsFilter: '' } });
  }
  await col('settings').updateOne({ _id: 'billing' }, { $setOnInsert: { packs: DEFAULT_PACKS, signupOpen: false, provider: 'manual' } }, { upsert: true });
}
export const listPlans = () => col('plans').find({}).sort({ order: 1 }).toArray();
export const getPlan = async (id) => (await col('plans').findOne({ _id: id || 'free' })) || DEFAULT_PLANS[0];
export async function billingSettings() {
  const s = (await col('settings').findOne({ _id: 'billing' })) || {};
  // sign-up starts closed — an admin opens it (Admin → Settings) when the service is ready for customers
  return { packs: s.packs || DEFAULT_PACKS, signupOpen: s.signupOpen === true, provider: s.provider || 'manual', overdraft: overdraftOf(s) };
}

// ---------------- balances ----------------
const wsOf = (id) => col('workspaces').findOne({ _id: id });
export const isUnlimited = async (ws) => ws?.plan === 'internal' || !!(await getPlan(ws?.plan)).unlimited;

/** Add (positive) or take (negative) credits, with the reason in the ledger. Returns the new balance. */
export async function changeCredits(workspaceId, delta, { kind, reason, ref = null, by = null, meta } = {}) {
  delta = Math.round(Number(delta) || 0);
  const ws = await col('workspaces').findOneAndUpdate({ _id: workspaceId }, { $inc: { credits: delta } }, { returnDocument: 'after', projection: { credits: 1 } });
  if (!ws) throw Object.assign(new Error('Workspace not found'), { status: 404 });
  await col('ledger').insertOne({ workspaceId, delta, balance: ws.credits, kind, reason: String(reason || '').slice(0, 200), ref, by, meta, at: new Date() });
  if (delta > 0) {
    forgetFunded();
    // pages that waited for credits are handed over right away (in the background)
    setImmediate(() => deliverAwaiting(workspaceId).catch((e) => log('warn', `Deliver after credits: ${e.message}`)));
  }
  return ws.credits;
}

/** What a workspace has and may do — used everywhere a limit is checked. */
export async function accountOf(workspaceId) {
  const ws = await wsOf(workspaceId);
  const plan = await getPlan(ws?.plan);
  const unlimited = await isUnlimited(ws);
  const expired = !!(ws?.periodEnd && new Date(ws.periodEnd) < new Date() && ws.plan !== 'free' && !unlimited);
  // an ended plan keeps its name on the bill, but the limits are the free plan's until it is renewed
  const limits = expired ? await getPlan('free') : plan;
  return {
    plan: plan._id, planName: plan.name, unlimited, credits: ws?.credits || 0, planStatus: unlimited ? 'active' : expired ? 'expired' : ws?.planStatus || 'trial',
    overdraft: unlimited ? 0 : await overdraft(),
    periodEnd: ws?.periodEnd || null, searchesPerDay: ws?.limits?.searchesPerDay ?? limits.searchesPerDay, maxAdsPerSearch: limits.maxAdsPerSearch, seats: limits.seats,
    // what the plan includes (an ended plan: the free plan's) — the team has everything
    perks: unlimited ? { ...ALL_PERKS } : perksOf(limits),
    minAdsFilter: unlimited || perksOf(limits).minAdsFilter,
  };
}
export const hasCredits = (acc) => acc.unlimited || acc.credits > 0;

/** The plans that include a perk, cheapest first — for "… is on the Pro plan and up". */
async function plansWith(perk) {
  return (await listPlans()).filter((p) => p.public && p.price > 0 && perksOf(p)[perk]).map((p) => p.name);
}
/** Refuses (402) what this workspace's plan doesn't include. */
export async function requirePerk(workspaceId, perk) {
  const acc = await accountOf(workspaceId);
  if (acc.perks[perk]) return acc;
  const on = await plansWith(perk);
  throw Object.assign(new Error(`${PERKS[perk]} is not in your plan${on.length ? ` — it comes with ${on.join(', ')}` : ''}. Upgrade in Billing.`), { status: 402, perk });
}

/** Workspaces that may have pages read right now (credits left, or unlimited) — the page queue asks this. */
let fundedCache = { at: 0, ids: null };
let sharesCache = { at: 0, map: null }; // fundedShares() below
export async function fundedWorkspaces() {
  if (Date.now() - fundedCache.at < 5000 && fundedCache.ids) return fundedCache.ids;
  const internalPlans = (await col('plans').find({ unlimited: true }).project({ _id: 1 }).toArray()).map((p) => p._id);
  // a running search may use the overdraft (down to -overdraft); below that its pages wait
  const ids = (await col('workspaces').find({ $or: [{ credits: { $gt: -(await overdraft()) } }, { plan: { $in: ['internal', ...internalPlans] } }] }).project({ _id: 1 }).toArray()).map((w) => w._id);
  fundedCache = { at: Date.now(), ids };
  return ids;
}
export const forgetFunded = () => {
  fundedCache = { at: 0, ids: null };
  sharesCache = { at: 0, map: null };
};

/**
 * Pages read per turn in the shared page queue (pageQueue.js): customers take turns, a paid plan reads
 * `queueShare` pages per turn (default 2), the free plan 1. An ended paid plan counts as free.
 */
export const queueShareOf = (plan) => Math.max(1, Math.min(10, Math.round(Number(plan?.queueShare ?? (plan?._id === 'free' ? 1 : 2)) || 1)));
/** Map: workspaceId (string) → { id, share } — only workspaces that may have pages read now. */
export async function fundedShares() {
  if (Date.now() - sharesCache.at < 5000 && sharesCache.map) return sharesCache.map;
  const funded = await fundedWorkspaces();
  const plans = new Map((await listPlans()).map((p) => [p._id, p]));
  const free = plans.get('free') || DEFAULT_PLANS[0];
  const now = new Date();
  const map = new Map();
  for (const ws of await col('workspaces').find({ _id: { $in: funded } }).project({ plan: 1, periodEnd: 1 }).toArray()) {
    const plan = plans.get(ws.plan) || free;
    const expired = ws.periodEnd && new Date(ws.periodEnd) < now && plan._id !== 'free' && !plan.unlimited && ws.plan !== 'internal';
    map.set(String(ws._id), { id: ws._id, share: queueShareOf(expired ? free : plan) });
  }
  sharesCache = { at: Date.now(), map };
  return map;
}

// ---------------- paying for a page: at the moment its data is handed over ----------------
let unlimitedCache = new Map(); // workspaceId → { at, v }
async function isUnlimitedWs(id) {
  const k = String(id);
  const c = unlimitedCache.get(k);
  if (c && Date.now() - c.at < 30000) return c.v;
  const v = await isUnlimited(await wsOf(id));
  unlimitedCache.set(k, { at: Date.now(), v });
  return v;
}

/**
 * A page was read (or already had been, for somebody else): each workspace waiting for it pays 1 credit NOW,
 * before it sees anything. A workspace without credits gets nothing yet — its lead waits (awaitingCredits) and
 * is handed over the moment credits arrive (deliverAwaiting). So a balance never goes below 0, and nobody gets
 * a page they didn't pay for — except the overdraft: a search already running may take the balance down to
 * -overdraft (default -50) so it isn't cut off half-way; there it stops. Called by syncLeads (leads.js) for every page that is "done".
 */
export async function payForPage(pageId) {
  const leads = await col('leads').find({ pageId, charged: { $ne: true } }).project({ workspaceId: 1 }).toArray();
  for (const l of leads) {
    const unlimited = await isUnlimitedWs(l.workspaceId);
    // take the credit first (atomic: never below 0) …
    if (!unlimited && !(await col('workspaces').findOneAndUpdate({ _id: l.workspaceId, credits: { $gt: -(await overdraft()) } }, { $inc: { credits: -1 } }))) {
      await col('leads').updateOne({ _id: l._id, charged: { $ne: true } }, { $set: { awaitingCredits: true } });
      forgetFunded();
      continue;
    }
    // … then mark the lead paid — if another run paid for it in between, the credit goes back (never twice)
    const won = await col('leads').findOneAndUpdate({ _id: l._id, charged: { $ne: true } }, { $set: { charged: true, chargedAt: new Date(), ledgered: false }, $unset: { awaitingCredits: '' } });
    if (!won && !unlimited) await col('workspaces').updateOne({ _id: l.workspaceId }, { $inc: { credits: 1 } });
    if (won && !unlimited) await creditMilestone(l.workspaceId);
  }
}

/** The bell: tell the customer once when the balance reaches 10, 0, and the end of the overdraft. */
async function creditMilestone(workspaceId) {
  const ws = await col('workspaces').findOne({ _id: workspaceId }, { projection: { credits: 1 } });
  const n = ws?.credits;
  const od = await overdraft();
  if (n === 10) await notifyWorkspace(workspaceId, { kind: 'credits', level: 'warn', title: 'Only 10 credits left', body: '1 credit = 1 page read. Buy credits or upgrade so your searches keep going.', link: '/billing' });
  else if (n === 0) await notifyWorkspace(workspaceId, { kind: 'credits', level: 'warn', title: 'Your credits are used up', body: `A running search goes on down to -${od}, then stops. New searches need credits.`, link: '/billing' });
  else if (od > 0 && n === -od) await notifyWorkspace(workspaceId, { kind: 'credits', level: 'error', title: 'Reading has stopped — no credits', body: `Your balance reached -${od}. Waiting pages are read as soon as you add credits.`, link: '/billing' });
}

// ---------------- the ledger lines for the pages paid (every few seconds, index.js) ----------------
/**
 * The credits were already taken page by page (payForPage); this writes them into the customer's history,
 * grouped by keyword ("−37 pages read: Skincare"). Leads that are done but not paid for (an older path) are
 * paid for first.
 */
export async function chargeReadPages() {
  const unpaid = await col('leads').distinct('pageId', { scrapeStatus: 'done', charged: { $ne: true }, awaitingCredits: { $ne: true }, lastError: { $ne: 'Page not available' } });
  if (unpaid.length) {
    const { syncLeads } = await import('./leads.js');
    await syncLeads(unpaid.slice(0, 500));
  }
  const rows = await col('leads')
    .aggregate([
      { $match: { charged: true, ledgered: false } },
      { $limit: 5000 },
      { $group: { _id: { ws: '$workspaceId', kw: { $arrayElemAt: ['$keywords', 0] } }, ids: { $push: '$_id' } } },
    ])
    .toArray();
  let written = 0;
  for (const r of rows) {
    const n = (await col('leads').updateMany({ _id: { $in: r.ids }, ledgered: false }, { $set: { ledgered: true } })).modifiedCount;
    if (!n) continue;
    const ws = await wsOf(r._id.ws);
    if (!ws) continue;
    const unlimited = await isUnlimited(ws);
    await col('ledger').insertOne({
      workspaceId: ws._id, delta: unlimited ? 0 : -n, balance: ws.credits || 0, kind: 'usage',
      reason: `${n} page${n > 1 ? 's' : ''} read${r._id.kw ? `: ${r._id.kw}` : ''}${unlimited ? ' (unlimited plan)' : ''}`, meta: { pages: n }, at: new Date(),
    });
    if (!unlimited && (ws.credits || 0) <= 0) forgetFunded();
    written += n;
  }
  return written;
}

/** Credits arrived: the pages this workspace was waiting for (already read) are handed over now. */
export async function deliverAwaiting(workspaceId) {
  const pageIds = await col('leads').distinct('pageId', { workspaceId, awaitingCredits: true });
  if (!pageIds.length) return 0;
  const { syncLeads } = await import('./leads.js');
  for (let i = 0; i < pageIds.length; i += 200) await syncLeads(pageIds.slice(i, i + 200));
  return pageIds.length;
}

/** Start of billing: everything read before costs nothing; the team's own workspaces are unlimited. */
export async function migrateBilling() {
  const done = await col('settings').findOne({ _id: 'billing-migration' });
  if (done?.v >= 1) return false;
  await ensurePlans();
  await col('leads').updateMany({ charged: { $ne: true } }, { $set: { charged: true } });
  const admins = await col('users').find({ role: 'admin' }).project({ workspaceId: 1 }).toArray();
  await col('workspaces').updateMany({ _id: { $in: admins.map((a) => a.workspaceId) } }, { $set: { plan: 'internal', planStatus: 'active' } });
  // everybody else starts on the free trial with its credits
  const free = await getPlan('free');
  const others = await col('workspaces').find({ plan: { $exists: false } }).project({ _id: 1 }).toArray();
  for (const w of others) {
    await col('workspaces').updateOne({ _id: w._id }, { $set: { plan: 'free', planStatus: 'trial', credits: 0 } });
    await changeCredits(w._id, free.credits, { kind: 'grant', reason: 'Free trial credits' });
  }
  await col('users').updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } }); // existing accounts are trusted
  await col('settings').updateOne({ _id: 'billing-migration' }, { $set: { v: 1, at: new Date() } }, { upsert: true });
  await log('info', `Billing started: ${admins.length} internal workspace(s), ${others.length} on the free trial`);
  return true;
}

/** A new account: the free plan and its trial credits. */
export async function startTrial(workspaceId) {
  const free = await getPlan('free');
  await col('workspaces').updateOne({ _id: workspaceId }, { $set: { plan: 'free', planStatus: 'trial', credits: 0 } });
  if (free.credits > 0) await changeCredits(workspaceId, free.credits, { kind: 'grant', reason: 'Free trial credits' });
}

// ---------------- orders ----------------
async function nextInvoiceNo() {
  const r = await col('settings').findOneAndUpdate({ _id: 'invoice-seq' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
  return `INV-${new Date().getFullYear()}-${String(r.n).padStart(5, '0')}`;
}

/** A plan or a credit pack the customer wants — pending until paid. */
export async function createOrder({ workspaceId, userId, kind, id }) {
  let item;
  if (kind === 'plan') {
    const p = await col('plans').findOne({ _id: id, public: true });
    if (!p || p._id === 'free') throw Object.assign(new Error('Unknown plan'), { status: 400 });
    item = { kind, planId: p._id, name: `${p.name} plan — ${PERIOD_DAYS} days`, credits: p.credits, amount: p.price };
  } else if (kind === 'pack') {
    const pack = (await billingSettings()).packs.find((x) => x.id === id);
    if (!pack) throw Object.assign(new Error('Unknown credit pack'), { status: 400 });
    item = { kind, packId: pack.id, name: pack.name, credits: pack.credits, amount: pack.price };
  } else throw Object.assign(new Error('Choose a plan or a credit pack'), { status: 400 });
  // one open order per customer is enough — an older pending one is replaced
  await col('orders').updateMany({ workspaceId, status: 'pending' }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: 'replaced by a new order' } });
  const order = { workspaceId, userId, ...item, currency: CURRENCY, status: 'pending', provider: (await billingSettings()).provider, createdAt: new Date() };
  const { insertedId } = await col('orders').insertOne(order);
  await notifyWorkspace(workspaceId, { kind: 'order', level: 'info', title: `Order received: ${item.name}`, body: `$${item.amount} — your credits arrive as soon as the payment is confirmed.`, link: '/billing' });
  return { ...order, _id: insertedId };
}

/** A paid order: the plan starts (or is renewed for another period) and its credits arrive. Idempotent. */
export async function markOrderPaid(orderId, { by = null, providerRef = null } = {}) {
  const o = await col('orders').findOneAndUpdate(
    { _id: orderId, status: 'pending' },
    { $set: { status: 'paid', paidAt: new Date(), paidBy: by, providerRef, invoiceNo: await nextInvoiceNo() } },
    { returnDocument: 'after' },
  );
  if (!o) return null;
  if (o.kind === 'plan') {
    const ws = await wsOf(o.workspaceId);
    const from = ws?.plan === o.planId && ws?.periodEnd && new Date(ws.periodEnd) > new Date() ? new Date(ws.periodEnd) : new Date();
    const periodEnd = new Date(from.getTime() + PERIOD_DAYS * 86400e3);
    await col('workspaces').updateOne({ _id: o.workspaceId }, { $set: { plan: o.planId, planStatus: 'active', periodEnd }, $unset: { 'limits.searchesPerDay': '' } });
  }
  await changeCredits(o.workspaceId, o.credits, { kind: o.kind === 'plan' ? 'plan' : 'purchase', reason: o.name, ref: String(o._id), by });
  forgetFunded();
  await requeueUnfunded(o.workspaceId);
  const ws2 = await wsOf(o.workspaceId);
  await notifyWorkspace(o.workspaceId, {
    kind: 'payment', level: 'success',
    title: o.kind === 'plan' ? `Payment received — your ${o.name.split(' plan')[0]} plan is active` : `Payment received — ${o.credits.toLocaleString('en-US')} credits added`,
    body: o.kind === 'plan' ? `+${o.credits.toLocaleString('en-US')} credits. Active until ${new Date(ws2?.periodEnd).toDateString()}. Invoice ${o.invoiceNo}.` : `Invoice ${o.invoiceNo}.`,
    link: '/billing',
  });
  return o;
}

/** Pages that waited for this workspace's credits go on being read. */
export async function requeueUnfunded(workspaceId) {
  // nothing to do: the queue asks fundedWorkspaces() on every claim — kept as the one place to hook into
  forgetFunded();
  return workspaceId;
}

/** A plan whose period ended (and no gateway renewed it): back to the free plan's limits; credits stay. */
export async function expirePlans() {
  const internalPlans = (await col('plans').find({ unlimited: true }).project({ _id: 1 }).toArray()).map((p) => p._id);
  const paidPlan = { plan: { $nin: ['free', 'internal', ...internalPlans] } };
  // 3 days before the end: a reminder in the bell (once per period)
  const soon = await col('workspaces')
    .find({ planStatus: 'active', ...paidPlan, periodEnd: { $gt: new Date(), $lt: new Date(Date.now() + 3 * 86400e3) } })
    .project({ periodEnd: 1, plan: 1, endWarned: 1 })
    .toArray();
  for (const w of soon) {
    if (w.endWarned && new Date(w.endWarned).getTime() === new Date(w.periodEnd).getTime()) continue;
    await col('workspaces').updateOne({ _id: w._id }, { $set: { endWarned: w.periodEnd } });
    await notifyWorkspace(w._id, { kind: 'plan', level: 'warn', title: `Your ${w.plan} plan ends on ${new Date(w.periodEnd).toDateString()}`, body: 'Renew it in Billing to keep your limits. Your credits stay either way.', link: '/billing' });
  }
  const ended = await col('workspaces').find({ planStatus: 'active', periodEnd: { $lt: new Date() }, ...paidPlan }).project({ plan: 1 }).toArray();
  for (const w of ended) {
    const r = await col('workspaces').updateOne({ _id: w._id, planStatus: 'active' }, { $set: { planStatus: 'expired' } });
    if (r.modifiedCount) await notifyWorkspace(w._id, { kind: 'plan', level: 'warn', title: `Your ${w.plan} plan has ended`, body: 'You are back on the free plan’s limits. Your credits stay. Renew in Billing.', link: '/billing' });
  }
  return ended.length;
}
