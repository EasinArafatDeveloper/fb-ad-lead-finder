import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Clock, Cpu, Eye, Link2, Loader2, MousePointerClick, Radio, Search } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Progress } from './ui';

/**
 * Admin → Overview → Live: what every account is doing right now (server: adminLive.js), refreshed every 5 s
 * while the page is in front — the search collecting (keyword, ads, computer, scrolling or page by page), the
 * searches waiting, the pages being read and how fast, recent searches, and what went wrong lately.
 */
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);

function Mode({ pc }) {
  if (!pc) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300">
      <Cpu className="h-3 w-3" /> {pc.name} · v{pc.version}
      <span className={cn('ml-1 rounded px-1', pc.mode === 'scroll' ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200')}>
        {pc.mode === 'scroll' ? 'scrolling' : 'page by page'}
      </span>
    </span>
  );
}

function Collecting({ j }) {
  const silent = j.silentSec != null && j.silentSec > 60;
  return (
    <div className={cn('rounded-xl border p-3', silent ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10' : 'border-indigo-200 bg-indigo-50/40 dark:border-indigo-500/30 dark:bg-indigo-500/10')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
        </span>
        <b className="text-sm">“{j.keyword}”</b>
        <span className="text-xs text-slate-500">{j.country}{j.manual ? ' · from the Ad Library panel' : ''} · started {timeAgo(j.startedAt)}</span>
        <Mode pc={j.pc} />
      </div>
      <div className="mt-2 flex items-baseline justify-between text-xs">
        <span className="font-semibold text-indigo-700 dark:text-indigo-300">{formatNumber(j.ads)} ads · {formatNumber(j.pages)} pages found</span>
        {j.maxAds && <span className="text-slate-500">max {formatNumber(j.maxAds)}</span>}
      </div>
      <div className="mt-1"><Progress value={pct(j.ads, j.maxAds)} /></div>
      <p className="mt-1.5 text-[11px] text-slate-500">
        Pages read {formatNumber(j.read)}/{formatNumber(j.pages)} · {formatNumber(j.withContact)} with a contact
        {j.silentSec != null && ` · last word from the tab ${j.silentSec} s ago`}
      </p>
      {(silent || j.tabHidden || j.note) && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {j.tabHidden ? 'The Ad Library tab is in the background — Facebook loads no more ads until it is in front. ' : ''}
          {silent ? 'The tab has not reported for a while. ' : ''}
          {j.note}
        </p>
      )}
    </div>
  );
}

function Account({ a }) {
  const busy = a.collecting.length || a.reading.working || a.reading.last5min;
  return (
    <li className="rounded-2xl border border-slate-200 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {a.name || a.email}
            {a.team && <span className="rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500 dark:bg-white/10">TEAM</span>}
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', busy ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
              {busy ? 'WORKING' : a.queued.length ? 'WAITING' : 'IDLE'}
            </span>
          </p>
          <p className="text-xs text-slate-500">
            {a.email} · {a.plan}{a.credits != null && ` · ${formatNumber(a.credits)} credits`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a.computers.map((pc) => <Mode key={`${pc.name}${pc.ip}`} pc={pc} />)}
          {!a.computers.length && <span className="text-[11px] text-slate-400">no computer online</span>}
          <Link to={`/admin/accounts/${a.workspaceId}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10">
            <Eye className="h-3.5 w-3.5" /> Projects & leads <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {a.issues.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
          {a.issues.map((i, n) => (
            <li key={n} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{i.msg}</span>
              <span className="shrink-0 text-rose-500/80">{timeAgo(i.at)}</span>
            </li>
          ))}
        </ul>
      )}

      {a.collecting.length > 0 && <div className="mt-3 space-y-2">{a.collecting.map((j) => <Collecting key={j.id} j={j} />)}</div>}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-white/5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Pages being read</p>
          <p className="mt-0.5 text-sm">
            <b className="tabular-nums">{formatNumber(a.reading.pending + a.reading.working)}</b> waiting
            {a.reading.working > 0 && <span className="text-slate-500"> · {a.reading.working} now</span>}
          </p>
          <p className="text-[11px] text-slate-500">{a.reading.last5min ? `${formatNumber(a.reading.last5min)} read in 5 min (${a.reading.perMin}/min)` : 'none read in the last 5 min'}</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-white/5 sm:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Waiting to start</p>
          {a.queued.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {a.queued.map((q) => (
                <span key={q.id} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-white/10" title={`Added ${timeAgo(q.createdAt)}`}>
                  <Clock className="h-3 w-3 text-slate-400" /> {q.keyword} <span className="text-slate-400">{q.country}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-sm text-slate-500">nothing</p>
          )}
        </div>
      </div>

      {a.recent.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Last 2 hours</p>
          <ul className="mt-1 divide-y divide-slate-100 text-xs dark:divide-white/5">
            {a.recent.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                {j.kind === 'links' ? <Link2 className="h-3.5 w-3.5 text-sky-500" /> : <Search className="h-3.5 w-3.5 text-slate-400" />}
                <span className="min-w-0 flex-1 truncate font-medium">{j.keyword}</span>
                <span className="text-slate-500">{j.kind === 'links' ? 'pasted links' : `${formatNumber(j.ads)} ads`} · {formatNumber(j.pages)} pages</span>
                <span className="w-28"><Progress value={pct(j.read, j.pages)} /></span>
                <span className="w-24 text-right tabular-nums text-slate-500">{formatNumber(j.read)}/{formatNumber(j.pages)} read</span>
                <span className="w-24 text-right tabular-nums font-semibold text-emerald-700 dark:text-emerald-300">{formatNumber(j.withContact)} contacts</span>
                <span className="w-20 text-right text-slate-400">{j.phase === 'stopped' ? 'stopped' : timeAgo(j.collectedAt || j.createdAt)}</span>
                {j.projectId && (
                  <Link to={`/admin/accounts/${a.workspaceId}?project=${j.projectId}`} className="font-semibold text-indigo-600 hover:underline dark:text-indigo-300">data</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export default function LiveActivity() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const load = () =>
      api('/admin/live')
        .then((r) => !stop && (setD(r), setError('')))
        .catch((e) => !stop && setError(e.message));
    load();
    const t = setInterval(() => !document.hidden && load(), 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-2 font-display font-bold">
          <Radio className="h-4 w-4 text-rose-500" /> Live — what every account is doing
        </h3>
        <span className="text-xs text-slate-500">{d ? `updated ${timeAgo(d.at)} · every 5 s` : 'loading…'}</span>
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
      {!d ? (
        <Loader2 className="mx-auto my-8 h-5 w-5 animate-spin text-slate-400" />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className={cn('rounded-full px-2.5 py-1 font-semibold', d.engine.running ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300')}>
              {d.engine.running ? 'Engine running' : `Paused${d.engine.pausedReason ? ` — ${d.engine.pausedReason}` : ''}`}
            </span>
            {d.engine.cooldownUntil && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">Break until {new Date(d.engine.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-white/10"><b className="tabular-nums">{formatNumber(d.engine.pagesLastMin)}</b> pages read in the last minute</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-white/10"><b className="tabular-nums">{formatNumber(d.engine.pagesLast5min)}</b> in 5 min</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-white/10"><b className="tabular-nums">{formatNumber(d.engine.queue)}</b> pages in the queue</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-white/10"><b className="tabular-nums">{d.engine.readingNow.length}</b> being read now</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-white/10"><MousePointerClick className="mr-1 inline h-3 w-3" /><b className="tabular-nums">{d.engine.computersOnline}</b> computers online</span>
          </div>
          {d.engine.readingNow.length > 0 && (
            <p className="mt-2 truncate text-[11px] text-slate-500">Reading now: {d.engine.readingNow.map((x) => x.page).join(' · ')}</p>
          )}
          {!d.accounts.length ? (
            <p className="mt-6 text-center text-sm text-slate-500">Nobody has worked in the last 2 hours.</p>
          ) : (
            <ul className="mt-4 space-y-3">{d.accounts.map((a) => <Account key={a.workspaceId} a={a} />)}</ul>
          )}
        </>
      )}
    </section>
  );
}
