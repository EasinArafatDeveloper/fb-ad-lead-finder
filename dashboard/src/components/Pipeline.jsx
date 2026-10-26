import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight, Check, CircleAlert, CirclePause, CirclePlay, ClipboardList, FileSpreadsheet, Globe, Info, ListPlus, Loader2, MousePointerClick,
  Network, PhoneCall, PhoneOff, Search, Square, Trash2, TriangleAlert,
} from 'lucide-react';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Progress } from './ui';

/** Step-by-step view of one project: Queued → Collect ads → Read pages → Ready. */
/** simple: the customer's view — what is found and how many, no engine details (PC, scrolling, page names). */
export function PipelineSteps({ data, simple = false }) {
  const f = data?.focus;
  if (!f) return null;
  const collected = f.jobPhase === 'collected' || f.jobPhase === 'stopped';
  const scraped = f.leads - f.pending;
  const steps = [
    {
      icon: ListPlus,
      title: 'Search queued',
      text: f.queuedAt ? timeAgo(f.queuedAt) : '—',
      state: 'done',
    },
    {
      icon: Search,
      title: simple ? 'Finding advertisers' : 'Ads from the Ad Library',
      text: f.jobPhase === 'queued' ? 'Waiting…' : `${formatNumber(f.ads)} ads · ${formatNumber(f.leads)} pages`,
      state: f.jobPhase === 'queued' ? 'todo' : f.jobPhase === 'collecting' ? 'active' : 'done',
      progress: f.jobPhase === 'collecting' ? (f.jobAds / Math.max(1, f.maxAds)) * 100 : null,
      live:
        f.jobPhase === 'collecting' && data.collecting
          ? data.collecting.silentSec >= 60
            ? simple
              ? 'Waiting — keep the Ad Library tab open in Chrome'
              : `Tab not responding (${Math.round(data.collecting.silentSec)} s)`
            : simple
              ? `Searching… ${formatNumber(data.collecting.ads)} ads found`
              : `Scrolling — ${data.collecting.ads}/${data.collecting.maxAds} ads (max)`
          : null,
    },
    {
      icon: PhoneCall,
      title: simple ? 'Finding contacts' : 'Contacts from pages',
      text: !collected ? 'Starts when ads are done' : simple ? `${scraped} of ${f.leads} advertisers checked · ${f.withContact} with contact` : `${scraped}/${f.leads} pages read · ${f.withContact} with contact`,
      state: !collected ? 'todo' : f.pending ? 'active' : 'done',
      progress: collected ? (scraped / Math.max(1, f.leads)) * 100 : null,
      live: collected && f.pending && data.working ? (simple ? 'Finding contacts…' : `Reading now: ${data.working.name}`) : null,
    },
    {
      icon: FileSpreadsheet,
      title: 'Ready in sheets',
      text: collected && !f.pending ? `${f.withContact} leads with contact` : 'When all pages are read',
      state: collected && !f.pending ? 'done' : 'todo',
    },
  ];

  return (
    <ol className="grid gap-3 md:grid-cols-4" aria-label={`${f.name} progress`}>
      {steps.map((s, i) => (
        <li
          key={s.title}
          className={cn(
            'relative overflow-hidden rounded-2xl border p-4 transition-colors',
            s.state === 'active' && 'border-indigo-300 bg-indigo-50/70 shadow-md shadow-indigo-500/10 dark:border-indigo-500/40 dark:bg-indigo-500/10',
            s.state === 'done' && 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5',
            s.state === 'todo' && 'border-slate-200 bg-white dark:border-white/10 dark:bg-slate-900',
          )}
          aria-current={s.state === 'active' ? 'step' : undefined}
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-lg',
                s.state === 'active' && 'bg-gradient-to-br from-indigo-500 to-blue-600 shadow-indigo-500/30',
                s.state === 'done' && 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/25',
                s.state === 'todo' && 'bg-slate-200 text-slate-500 shadow-none dark:bg-white/10 dark:text-slate-400',
              )}
            >
              {s.state === 'done' ? <Check className="h-4 w-4" aria-hidden="true" /> : <s.icon className="h-4 w-4" aria-hidden="true" />}
              {s.state === 'active' && <span className="absolute inset-0 animate-ping rounded-xl bg-indigo-500/30" aria-hidden="true" />}
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Step {i + 1}</p>
              <p className="truncate text-sm font-bold">{s.title}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">{s.text}</p>
          {s.progress !== null && s.progress !== undefined && (
            <div className="mt-2">
              <Progress value={s.progress} />
            </div>
          )}
          {s.live && (
            <p className="mt-2 flex items-center gap-1.5 truncate text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" /> {s.live}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

const EVENT = {
  queued: { icon: ClipboardList, cls: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300' },
  collect: { icon: Globe, cls: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300' },
  collected: { icon: Search, cls: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300' },
  found: { icon: PhoneCall, cls: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' },
  empty: { icon: PhoneOff, cls: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400' },
  failed: { icon: TriangleAlert, cls: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' },
  paused: { icon: CirclePause, cls: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300' },
  resumed: { icon: CirclePlay, cls: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' },
  delete: { icon: Trash2, cls: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' },
  stopped: { icon: Square, cls: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' },
};

/** Newest-first timeline of what the worker did. */
export function ActivityFeed({ items }) {
  if (!items?.length)
    return (
      <div className="flex flex-col items-center py-10 text-center text-sm text-slate-500">
        <MousePointerClick className="mb-2 h-6 w-6 text-slate-300" aria-hidden="true" />
        Nothing yet. Start a search and every step will show up here.
      </div>
    );
  return (
    <ol className="relative space-y-0.5" aria-live="polite">
      <span aria-hidden="true" className="absolute bottom-3 left-[17px] top-3 w-px bg-slate-200 dark:bg-white/10" />
      <AnimatePresence initial={false}>
        {items.map((a) => {
          const e = EVENT[a.type] || { icon: CircleAlert, cls: 'bg-slate-100 text-slate-500' };
          return (
            <motion.li
              key={`${a.ts}-${a.msg}`}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="relative flex items-start gap-3 rounded-xl px-1 py-2"
            >
              <span className={cn('relative z-10 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl ring-4 ring-white dark:ring-slate-900', e.cls)}>
                <e.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 pt-1">
                <p className="text-sm leading-snug text-slate-800 dark:text-slate-100">{a.msg}</p>
                <p className="mt-0.5 text-[11px] text-slate-400">{timeAgo(a.ts)}</p>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What the server reader is doing, in one sentence (pages are read on the server through the proxy list). */
function serverLine(data) {
  const sv = data.server;
  const forServer = data.pendingAll - sv.forChrome;
  const free = sv.ips - sv.resting;
  const rest = sv.resting ? ` · ${sv.resting} resting after a login wall` : '';
  if (forServer > 0 && !free) {
    return { tone: 'amber', text: `All ${sv.ips} IPs are resting after login walls — reading continues by itself at ${hhmm(sv.nextIpAt)}. Nothing to do.` };
  }
  if (forServer > 0) {
    return { tone: 'indigo', text: `Reading pages on the server — ${Math.max(1, sv.lanes)} at a time through ${free} of ${sv.ips} IPs${rest} · ${forServer} left` };
  }
  if (sv.forChrome > 0) {
    const when = sv.chromeWaitUntil ? `Chrome reads them from ${hhmm(sv.chromeWaitUntil)} (it got a login wall)` : 'Chrome reads them next (keep Chrome open with the extension on)';
    return { tone: 'amber', text: `${sv.forChrome} page${sv.forChrome > 1 ? 's' : ''} the server couldn't read — ${when}` };
  }
  return null;
}

/** "3 s ago", ticking by itself every second. */
function Ago({ at }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <>{s < 60 ? `${s} s ago` : timeAgo(at)}</>;
}

const OUTCOME = {
  contact: { label: null, cls: '' },
  none: { label: 'no contact', cls: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400' },
  unavailable: { label: 'page not available', cls: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400' },
  failed: { label: 'failed', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
};
const chip = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold';

/**
 * The live board: what the engine is doing this second — the lanes reading pages (and through which IP),
 * the Ad Library collecting, and every page as it is read, with what was found. Refreshes by itself.
 */
export function LiveBoard({ data, updatedAt }) {
  if (!data?.live) return null;
  const { lanes, recent, perMin } = data.live;
  const c = data.collecting;
  const busy = lanes.length > 0 || !!c || data.pendingAll > 0;
  return (
    <section className="card overflow-hidden" aria-labelledby="live-h">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-white/10">
        <h2 id="live-h" className="flex items-center gap-2 font-display font-bold">
          <span className="relative flex h-2.5 w-2.5">
            {busy && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />}
            <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', busy ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')} />
          </span>
          Live
          <span className="text-xs font-medium text-slate-500">{busy ? 'working right now' : 'idle'}</span>
        </h2>
        <p className="text-xs text-slate-500">
          {perMin > 0 && <span className="mr-2 font-semibold text-slate-700 dark:text-slate-200">~{perMin} pages/min</span>}
          updated <Ago at={updatedAt} />
        </p>
      </div>
      <div className="grid gap-0 md:grid-cols-2 md:divide-x md:divide-slate-100 md:dark:divide-white/10">
        {/* left — what is happening this second */}
        <div className="p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Now</p>
          <ul className="space-y-1.5">
            {c && (
              <li className="flex items-center gap-2.5 rounded-xl bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-500/10">
                <Search className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  Ad Library: <b>“{c.keyword}”</b> — {c.ads}/{c.maxAds} ads · {c.pages} pages{c.pc && <span className="text-indigo-600 dark:text-indigo-300"> · on {c.pc}</span>}
                </span>
                {c.silentSec >= 60 ? (
                  <span className={cn(chip, 'bg-amber-100 text-amber-800')}>not responding</span>
                ) : (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-500" aria-hidden="true" />
                )}
              </li>
            )}
            <AnimatePresence initial={false}>
              {lanes.map((l) => (
                <motion.li
                  key={`${l.lane}-${l.page}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-white/5"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    Reading <b>{l.page}</b>
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {l.ip}
                    {l.sec != null && ` · ${l.sec}s`}
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
            {!c && !lanes.length && (
              <li className="rounded-xl px-3 py-2 text-sm text-slate-500">
                {data.pendingAll ? `${data.pendingAll} pages waiting — see the line above for why` : 'Nothing to read right now. Start a new search.'}
              </li>
            )}
          </ul>
        </div>
        {/* right — every page as it is read */}
        <div className="p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Just read</p>
          {!recent.length ? (
            <p className="px-3 py-2 text-sm text-slate-500">No pages read in the last 30 minutes.</p>
          ) : (
            <ul className="space-y-1">
              <AnimatePresence initial={false}>
                {recent.map((r) => {
                  const o = OUTCOME[r.outcome] || OUTCOME.none;
                  return (
                    <motion.li
                      key={r.id}
                      layout
                      initial={{ opacity: 0, y: -8, backgroundColor: 'rgba(16,185,129,0.12)' }}
                      animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(16,185,129,0)' }}
                      transition={{ duration: 0.6 }}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
                    >
                      {r.outcome === 'contact' ? (
                        <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                      ) : r.outcome === 'failed' ? (
                        <TriangleAlert className="h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" />
                      ) : (
                        <PhoneOff className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate" title={r.category}>{r.name}</span>
                      <span className="flex shrink-0 gap-1">
                        {r.phones > 0 && <span className={cn(chip, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300')}>📞 {r.phones}</span>}
                        {r.whatsapp > 0 && <span className={cn(chip, 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300')}>WA</span>}
                        {r.emails > 0 && <span className={cn(chip, 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300')}>✉ {r.emails}</span>}
                        {o.label && <span className={cn(chip, o.cls)}>{o.label}</span>}
                      </span>
                      <span className="hidden w-14 shrink-0 text-right text-[11px] text-slate-400 sm:inline">
                        <Ago at={new Date(r.at).getTime()} />
                      </span>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

const HEALTH = {
  error: { icon: CircleAlert, cls: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100', dot: 'text-rose-600' },
  warn: { icon: TriangleAlert, cls: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100', dot: 'text-amber-600' },
  info: { icon: Info, cls: 'border-slate-200 bg-white text-slate-800 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100', dot: 'text-indigo-500' },
};

/** Engine health: what is stuck or waiting, why, and what to do — straight from the server (health.js). */
export function HealthPanel({ items, hide = [] }) {
  if (!items) return null;
  items = items.filter((it) => !hide.includes(it.key));
  if (!items.length) return null;
  return (
    <ul className="space-y-2" aria-label="Engine health">
      {items.map((it, i) => {
        const h = HEALTH[it.level] || HEALTH.info;
        return (
          <li key={`${it.key}-${i}`} className={cn('flex gap-3 rounded-2xl border px-4 py-3', h.cls)}>
            <h.icon className={cn('mt-0.5 h-4 w-4 shrink-0', h.dot)} aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">{it.title}</p>
              {it.detail && <p className="mt-0.5 opacity-90">{it.detail}</p>}
              {it.fix && <p className="mt-1 text-xs font-semibold opacity-80">→ {it.fix}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The health keys the IP card below already shows — the alert list leaves them out. */
export const IP_HEALTH_KEYS = ['ips-some-resting', 'ips-bad'];

/**
 * The proxy IPs at a glance: one bar — reading / short rest / bad — instead of two alerts with the same number.
 * Bad = Facebook shows them the login wall on most tries; they rest 12 h at a time.
 */
export function ProxyCard({ server }) {
  if (!server?.ips) return null;
  const bad = server.bad || 0;
  const resting = server.restingGood ?? Math.max(0, server.resting - bad);
  const ready = Math.max(0, server.ips - bad - resting);
  const parts = [
    { n: ready, label: 'ready to read', cls: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' },
    { n: resting, label: 'short rest', cls: 'bg-amber-400', text: 'text-amber-700 dark:text-amber-300', hint: 'Got a login wall or a connection error — back by itself in 10 min to 4 h' },
    { n: bad, label: 'bad', cls: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300', hint: 'Facebook blocks them most of the time — they rest 12 h and hardly read anything' },
  ];
  return (
    <section className="card p-5" aria-labelledby="ip-h">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Network className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div>
          <h2 id="ip-h" className="font-display font-bold">Proxy IPs</h2>
          <p className="text-xs text-slate-500">{server.ips} IPs read the Facebook pages</p>
        </div>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" role="img" aria-label={parts.map((p) => `${p.n} ${p.label}`).join(', ')}>
        {parts.map((p) => p.n > 0 && <div key={p.label} className={cn('h-full transition-all', p.cls)} style={{ width: `${(p.n / server.ips) * 100}%` }} />)}
      </div>
      <ul className="mt-4 space-y-2.5">
        {parts.map((p) => (
          <li key={p.label} className="flex items-start gap-2.5 text-sm" title={p.hint}>
            <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', p.cls)} />
            <span className="min-w-0 flex-1">
              <span className={cn('font-bold tabular-nums', p.text)}>{p.n}</span> <span className="text-slate-700 dark:text-slate-200">{p.label}</span>
              {p.hint && p.n > 0 && <span className="block text-xs text-slate-500">{p.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      {bad > 0 && (
        <Link
          to="/settings"
          className="mt-4 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20"
        >
          <span className="flex-1">Replace the {bad} bad IPs in Webshare, then paste the new list in Settings → Proxy</span>
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

export function NowLine({ data, simple = false }) {
  if (!data) return null;
  let text;
  let tone = 'indigo';
  if (simple) return <SimpleNowLine data={data} />;
  const sv = data.running && !data.collecting && data.pendingAll && data.server && data.doneToday < data.dailyLimit ? serverLine(data) : null;
  // reading stops when the balance reaches the end of the overdraft (e.g. -50)
  const noCredits = data.account && !data.account.unlimited && data.account.credits <= -(data.account.overdraft || 0);
  if (noCredits && data.pendingAll && !data.collecting) {
    // a customer out of credits: nothing more is read until they buy — say so, not "starts shortly"
    text = `${data.pendingAll} page${data.pendingAll > 1 ? 's are' : ' is'} waiting for credits — they are read as soon as you add credits (1 credit = 1 page).`;
    tone = 'amber';
  } else if (!data.running) {
    text = `Paused${data.pausedReason ? ` — ${data.pausedReason}` : ''}. Press Resume at the top to continue.`;
    tone = 'amber';
  } else if (data.cooldownUntil && !data.collecting) {
    const why = data.cooldownReason && !/login/i.test(data.cooldownReason) ? data.cooldownReason : 'Facebook asked for a login';
    text = `${why}, so the worker is taking a break — it continues by itself at ${hhmm(data.cooldownUntil)}. Nothing to do.`;
    tone = 'amber';
  } else if (data.collecting && data.collecting.silentSec >= 60) {
    text = `The Ad Library tab for "${data.collecting.keyword}" is not responding — ${data.collecting.ads} ads, ${data.collecting.pages} pages arrived. Reload that tab to continue.`;
    tone = 'amber';
  } else if (data.collecting && data.collecting.tabHidden) {
    text = `"${data.collecting.keyword}" is waiting: the Ad Library tab${data.collecting.pc ? ` on ${data.collecting.pc}` : ''} is in the background. Bring it to the front — Facebook only loads more ads while it is visible (${data.collecting.ads} so far).`;
    tone = 'amber';
  } else if (data.collecting)
    text = `Collecting ads for "${data.collecting.keyword}" in the Ad Library${data.collecting.pc ? ` on ${data.collecting.pc}` : ''} — ${data.collecting.ads} of max ${data.collecting.maxAds} ads, ${data.collecting.pages} pages so far`;
  else if (sv) ({ text, tone } = sv);
  else if (data.working) text = `Reading the page "${data.working.name}"`;
  else if (data.pendingAll && data.doneToday >= data.dailyLimit) {
    text = `Today's limit (${data.dailyLimit}) reached — the remaining ${data.pendingAll} pages continue automatically tomorrow`;
    tone = 'amber';
  } else if (data.pendingAll) text = `${data.pendingAll} pages in the queue — the next one starts shortly`;
  else if (data.queued.length) text = `Waiting to start the search "${data.queued[0].keyword}"`;
  else {
    text = 'All done. Start a new search with a keyword.';
    tone = 'emerald';
  }
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium',
        tone === 'indigo' && 'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-lg shadow-indigo-600/20',
        tone === 'amber' && 'bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30',
        tone === 'emerald' && 'bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30',
      )}
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {tone === 'indigo' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />}
        <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', tone === 'indigo' ? 'bg-white' : 'bg-current')} />
      </span>
      <span className="min-w-0 flex-1">{text}</span>
      {tone === 'indigo' && data.pendingAll > 0 && data.etaMinutes > 0 && !(data.server && data.server.forChrome >= data.pendingAll) && (
        <span
          className="hidden shrink-0 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold sm:inline"
          title={data.paceMeasured ? 'Based on the real speed of the last few pages' : 'Estimate — becomes exact after a few pages'}
        >
          {data.tomorrow > 0 ? `Today's ${data.todayLeft}` : 'Remaining'} ~{data.etaMinutes} min · ~{data.secPerPage}s per page
          {data.tomorrow > 0 && ` · ${data.tomorrow} tomorrow`}
        </span>
      )}
      {noCredits && data.pendingAll > 0 && (
        <Link to="/billing" className="shrink-0 rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold text-white hover:bg-amber-600">
          Buy credits
        </Link>
      )}
      {data.focus && (
        <Link to={`/projects/${data.focus.id}`} className={cn('hidden shrink-0 text-xs font-bold underline-offset-2 hover:underline md:inline', tone === 'indigo' ? 'text-white' : '')}>
          Open project →
        </Link>
      )}
    </div>
  );
}

/**
 * The customer's one-line status: what is being found and how far it is — never the engine's inner workings
 * (proxies, breaks, page names, computers). Things only the team can fix are shown as "continues shortly".
 */
function SimpleNowLine({ data }) {
  let text;
  let tone = 'indigo';
  const noCredits = data.account && !data.account.unlimited && data.account.credits <= -(data.account.overdraft || 0);
  const c = data.collecting;
  if (noCredits && data.pendingAll && !c) {
    text = `${data.pendingAll} advertiser${data.pendingAll > 1 ? 's are' : ' is'} waiting for credits — their contacts are found as soon as you add credits (1 credit = 1 advertiser).`;
    tone = 'amber';
  } else if (c && (c.silentSec >= 60 || c.tabHidden)) {
    text = `"${c.keyword}" is waiting — keep the Ad Library tab open in your Chrome (${formatNumber(c.ads)} ads found so far).`;
    tone = 'amber';
  } else if (c) {
    text = `Searching "${c.keyword}" — ${formatNumber(c.ads)} ads from ${formatNumber(c.pages)} advertisers found so far`;
  } else if (data.pendingAll) {
    text = `Finding contact details — ${formatNumber(data.pendingAll)} advertiser${data.pendingAll > 1 ? 's' : ''} left${data.etaMinutes > 0 ? ` (about ${data.etaMinutes} min)` : ''}`;
  } else if (data.queued.length) {
    text = `"${data.queued[0].keyword}" starts in a moment`;
  } else {
    text = 'All done. Start a new search with a keyword.';
    tone = 'emerald';
  }
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium',
        tone === 'indigo' && 'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-lg shadow-indigo-600/20',
        tone === 'amber' && 'bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30',
        tone === 'emerald' && 'bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30',
      )}
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {tone === 'indigo' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />}
        <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', tone === 'indigo' ? 'bg-white' : 'bg-current')} />
      </span>
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}