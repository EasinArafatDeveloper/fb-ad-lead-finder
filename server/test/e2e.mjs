// End-to-end test against the running server. Run inside the container:
//   docker cp server/test/e2e.mjs fb-leads:/app/server/e2e.mjs && docker exec fb-leads node e2e.mjs
// Creates temporary users/pages (prefix e2e-), checks multi-user isolation, the worker flow and the safety fixes,
// then deletes everything it created.
import crypto from 'node:crypto';
import { connect, col } from './src/db.js';
import { createUser } from './src/auth.js';
import { deleteWorkspaceData } from './src/projects.js';
import { isPrivateIp, websiteContacts } from './src/contacts.js';

const BASE = 'http://127.0.0.1:4000';
const WK = process.env.WORKER_KEY;
const tag = crypto.randomBytes(3).toString('hex');
const P = (n) => `e2e${tag}${n}`; // page ids (digits not required)
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};

async function req(method, path, { cookie, body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}
const worker = (method, path, body) => req(method, `/api/worker${path}`, { body, headers: { 'x-api-key': WK } });
async function login(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  return { ...r, cookie: (r.setCookie || '').split(';')[0] };
}

const ad = (id, pageId, extra = {}) => ({ adId: `${P('ad')}${id}`, pageId, pageName: `Shop ${pageId}`, body: `Ad ${id}`, linkUrl: '', ...extra });

await connect();
const pw = crypto.randomBytes(9).toString('hex');
const A = await createUser({ email: `e2e-a-${tag}@test.local`, name: 'E2E Admin', password: pw, role: 'admin' });
const B = await createUser({ email: `e2e-b-${tag}@test.local`, name: 'E2E Member', password: pw, role: 'member', searchesPerDay: 2 });
const created = [A, B];

try {
  // ---------- auth ----------
  ok((await req('GET', '/api/stats')).status === 401, 'API without login → 401');
  ok((await login(A.email, 'wrong-password')).status === 401, 'wrong password → 401');
  const a = await login(A.email, pw);
  const b = await login(B.email, pw);
  ok(a.status === 200 && a.cookie.startsWith('fblf_sid='), 'admin login sets a session cookie');
  ok(/HttpOnly/i.test(a.setCookie) && /SameSite=Lax/i.test(a.setCookie), 'cookie is HttpOnly + SameSite=Lax');
  ok((await req('GET', '/api/auth/me', { cookie: b.cookie })).json.user?.role === 'member', '/auth/me returns the member');
  ok((await req('GET', '/api/stats?key=anything')).status === 401, '?key= query login no longer works');

  // ---------- admin ingests ads (P1 shared, P2 only A) ----------
  const ing = await req('POST', '/api/dev/ingest', {
    cookie: a.cookie,
    body: {
      keyword: `e2e ${tag}`, country: 'BD',
      ads: [
        ad(1, P(1), { linkUrl: 'https://wa.me/8801711000001' }),
        ad(2, P(2), { body: '=HYPERLINK("http://evil.example","click")' }),
      ],
    },
  });
  ok(ing.status === 200 && ing.json.pages === 2, 'admin: ingest 2 pages');
  let la = await req('GET', '/api/leads?per=200', { cookie: a.cookie });
  ok(la.json.total === 2, 'admin sees 2 leads');
  ok(la.json.items.find((l) => l.pageId === P(1))?.whatsapp?.[0] === '+8801711000001', 'WhatsApp taken from the ad link (wa.me)');

  // ---------- isolation ----------
  let lb = await req('GET', '/api/leads', { cookie: b.cookie });
  ok(lb.json.total === 0, "member does NOT see the admin's leads");
  const projA = (await req('GET', '/api/projects', { cookie: a.cookie })).json[0];
  ok((await req('GET', `/api/projects/${projA.id}/items`, { cookie: b.cookie })).status === 404, "member can't open the admin's project");
  ok((await req('GET', `/api/leads/${P(1)}`, { cookie: b.cookie })).status === 404, "member can't open the admin's lead");
  ok((await req('GET', '/api/admin/users', { cookie: b.cookie })).status === 403, 'member → /admin/users is 403');
  ok((await req('PUT', '/api/settings', { cookie: b.cookie, body: { worker: { dailyLimit: 9999 } } })).status === 403, "member can't change worker settings");
  ok((await req('GET', '/api/leads?kw[$ne]=x', { cookie: b.cookie })).json.total === 0, 'query operator injection (kw[$ne]) finds nothing');

  // ---------- member search + quota ----------
  const job = await req('POST', '/api/jobs', { cookie: b.cookie, body: { keywords: `e2e b ${tag}`, country: 'BD' } });
  ok(job.status === 200, 'member queues a search');
  ok((await req('POST', '/api/jobs', { cookie: b.cookie, body: { keywords: 'x1\nx2', country: 'BD' } })).status === 429, 'daily search limit (2) enforced');
  ok((await req('GET', '/api/jobs', { cookie: a.cookie })).json.every((j) => !j.keyword.startsWith('e2e b')), "admin's search list doesn't show the member's search");

  // ---------- worker ----------
  ok((await req('GET', '/api/worker/status')).status === 401, 'worker API without key → 401');
  // move other queued jobs out of the way is not needed: oldest first; ours may not be first on a busy server
  const bJob = await col('jobs').findOne({ workspaceId: B.workspaceId });
  await col('jobs').updateOne({ _id: bJob._id }, { $set: { phase: 'collecting', startedAt: new Date(), lastActivity: new Date() } });
  const adsRes = await worker('POST', '/ads', { jobId: String(bJob._id), ads: [ad(3, P(1)), ad(4, P(3))] });
  ok(adsRes.status === 200 && adsRes.json.pages === 2, 'worker sends ads for the member (P1 shared, P3 new)');
  await worker('POST', '/collect-done', { jobId: String(bJob._id), reason: 'done' });
  lb = await req('GET', '/api/leads', { cookie: b.cookie });
  ok(lb.json.total === 2, 'member now has 2 leads');
  ok((await col('pages').countDocuments({ pageId: P(1) })) === 1, 'shared page P1 stored once');

  // page result for P1 → both workspaces get it
  const result = {
    finalUrl: 'https://www.facebook.com/toyshop.com.bd/',
    pageName: 'Toy Shop BD',
    pageCategory: 'Toy shop',
    phones: ['01771-084424'],
    emails: ['fb@toyshop.com.bd'],
    links: ['https://www.instagram.com/toyshop_bd/', 'https://toyshop.com.bd/'],
    sections: { Page: 'Intro\nPage · Toy shop · Shopping centre · Games/toys\n01771-084424\n+880 1771-084424\nfb@toyshop.com.bd' },
    fullText: 'Intro\nPage · Toy shop · Shopping centre · Games/toys\n01771-084424\n+880 1771-084424\nfb@toyshop.com.bd',
  };
  await col('pages').updateOne({ pageId: P(1) }, { $set: { scrapeStatus: 'working' } });
  ok((await worker('POST', '/result', { pageId: P(1), result })).status === 200, 'worker posts the page result');
  const p1a = (await req('GET', `/api/leads/${P(1)}`, { cookie: a.cookie })).json.lead;
  const p1b = (await req('GET', `/api/leads/${P(1)}`, { cookie: b.cookie })).json.lead;
  ok(p1a.scrapeStatus === 'done' && p1b.scrapeStatus === 'done', 'one page read → done for BOTH workspaces');
  ok(p1a.emails?.[0] === 'fb@toyshop.com.bd' && p1b.phones?.[0] === '+8801771084424', 'email + phone copied to both');
  ok(p1a.instagram === 'https://www.instagram.com/toyshop_bd/', 'Instagram from the link');
  ok((p1a.whatsapp || []).includes('+8801771084424'), 'WhatsApp detected (+880 next to the local number)');

  // member's own correction survives the next scrape
  await req('PATCH', `/api/leads/${P(1)}`, { cookie: b.cookie, body: { phones: '01999999999' } });
  await col('pages').updateOne({ pageId: P(1) }, { $set: { scrapeStatus: 'working' } });
  await worker('POST', '/result', { pageId: P(1), result: { ...result, phones: ['01888888888'] } });
  const p1b2 = (await req('GET', `/api/leads/${P(1)}`, { cookie: b.cookie })).json.lead;
  const p1a2 = (await req('GET', `/api/leads/${P(1)}`, { cookie: a.cookie })).json.lead;
  ok(p1b2.phones.length === 1 && p1b2.phones[0] === '+8801999999999', "member's hand-typed phone is NOT overwritten");
  ok(p1a2.phones.includes('+8801888888888'), "admin's copy (not edited) gets the new phone");
  ok((await req('PATCH', `/api/leads/${P(1)}`, { cookie: b.cookie, body: { website: 'javascript:alert(1)' } })).status === 400, 'javascript: link rejected');

  // ---------- stop ----------
  const stop = await req('POST', '/api/runner/stop', { cookie: b.cookie });
  ok(stop.status === 200, 'member presses Stop');
  ok((await col('pages').findOne({ pageId: P(3) })).scrapeStatus === 'stopped', 'page only the member wanted → stopped');
  ok((await col('pages').findOne({ pageId: P(2) })).scrapeStatus === 'pending', "admin's pending page is NOT stopped by the member");

  // ---------- CSV ----------
  const csv = await fetch(`${BASE}/api/export.csv`, { headers: { cookie: a.cookie } }).then((r) => r.text());
  ok(csv.includes(`"'=HYPERLINK`) && !csv.includes('",=HYPERLINK') && !csv.includes(',"=HYPERLINK'), 'CSV: formula text is neutralised');

  // ---------- sheets: clearing cells must not delete, deleting a row must ----------
  const items = (await req('GET', `/api/projects/${projA.id}/items`, { cookie: a.cookie })).json.items;
  const leadsFolder = items.find((i) => i.name === 'Leads');
  const sheetItem = (await req('GET', `/api/projects/${projA.id}/items?parent=${leadsFolder.id}`, { cookie: a.cookie })).json.items.find((i) => i.name === 'All Leads');
  const sv = (await req('GET', `/api/sheets/${sheetItem.id}`, { cookie: a.cookie })).json;
  const live = sv.sheets[0];
  const rows = [...new Set(live.celldata.filter((x) => x.r > 0).map((x) => x.r))].sort((x, y) => x - y);
  ok(rows.length === 2, 'live sheet has 2 rows');
  // clear the FIRST row's cells (like select + Delete key)
  const cleared = { ...live, celldata: live.celldata.filter((x) => x.r !== rows[0]) };
  let put = await req('PUT', `/api/sheets/${sheetItem.id}`, { cookie: a.cookie, body: { sheets: [cleared] } });
  ok(put.status === 200 && put.json.deleted === 0, 'clearing cells of a row → nothing deleted');
  ok((await req('GET', '/api/leads', { cookie: a.cookie })).json.total === 2, 'admin still has 2 leads');
  // restore, then really delete the first row (rows below move up)
  await req('PUT', `/api/sheets/${sheetItem.id}`, { cookie: a.cookie, body: { sheets: [live] } });
  const shifted = { ...live, celldata: live.celldata.filter((x) => x.r !== rows[0]).map((x) => (x.r > rows[0] ? { ...x, r: x.r - 1 } : x)) };
  put = await req('PUT', `/api/sheets/${sheetItem.id}`, { cookie: a.cookie, body: { sheets: [shifted] } });
  ok(put.json.deleted === 1, 'deleting a row → that lead deleted');
  ok((await req('GET', '/api/leads', { cookie: a.cookie })).json.total === 1, 'admin now has 1 lead');
  ok((await req('GET', '/api/leads', { cookie: b.cookie })).json.total === 2, "member's leads untouched by the admin's delete");

  // ---------- CSRF / SSRF / sheet URL ----------
  ok((await req('POST', '/api/runner/stop', { cookie: a.cookie, headers: { origin: 'https://evil.example' } })).status === 403, 'cross-site POST blocked (Origin check)');
  ok(isPrivateIp('172.18.0.5') && isPrivateIp('169.254.169.254') && isPrivateIp('::1') && !isPrivateIp('8.8.8.8'), 'private IP detection');
  ok((await websiteContacts('http://mongodb:27017')).emails.length === 0, 'website crawler refuses an internal host');
  ok((await req('PUT', '/api/settings', { cookie: b.cookie, body: { workspace: { sheetUrl: 'http://mongodb:27017/' } } })).status === 400, 'Sheet URL must be script.google.com');

  // ---------- logout ----------
  await req('POST', '/api/auth/logout', { cookie: b.cookie });
  ok((await req('GET', '/api/stats', { cookie: b.cookie })).status === 401, 'after logout the old cookie is dead');
} catch (e) {
  failed++;
  console.log('ERROR', e.stack);
} finally {
  // ---------- cleanup ----------
  for (const u of created) {
    await deleteWorkspaceData(u.workspaceId);
    await col('sessions').deleteMany({ userId: u._id });
    await col('users').deleteOne({ _id: u._id });
  }
  await col('pages').deleteMany({ pageId: { $regex: `^e2e${tag}` } });
  await col('ads').deleteMany({ adId: { $regex: `^e2e${tag}` } });
  await col('jobs').deleteMany({ workspaceId: { $in: created.map((u) => u.workspaceId) } });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
}
