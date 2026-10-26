// Engine health: everything that is stuck, waiting or broken right now — in plain words, with the reason and
// what (if anything) the user should do. Shown on the Dashboard; one place, so the Dashboard can never tell
// a different story than the engine (docs/ENGINE.md §4).
import { col } from './db.js';
import { isBadIp, proxyPool } from './proxies.js';
import { serverReads, COLLECT_SILENT_WARN_MS, STALE_COLLECT_MS } from './worker.js';
import { workerInfo } from './worker-state.js';
import { startOfToday } from './util.js';

const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const ago = (sec) => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);
const WORKER_OFFLINE_SEC = 150; // the extension asks the server at least once a minute

/**
 * level: 'error' (stopped, you must act) | 'warn' (stuck/slow, may fix itself) | 'info' (waiting by design)
 * Each: { level, key, title, detail, fix }
 */
export async function engineHealth(s) {
  const issues = [];
  const add = (level, key, title, detail, fix = '') => issues.push({ level, key, title, detail, fix });
  const now = Date.now();
  const pool = proxyPool(s);
  const onServer = serverReads(s, pool);
  const [worker, collecting, queuedJobs, pending, forChrome, visits, recentErrors, ipStates] = await Promise.all([
    workerInfo(),
    col('jobs').find({ phase: 'collecting' }).project({ keyword: 1, lastActivity: 1, adsSeen: 1, maxAds: 1, pageIds: 1 }).toArray(),
    col('jobs').countDocuments({ phase: 'queued' }),
    col('pages').countDocuments({ scrapeStatus: 'pending' }),
    col('pages').countDocuments({ scrapeStatus: 'pending', needsBrowser: true }),
    col('pages').countDocuments({ lastAttemptAt: { $gte: startOfToday() } }),
    col('logs').find({ level: 'error', ts: { $gt: new Date(now - 30 * 60e3) } }).sort({ ts: -1 }).limit(3).toArray(),
    col('proxystate').find({ _id: { $in: pool.map((p) => p.id) } }).toArray(),
  ]);

  // 1 — stopped
  if (!s.running) add('error', 'paused', 'The worker is paused', s.pausedReason || 'Paused by hand.', 'Fix the reason above if there is one, then press Resume at the top.');

  // 2 — the Chrome extension (it collects ads, and reads the few pages the server can't)
  const needChrome = queuedJobs > 0 || collecting.length > 0 || forChrome > 0 || (!onServer && pending > 0);
  if (!worker || worker.seenAgo > WORKER_OFFLINE_SEC) {
    if (needChrome) add('error', 'extension-offline', 'The Chrome extension is not connected', worker ? `Last seen ${ago(worker.seenAgo)} ago.` : 'It never connected.', 'Open Chrome with the FB Ad Lead Finder extension on (popup: server URL + worker key, then Save).');
  } else if (worker.outdated) {
    const now = worker.running?.length ? `Running right now: ${worker.running.join(', ')}. ` : '';
    const where = worker.oldCopies?.length ? `Old copies online: ${worker.oldCopies.join(' · ')}. ` : now;
    add('warn', 'extension-old', `An old extension version is running (${worker.version})`, `${where}The latest is ${worker.latest}.`, 'On that computer open chrome://extensions: if FB Ad Lead Finder is there twice, Remove the old one; otherwise put the new ZIP in its folder and press Reload. One copy per browser.');
  }

  // 3 — Ad Library tabs that went silent
  for (const j of collecting) {
    const silent = (now - new Date(j.lastActivity || 0).getTime()) / 1000;
    if (silent * 1000 >= COLLECT_SILENT_WARN_MS) {
      const left = Math.max(0, Math.round((STALE_COLLECT_MS / 1000 - silent) / 60));
      add('warn', 'collect-silent', `The Ad Library tab for "${j.keyword}" is not responding`, `No news for ${ago(silent)} — ${j.adsSeen || 0} ads and ${(j.pageIds || []).length} pages arrived so far. This happens when the extension was reloaded or the tab was closed/frozen.`, `Reload the Ad Library tab — it continues where it was. Otherwise the search ends by itself in ~${left} min, keeping what arrived.`);
    }
  }

  // 4 — reading pages
  if (s.running && s.cooldownUntil && new Date(s.cooldownUntil) > new Date()) {
    const login = !s.cooldownReason || /login/i.test(s.cooldownReason);
    add(
      'warn',
      'cooldown',
      login ? 'Facebook asked for a login — the worker is taking a break' : 'The worker is taking a short break',
      `${login ? '' : `${s.cooldownReason}. `}Continues by itself at ${hhmm(s.cooldownUntil)}.`,
      login ? 'Nothing to do. Adding proxy IPs (Settings → Proxy) avoids these breaks.' : 'Nothing to do if it happens once. If it keeps happening the worker pauses and says so.',
    );
  }
  if (onServer && pool.length) {
    const resting = ipStates.filter((x) => x.wallUntil && new Date(x.wallUntil) > new Date());
    if (resting.length === pool.length && pending - forChrome > 0) {
      const first = new Date(Math.min(...resting.map((x) => new Date(x.wallUntil).getTime())));
      add('warn', 'ips-resting', `All ${pool.length} proxy IPs are resting`, `Facebook showed a login wall on each of them. The first one is back at ${hhmm(first)}; reading continues by itself.`, 'Nothing to do. If it happens often: Settings → Proxy → raise "Rest per IP", or lower "Pages at the same time".');
    } else if (resting.some((x) => !isBadIp(x))) {
      // only the short, normal rests — the bad IPs have their own line below
      const n = resting.filter((x) => !isBadIp(x)).length;
      add('info', 'ips-some-resting', `${n} of ${pool.length} proxy IPs are resting`, 'They got a login wall or a connection error; the other IPs keep reading.', '');
    }
    const bad = ipStates.filter(isBadIp).length;
    if (bad) {
      add(
        bad >= pool.length / 2 ? 'warn' : 'info',
        'ips-bad',
        `${bad} of ${pool.length} proxy IPs are bad`,
        'Facebook shows them the login wall on most tries, so they rest 12 h at a time and hardly read anything.',
        'Webshare → Proxy List → select them → Replace Proxy, then paste the new list in Settings → Proxy (the bad ones are marked there).',
      );
    }
  }
  if (forChrome > 0) {
    const wait = s.browserCooldownUntil && new Date(s.browserCooldownUntil) > new Date();
    add('info', 'chrome-pages', `${forChrome} page${forChrome > 1 ? 's' : ''} can only be read in Chrome`, wait ? `Chrome got a login wall and continues at ${hhmm(s.browserCooldownUntil)}.` : 'The server could not recognise them; Chrome reads them next.', 'Keep Chrome open. Not read within a day = marked failed.');
  }
  if (pending > 0 && visits >= s.dailyLimit) {
    add('info', 'daily-limit', `Today's page limit (${s.dailyLimit}) is reached`, `${pending} pages continue tomorrow.`, 'Settings → Worker → Daily page limit, if you want more today.');
  }

  // (sheets have no size limit any more — big ones are stored in parts, projects.js storeWorkbook)

  // 5 — errors the engine logged recently (format change, proxy account, crashes …)
  for (const e of recentErrors) {
    if (/^Paused:/.test(e.msg) && !s.running) continue; // already shown as "paused"
    add('error', 'log', 'Error in the last 30 minutes', `${hhmm(e.ts)} — ${e.msg}`, 'See Server logs for details.');
  }

  const order = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}
