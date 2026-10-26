// Engine tests — the scenarios of docs/ENGINE.md §4, with a fake reader instead of Facebook.
// Needs an EMPTY throw-away MongoDB (it wipes the collections it uses): run scripts/test-engine.sh, never
// against the real database.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

if (!/test/i.test(process.env.DB_NAME || '')) {
  console.error('Refusing to run: DB_NAME must contain "test" (this test wipes collections). Use scripts/test-engine.sh');
  process.exit(1);
}

const { connect, col, disconnect } = await import('../src/db.js');
const { claimPage, janitor, resetServerClaims, CHROME_GIVE_UP_MS } = await import('../src/pageQueue.js');
const { takeProxy, proxyPool } = await import('../src/proxies.js');
const { getSettings } = await import('../src/settings.js');
const SR = await import('../src/serverReader.js');
const W = await import('../src/worker.js');
const { engineHealth } = await import('../src/health.js');
const { default: express } = await import('express');

const WS = new ObjectId();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (extra = {}) => ({ kind: 'ok', result: { finalUrl: 'u', pageName: 'x', phones: ['+880 1811-998884'], emails: ['a@shop.com'], whatsapp: [], links: [], sections: { Page: 'Intro' }, fullText: 'Intro', ...extra } });

/** The fake Facebook: per page a list of answers (the last one repeats); records which IP read what. */
let script = {};
let reads = [];
function fakeReader(url, proxy) {
  const pageId = url.match(/facebook\.com\/([^/]+)/)[1];
  reads.push({ pageId, ip: proxy.id });
  const list = script[pageId] || script['*'] || [ok()];
  const out = list.length > 1 ? list.shift() : list[0];
  if (out === 'throw') throw new Error('reader exploded');
  return Promise.resolve(out);
}

async function settings(patch = {}) {
  const ips = patch.ips ?? 3;
  delete patch.ips;
  const proxyList = Array.from({ length: ips }, (_, i) => `ip${i + 1}.test:80:u${i + 1}:p`).join('\n');
  await col('settings').updateOne(
    { _id: 'main' },
    {
      $set: {
        running: true, pausedReason: '', cooldownUntil: null, dailyLimit: 1000, delayMin: 0, delayMax: 0, websiteFallback: false,
        proxyEnabled: true, proxyList, serverReader: true, serverParallel: 2, ipGapSec: 0, ...patch,
      },
    },
    { upsert: true },
  );
}

async function addPages(n, prefix = 'p') {
  const now = Date.now();
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  await col('pages').insertMany(ids.map((pageId, i) => ({ pageId, pageName: `Shop ${pageId}`, pageUrl: `https://www.facebook.com/${pageId}/`, scrapeStatus: 'pending', retries: 0, phones: [], emails: [], createdAt: new Date(now + i) })));
  await col('leads').insertMany(ids.map((pageId) => ({ workspaceId: WS, pageId, status: 'New', overrides: [], keywords: ['t'], createdAt: new Date(), updatedAt: new Date() })));
  return ids;
}

/** Start the lanes and wait until they all stopped by themselves. */
async function run() {
  await SR.kickServerReader({ stagger: 0 });
  assert.ok(await SR.lanesIdle(20000), 'lanes stopped by themselves');
}
const page = (pageId) => col('pages').findOne({ pageId });
const statuses = async () => Object.fromEntries((await col('pages').aggregate([{ $group: { _id: '$scrapeStatus', n: { $sum: 1 } } }]).toArray()).map((x) => [x._id, x.n]));

before(async () => {
  await connect();
  SR.setReaderForTests(fakeReader);
});
after(async () => {
  SR.setReaderForTests(null);
  await SR.lanesIdle();
  await disconnect();
});
beforeEach(async () => {
  for (const c of ['pages', 'leads', 'proxystate', 'settings', 'logs', 'activity', 'jobs']) await col(c).deleteMany({});
  script = {};
  reads = [];
  SR.resetStreaksForTests();
  await settings();
  // the engine tests' own workspace: the team's (unlimited) — billing has its own tests below
  await col('workspaces').updateOne({ _id: WS }, { $set: { plan: 'internal' } }, { upsert: true });
});

test('#0 every page read, contacts copied into the lead, every IP used', async () => {
  await addPages(6);
  await run();
  assert.deepEqual(await statuses(), { done: 6 });
  const lead = await col('leads').findOne({ pageId: 'p0' });
  assert.equal(lead.scrapeStatus, 'done');
  assert.deepEqual(lead.emails, ['a@shop.com']);
  assert.equal(new Set(reads.map((r) => r.ip)).size, 3, 'the load is spread over all 3 IPs');
  assert.equal((await col('proxystate').find({}).toArray()).reduce((a, x) => a + (x.pages || 0), 0), 6);
});

test('unavailable page → done, "Page not available"', async () => {
  await addPages(1);
  script.p0 = [{ kind: 'unavailable', result: { notFound: true, finalUrl: 'u' } }];
  await run();
  const p = await page('p0');
  assert.equal(p.scrapeStatus, 'done');
  assert.equal(p.lastError, 'Page not available');
});

test('#1 login wall on one IP → only that IP rests, the page is read through another IP', async () => {
  await addPages(1);
  script.p0 = [{ kind: 'wall', detail: 'redirect to login' }, ok()];
  await run();
  const p = await page('p0');
  assert.equal(p.scrapeStatus, 'done');
  assert.equal(p.loginWalls, 1);
  assert.notEqual(reads[0].ip, reads[1].ip, 'the second try used another IP');
  const resting = await col('proxystate').find({ wallUntil: { $gt: new Date() } }).toArray();
  assert.deepEqual(resting.map((x) => x._id), [reads[0].ip]);
  assert.equal((await getSettings()).running, true, 'the worker keeps running');
});

test('#2 walls on every IP → lanes stop, pages wait (not failed), nothing more is read', async () => {
  await addPages(3);
  script['*'] = [{ kind: 'wall', detail: 'login' }];
  await run();
  assert.equal(await col('proxystate').countDocuments({ wallUntil: { $gt: new Date() } }), 3);
  assert.equal((await statuses()).failed, undefined, 'no page failed because of walls on IPs');
  const before = reads.length;
  await run();
  assert.equal(reads.length, before, 'with every IP resting nothing is read');
});

test('wall rest grows 30 → 60 min on the same IP', async () => {
  await settings({ ips: 1, serverParallel: 1 });
  await addPages(1);
  script.p0 = [{ kind: 'wall', detail: 'login' }];
  await run();
  const ip = await col('proxystate').findOne({});
  assert.equal(ip.wallMin, 30);
  await col('proxystate').updateOne({ _id: ip._id }, { $set: { wallUntil: new Date(0) } }); // rest over
  await run();
  assert.equal((await col('proxystate').findOne({})).wallMin, 60);
});

test('a page walled on 6 different IPs is given up with the reason', async () => {
  await settings({ ips: 8 });
  await addPages(1);
  script.p0 = [{ kind: 'wall', detail: 'login' }];
  await run();
  const p = await page('p0');
  assert.equal(p.scrapeStatus, 'failed');
  assert.match(p.lastError, /only shows this page after login/);
  assert.equal(p.loginWalls, 6);
});

test('#3 a network error → page back to the queue (no retry used), that IP rests 10 min', async () => {
  await addPages(1);
  script.p0 = [{ kind: 'neterror', detail: 'UND_ERR_CONNECT_TIMEOUT' }, ok()];
  await run();
  const p = await page('p0');
  assert.equal(p.scrapeStatus, 'done');
  assert.ok(!p.retries, 'no retry used');
  const rest = await col('proxystate').findOne({ _id: reads[0].ip });
  assert.equal(rest.netErrors, 1);
  assert.ok(rest.wallUntil - Date.now() > 9 * 60e3);
});

test('#4 six network errors in a row → a 10 min break that ends by itself (not a pause); pages untouched', async () => {
  await settings({ ips: 10 });
  await addPages(3);
  script['*'] = [{ kind: 'neterror', detail: 'timeout — no answer within 30 s' }];
  await run();
  const s = await getSettings();
  assert.equal(s.running, true, 'still running');
  assert.ok(new Date(s.cooldownUntil) - Date.now() > 9 * 60e3, '10 min break');
  assert.match(s.cooldownReason, /don't load through the proxy \(timeout/);
  assert.equal(s.netBreaks.length, 1);
  assert.deepEqual(await statuses(), { pending: 3 });
  assert.equal(await col('pages').countDocuments({ retries: { $gt: 0 } }), 0);
  const h = await engineHealth(s);
  assert.ok(h.some((x) => x.key === 'cooldown' && /short break/.test(x.title)), 'health says why');
});

test('#4 the proxy refusing the login (407) a 3rd time within 2 hours → a real pause that waits for a person', async () => {
  await settings({ ips: 10, netBreaks: [new Date(Date.now() - 50 * 60e3), new Date(Date.now() - 20 * 60e3)] });
  await addPages(3);
  script['*'] = [{ kind: 'neterror', detail: 'proxy login refused (407)' }];
  await run();
  const s = await getSettings();
  assert.equal(s.running, false);
  assert.match(s.pausedReason, /3 times within 2 hours/);
});

// ---------------- bad IPs (real use: 30 of 100 IPs got a wall on most tries) ----------------
test('an IP that walls most of the time becomes "bad": it rests 12 h, not 30 min', async () => {
  await settings({ ips: 1, serverParallel: 1 });
  const [ip] = proxyPool(await getSettings());
  await col('proxystate').insertOne({ _id: ip.id, pages: 3, walls: 6, wallRate: 0.62, tries: 9 });
  await addPages(1);
  script.p0 = [{ kind: 'wall', detail: 'login' }];
  await run();
  const x = await col('proxystate').findOne({ _id: ip.id });
  assert.equal(x.bad, true);
  assert.ok(x.wallUntil - Date.now() > 11 * 3600e3, 'quarantined ~12 h');
  assert.ok((await engineHealth(await getSettings())).some((h) => h.key === 'ips-bad'), 'health tells to replace it');
});

test("a bad IP's wall is not held against the page; a good IP's wall is", async () => {
  await settings({ ips: 2, serverParallel: 1 });
  const [bad, good] = proxyPool(await getSettings());
  await col('proxystate').insertMany([
    { _id: bad.id, pages: 2, walls: 20, wallRate: 0.9, tries: 22, lastUsedAt: new Date(0) },
    { _id: good.id, pages: 50, walls: 1, wallRate: 0.02, tries: 51, lastUsedAt: new Date() },
  ]);
  await addPages(1);
  script.p0 = [{ kind: 'wall', detail: 'login' }, { kind: 'wall', detail: 'login' }];
  await run();
  const order = reads.map((r) => r.ip);
  assert.deepEqual(order, [bad.id, good.id], 'bad IP first (used longest ago), then the good one');
  assert.equal((await page('p0')).loginWalls, 1, 'only the good IP\'s wall counts');
});

test('the 48 pages skipped in real use came from bad IPs: a good IP read 3 of 4 — simulated here', async () => {
  await settings({ ips: 8 });
  const pool = proxyPool(await getSettings());
  // six bad IPs and two good ones; the bad ones wall, the good ones read
  for (const [i, p] of pool.entries()) await col('proxystate').insertOne({ _id: p.id, pages: i < 6 ? 2 : 80, walls: i < 6 ? 30 : 1, wallRate: i < 6 ? 0.9 : 0.02, tries: i < 6 ? 32 : 81 });
  await addPages(1);
  const badIds = new Set(pool.slice(0, 6).map((p) => p.id));
  script.p0 = [];
  SR.setReaderForTests((url, proxy) => {
    reads.push({ pageId: 'p0', ip: proxy.id });
    return Promise.resolve(badIds.has(proxy.id) ? { kind: 'wall', detail: 'login' } : ok());
  });
  await run();
  SR.setReaderForTests(fakeReader);
  const p = await page('p0');
  assert.equal(p.scrapeStatus, 'done', 'not given up — read through a good IP');
  assert.ok(!p.loginWalls, 'no wall counted against the page');
});

test('saving a new proxy list forgets the IPs that are no longer in it', async () => {
  const { forgetOldProxies } = await import('../src/proxies.js');
  const pool = proxyPool(await getSettings());
  await col('proxystate').insertMany([{ _id: pool[0].id, pages: 1 }, { _id: 'old.host:80:u', pages: 5 }]);
  await forgetOldProxies(pool);
  assert.deepEqual((await col('proxystate').find({}).toArray()).map((x) => x._id), [pool[0].id]);
});

test('#5 three unknown answers → only Chrome gets the page; ten in a row → "format changed" warning', async () => {
  await settings({ ips: 20, serverParallel: 1 });
  await addPages(4);
  script['*'] = [{ kind: 'unknown', detail: 'HTTP 200, no profile' }];
  await run();
  assert.equal(await col('pages').countDocuments({ needsBrowser: true, scrapeStatus: 'pending' }), 4);
  assert.equal((await page('p0')).serverMisses, 3);
  assert.ok(await col('logs').findOne({ msg: /changed its page format/ }), 'warning logged');
  // the server leaves them alone, Chrome can take them
  assert.equal(await claimPage('server', { forChrome: false }), null);
  assert.equal((await claimPage('chrome', { forChrome: true })).pageId, 'p0');
});

test('#6 server restart while reading → its pages back at once; Chrome\'s claim is left alone', async () => {
  await addPages(2);
  await col('pages').updateOne({ pageId: 'p0' }, { $set: { scrapeStatus: 'working', claimedBy: 'server', claimedAt: new Date() } });
  await col('pages').updateOne({ pageId: 'p1' }, { $set: { scrapeStatus: 'working', claimedBy: 'chrome', claimedAt: new Date() } });
  assert.equal(await resetServerClaims(), 1);
  assert.equal((await page('p0')).scrapeStatus, 'pending');
  assert.equal((await page('p1')).scrapeStatus, 'working');
});

test('#7 #8 janitor: a silent reader loses its page; a page Chrome never read is given up after a day', async () => {
  await addPages(2);
  await col('pages').updateOne({ pageId: 'p0' }, { $set: { scrapeStatus: 'working', claimedBy: 'chrome', claimedAt: new Date(Date.now() - 6 * 60e3) } });
  await col('pages').updateOne({ pageId: 'p1' }, { $set: { needsBrowser: true, chromeSince: new Date(Date.now() - CHROME_GIVE_UP_MS - 60e3) } });
  const out = await janitor();
  assert.deepEqual(out, { stale: 1, forgotten: 1 });
  assert.equal((await page('p0')).scrapeStatus, 'pending');
  const p1 = await page('p1');
  assert.equal(p1.scrapeStatus, 'failed');
  assert.match(p1.lastError, /Only Chrome can read this page/);
});

test('the reader crashing does not leave the page stuck in "working"', async () => {
  await addPages(1);
  script.p0 = ['throw'];
  await run();
  assert.equal((await page('p0')).scrapeStatus, 'pending');
  assert.ok(await col('logs').findOne({ msg: /reader exploded/ }));
});

test('#11 daily limit reached → nothing is read', async () => {
  await settings({ dailyLimit: 1 });
  await addPages(2);
  await col('pages').updateOne({ pageId: 'p0' }, { $set: { lastAttemptAt: new Date() } });
  await run();
  assert.equal(reads.length, 0);
});

test('paused / proxy off / server reading off → the server reads nothing', async () => {
  await addPages(1);
  for (const patch of [{ running: false }, { proxyEnabled: false }, { serverReader: false }]) {
    await settings(patch);
    await run();
    assert.equal(reads.length, 0, JSON.stringify(patch));
  }
});

test('#14 one page is never given to two readers (20 claims at once on 5 pages)', async () => {
  await addPages(5);
  const got = await Promise.all(Array.from({ length: 20 }, (_, i) => claimPage(i % 2 ? 'server' : 'chrome')));
  const ids = got.filter(Boolean).map((p) => p.pageId);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
});

// ---------------- collecting (the Ad Library tab) ----------------
const collectingJob = (silentMs, extra = {}) =>
  col('jobs').insertOne({ workspaceId: WS, keyword: 'khulna', phase: 'collecting', manual: true, adsSeen: 173, maxAds: 200, pageIds: ['a', 'b'], startedAt: new Date(), lastActivity: new Date(Date.now() - silentMs), ...extra });

test('#10 an Ad Library tab silent for 3 min → its search ends with what arrived, and says why', async () => {
  await collectingJob(W.STALE_COLLECT_MS + 1000);
  await collectingJob(10_000, { keyword: 'alive' });
  assert.equal(await W.closeStaleCollects(), 1);
  const j = await col('jobs').findOne({ keyword: 'khulna' });
  assert.equal(j.phase, 'collected');
  assert.equal(j.note, 'tab stopped responding');
  assert.equal((await col('jobs').findOne({ keyword: 'alive' })).phase, 'collecting', 'a tab that is alive keeps collecting');
  assert.ok(await col('activity').findOne({ msg: /stopped responding.*2 pages from 173 ads/ }));
});

test('#10 the reloaded tab takes its search up again; an old ended search cannot be resumed', async () => {
  const app = express().use('/w', W.default);
  const srv = app.listen(0);
  const url = (id) => `http://127.0.0.1:${srv.address().port}/w/job/${id}/resume`;
  try {
    const { insertedId: closed } = await collectingJob(0, { phase: 'collected', note: 'tab stopped responding', collectedAt: new Date() });
    const r = await fetch(url(closed), { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).job.keyword, 'khulna');
    assert.equal((await col('jobs').findOne({ _id: closed })).phase, 'collecting');
    const { insertedId: done } = await collectingJob(0, { phase: 'collected', note: 'done', collectedAt: new Date() });
    assert.equal((await fetch(url(done), { method: 'POST' })).status, 409, 'a search that finished normally stays finished');
  } finally {
    srv.close();
  }
});

test('the Ad Library panel sees how far the server is with its search (read / with contact / project)', async () => {
  await addPages(4);
  await col('leads').updateMany({ pageId: { $in: ['p0', 'p1'] } }, { $set: { scrapeStatus: 'done', phones: ['+8801711000000'] } });
  await col('leads').updateOne({ pageId: 'p2' }, { $set: { scrapeStatus: 'failed' } });
  const projectId = new ObjectId();
  const { insertedId } = await col('jobs').insertOne({ workspaceId: WS, keyword: 'k', phase: 'collected', projectId, pageIds: ['p0', 'p1', 'p2', 'p3'] });
  const srv = express().use('/w', W.default).listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/w/job/${insertedId}/progress`)).json();
    assert.deepEqual(r, { phase: 'collected', pages: 4, read: 3, withContact: 2, projectId: String(projectId) });
  } finally {
    srv.close();
  }
});

test('"Remove empty projects": only projects with 0 leads go — not one still searching, not one with a sheet typed in', async () => {
  for (const c of ['projects', 'items', 'sheets']) await col(c).deleteMany({});
  const { emptyProjects } = await import('../src/projectRoutes.js');
  const mk = async (name) => (await col('projects').insertOne({ workspaceId: WS, name, key: name, createdAt: new Date() })).insertedId;
  const empty = await mk('empty');
  const withLeads = await mk('with leads');
  const searching = await mk('searching');
  const ownSheet = await mk('own sheet');
  await addPages(1);
  await col('leads').updateOne({ pageId: 'p0' }, { $set: { projectIds: [withLeads] } });
  await col('jobs').insertOne({ workspaceId: WS, projectId: searching, phase: 'collecting', keyword: 'x' });
  const { insertedId: sheetId } = await col('items').insertOne({ workspaceId: WS, projectId: ownSheet, type: 'sheet', kind: 'custom', name: 'notes' });
  await col('sheets').insertOne({ _id: sheetId, workspaceId: WS, rowCount: 3, sheets: [] });
  const list = await emptyProjects(WS);
  assert.deepEqual(list.map((p) => String(p._id)), [String(empty)]);
});

test('"Remove empty projects" removes only the ticked ones — and never one that has leads, even if its id is sent', async () => {
  for (const c of ['projects', 'items', 'sheets']) await col(c).deleteMany({});
  const { default: projectRoutes } = await import('../src/projectRoutes.js');
  const mk = async (name) => (await col('projects').insertOne({ workspaceId: WS, name, key: name, createdAt: new Date() })).insertedId;
  const [keepMe, removeMe, hasLeads] = [await mk('keep me'), await mk('remove me'), await mk('has leads')];
  await addPages(1);
  await col('leads').updateOne({ pageId: 'p0' }, { $set: { projectIds: [hasLeads] } });
  const app = express().use(express.json()).use((req, _res, next) => ((req.ws = WS), (req.user = { role: 'admin' }), next())).use('/api', projectRoutes);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const list = await (await fetch(`${base}/projects/empty`)).json();
    assert.equal(list.count, 2);
    assert.ok(list.projects.every((p) => p.leads === 0 && 'ads' in p && 'searches' in p), 'each row says what is in it');
    const r = await (await fetch(`${base}/projects/delete-empty`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [String(removeMe), String(hasLeads)] }) })).json();
    assert.equal(r.deleted, 1);
    const left = (await col('projects').find({}).toArray()).map((p) => p.name).sort();
    assert.deepEqual(left, ['has leads', 'keep me']);
  } finally {
    srv.close();
  }
});

// ---------------- health: the Dashboard tells the engine's real story ----------------
const keys = async () => (await engineHealth(await getSettings())).map((x) => `${x.level}:${x.key}`);
const workerSeen = (secAgo, version) => col('settings').updateOne({ _id: 'worker' }, { $set: { at: new Date(Date.now() - secAgo * 1000), version } }, { upsert: true });
const latest = (await import('../src/worker-state.js')).worker.latest;

test('health: all fine → nothing to report', async () => {
  await workerSeen(5, latest);
  assert.deepEqual(await keys(), []);
});

test('health: paused, extension offline while a search waits, silent Ad Library tab', async () => {
  await settings({ running: false, pausedReason: "Pages don't load through the proxy" });
  await col('jobs').insertOne({ workspaceId: WS, keyword: 'x', phase: 'queued', createdAt: new Date() });
  await collectingJob(90_000);
  const k = await keys();
  assert.ok(k.includes('error:paused'));
  assert.ok(k.includes('error:extension-offline'), 'never connected + a search waiting');
  assert.ok(k.includes('warn:collect-silent'));
  assert.equal(k[0].split(':')[0], 'error', 'errors first');
});

test('health: old extension version; every IP resting; pages only Chrome can read', async () => {
  await workerSeen(5, '0.0.1');
  await addPages(2);
  await col('pages').updateOne({ pageId: 'p1' }, { $set: { needsBrowser: true } });
  for (const p of proxyPool(await getSettings())) await col('proxystate').updateOne({ _id: p.id }, { $set: { wallUntil: new Date(Date.now() + 60e3) } }, { upsert: true });
  const k = await keys();
  assert.ok(k.includes('warn:extension-old'));
  assert.ok(k.includes('warn:ips-resting'));
  assert.ok(k.includes('info:chrome-pages'));
});

test('health: a recent engine error is shown (e.g. Facebook changed its pages)', async () => {
  await workerSeen(5, latest);
  await col('logs').insertOne({ ts: new Date(), level: 'error', msg: 'Facebook changed its page format? 10 pages in a row were not recognised' });
  const h = await engineHealth(await getSettings());
  assert.equal(h[0].level, 'error');
  assert.match(h[0].detail, /changed its page format/);
});

test('#15 one IP is never given to two lanes, and an IP rests ipGapSec between pages', async () => {
  const pool = proxyPool({ proxyEnabled: true, proxyList: 'a.test:80:u:p\nb.test:80:u:p\nc.test:80:u:p' });
  const got = await Promise.all(Array.from({ length: 10 }, () => takeProxy(pool, 60000)));
  const ips = got.filter((x) => x.proxy).map((x) => x.proxy.id);
  assert.equal(ips.length, 3);
  assert.equal(new Set(ips).size, 3);
  assert.ok(got.filter((x) => x.busy).length === 7, 'the rest are told to wait');
});

test('All Leads shortlist: "must have" chips, followers / ads minimums, and "Most contacts" sort', async () => {
  await col('leads').deleteMany({ workspaceId: WS });
  const { leadsCursor, buildFilter, CONTACT_KINDS } = await import('../src/leads.js');
  const mk = (pageId, x) => ({ workspaceId: WS, pageId, pageName: pageId, phones: [], emails: [], whatsapp: [], website: '', followersNum: 0, adCount: 1, createdAt: new Date(), updatedAt: new Date(), ...x });
  await col('leads').insertMany([
    mk('both', { phones: ['1'], emails: ['a@x.com'], whatsapp: ['1'], followersNum: 50000, adCount: 12 }),
    mk('phone', { phones: ['2'], followersNum: 900, website: 'https://x.com' }),
    mk('email', { emails: ['b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'], followersNum: 20000 }),
    mk('none', { followersNum: 2000000 }),
  ]);
  const ids = async (q) => (await leadsCursor(WS, q, { limit: 50 }).toArray()).map((l) => l.pageId);
  assert.deepEqual((await ids({ need: 'phone,email' })).sort(), ['both']);
  assert.deepEqual((await ids({ need: 'website' })).sort(), ['phone']);
  assert.deepEqual((await ids({ has: 'none' })).sort(), ['none']);
  assert.deepEqual((await ids({ minFollowers: '10000', need: 'email' })).sort(), ['both', 'email']);
  assert.deepEqual(await ids({ minAds: '10' }), ['both']);
  assert.deepEqual(await ids({ sort: 'contacts', dir: 'desc' }), ['email', 'both', 'phone', 'none'], '4 emails > phone+wa+email > 1 phone > nothing');
  assert.deepEqual(await ids({ sort: 'followers', dir: 'desc', need: 'phone' }), ['both', 'phone']);
  // the chip counts
  const base = buildFilter(WS, {});
  const n = async (k) => col('leads').countDocuments({ $and: [...base.$and, CONTACT_KINDS[k]] });
  assert.deepEqual([await n('phone'), await n('email'), await n('whatsapp'), await n('website'), await n('none')], [2, 2, 1, 1, 1]);
  // a "$ne" trick in the query stays a plain string
  assert.equal((await ids({ minFollowers: { $gt: '' } })).length, 4);
  await col('leads').deleteMany({ workspaceId: WS });
});

test('"Max ads per keyword" goes up to 50,000 — saved in Settings and used by a new search', async () => {
  const { clampMaxAds, updateSettings, getSettings: gs } = await import('../src/settings.js');
  assert.equal(clampMaxAds(20000), 20000);
  assert.equal(clampMaxAds(80000), 50000);
  assert.equal(clampMaxAds(3), 10);
  assert.equal(clampMaxAds('', 300), 300);
  await updateSettings({ maxAds: 20000 });
  assert.equal((await gs()).maxAds, 20000);
  await updateSettings({ maxAds: 200 });
});

test('"Search ready" notification: only when every page is read, only once, never for old searches', async () => {
  const { notifyFinishedSearches } = await import('../src/notify.js');
  await col('settings').deleteOne({ _id: 'notify' });
  await col('jobs').deleteMany({});
  await col('leads').deleteMany({ workspaceId: WS });
  await notifyFinishedSearches(); // first run: "notifications start now"
  const since = (await col('settings').findOne({ _id: 'notify' })).since;
  const job = async (keyword, collectedAt) => String((await col('jobs').insertOne({ workspaceId: WS, keyword, country: 'BD', phase: 'collected', collectedAt, pageIds: ['n1', 'n2'], adsSeen: 3 })).insertedId);
  const old = await job('old search', new Date(since.getTime() - 60000));
  const fresh = await job('fresh search', new Date(since.getTime() + 1000));
  const lead = (pageId, scrapeStatus, x = {}) => ({ workspaceId: WS, pageId, jobIds: [fresh, old], scrapeStatus, phones: [], emails: [], whatsapp: [], ...x });
  await col('leads').insertMany([lead('n1', 'done', { phones: ['+880 1711-000000'] }), lead('n2', 'pending')]);
  assert.equal(await notifyFinishedSearches(), 0, 'a page is still waiting');
  await col('leads').updateOne({ workspaceId: WS, pageId: 'n2' }, { $set: { scrapeStatus: 'done', emails: ['a@b.com'] } });
  assert.equal(await notifyFinishedSearches(), 1, 'now it is done');
  assert.ok((await col('jobs').findOne({ keyword: 'fresh search' })).notifiedAt);
  assert.equal(await notifyFinishedSearches(), 0, 'announced once');
  assert.equal((await col('jobs').findOne({ keyword: 'old search' })).notifiedAt, undefined, 'searches from before are never announced');
  await col('leads').deleteMany({ workspaceId: WS });
});

test('Notification emails: several addresses, checked and de-duplicated; an old single address still works', async () => {
  const { parseRecipients, prefsOf } = await import('../src/notify.js');
  assert.deepEqual(parseRecipients('A@x.com, b@y.com; a@x.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseRecipients(['c@z.org']), ['c@z.org']);
  assert.deepEqual(parseRecipients(''), []);
  assert.throws(() => parseRecipients('not-an-email'), /not a valid email/);
  assert.throws(() => parseRecipients(Array.from({ length: 11 }, (_, i) => `u${i}@x.com`)), /At most 10/);
  assert.deepEqual(prefsOf({ notify: { to: 'old@x.com' } }).to, ['old@x.com']);
  assert.deepEqual(prefsOf({}).to, []);
});

test('5 keywords: each one is announced when ITS pages are all read; two finishing together share one message', async () => {
  const { notifyFinishedSearches } = await import('../src/notify.js');
  await col('jobs').deleteMany({});
  await col('leads').deleteMany({ workspaceId: WS });
  await notifyFinishedSearches(); // the settings are reset before each test — this sets "notifications start now"
  const since = (await col('settings').findOne({ _id: 'notify' })).since;
  const ids = [];
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) {
    const id = String((await col('jobs').insertOne({ workspaceId: WS, keyword: k, country: 'BD', phase: 'collected', collectedAt: new Date(since.getTime() + 5000), pageIds: [`${k}-p`] })).insertedId);
    ids.push(id);
    await col('leads').insertOne({ workspaceId: WS, pageId: `${k}-p`, jobIds: [id], scrapeStatus: 'pending', phones: [], emails: [], whatsapp: [] });
  }
  const read = (k) => col('leads').updateOne({ workspaceId: WS, pageId: `${k}-p` }, { $set: { scrapeStatus: 'done' } });
  assert.equal(await notifyFinishedSearches(), 0, 'nothing read yet');
  await read('k1');
  assert.equal(await notifyFinishedSearches(), 1, 'k1 done');
  await read('k2');
  await read('k3');
  assert.equal(await notifyFinishedSearches(), 2, 'k2 + k3 done together → one message about both');
  assert.equal(await notifyFinishedSearches(), 0);
  await read('k4');
  await read('k5');
  assert.equal(await notifyFinishedSearches(), 2);
  assert.equal(await col('jobs').countDocuments({ notifiedAt: { $exists: true } }), 5, 'all five announced, each once');
  await col('leads').deleteMany({ workspaceId: WS });
});

test('20 lanes: a few dead IPs among good reads are noise — no break', async () => {
  await settings({ ips: 30, serverParallel: 20 });
  await addPages(40);
  // every 4th page fails to load on its first try, the rest read fine
  for (let i = 0; i < 40; i += 4) script[`p${i}`] = [{ kind: 'neterror', detail: 'fetch failed' }, ok()];
  await run();
  const s = await getSettings();
  assert.ok(!s.cooldownUntil || new Date(s.cooldownUntil) < new Date(), 'no break');
  assert.deepEqual(await statuses(), { done: 40 });
});

test('an outage that keeps coming back → longer breaks (10 → 20 → 30 min), never a stop that waits for a person', async () => {
  await settings({ ips: 10, netBreaks: [new Date(Date.now() - 50 * 60e3), new Date(Date.now() - 20 * 60e3)] });
  await addPages(3);
  script['*'] = [{ kind: 'neterror', detail: 'fetch failed' }];
  await run();
  const s = await getSettings();
  assert.equal(s.running, true, 'still running — it goes on by itself');
  assert.ok(new Date(s.cooldownUntil) - Date.now() > 29 * 60e3, '3rd break is 30 min');
});

test('the same keyword is not queued twice while it is waiting or collecting', async () => {
  const { default: routes } = await import('../src/routes.js');
  const user = { _id: new ObjectId(), role: 'admin' };
  const app = express().use(express.json()).use((req, _res, next) => ((req.ws = WS), (req.user = user), next())).use('/api', routes);
  const srv = app.listen(0);
  const post = async (keywords) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keywords, country: 'BD' }) })).json();
  try {
    assert.deepEqual(await post(['Borka', 'Hijab']), { created: 2, skipped: [] });
    assert.deepEqual(await post(['borka ', 'Khimar']), { created: 1, skipped: ['borka'] });
    assert.equal(await col('jobs').countDocuments({ workspaceId: WS }), 3);
    await col('jobs').updateMany({ workspaceId: WS }, { $set: { phase: 'collected' } });
    assert.equal((await post(['Borka'])).created, 1, 'a finished keyword can be searched again');
  } finally {
    srv.close();
  }
});

test('Computers: a PC with "Runs Dashboard searches" off never gets one; the search remembers which PC runs it', async () => {
  const { default: workerRoutes } = await import('../src/worker.js');
  await col('pcs').deleteMany({});
  await col('pcs').insertMany([
    { _id: 'sir-pc', name: "Sir's PC", ip: '1.1.1.1', takeQueue: false, lastSeen: new Date() },
    { _id: 'dev-pc', name: 'Dev PC', ip: '2.2.2.2', takeQueue: true, lastSeen: new Date() },
  ]);
  // the team's computers run the team's (internal-plan) searches
  await col('workspaces').updateOne({ _id: WS }, { $set: { plan: 'internal' } }, { upsert: true });
  await col('jobs').insertOne({ workspaceId: WS, keyword: 'Skincare', country: 'BD', phase: 'queued', maxAds: 100, pageIds: [], createdAt: new Date() });
  const as = (pc) => express().use(express.json()).use((req, _res, next) => ((req.pcId = pc), next())).use('/api/worker', workerRoutes);
  const ask = async (pc) => {
    const srv = as(pc).listen(0);
    try {
      return await (await fetch(`http://127.0.0.1:${srv.address().port}/api/worker/next-collect`, { headers: { 'x-ext-version': '3.5.5' } })).json();
    } finally {
      srv.close();
    }
  };
  const sir = await ask('sir-pc');
  assert.equal(sir.job, null);
  assert.match(sir.reason, /does not run Dashboard searches/);
  assert.equal((await col('jobs').findOne({ keyword: 'Skincare' })).phase, 'queued', 'still waiting for the right PC');
  const dev = await ask('dev-pc');
  assert.equal(dev.job.keyword, 'Skincare');
  assert.equal((await col('jobs').findOne({ keyword: 'Skincare' })).collector, 'dev-pc');
  await col('pcs').deleteMany({});
});

// ---------------- SaaS: credits, orders, limits, one customer never sees another ----------------
const B = await import('../src/billing.js');
async function customer(credits, { plan = 'free', verified = true } = {}) {
  const ws = (await col('workspaces').insertOne({ name: 'c', plan, credits, planStatus: 'trial', limits: {} })).insertedId;
  const user = { _id: new ObjectId(), role: 'member', workspaceId: ws, emailVerified: verified, email: `u${Date.now()}@x.com` };
  await col('users').insertOne(user);
  B.forgetFunded();
  return { ws, user };
}

test('Credits: 1 page read = 1 credit, taken when the data is handed over; failed and "not available" pages are free; the team is never charged', async () => {
  await B.ensurePlans();
  const { syncLeads } = await import('../src/leads.js');
  const a = await customer(10);
  const team = (await col('workspaces').insertOne({ name: 'team', plan: 'internal', credits: 0 })).insertedId;
  const page = (pageId, x) => ({ pageId, scrapeStatus: 'done', phones: ['+8801711000000'], emails: [], createdAt: new Date(), ...x });
  await col('pages').insertMany([page('r1'), page('r2'), page('r3'), page('bad', { scrapeStatus: 'failed' }), page('gone', { lastError: 'Page not available', phones: [] }), page('wait', { scrapeStatus: 'pending', phones: [] }), page('t1')]);
  const lead = (ws, pageId) => ({ workspaceId: ws, pageId, keywords: ['shoes'], scrapeStatus: 'pending', phones: [] });
  await col('leads').insertMany(['r1', 'r2', 'r3', 'bad', 'gone', 'wait'].map((id) => lead(a.ws, id)).concat([lead(team, 't1')]));
  await syncLeads(['r1', 'r2', 'r3', 'bad', 'gone', 'wait', 't1']);
  assert.equal((await col('workspaces').findOne({ _id: a.ws })).credits, 7, '3 pages read → 3 credits, taken at once');
  assert.equal((await col('workspaces').findOne({ _id: team })).credits, 0, 'internal plan: nothing taken');
  await B.chargeReadPages();
  const usage = await col('ledger').findOne({ workspaceId: a.ws, kind: 'usage' });
  assert.equal(usage.delta, -3);
  assert.match(usage.reason, /3 pages read: shoes/);
  await syncLeads(['r1', 'r2', 'r3']);
  await B.chargeReadPages();
  assert.equal((await col('workspaces').findOne({ _id: a.ws })).credits, 7, 'never charged twice');
});

test('Credits: a running search may go below 0 down to -50 (the overdraft), then it stops; buying credits pays the minus back and hands over the rest', async () => {
  const { syncLeads } = await import('../src/leads.js');
  B.forgetOverdraft();
  const c = await customer(-48);
  const ids = ['k1', 'k2', 'k3', 'k4', 'k5'];
  await col('pages').insertMany(ids.map((pageId) => ({ pageId, scrapeStatus: 'done', phones: ['+8801711000000'], emails: ['a@b.com'], createdAt: new Date() })));
  await col('leads').insertMany(ids.map((pageId) => ({ workspaceId: c.ws, pageId, keywords: ['gadget'], scrapeStatus: 'pending', phones: [], emails: [] })));
  await syncLeads(ids);
  assert.equal((await col('workspaces').findOne({ _id: c.ws })).credits, -50, 'stopped exactly at -50');
  const got = await col('leads').find({ workspaceId: c.ws }).toArray();
  assert.equal(got.filter((l) => l.phones.length).length, 2, 'only 2 more pages handed over');
  assert.equal(got.filter((l) => l.awaitingCredits && l.scrapeStatus === 'pending' && !l.phones.length).length, 3, 'the other 3 wait, with nothing shown');
  const { claimPage } = await import('../src/pageQueue.js');
  await col('pages').insertOne({ pageId: 'new1', scrapeStatus: 'pending', wantedBy: [c.ws], createdAt: new Date() });
  B.forgetFunded();
  assert.equal(await claimPage('server'), null, 'at -50 nothing more is read');
  await B.changeCredits(c.ws, 10, { kind: 'purchase', reason: 'test' }); // -50 + 10 = -40: the minus is paid back first
  await B.deliverAwaiting(c.ws);
  const after = await col('leads').find({ workspaceId: c.ws }).toArray();
  assert.equal(after.filter((l) => l.phones.length && l.scrapeStatus === 'done').length, 5, 'all 5 handed over');
  assert.equal((await col('workspaces').findOne({ _id: c.ws })).credits, -43);
  assert.equal((await B.accountOf(c.ws)).overdraft, 50);
});
test('Credits: pages of a customer with no credits wait in the queue; buying credits lets them be read', async () => {
  const broke = await customer(-50); // at the end of the overdraft
  const rich = await customer(5);
  await col('pages').insertMany([
    { pageId: 'pb', scrapeStatus: 'pending', wantedBy: [broke.ws], createdAt: new Date(1) },
    { pageId: 'pr', scrapeStatus: 'pending', wantedBy: [rich.ws], createdAt: new Date(2) },
  ]);
  const { claimPage } = await import('../src/pageQueue.js');
  const first = await claimPage('server');
  assert.equal(first.pageId, 'pr', 'the funded customer\'s page is read, the other waits');
  assert.equal(await claimPage('server'), null, 'nothing else may be read');
  const order = await B.createOrder({ workspaceId: broke.ws, userId: broke.user._id, kind: 'pack', id: 'pack-1k' });
  assert.equal(order.status, 'pending');
  const paid = await B.markOrderPaid(order._id, { by: 'admin@x.com' });
  assert.match(paid.invoiceNo, /^INV-\d{4}-\d{5}$/);
  assert.equal(await B.markOrderPaid(order._id), null, 'paid only once');
  assert.equal((await col('workspaces').findOne({ _id: broke.ws })).credits, 950, 'the minus is paid back first');
  assert.equal((await claimPage('server')).pageId, 'pb', 'now it is read');
});

test('Orders: a plan starts for 30 days with its credits; it ends by itself', async () => {
  const c = await customer(3);
  const o = await B.createOrder({ workspaceId: c.ws, userId: c.user._id, kind: 'plan', id: 'starter' });
  await B.markOrderPaid(o._id);
  let acc = await B.accountOf(c.ws);
  assert.equal(acc.plan, 'starter');
  assert.equal(acc.planStatus, 'active');
  assert.equal(acc.credits, 3 + 2000);
  assert.equal(acc.searchesPerDay, 20);
  assert.ok(new Date(acc.periodEnd) - Date.now() > 29 * 86400e3);
  await col('workspaces').updateOne({ _id: c.ws }, { $set: { periodEnd: new Date(Date.now() - 1000) } });
  assert.equal(await B.expirePlans(), 1);
  acc = await B.accountOf(c.ws);
  assert.equal(acc.planStatus, 'expired');
  assert.equal(acc.searchesPerDay, 3, 'back to the free plan\'s limits');
  assert.equal(acc.credits, 2003, 'credits stay');
});

test('Limits: no credits → no new search (402); email not confirmed → 403; the plan caps max ads', async () => {
  const { default: routes } = await import('../src/routes.js');
  const post = async (c, body) => {
    const app = express().use(express.json()).use((req, _res, next) => ((req.ws = c.ws), (req.user = c.user), next())).use('/api', routes).use((err, _q, res, _n) => res.status(err.status || 500).json({ error: err.message }));
    const srv = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    } finally {
      srv.close();
    }
  };
  const broke = await customer(0);
  assert.equal((await post(broke, { keywords: ['shoes'] })).status, 402);
  const unverified = await customer(100, { verified: false });
  assert.equal((await post(unverified, { keywords: ['shoes'] })).status, 403);
  const ok = await customer(100);
  assert.equal((await post(ok, { keywords: ['shoes'], maxAds: 20000 })).body.created, 1);
  assert.equal((await col('jobs').findOne({ workspaceId: ok.ws })).maxAds, 500, 'the free plan allows 500 ads per search');
  await post(ok, { keywords: ['bags'], minAds: 5 });
  assert.equal((await col('jobs').findOne({ workspaceId: ok.ws, keyword: 'bags' })).minAds, 1, 'the free plan has no N+ ads filter');
  const paid = await customer(100, { plan: 'starter' });
  await post(paid, { keywords: ['bags'], minAds: 5, maxAds: 20000 });
  const pj = await col('jobs').findOne({ workspaceId: paid.ws });
  assert.equal(pj.minAds, 5, 'a paid plan has it');
  assert.equal(pj.maxAds, 5000, 'Starter: up to 5,000 ads');
});

test('Extension keys: a customer\'s extension runs only that customer\'s searches; the team\'s computers only the team\'s', async () => {
  const { default: workerRoutes } = await import('../src/worker.js');
  const { createExtensionKey, requireWorker } = await import('../src/auth.js');
  const a = await customer(50);
  const b = await customer(50);
  const team = (await col('workspaces').insertOne({ name: 'team', plan: 'internal', credits: 0 })).insertedId;
  const job = async (ws, keyword, createdAt) => col('jobs').insertOne({ workspaceId: ws, keyword, country: 'BD', phase: 'queued', maxAds: 100, pageIds: [], createdAt });
  await job(b.ws, 'B-first', new Date(1));
  await job(a.ws, 'A-search', new Date(2));
  await job(team, 'team-search', new Date(3));
  const keyA = await createExtensionKey(a.user, 'test');
  process.env.WORKER_KEY = process.env.WORKER_KEY || 'test-worker-key';
  const app = express().use(express.json()).use('/api/worker', requireWorker, workerRoutes);
  const srv = app.listen(0);
  const next = async (key) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/worker/next-collect`, { headers: { 'x-api-key': key, 'x-ext-version': '3.5.5' } })).json();
  try {
    assert.equal((await next(keyA)).job.keyword, 'A-search', "A's extension skips B's older search");
    assert.equal((await next(process.env.WORKER_KEY)).job.keyword, 'team-search', "the team's computer skips the customers' searches");
    assert.equal((await next(keyA)).reason, 'busy', 'one search at a time per account');
    const bad = await fetch(`http://127.0.0.1:${srv.address().port}/api/worker/next-collect`, { headers: { 'x-api-key': 'ext_wrong' } });
    assert.equal(bad.status, 401);
  } finally {
    srv.close();
  }
});

test('Sign-up: name, country, valid phone; nothing opens until the 6-digit email code is entered', async () => {
  const { createApp } = await import('../src/app.js');
  await B.ensurePlans();
  await col('settings').updateOne({ _id: 'billing' }, { $set: { signupOpen: true } }, { upsert: true });
  const srv = createApp().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  let cookie = '';
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const email = `new${Date.now()}@example.com`;
  try {
    const form = { firstName: 'Rahim', lastName: 'Uddin', country: 'BD', phone: '01712345678', email, password: 'a-good-password' };
    assert.equal((await call('/auth/signup', { ...form, phone: '12345' })).status, 400, 'a wrong phone number is refused');
    assert.equal((await call('/auth/signup', { ...form, firstName: '' })).status, 400, 'the first name is needed');
    const ok = await call('/auth/signup', form);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.emailVerified, false);
    assert.equal(ok.body.user.phone, '+8801712345678', 'stored with the country code');
    assert.equal(ok.body.user.name, 'Rahim Uddin');
    assert.equal(ok.body.account.credits, (await B.getPlan('free')).credits, 'free trial credits');
    assert.equal((await call('/jobs', { keywords: ['shoes'] })).body.verify, true, 'the app is closed before the code');
    assert.equal((await call('/stats')).status, 403);
    assert.equal((await call('/auth/signup', { ...form, email: `other${Date.now()}@example.com` })).status, 409, 'one phone number, one free trial');
    // the code from the email (here: set to a known one)
    const user = await col('users').findOne({ email });
    const sha = (await import('node:crypto')).createHash('sha256');
    await col('authtokens').updateOne({ _id: `code:${user._id}` }, { $set: { hash: sha.update(`${user._id}:123456`).digest('hex'), tries: 0, email, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });
    const wrong = await call('/auth/verify-code', { code: '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /4 tries left/);
    const right = await call('/auth/verify-code', { code: '123 456' });
    assert.equal(right.status, 200);
    assert.equal(right.body.user.emailVerified, true);
    assert.equal((await call('/stats')).status, 200, 'now the app opens');
  } finally {
    srv.close();
    const u = await col('users').findOne({ email });
    if (u) await col('users').deleteOne({ _id: u._id });
  }
});

test('Plan perks: a plan only gets what it includes — Excel, Sheet sync and alerts are refused (402) on the free plan', async () => {
  await B.ensurePlans();
  const { default: routes } = await import('../src/routes.js');
  const as = (c) => express().use(express.json()).use((req, _res, next) => ((req.ws = c.ws), (req.user = c.user), next())).use('/api', routes).use((err, _q, res, _n) => res.status(err.status || 500).json({ error: err.message }));
  const hit = async (c, method, path) => {
    const srv = as(c).listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      return { status: r.status, body: await r.text() };
    } finally {
      srv.close();
    }
  };
  const free = await customer(50);
  for (const [m, path] of [['GET', '/export.xlsx'], ['POST', '/sheet/sync'], ['POST', '/notify/test']]) {
    const r = await hit(free, m, path);
    assert.equal(r.status, 402, `${path} is refused on the free plan`);
    assert.match(r.body, /not in your plan/);
  }
  assert.equal((await hit(free, 'GET', '/export.csv')).status, 200, 'CSV is for everybody');
  const starter = await customer(50, { plan: 'starter' });
  assert.equal((await hit(starter, 'GET', '/export.xlsx')).status, 200, 'Starter has Excel');
  assert.equal((await hit(starter, 'POST', '/sheet/sync')).status, 402, 'Starter has no Sheet sync');
  assert.deepEqual((await B.accountOf(starter.ws)).perks, { excelExport: true, notifications: true, minAdsFilter: true, sheetSync: false });
  assert.equal((await B.accountOf(free.ws)).perks.notifications, false);
});

test('The bell: an order, its payment, the credit milestones and a notice from the team reach the account; opening the box marks them read', async () => {
  const I = await import('../src/inbox.js');
  B.forgetOverdraft();
  const c = await customer(11);
  const user = await col('users').findOne({ workspaceId: c.ws });
  const o = await B.createOrder({ workspaceId: c.ws, userId: user._id, kind: 'pack', id: 'pack-1k' });
  await B.markOrderPaid(o._id, { by: 'admin' });
  await I.announce({ title: 'Maintenance on Sunday', by: 'admin' }); // to everybody
  const other = await customer(5);
  await I.announce({ title: 'Only for the other one', workspaceId: other.ws, by: 'admin' });
  let items = await I.listInbox(await col('users').findOne({ _id: user._id }));
  const titles = items.map((x) => x.title);
  assert.ok(titles.some((t) => /Order received: 1,000 credits/.test(t)), 'order');
  assert.ok(titles.some((t) => /Payment received — 1,000 credits added/.test(t)), 'payment');
  assert.ok(titles.includes('Maintenance on Sunday'), 'a notice to everybody');
  assert.ok(!titles.includes('Only for the other one'), "never another account's notice");
  assert.equal(await I.unreadCount(await col('users').findOne({ _id: user._id })), items.length);
  await I.markRead(user);
  assert.equal(await I.unreadCount(await col('users').findOne({ _id: user._id })), 0);
  // spending down to 10 credits rings once
  const { syncLeads } = await import('../src/leads.js');
  await col('workspaces').updateOne({ _id: c.ws }, { $set: { credits: 11 } });
  await col('pages').insertOne({ pageId: 'm1', scrapeStatus: 'done', phones: ['+8801711000000'], createdAt: new Date() });
  await col('leads').insertOne({ workspaceId: c.ws, pageId: 'm1', keywords: ['x'], scrapeStatus: 'pending', phones: [] });
  await syncLeads(['m1']);
  items = await I.listInbox(await col('users').findOne({ _id: user._id }));
  assert.equal(items[0].title, 'Only 10 credits left');
  assert.equal(items[0].unread, true);
});

test('Ad Library filters go into the link; unknown values fall back to the defaults', async () => {
  const { adLibraryUrl, cleanAdFilters } = await import('../src/util.js');
  assert.equal(
    adLibraryUrl('borka', 'BD'),
    'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BD&is_targeted_country=false&media_type=all&q=borka&search_type=keyword_unordered',
  );
  const u = adLibraryUrl('borka', 'BD', { status: 'all', media: 'video', platforms: ['instagram', 'x'], languages: ['bn', 'not a code'], from: '2026-10-01', to: '2026-09-01', exact: true, sort: 'recent' });
  assert.match(u, /active_status=all&/);
  assert.match(u, /media_type=video&/);
  assert.match(u, /search_type=keyword_exact_phrase/);
  assert.match(u, /publisher_platforms\[0\]=instagram/);
  assert.doesNotMatch(u, /publisher_platforms\[1\]/);
  assert.match(u, /content_languages\[0\]=bn/);
  assert.doesNotMatch(u, /content_languages\[1\]/);
  assert.match(u, /start_date\[min\]=2026-09-01&start_date\[max\]=2026-10-01/); // swapped into order
  assert.match(u, /sort_data\[mode\]=relevancy_monthly_grouped&sort_data\[direction\]=desc/);
  assert.match(adLibraryUrl('x', 'BD', { sort: 'impressions' }), /sort_data\[mode\]=total_impressions&sort_data\[direction\]=desc/);
  assert.deepEqual(cleanAdFilters({ status: 'hacked', media: '<b>', sort: 'newest', from: 'yesterday' }), {});
  assert.deepEqual(cleanAdFilters(null), {});
});

test('Fair queue: customers take turns — paid reads 2 pages per turn, free 1; alone a customer gets every turn; no saved-up turns', async () => {
  await B.ensurePlans();
  const { claimPage, resetTurns } = await import('../src/pageQueue.js');
  resetTurns();
  const big = await customer(100000, { plan: 'starter' }); // paid, started first with a big search
  const small = await customer(50); // free, came later with a small one
  const t0 = Date.now();
  const pending = (pageId, ws, at) => ({ pageId, scrapeStatus: 'pending', wantedBy: [ws], createdAt: new Date(at) });
  await col('pages').insertMany([
    ...Array.from({ length: 40 }, (_, i) => pending(`big${i}`, big.ws, t0 + i)),
    ...Array.from({ length: 6 }, (_, i) => pending(`small${i}`, small.ws, t0 + 1000 + i)),
  ]);
  const who = (p) => (p ? p.pageId.replace(/\d+$/, '') : null);
  const first = [];
  for (let i = 0; i < 9; i++) first.push(who(await claimPage('server')));
  assert.equal(first.filter((x) => x === 'small').length, 3, 'the free customer gets 1 of every 3 turns although all its pages came last');
  assert.equal(first.filter((x) => x === 'big').length, 6, 'the paid customer gets 2 of every 3');
  assert.equal((await col('pages').findOne({ pageId: 'big0' })).scrapeStatus, 'working', "inside one customer's line: oldest first");

  // parallel readers (the server's lanes) spread over both customers too
  const par = (await Promise.all(Array.from({ length: 6 }, () => claimPage('server')))).map(who);
  assert.ok(par.includes('small') && par.includes('big'), `parallel claims reach both: ${par}`);

  // the small one runs out → the big one gets every turn
  while (await col('pages').countDocuments({ pageId: /^small/, scrapeStatus: 'pending' })) await claimPage('server');
  const alone = [];
  for (let i = 0; i < 5; i++) alone.push(who(await claimPage('server')));
  assert.deepEqual(alone, ['big', 'big', 'big', 'big', 'big'], 'alone: full speed');

  // the small one comes back: it takes turns again, it does not get a burst for the time it was away
  await col('pages').insertMany(Array.from({ length: 5 }, (_, i) => pending(`small${i + 10}`, small.ws, Date.now() + i)));
  (await import('../src/queueSignal.js')).queueChanged(); // as the app does when ads arrive (leads.js)
  const back = [];
  for (let i = 0; i < 3; i++) back.push(who(await claimPage('server')));
  assert.ok(back.includes('big'), `no saved-up turns: ${back}`);
  assert.ok(back.includes('small'), `but it is back in the rotation at once: ${back}`);

  // out of credits: that line stops, the others go on
  await col('workspaces').updateOne({ _id: big.ws }, { $set: { credits: -50 } });
  B.forgetFunded();
  const broke = [];
  for (let i = 0; i < 3; i++) broke.push(who(await claimPage('server')));
  assert.ok(!broke.includes('big'), `a customer at -50 is skipped: ${broke}`);
  resetTurns();
});

test('Sheets have no size limit: a workbook over 16 MB even when packed is stored in parts, loads back whole, and its parts go when it is deleted', async () => {
  const P = await import('../src/projects.js');
  const { randomBytes } = await import('node:crypto');
  const item = { _id: new ObjectId(), workspaceId: WS, kind: 'custom' };
  const celldata = [];
  // random text barely packs — this workbook stays bigger than one MongoDB document after gzip
  for (let r = 0; r < 40000; r++) for (let c = 0; c < 10; c++) { const s = randomBytes(48).toString('base64'); celldata.push({ r, c, v: { v: s, m: s } }); }
  const sheets = [{ id: 's1', name: 'Sheet1', celldata, config: {} }];
  const v1 = (await P.saveSheet(item, sheets, 0)).version;
  const doc = await col('sheets').findOne({ _id: item._id });
  assert.ok(doc.blob && doc.blob.bytes > 16 * 1048576, `stored in parts (${doc.blob?.bytes} bytes packed)`);
  assert.ok((await col('sheetblobs').countDocuments({ sheetId: item._id })) >= 3);
  const back = await P.loadSheet(item);
  assert.equal(back.sheets[0].celldata.length, celldata.length);
  assert.equal(back.sheets[0].celldata[123456].v.v, celldata[123456].v.v);
  // saving a small version again: back in the document, the old parts are removed
  const small = [{ id: 's1', name: 'Sheet1', celldata: celldata.slice(0, 100), config: {} }];
  await P.saveSheet(item, small, v1);
  assert.equal((await col('sheetblobs').countDocuments({ sheetId: item._id })), 0, 'old parts removed');
  assert.equal((await P.loadSheet(item)).sheets[0].celldata.length, 100);
  await P.saveSheet(item, sheets, v1 + 1);
  await P.deleteSheetDocs([item._id]);
  assert.equal(await col('sheetblobs').countDocuments({ sheetId: item._id }), 0, 'deleted with the sheet');
  assert.equal(await col('sheets').countDocuments({ _id: item._id }), 0);
});
test('A WhatsApp link that came in as the page link is never opened as the page', async () => {
  const U = await import('../src/util.js');
  const { isPageUrl } = await import('../src/leads.js');
  const wa = { pageId: '784358141435654', pageUrl: 'https://api.whatsapp.com/send?token=abc' };
  assert.equal(U.mainUrl(wa), 'https://www.facebook.com/784358141435654');
  assert.equal(U.aboutUrl(wa), 'https://www.facebook.com/784358141435654/about');
  assert.equal(U.pageLink(wa), 'https://www.facebook.com/784358141435654');
  assert.equal(U.mainUrl({ pageId: '1', pageUrl: 'https://www.facebook.com/shop.bd/?ref=x' }), 'https://www.facebook.com/shop.bd/');
  assert.ok(isPageUrl('https://m.facebook.com/x/') && isPageUrl('https://www.instagram.com/x/') && !isPageUrl('https://wa.me/8801'));
});

test('Ad facts: how a page takes orders, its ad formats, advertising since, its website type and platform — and the lead filters on them', async () => {
  const F = await import('../src/adFacts.js');
  const { ingestAds, buildFilter, leadRow, LEAD_HEADERS } = await import('../src/leads.js');
  // single ads
  assert.equal(F.orderChannel({ ctaType: 'WHATSAPP_MESSAGE' }), 'WhatsApp');
  assert.equal(F.orderChannel({ ctaType: 'MESSAGE_PAGE' }), 'Messenger');
  assert.equal(F.orderChannel({ cta: 'Send WhatsApp message' }), 'WhatsApp', 'older ads: from the button text');
  assert.equal(F.orderChannel({ cta: 'Send message' }), 'Messenger');
  assert.equal(F.orderChannel({ ctaType: 'CALL_NOW' }), 'Call');
  assert.equal(F.orderChannel({ ctaType: 'SHOP_NOW', linkUrl: 'https://barisalmart.com/p/1' }), 'Website');
  assert.equal(F.orderChannel({ ctaType: 'ORDER_NOW', linkUrl: 'https://www.daraz.com.bd/x' }), 'Marketplace');
  assert.equal(F.orderChannel({ ctaType: 'LEARN_MORE', linkUrl: 'https://api.whatsapp.com/send?phone=1' }), 'WhatsApp');
  assert.equal(F.orderChannel({ ctaType: 'INSTALL_MOBILE_APP', linkUrl: 'https://play.google.com/store/apps/x' }), 'App');
  assert.equal(F.formatName('MULTI_IMAGES'), 'Multi-image');
  assert.equal(F.formatName('DPA'), 'Catalog');
  assert.equal(F.siteTypeOf(['https://wa.me/1'], []), 'WhatsApp only');
  assert.equal(F.siteTypeOf(['https://othoba.com/x'], []), 'Marketplace');
  assert.equal(F.siteTypeOf([], ['shop.com.bd']), 'Own website');
  assert.equal(F.siteTypeOf([], []), 'Facebook only');
  assert.equal(F.detectPlatform('<script src="https://cdn.shopify.com/s/x.js">'), 'Shopify');
  assert.equal(F.detectPlatform('<link href="/wp-content/plugins/woocommerce/a.css">'), 'WooCommerce');
  assert.equal(F.detectPlatform('<link href="/wp-content/themes/a.css">'), 'WordPress');
  assert.equal(F.detectPlatform('<html><body>hello</body></html>'), 'Custom');

  // a whole page from its ads, into the lead
  const job = { id: 'j-facts', workspaceId: WS, keyword: 'facts', country: 'BD', maxAds: 100 };
  const ad = (adId, x) => ({ adId, pageId: 'pf1', pageName: 'Facts Shop', ...x });
  await ingestAds(job, [
    ad('f1', { ctaType: 'WHATSAPP_MESSAGE', format: 'VIDEO', startDate: '2026-01-10' }),
    ad('f2', { ctaType: 'SHOP_NOW', format: 'CAROUSEL', startDate: '2026-03-01', linkUrl: 'https://factsshop.com/a' }),
    ad('f3', { cta: 'Send message', format: 'IMAGE', startDate: '2025-12-01' }),
  ]);
  const lead = await col('leads').findOne({ workspaceId: WS, pageId: 'pf1' });
  assert.equal(lead.firstAdDate, '2025-12-01', 'the earliest ad');
  assert.deepEqual(lead.orderVia, ['Messenger', 'Website', 'WhatsApp']);
  assert.deepEqual(lead.adFormats, ['Carousel', 'Image', 'Video']);
  assert.equal(lead.siteType, 'Own website');
  const n = async (q) => col('leads').countDocuments(buildFilter(WS, q));
  assert.equal(await n({ via: 'WhatsApp' }), 1);
  assert.equal(await n({ via: 'Call' }), 0);
  assert.equal(await n({ format: 'Video' }), 1);
  assert.equal(await n({ site: 'Own website' }), 1);
  assert.equal(await n({ minRunDays: '30' }), 1, 'advertising since Dec 2025');
  assert.equal(await n({ minRunDays: '100000' }), 0);
  const row = leadRow(lead);
  assert.equal(row[LEAD_HEADERS.indexOf('Orders Via')], 'Messenger, Website, WhatsApp');
  assert.ok(row[LEAD_HEADERS.indexOf('Running Days')] > 30);
});

test('Outdated extensions get no searches to collect (they could flood Facebook or use the person\'s account)', async () => {
  const W2 = await import('../src/worker.js');
  assert.ok(W2.canCollect('3.5.5') && W2.canCollect('3.6.0') && W2.canCollect('4.0.0') && W2.canCollect('3.5.10'));
  assert.ok(!W2.canCollect('3.5.4') && !W2.canCollect('3.1.0') && !W2.canCollect('old') && !W2.canCollect(''));
});

test('A proxy IP that fails 10 times in a row without one page read is parked for 12 h; one good read resets it', async () => {
  const PX = await import('../src/proxies.js');
  let r;
  for (let i = 0; i < 9; i++) r = await PX.restProxyBriefly('dead.test:1:u:p');
  assert.equal(r.dead, false);
  r = await PX.restProxyBriefly('dead.test:1:u:p');
  assert.equal(r.dead, true);
  const st = await col('proxystate').findOne({ _id: 'dead.test:1:u:p' });
  assert.ok(new Date(st.wallUntil) - Date.now() > 11 * 3600e3, 'rests about 12 h');
  await PX.proxyWorked('dead.test:1:u:p');
  r = await PX.restProxyBriefly('dead.test:1:u:p');
  assert.equal(r.dead, false, 'counting starts again after a page was read');
});

test("A customer's extension sees only its own account's numbers — never the service's totals or the proxy list", async () => {
  await B.ensurePlans();
  const c = await customer(40, { plan: 'starter' });
  await col('leads').insertMany([
    { workspaceId: c.ws, pageId: 'own1', scrapeStatus: 'done', chargedAt: new Date() },
    { workspaceId: c.ws, pageId: 'own2', scrapeStatus: 'pending' },
  ]);
  const { createExtensionKey } = await import('../src/auth.js');
  const key = await createExtensionKey(c.user, 'test');
  const { createApp } = await import('../src/app.js');
  const srv = createApp().listen(0);
  try {
    const s = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/worker/status`, { headers: { 'x-api-key': key, 'x-ext-version': '3.5.8' } })).json();
    assert.equal(s.customer, true);
    assert.equal(s.leads, 2);
    assert.equal(s.waiting, 1);
    assert.equal(s.readToday, 1);
    assert.equal(s.credits, 40);
    assert.equal(s.proxy, undefined, 'no proxy details');
    assert.equal(s.pages, undefined, "not the service's page total");
    assert.equal(s.dailyLimit, undefined);
  } finally {
    srv.close();
  }
});

test("A customer's extension can only report on the page its own Chrome is reading — it can't pause the service, start a cooldown or change other pages", async () => {
  await B.ensurePlans();
  await settings(); // a proxy list → pages are read on the server; Chrome gets only the ones that need it
  const c = await customer(40, { plan: 'starter' });
  const { createExtensionKey } = await import('../src/auth.js');
  const key = await createExtensionKey(c.user, 'test');
  process.env.WORKER_KEY = process.env.WORKER_KEY || 'test-worker-key';
  const pcId = '99999999-2222-4333-8444-aaaaaaaaaaaa';
  await col('pages').insertMany([
    { pageId: 'cp1', pageName: 'Customer page', pageUrl: 'https://www.facebook.com/cp1/', scrapeStatus: 'pending', needsBrowser: true, wantedBy: [c.ws], retries: 0, phones: [], emails: [], createdAt: new Date() },
    { pageId: 'xp1', pageName: 'Someone else', pageUrl: 'https://www.facebook.com/xp1/', scrapeStatus: 'working', claimedBy: 'chrome', claimedFor: null, claimedAt: new Date(), retries: 0, phones: [], emails: [], createdAt: new Date() },
  ]);
  await col('leads').insertOne({ workspaceId: c.ws, pageId: 'cp1', status: 'New', overrides: [], createdAt: new Date(), updatedAt: new Date() });
  const { createApp } = await import('../src/app.js');
  const srv = createApp().listen(0);
  const call = async (k, path, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/worker${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-api-key': k, 'x-ext-version': '3.6.0', 'x-ext-pc': pcId, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  try {
    // somebody else's page: every report is ignored
    const fake = await call(key, '/result', { pageId: 'xp1', result: { phones: ['+8801999999999'] } });
    assert.equal(fake.ok, false, 'fake result refused');
    assert.deepEqual((await page('xp1')).phones, [], 'the shared page is untouched');
    assert.equal((await call(key, '/wall', { pageId: 'xp1' })).ok, false);
    assert.equal((await page('xp1')).scrapeStatus, 'working', 'not released by a stranger');
    assert.equal((await call(key, '/net-error', { pageId: 'xp1', error: 'x' })).ok, false);
    assert.equal((await page('xp1')).scrapeStatus, 'working');
    assert.ok(!(await getSettings()).browserCooldownUntil, 'no cooldown for everybody');

    // its own page: given by /next-scrape, then read normally
    const n = await call(key, '/next-scrape?slot=0');
    assert.equal(n.lead?.pageId, 'cp1', "the customer's Chrome gets its own page");
    assert.equal(String((await page('cp1')).claimedFor), String(c.ws));
    assert.equal((await call(key, '/result', { pageId: 'cp1', result: ok().result })).ok, true);
    assert.equal((await page('cp1')).scrapeStatus, 'done', 'its own page is saved as before');

    // a checkpoint in the customer's own Facebook: only that computer rests, the service keeps running
    await call(key, '/blocked', { reason: 'Facebook checkpoint / temporary block' });
    assert.equal((await getSettings()).running, true, 'the service is NOT paused');
    const wait = await call(key, '/next-scrape?slot=0');
    assert.equal(wait.lead, null);
    assert.match(wait.reason, /waiting until/, 'that computer rests');

    // the team's own key works exactly as before: a checkpoint pauses the worker
    await call(process.env.WORKER_KEY, '/blocked', { reason: 'team checkpoint' });
    assert.equal((await getSettings()).running, false, "the team's computer still pauses the worker");
  } finally {
    srv.close();
    await col('pcs').deleteOne({ _id: pcId });
  }
});

test('Ad insights without AI: hook, offers, prices from the ad text; the page gets its longest-running hook; filters, sheets and the project page use them', async () => {
  const I = await import('../src/insights.js');
  const { ingestAds, buildFilter } = await import('../src/leads.js');
  assert.equal(I.hookOf('🔥🔥 মা এখন আর আগের মতো হাঁটতে পারেন না?\nআমাদের তেল ব্যবহার করুন'), 'মা এখন আর আগের মতো হাঁটতে পারেন না?');
  assert.equal(I.hookOf('#বিগ_সেল_আজ শুরু'), 'বিগ সেল আজ শুরু', 'hashtags read as words');
  assert.ok(I.hookOf('x'.repeat(300)).endsWith('…'));
  assert.deepEqual(I.offersOf('সারা দেশে ফ্রি হোম ডেলিভারি, ক্যাশ অন ডেলিভারি, ৩০% পর্যন্ত ছাড়'), ['Free delivery', 'Cash on delivery', 'Discount']);
  assert.deepEqual(I.offersOf('EMI সুবিধা, ২২ বছরের ওয়ারেন্টি'), ['EMI', 'Warranty']);
  assert.deepEqual(I.pricesOf('দাম মাত্র ৳১,২৫০ | ডেলিভারি চার্জ ১২০ টাকা | ফোন 01711000000'), [1250], 'Bangla digits, no delivery charge, no phone');
  const en = I.pricesOf('Price 990/- only, Tk 1500');
  assert.ok(en.includes(990) && en.includes(1500), `English prices: ${en}`);
  assert.equal(I.languageOf('এটা বাংলা লেখা'), 'Bangla');
  assert.equal(I.languageOf('This is English'), 'English');

  const job = { id: 'j-ins', workspaceId: WS, keyword: 'ins', country: 'BD', maxAds: 100, projectId: new ObjectId() };
  const ad = (adId, x) => ({ adId, pageId: 'pins', pageName: 'Ins Shop', ...x });
  await ingestAds(job, [
    ad('i1', { body: 'নতুন কালেকশন এসেছে!\nফ্রি ডেলিভারি', startDate: '2026-09-20' }),
    ad('i2', { body: 'পুরনো কিন্তু চলছে — সেরা বোরকা\nদাম ৳৯৫০, ক্যাশ অন ডেলিভারি', startDate: '2026-01-05' }),
    ad('i3', { body: 'আরেকটা অফার: ১৫% ছাড়\nমাত্র ২,৪৫০ টাকা', startDate: '2026-06-01' }),
  ]);
  const lead = await col('leads').findOne({ workspaceId: WS, pageId: 'pins' });
  assert.equal(lead.ins.bestHook, 'পুরনো কিন্তু চলছে — সেরা বোরকা', 'the hook of the longest-running ad');
  assert.deepEqual(lead.ins.offers, ['Free delivery', 'Cash on delivery', 'Discount']);
  assert.equal(lead.ins.priceMin, 950);
  assert.equal(lead.ins.priceMax, 2450);
  assert.equal(await col('leads').countDocuments(buildFilter(WS, { offer: 'Cash on delivery' })), 1);
  assert.equal(await col('leads').countDocuments(buildFilter(WS, { offer: 'EMI' })), 0);

  const pi = await I.projectInsights(job.projectId);
  assert.equal(pi.ads, 3);
  assert.equal(pi.hooks[0].hook, 'পুরনো কিন্তু চলছে — সেরা বোরকা');
  assert.equal(pi.longRunning, 3, 'all three have run 30+ days');
  assert.equal(pi.prices.min, 950);

  // an error inside insights never reaches the engine: ingestAds still saves the ads
  const r = await I.insightsAfterIngest(null);
  assert.equal(r, undefined);
});

test('A computer takes a short (30 s) break between searches (back-to-back searches got "Rate limit exceeded")', async () => {
  await col('pcs').deleteMany({});
  const { createApp } = await import('../src/app.js');
  await col('workspaces').updateOne({ _id: WS }, { $set: { plan: 'internal' } }, { upsert: true });
  const now = Date.now();
  await col('jobs').insertMany([
    { workspaceId: WS, keyword: 'just done', country: 'BD', phase: 'collected', collector: '11111111-2222-4333-8444-555555555555', collectedAt: new Date(now - 10e3), createdAt: new Date(now - 60e3) },
    { workspaceId: WS, keyword: 'next one', country: 'BD', phase: 'queued', createdAt: new Date(now) },
  ]);
  const srv = createApp().listen(0);
  const ask = async (pc) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/worker/next-collect`, { headers: { 'x-api-key': process.env.WORKER_KEY || 'test-worker-key', 'x-ext-version': '3.5.9', 'x-ext-pc': pc } })).json();
  try {
    const a = await ask('11111111-2222-4333-8444-555555555555');
    assert.equal(a.job, null);
    assert.match(a.reason, /short break/);
    const b = await ask('99999999-2222-4333-8444-555555555555');
    assert.equal(b.job?.keyword, 'next one', 'another computer is not held up');
  } finally {
    srv.close();
    await col('pcs').deleteMany({});
  }
});

test('Gentle mode is per computer: smaller searches, slower pace, a 10-minute gap, and an hour of rest after "slow down"; other computers are not affected', async () => {
  await col('pcs').deleteMany({});
  const { createApp } = await import('../src/app.js');
  const W2 = await import('../src/worker.js');
  await col('workspaces').updateOne({ _id: WS }, { $set: { plan: 'internal' } }, { upsert: true });
  const GENTLE_PC = 'aaaaaaaa-2222-4333-8444-555555555555';
  const NORMAL_PC = 'bbbbbbbb-2222-4333-8444-555555555555';
  const srv = createApp().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/worker`;
  const H = (pc) => ({ 'x-api-key': process.env.WORKER_KEY || 'test-worker-key', 'x-ext-version': '3.6.0', 'x-ext-pc': pc });
  const next = async (pc) => (await fetch(`${base}/next-collect`, { headers: H(pc) })).json();
  try {
    await next(GENTLE_PC); // the computer is remembered on its first contact
    await new Promise((r) => setTimeout(r, 50));
    await col('pcs').updateOne({ _id: GENTLE_PC }, { $set: { gentle: true } });
    await col('jobs').insertOne({ workspaceId: WS, keyword: 'big', country: 'BD', phase: 'queued', maxAds: 10000, createdAt: new Date() });
    const a = await next(GENTLE_PC);
    assert.equal(a.job.keyword, 'big');
    assert.equal(a.job.maxAds, W2.GENTLE.maxAds, 'at most 2,000 ads per search');
    assert.deepEqual(a.job.pace.limitWaits, W2.GENTLE.limitWaits);
    // Facebook says "slow down" → this computer rests an hour
    await fetch(`${base}/job/${a.job.id}?note=${encodeURIComponent('Facebook rate limit after 58 ads — finished there')}`, { headers: H(GENTLE_PC) });
    await col('jobs').updateOne({ _id: new ObjectId(a.job.id) }, { $set: { phase: 'collected', collectedAt: new Date(Date.now() - 20 * 60e3) } });
    await col('jobs').insertOne({ workspaceId: WS, keyword: 'next', country: 'BD', phase: 'queued', maxAds: 10000, createdAt: new Date() });
    const b = await next(GENTLE_PC);
    assert.equal(b.job, null);
    assert.match(b.reason, /resting after Facebook asked to slow down/);
    // a normal computer is not held up and keeps its own limits
    const c = await next(NORMAL_PC);
    assert.equal(c.job.keyword, 'next');
    assert.equal(c.job.maxAds, 10000);
    assert.equal(c.job.pace, null);
  } finally {
    srv.close();
    await col('pcs').deleteMany({});
  }
});