// Accounts: email + password logins (scrypt), cookie sessions, one workspace per user,
// and the separate key the Chrome extension (worker) uses.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { col, httpError, log } from './db.js';
import { accountOf, billingSettings, startTrial } from './billing.js';
import { getSmtp, sendEmail } from './notify.js';
import { notifyWorkspace } from './inbox.js';
// the full rules (the server decides; the dashboard uses the small set only to help while typing)
import { getCountries, getCountryCallingCode, parsePhoneNumberWithError } from 'libphonenumber-js/max';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'fblf_sid';
const SESSION_DAYS = 30;
export const ROLES = ['admin', 'member'];
export const DEFAULT_SEARCHES_PER_DAY = 20;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;

// ---------------- passwords ----------------
export function checkPasswordRules(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw httpError(400, 'Password is too long');
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}
// compared against when the email doesn't exist, so a wrong email takes as long as a wrong password
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------------- users ----------------
/** Creates a user with their own workspace. */
export async function createUser({ email, name, password, role = 'member', searchesPerDay, emailVerified = true, profile = {} }) {
  email = normEmail(email);
  if (!validEmail(email)) throw httpError(400, 'Enter a valid email address');
  checkPasswordRules(password);
  if (!ROLES.includes(role)) throw httpError(400, 'Unknown role');
  if (await col('users').findOne({ email })) throw httpError(409, 'A user with this email already exists');
  const now = new Date();
  name = String(name || '').trim().slice(0, 80) || email.split('@')[0];
  const ws = await col('workspaces').insertOne({
    name: `${name}'s workspace`,
    createdAt: now,
    settings: {},
    // no own number = the plan's limit (billing.js); an admin can still set one per customer
    limits: searchesPerDay == null ? {} : { searchesPerDay: Math.max(0, Math.round(Number(searchesPerDay) || 0)) },
  });
  const user = { email, name, role, passwordHash: await hashPassword(password), workspaceId: ws.insertedId, disabled: false, createdAt: now, emailVerified, ...profile };
  const { insertedId } = await col('users').insertOne(user);
  await col('workspaces').updateOne({ _id: ws.insertedId }, { $set: { ownerId: insertedId } });
  // billing: the team gets the unlimited internal plan, everybody else the free trial and its credits
  if (role === 'admin') await col('workspaces').updateOne({ _id: ws.insertedId }, { $set: { plan: 'internal', planStatus: 'active', credits: 0 } });
  else await startTrial(ws.insertedId);
  return { ...user, _id: insertedId };
}

export const userDTO = (u) => ({
  id: String(u._id), email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  firstName: u.firstName || '', lastName: u.lastName || '', country: u.country || '', phone: u.phone || '',
});

/** Sign-up details: first and last name, the country, and a phone number valid for that country (stored as +880…). */
export function checkProfile(b = {}) {
  const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
  const firstName = clean(b.firstName).slice(0, 40);
  const lastName = clean(b.lastName).slice(0, 40);
  if (!firstName) throw httpError(400, 'Enter your first name');
  if (!lastName) throw httpError(400, 'Enter your last name');
  const country = String(b.country || '').toUpperCase();
  if (!getCountries().includes(country)) throw httpError(400, 'Choose your country');
  const raw = String(b.phone || '').trim();
  if (!raw) throw httpError(400, 'Enter your phone number');
  let phone;
  try {
    phone = parsePhoneNumberWithError(raw, country);
  } catch {
    throw httpError(400, 'Enter a valid phone number');
  }
  if (!phone.isValid()) throw httpError(400, `This is not a valid phone number for ${country} (+${getCountryCallingCode(country)})`);
  return { firstName, lastName, country, phone: phone.number };
}

// ---------------- sessions ----------------
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** Real visitor IP: Cloudflare puts it in CF-Connecting-IP; locally it's the socket address. */
export const clientIp = (req) => req.get('cf-connecting-ip') || req.ip || '';
const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });

async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await col('sessions').insertOne({
    _id: sha(token), userId: user._id, createdAt: new Date(), expiresAt, ip: clientIp(req), ua: String(req.get('user-agent') || '').slice(0, 200),
  });
  res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_DAYS * 864e5 });
}

/** Puts the logged-in user (if any) on req.user / req.ws. */
export async function loadUser(req, _res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (token) {
      const s = await col('sessions').findOne({ _id: sha(token), expiresAt: { $gt: new Date() } });
      const u = s && (await col('users').findOne({ _id: s.userId, disabled: { $ne: true } }));
      if (u) {
        req.user = u;
        req.ws = u.workspaceId;
        req.sessionId = s._id;
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
export const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do this' }));
export const isAdmin = (req) => req.user?.role === 'admin';

/**
 * The Chrome extension. Two kinds of key:
 *  - a customer's own extension key (Dashboard → "Connect the extension"): it works only for that account —
 *    req.workerWs / req.workerUser; it runs that account's searches and "Collect" saves into it
 *  - the server's WORKER_KEY (the team's own computers): the shared worker, as before
 */
export async function requireWorker(req, res, next) {
  try {
    const key = String(req.get('x-api-key') || '');
    if (key.startsWith('ext_')) {
      const t = await col('extokens').findOne({ _id: sha(key) });
      const u = t && (await col('users').findOne({ _id: t.userId, disabled: { $ne: true } }));
      if (!u) return res.status(401).json({ error: 'This extension is not connected any more — connect it again from the dashboard' });
      req.workerUser = u;
      req.workerWs = u.workspaceId;
      if (!t.lastUsed || Date.now() - new Date(t.lastUsed).getTime() > 60000) col('extokens').updateOne({ _id: t._id }, { $set: { lastUsed: new Date() } }).catch(() => {});
      return next();
    }
    const want = process.env.WORKER_KEY;
    if (!want) return res.status(500).json({ error: 'WORKER_KEY is not set on the server' });
    if (!safeEqual(key, want)) return res.status(401).json({ error: 'Wrong worker key' });
    next();
  } catch (e) {
    next(e);
  }
}

/** A new extension key for this account (shown once; only its hash is kept). */
export async function createExtensionKey(user, label) {
  const key = `ext_${crypto.randomBytes(24).toString('base64url')}`;
  await col('extokens').insertOne({ _id: sha(key), userId: user._id, workspaceId: user.workspaceId, label: String(label || '').slice(0, 60), createdAt: new Date(), lastUsed: null, hint: key.slice(-4) });
  return key;
}

/** Blocks cross-site form posts: a state-changing request from a browser must come from this site. */
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // not a browser request
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch {
    /* bad header */
  }
  res.status(403).json({ error: 'Request blocked (wrong origin)' });
}

// ---------------- login throttling ----------------
// After 8 wrong passwords from one IP, that IP waits 15 minutes. An email alone is locked only after 50
// (spread over many IPs) — so a stranger can't lock the real user out with a few wrong tries.
// (One server process → memory is fine.)
const fails = new Map();
const WINDOW = 15 * 60e3;
const MAX_FAILS = 8;
const MAX_EMAIL_FAILS = 50;
const isLocked = (key, max = MAX_FAILS) => {
  const f = fails.get(key);
  return !!f && f.until > Date.now() && f.n >= max;
};
function addFail(key) {
  const now = Date.now();
  const f = fails.get(key);
  if (!f || f.until < now) fails.set(key, { n: 1, until: now + WINDOW });
  else f.n++;
  if (fails.size > 20000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
}

// ---------------- routes ----------------
const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);
// sign-up: open unless an admin closed it (Admin → Settings) — or forced open with ALLOW_SIGNUP=true
const signupOpen = async () => process.env.ALLOW_SIGNUP === 'true' || (await billingSettings()).signupOpen;

async function meDTO(user) {
  const ws = await col('workspaces').findOne({ _id: user.workspaceId }, { projection: { name: 1, limits: 1 } });
  return {
    user: { ...userDTO(user), emailVerified: user.emailVerified !== false },
    workspace: { id: String(user.workspaceId), name: ws?.name || '', limits: ws?.limits || {} },
    account: await accountOf(user.workspaceId),
  };
}

// ---------------- email links: verify the address, reset a forgotten password ----------------
const TOKEN_TTL = { verify: 7 * 864e5, reset: 60 * 60e3 };
async function makeToken(userId, kind) {
  const token = crypto.randomBytes(32).toString('base64url');
  await col('authtokens').deleteMany({ userId, kind });
  await col('authtokens').insertOne({ _id: sha(token), userId, kind, expiresAt: new Date(Date.now() + TOKEN_TTL[kind]) });
  return token;
}
async function useToken(token, kind) {
  const t = await col('authtokens').findOneAndDelete({ _id: sha(String(token || '')), kind, expiresAt: { $gt: new Date() } });
  return t ? col('users').findOne({ _id: t.userId }) : null;
}
function emailHtml(title, text, button, url) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif"><table role="presentation" width="100%" style="padding:28px 12px"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #e2e8f0"><tr><td style="padding:28px">
  <div style="font-size:13px;color:#6366f1;font-weight:700">FB Lead Finder</div>
  <div style="font-size:21px;font-weight:800;color:#0f172a;margin-top:6px">${title}</div>
  <p style="font-size:14px;color:#334155;line-height:1.6">${text}</p>
  <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px">${button}</a>
  <p style="font-size:12px;color:#94a3b8;margin-top:22px">If the button doesn't work, open this link: ${url}</p>
  </td></tr></table></td></tr></table></body></html>`;
}
// ---------------- the 6-digit code that confirms an email address ----------------
// One code per user (15 minutes, 5 tries); a new code at most once a minute. Until the code is entered the
// account can do nothing but this (requireVerified in app.js).
export const CODE_TTL_MS = 15 * 60e3;
const CODE_TRIES = 5;
const CODE_RESEND_MS = 60e3;

export async function sendVerifyCode(user) {
  const prev = await col('authtokens').findOne({ _id: `code:${user._id}` });
  if (prev?.sentAt && Date.now() - new Date(prev.sentAt).getTime() < CODE_RESEND_MS) {
    throw httpError(429, `Wait ${Math.ceil((CODE_RESEND_MS - (Date.now() - new Date(prev.sentAt).getTime())) / 1000)} seconds for a new code`);
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await col('authtokens').updateOne(
    { _id: `code:${user._id}` },
    { $set: { userId: user._id, kind: 'code', hash: sha(`${user._id}:${code}`), email: user.email, tries: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + CODE_TTL_MS) } },
    { upsert: true },
  );
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif"><table role="presentation" width="100%" style="padding:28px 12px"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:16px;border:1px solid #e2e8f0"><tr><td style="padding:28px;text-align:center">
  <div style="font-size:13px;color:#6366f1;font-weight:700">FB Lead Finder</div>
  <div style="font-size:20px;font-weight:800;color:#0f172a;margin-top:6px">Your confirmation code</div>
  <div style="margin:22px auto;font-size:36px;letter-spacing:10px;font-weight:800;color:#0f172a;background:#eef2ff;border-radius:12px;padding:14px 0;width:260px">${code}</div>
  <p style="font-size:14px;color:#334155;line-height:1.6">Enter this code on the sign-up page to confirm your email. It works for 15 minutes.</p>
  <p style="font-size:12px;color:#94a3b8;margin-top:18px">If you didn't create an account, ignore this email.</p>
  </td></tr></table></td></tr></table></body></html>`;
  await sendEmail(user.email, `${code} is your FB Lead Finder code`, html, `Your FB Lead Finder confirmation code: ${code} (valid 15 minutes)`);
}

async function checkVerifyCode(user, code) {
  const t = await col('authtokens').findOne({ _id: `code:${user._id}` });
  if (!t || new Date(t.expiresAt) < new Date() || t.email !== user.email) throw httpError(400, 'This code has expired — ask for a new one');
  if (t.tries >= CODE_TRIES) throw httpError(429, 'Too many wrong codes — ask for a new one');
  if (!safeEqual(t.hash, sha(`${user._id}:${String(code || '').replace(/\D/g, '')}`))) {
    await col('authtokens').updateOne({ _id: t._id }, { $inc: { tries: 1 } });
    const left = CODE_TRIES - t.tries - 1;
    throw httpError(400, left > 0 ? `Wrong code — ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Too many wrong codes — ask for a new one');
  }
  await col('authtokens').deleteOne({ _id: t._id });
  await col('users').updateOne({ _id: user._id }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } });
  const acc = await accountOf(user.workspaceId);
  await notifyWorkspace(user.workspaceId, {
    kind: 'welcome', level: 'success', title: `Welcome, ${user.firstName || user.name || 'there'}!`,
    body: `You have ${acc.credits} free credits (1 credit = 1 page read). Connect the Chrome extension and start your first search.`, link: '/connect-extension',
  });
}

/** After requireUser: an account whose email isn't confirmed yet can only use /auth/* (enter the code). */
export function requireVerified(req, res, next) {
  if (req.user?.emailVerified === false) return res.status(403).json({ error: 'Confirm your email first — enter the code we sent you', verify: true });
  next();
}

r.get('/auth/config', ah(async () => ({ signup: await signupOpen() })));

r.get('/auth/verify', ah(async (req, res) => {
  const user = await useToken(req.query.token, 'verify');
  if (!user) return res.redirect('/login?verify=expired');
  await col('users').updateOne({ _id: user._id }, { $set: { emailVerified: true } });
  return res.redirect('/dashboard?verified=1');
}));

r.post('/auth/verify/resend', ah(async (req) => {
  if (!req.user) throw httpError(401, 'Please log in');
  if (req.user.emailVerified !== false) return { ok: true, already: true };
  const key = `verify:${req.user._id}`;
  if (isLocked(key, 6)) throw httpError(429, 'Too many codes — wait 15 minutes');
  await sendVerifyCode(req.user);
  addFail(key);
  return { ok: true };
}));

r.post('/auth/verify-code', ah(async (req) => {
  if (!req.user) throw httpError(401, 'Please log in');
  if (req.user.emailVerified !== false) return meDTO(req.user);
  await checkVerifyCode(req.user, req.body?.code);
  return meDTO(await col('users').findOne({ _id: req.user._id }));
}));

// typed the email wrong at sign-up: fix it before it is confirmed, a new code goes to the new address
r.post('/auth/change-email', ah(async (req) => {
  if (!req.user) throw httpError(401, 'Please log in');
  if (req.user.emailVerified !== false) throw httpError(400, 'Your email is already confirmed');
  const email = normEmail(req.body?.email);
  if (!validEmail(email)) throw httpError(400, 'Enter a valid email address');
  if (email !== req.user.email && (await col('users').findOne({ email }))) throw httpError(409, 'An account with this email already exists');
  await col('users').updateOne({ _id: req.user._id }, { $set: { email } });
  await col('authtokens').deleteOne({ _id: `code:${req.user._id}` }); // the old code (and its 1-minute wait) goes
  const user = await col('users').findOne({ _id: req.user._id });
  await sendVerifyCode(user);
  return meDTO(user);
}));

// always "ok" — never tells a stranger whether an address has an account
r.post('/auth/forgot', ah(async (req) => {
  const email = normEmail(req.body?.email);
  const key = `forgot:${clientIp(req)}`;
  if (isLocked(key, 10)) throw httpError(429, 'Too many requests — wait 15 minutes');
  addFail(key);
  const user = email ? await col('users').findOne({ email, disabled: { $ne: true } }) : null;
  if (user) {
    const { appUrl } = await getSmtp();
    const url = `${appUrl}/reset-password?token=${await makeToken(user._id, 'reset')}`;
    await sendEmail(user.email, 'Reset your password — FB Lead Finder', emailHtml('Reset your password', 'Someone (hopefully you) asked to reset the password of this account. The link works for 1 hour.', 'Choose a new password', url), `Reset your password: ${url}`).catch((e) => log('warn', `Reset email to ${user.email}: ${e.message}`));
  }
  return { ok: true };
}));

r.post('/auth/reset', ah(async (req, res) => {
  checkPasswordRules(req.body?.password);
  const user = await useToken(req.body?.token, 'reset');
  if (!user || user.disabled) throw httpError(400, 'This link has expired — ask for a new one');
  // the email link proves the address too
  await col('users').updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(req.body.password), emailVerified: true } });
  await col('sessions').deleteMany({ userId: user._id });
  await startSession(req, res, user);
  return meDTO(await col('users').findOne({ _id: user._id }));
}));

r.get('/auth/me', ah(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  return meDTO(req.user);
}));

r.post('/auth/login', ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const ipKey = `ip:${clientIp(req)}`;
  const emailKey = `email:${email}`;
  if (isLocked(ipKey) || isLocked(emailKey, MAX_EMAIL_FAILS)) throw httpError(429, 'Too many wrong attempts. Wait 15 minutes and try again.');
  const user = email ? await col('users').findOne({ email }) : null;
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await DUMMY_HASH), false);
  if (!ok || user.disabled) {
    addFail(ipKey);
    addFail(emailKey);
    if (user && ok && user.disabled) throw httpError(403, 'This account is disabled');
    throw httpError(401, 'Wrong email or password');
  }
  fails.delete(emailKey);
  await col('users').updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  await startSession(req, res, user);
  return meDTO(user);
}));

r.post('/auth/logout', ah(async (req, res) => {
  if (req.sessionId) await col('sessions').deleteOne({ _id: req.sessionId });
  res.clearCookie(COOKIE, cookieOptions(req));
  return { ok: true };
}));

r.post('/auth/password', ah(async (req) => {
  if (!req.user) throw httpError(401, 'Please log in');
  const { current, next } = req.body || {};
  if (!(await verifyPassword(String(current || ''), req.user.passwordHash))) throw httpError(400, 'The current password is wrong');
  checkPasswordRules(next);
  await col('users').updateOne({ _id: req.user._id }, { $set: { passwordHash: await hashPassword(next) } });
  // log out every other device
  await col('sessions').deleteMany({ userId: req.user._id, _id: { $ne: req.sessionId } });
  return { ok: true };
}));

r.post('/auth/signup', ah(async (req, res) => {
  if (!(await signupOpen())) throw httpError(403, 'Sign-up is closed right now.');
  const ipKey = `signup:${clientIp(req)}`;
  if (isLocked(ipKey, 5)) throw httpError(429, 'Too many sign-ups from this network. Try again later.');
  const { email, password } = req.body || {};
  const profile = checkProfile(req.body);
  // one phone number = one free trial (free credits are not for farming)
  if (await col('users').findOne({ phone: profile.phone })) throw httpError(409, 'An account with this phone number already exists — log in instead');
  const user = await createUser({ email, name: `${profile.firstName} ${profile.lastName}`, password, role: 'member', emailVerified: false, profile });
  addFail(ipKey); // counts sign-ups per IP (5 per 15 min) — only real ones, not typing mistakes
  await log('info', `New sign-up: ${user.email} (${profile.country}, ${profile.phone})`);
  await startSession(req, res, user);
  let codeSent = true;
  await sendVerifyCode(user).catch((e) => {
    codeSent = false;
    log('warn', `Code email to ${user.email}: ${e.message}`);
  });
  return { ...(await meDTO(user)), codeSent };
}));

export const authRoutes = r;
