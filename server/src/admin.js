import http from 'node:http';
import https from 'node:https';
// Admin-only API (mounted at /api/admin behind requireAdmin): users and server logs.
import express from 'express';
import { col, httpError, log } from './db.js';
import { DEFAULT_SEARCHES_PER_DAY, ROLES, checkPasswordRules, createUser, hashPassword, userDTO } from './auth.js';
import { deleteWorkspaceData, oid } from './projects.js';
import { startOfToday } from './util.js';

const r = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && !res.headersSent && res.json(out)).catch(next);

async function userRow(u) {
  const [ws, leads, searchesToday] = await Promise.all([
    col('workspaces').findOne({ _id: u.workspaceId }, { projection: { limits: 1 } }),
    col('leads').countDocuments({ workspaceId: u.workspaceId }),
    col('jobs').countDocuments({ workspaceId: u.workspaceId, manual: { $ne: true }, createdAt: { $gte: startOfToday() } }),
  ]);
  return { ...userDTO(u), searchesPerDay: ws?.limits?.searchesPerDay ?? DEFAULT_SEARCHES_PER_DAY, leads, searchesToday };
}

const activeAdmins = (exceptId) => col('users').countDocuments({ role: 'admin', disabled: { $ne: true }, _id: { $ne: exceptId } });

r.get('/users', ah(async () => {
  const users = await col('users').find({}).sort({ createdAt: 1 }).toArray();
  return Promise.all(users.map(userRow));
}));

r.post('/users', ah(async (req) => {
  const { email, name, password, role, searchesPerDay } = req.body || {};
  const u = await createUser({ email, name, password, role: role || 'member', searchesPerDay: searchesPerDay ?? DEFAULT_SEARCHES_PER_DAY });
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
    await col('workspaces').updateOne({ _id: u.workspaceId }, { $set: { 'limits.searchesPerDay': Math.max(0, Math.min(1000, Math.round(Number(b.searchesPerDay) || 0))) } });
  }
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
      const tls = https.connect({ socket, servername: 'geo.brdtest.com' }, () => {
        tls.write(['GET /mygeo.json HTTP/1.1', 'Host: geo.brdtest.com', 'User-Agent: curl/8.0', 'Connection: close', '', ''].join(CRLF));
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
