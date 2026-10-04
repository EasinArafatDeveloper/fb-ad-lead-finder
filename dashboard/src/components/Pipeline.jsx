import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check, CircleAlert, CirclePause, CirclePlay, ClipboardList, FileSpreadsheet, Globe, ListPlus, Loader2, MousePointerClick, PhoneCall,
  PhoneOff, Search, Square, Trash2, TriangleAlert,
} from 'lucide-react';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Progress } from './ui';

/** Step-by-step view of one project: Queued → Collect ads → Read pages → Ready. */
export function PipelineSteps({ data }) {
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
      title: 'Ads from the Ad Library',
      text: f.jobPhase === 'queued' ? 'Waiting…' : `${formatNumber(f.ads)} ads · ${formatNumber(f.leads)} pages`,
      state: f.jobPhase === 'queued' ? 'todo' : f.jobPhase === 'collecting' ? 'active' : 'done',
      progress: f.jobPhase === 'collecting' ? (f.jobAds / Math.max(1, f.maxAds)) * 100 : null,
      live: f.jobPhase === 'collecting' && data.collecting ? `Scrolling — ${data.collecting.ads}/${data.collecting.maxAds} ads` : null,
    },
    {
      icon: PhoneCall,
      title: 'Contacts from pages',
      text: !collected ? 'Starts when ads are done' : `${scraped}/${f.leads} pages read · ${f.withContact} with contact`,
      state: !collected ? 'todo' : f.pending ? 'active' : 'done',
      progress: collected ? (scraped / Math.max(1, f.leads)) * 100 : null,
      live: collected && f.pending && data.working ? `Reading now: ${data.working.name}` : null,
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

export function NowLine({ data }) {
  if (!data) return null;
  let text;
  let tone = 'indigo';
  if (!data.running) {
    text = `Paused${data.pausedReason ? ` — ${data.pausedReason}` : ''}. Press Resume at the top to continue.`;
    tone = 'amber';
  } else if (data.cooldownUntil && !data.collecting) {
    const at = new Date(data.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    text = `Facebook asked for a login, so the worker is taking a break — it continues by itself at ${at}. Nothing to do.`;
    tone = 'amber';
  } else if (data.collecting) text = `Collecting ads for "${data.collecting.keyword}" in the Ad Library — ${data.collecting.ads} ads, ${data.collecting.pages} pages so far`;
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
      {tone === 'indigo' && data.pendingAll > 0 && data.etaMinutes > 0 && (
        <span
          className="hidden shrink-0 rounded-full bg-white/15 px-2.5 py-1 text-xs font-semibold sm:inline"
          title={data.paceMeasured ? 'Based on the real speed of the last few pages' : 'Estimate — becomes exact after a few pages'}
        >
          {data.tomorrow > 0 ? `Today's ${data.todayLeft}` : 'Remaining'} ~{data.etaMinutes} min · ~{data.secPerPage}s per page
          {data.tomorrow > 0 && ` · ${data.tomorrow} tomorrow`}
        </span>
      )}
      {data.focus && (
        <Link to={`/projects/${data.focus.id}`} className={cn('hidden shrink-0 text-xs font-bold underline-offset-2 hover:underline md:inline', tone === 'indigo' ? 'text-white' : '')}>
          Open project →
        </Link>
      )}
    </div>
  );
}
