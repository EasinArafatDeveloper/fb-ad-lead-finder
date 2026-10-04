// Accounts: email + password logins (scrypt), cookie sessions, one workspace per user,
// and the separate key the Chrome extension (worker) uses.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { col, httpError, log } from './db.js';

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
export async function createUser({ email, name, password, role = 'member', searchesPerDay = DEFAULT_SEARCHES_PER_DAY }) {
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
    limits: { searchesPerDay: Math.max(0, Math.round(Number(searchesPerDay) || 0)) },
  });
  const user = { email, name, role, passwordHash: await hashPassword(password), workspaceId: ws.insertedId, disabled: false, createdAt: now };
  const { insertedId } = await col('users').insertOne(user);
  await col('workspaces').updateOne({ _id: ws.insertedId }, { $set: { ownerId: insertedId } });
  return { ...user, _id: insertedId };
}

export const userDTO = (u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null });

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

/** The Chrome extension: authenticated with WORKER_KEY, not with a user login. */
export function requireWorker(req, res, next) {
  const want = process.env.WORKER_KEY;
  if (!want) return res.status(500).json({ error: 'WORKER_KEY is not set on the server' });
  if (!safeEqual(req.get('x-api-key') || '', want)) return res.status(401).json({ error: 'Wrong worker key' });
  next();
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
// After 8 wrong passwords from one IP or for one email, wait 15 minutes. (One server process → memory is fine.)
const fails = new Map();
const WINDOW = 15 * 60e3;
const MAX_FAILS = 8;
const isLocked = (key) => {
  const f = fails.get(key);
  return !!f && f.until > Date.now() && f.n >= MAX_FAILS;
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
const signupOpen = () => process.env.ALLOW_SIGNUP === 'true';

async function meDTO(user) {
  const ws = await col('workspaces').findOne({ _id: user.workspaceId }, { projection: { name: 1, limits: 1 } });
  return { user: userDTO(user), workspace: { id: String(user.workspaceId), name: ws?.name || '', limits: ws?.limits || {} } };
}

r.get('/auth/config', (_req, res) => res.json({ signup: signupOpen() }));

r.get('/auth/me', ah(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  return meDTO(req.user);
}));

r.post('/auth/login', ah(async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const ipKey = `ip:${clientIp(req)}`;
  const emailKey = `email:${email}`;
  if (isLocked(ipKey) || isLocked(emailKey)) throw httpError(429, 'Too many wrong attempts. Wait 15 minutes and try again.');
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
  if (!signupOpen()) throw httpError(403, 'Sign-up is closed. Ask the admin for an account.');
  const ipKey = `signup:${clientIp(req)}`;
  if (isLocked(ipKey)) throw httpError(429, 'Too many sign-ups from this network. Try again later.');
  addFail(ipKey); // counts sign-ups per IP
  const { email, name, password } = req.body || {};
  const user = await createUser({ email, name, password, role: 'member' });
  await log('info', `New sign-up: ${user.email}`);
  await startSession(req, res, user);
  return meDTO(user);
}));

export const authRoutes = r;
