import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Activity, ArrowRight, AtSign, Check, Clock, LayoutDashboard, Phone, Plus, Users, Workflow } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { cn, formatNumber, PHASE, timeAgo } from '../lib/utils';
import { Badge, EmptyState, KpiCard, PageHeader, Progress, ShimmerButton, Skeleton } from '../components/ui';
import { FolderIcon } from '../components/FileIcons';
import { ActivityFeed, HealthPanel, IP_HEALTH_KEYS, LiveBoard, NowLine, PipelineSteps, ProxyCard } from '../components/Pipeline';
import { useStats } from '../components/Layout';

/** Something is moving: a search collecting, pages waiting or being read. */
const isBusy = (p) => !!p && (!!p.collecting || p.pendingAll > 0 || (p.live?.lanes?.length || 0) > 0);

export default function Dashboard() {
  const { stats, refresh: refreshStats } = useStats();
  const [pipe, setPipe] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [projects, setProjects] = useState(null);
  const navigate = useNavigate();
  const { me, refreshMe } = useAuth();
  const [params, setParams] = useSearchParams();
  // after sign-up / after the email link
  useEffect(() => {
    if (params.get('welcome')) toast.success('Welcome! Your free credits are ready', { description: 'Confirm your email (link in your inbox) and start your first keyword search.' });
    if (params.get('verified')) {
      toast.success('Email confirmed — you can start searching');
      refreshMe?.();
    }
    if (params.get('welcome') || params.get('verified')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live: every 2 s while the engine works, every 10 s when idle — no reloading by hand
  useEffect(() => {
    let stop = false;
    let timer;
    let rounds = 0;
    const loop = async () => {
      let busy = false;
      if (!document.hidden) {
        try {
          const p = await api('/pipeline');
          if (stop) return;
          setPipe(p);
          setUpdatedAt(Date.now());
          busy = isBusy(p);
          // the numbers in the cards and the project list follow along
          if (busy || rounds % 3 === 0) {
            refreshStats();
            api('/projects').then((x) => !stop && setProjects(x)).catch(() => {});
          }
        } catch {
          /* offline for a moment — try again */
        }
      }
      rounds++;
      if (!stop) timer = setTimeout(loop, busy ? 2000 : 10000);
    };
    loop();
    const wake = () => !document.hidden && (clearTimeout(timer), loop());
    document.addEventListener('visibilitychange', wake);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // customers see what is found and how far it is; the engine's inner workings are for the team only
  const admin = me?.user.role === 'admin';

  return (
    <div className="space-y-8">
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle="What happened, what's happening now, and what's next — step by step"
        actions={
          <ShimmerButton onClick={() => navigate('/search?new=1')}>
            <Plus className="h-4 w-4" /> New search
          </ShimmerButton>
        }
      />

      {/* a new customer: three steps to the first leads */}
      {pipe && me?.user.role !== 'admin' && (!pipe.extensionConnected || !stats?.total) && (
        <section className="card overflow-hidden" aria-labelledby="start-h">
          <div className="border-b border-slate-100 bg-gradient-to-r from-indigo-600 to-blue-600 px-6 py-4 text-white dark:border-white/10">
            <h2 id="start-h" className="font-display text-lg font-bold">Get your first leads in 3 steps</h2>
            <p className="text-sm text-white/80">You have {pipe.account?.unlimited ? 'unlimited' : formatNumber(pipe.account?.credits || 0)} credits — 1 credit = 1 Facebook Page read.</p>
          </div>
          <ol className="grid gap-px bg-slate-100 sm:grid-cols-3 dark:bg-white/10">
            {(pipe.serverCollector
              ? [
                  [me?.user.emailVerified !== false, 'Confirm your email', 'Click the link we sent to your inbox.', null],
                  [stats?.total > 0 || !!pipe.collecting || (pipe.queued?.length || 0) > 0, 'Start a keyword search', 'Type a keyword and pick a country — our cloud server collects the ads in the background.', '/search?new=1'],
                  [stats?.withPhone > 0 || stats?.withEmail > 0, 'Export verified leads', 'Filter by phone, WhatsApp, or email and export to Excel, CSV, or Google Sheets.', '/leads'],
                ]
              : [
                  [me?.user.emailVerified !== false, 'Confirm your email', 'Click the link we sent you.', null],
                  [pipe.extensionConnected, 'Connect the Chrome extension', 'Your searches run in your own Chrome.', '/connect-extension'],
                  [stats?.total > 0, 'Start a search', 'Type a keyword, pick a country.', '/search?new=1'],
                ]
            ).map(([done, title, text, to], i) => (
              <li key={title} className="bg-white p-5 dark:bg-slate-900">
                <div className="flex items-center gap-2">
                  <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-emerald-500 text-white' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200')}>
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </span>
                  <span className={cn('font-semibold', done && 'text-slate-400 line-through')}>{title}</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-500">{text}</p>
                {!done && to && (
                  <Link to={to} className="mt-3 inline-flex items-center gap-1 text-sm font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                    {!pipe.serverCollector && i === 1 ? 'Connect now' : 'Start'} <ArrowRight className="h-4 w-4" />
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 1 — one line: what is happening right now, and anything that needs you */}
      <section aria-labelledby="now-h" className="-mt-2 space-y-3">
        <h2 id="now-h" className="sr-only">What is happening now</h2>
        {pipe ? <NowLine data={pipe} simple={!admin} /> : <Skeleton className="h-12" />}
        {pipe && <HealthPanel items={pipe.health} hide={IP_HEALTH_KEYS} />}
      </section>

      {/* 2 — totals */}
      <section aria-label="Totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats ? (
          <>
            <KpiCard label="Total leads" value={stats.total} icon={Users} tone="indigo" sub={`across ${formatNumber(projects?.length || 0)} projects`} />
            <KpiCard label="Phone / WhatsApp" value={stats.withPhone} icon={Phone} tone="emerald" sub={`${pct(stats.withPhone, stats.total)}% of leads have a number`} />
            <KpiCard label="Email" value={stats.withEmail} icon={AtSign} tone="blue" sub={`${pct(stats.withEmail, stats.total)}% of leads have an email`} />
            <KpiCard label="Queue" value={stats.pending} icon={Clock} tone="amber" sub={stats.dailyLimit != null ? `${stats.scrapedToday}/${stats.dailyLimit} pages read today` : `${stats.workerVisitsToday} pages read for you today`} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[140px]" />)
        )}
      </section>

      {/* 3 — the engine: the current project step by step + the live board, and the proxy IPs beside it */}
      <div className={cn('grid items-start gap-6', pipe?.server && 'xl:grid-cols-[1fr_340px]')}>
        <div className="min-w-0 space-y-6">
          {pipe?.focus && (
            <div className="card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30">
                    <Workflow className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="font-display text-lg font-bold leading-tight">{pipe.focus.name}</h2>
                    <p className="text-xs text-slate-500">
                      {pipe.focus.country} · where this project is right now
                      {pipe.focus.failed > 0 && <> · <span className="text-rose-600">{pipe.focus.failed} pages could not be read</span></>}
                    </p>
                  </div>
                </div>
                <Link to={`/projects/${pipe.focus.id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
                  Open project <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <PipelineSteps data={pipe} simple={!admin} />
              {pipe.queued.length > 0 && (
                <p className="mt-4 text-xs text-slate-500">
                  Next in queue: {pipe.queued.slice(0, 5).map((q) => `“${q.keyword}”`).join(', ')}
                  {pipe.queued.length > 5 && ` +${pipe.queued.length - 5}`}
                </p>
              )}
            </div>
          )}
          {/* the live board only when there is something to watch — an empty "idle" box says nothing */}
          {admin && pipe && (isBusy(pipe) || pipe.live?.recent?.length > 0) && <LiveBoard data={pipe} updatedAt={updatedAt} />}
        </div>
        {pipe?.server && <ProxyCard server={pipe.server} />}
      </div>

      {/* 4 — timeline + projects */}
      <div className={cn('grid gap-6', admin && 'xl:grid-cols-[1fr_380px]')}>
        {admin && (
        <section className="card p-5" aria-labelledby="act-h">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Activity className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <div>
              <h2 id="act-h" className="font-display font-bold">Activity</h2>
              <p className="text-xs text-slate-500">Newest first · updates every 10 seconds</p>
            </div>
          </div>
          <div className="max-h-[520px] overflow-y-auto pr-1">{pipe ? <ActivityFeed items={pipe.activity} /> : <Skeleton className="h-64" />}</div>
        </section>
        )}

        <section aria-labelledby="proj-h">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="proj-h" className="font-display text-lg font-bold">Projects</h2>
            <Link to="/projects" className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {!projects ? (
            <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
          ) : !projects.length ? (
            <EmptyState icon={Plus} title="No projects yet" text="Start your first search with a keyword — e.g. “organic food”." />
          ) : (
            <div className="space-y-3">
              {projects.slice(0, 5).map((p, i) => {
                const scraped = p.leads - p.pending;
                return (
                  <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                    <Link
                      to={`/projects/${p.id}`}
                      className="group flex gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/10 dark:border-white/10 dark:bg-slate-900"
                    >
                      <FolderIcon size={56} peek={p.leads > 0} accent className="shrink-0 transition-transform group-hover:scale-105" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="truncate font-display font-bold">{p.name}</h3>
                          <Badge tone={PHASE[p.phase]?.tone} dot={p.phase === 'done' ? true : 'pulse'} className="shrink-0 text-[10px]">
                            {PHASE[p.phase]?.label}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {formatNumber(p.leads)} leads · {formatNumber(p.withContact)} contact
                        </p>
                        <div className="mt-2.5">
                          <Progress value={p.leads ? (scraped / p.leads) * 100 : 0} />
                          <p className="mt-1 text-[11px] text-slate-400">{scraped}/{p.leads} read · {timeAgo(p.lastRunAt)}</p>
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
