import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity, ArrowRight, AtSign, Clock, LayoutDashboard, Phone, Plus, Users, Workflow } from 'lucide-react';
import { api } from '../lib/api';
import { formatNumber, PHASE, timeAgo } from '../lib/utils';
import { Badge, EmptyState, KpiCard, PageHeader, Progress, ShimmerButton, Skeleton } from '../components/ui';
import { FolderIcon } from '../components/FileIcons';
import { ActivityFeed, NowLine, PipelineSteps } from '../components/Pipeline';
import { useStats } from '../components/Layout';

export default function Dashboard() {
  const { stats } = useStats();
  const [pipe, setPipe] = useState(null);
  const [projects, setProjects] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const loadPipe = () => api('/pipeline').then(setPipe).catch(() => {});
    const loadProjects = () => api('/projects').then(setProjects).catch(() => {});
    loadPipe();
    loadProjects();
    const fast = setInterval(() => !document.hidden && loadPipe(), 10000);
    const slow = setInterval(() => !document.hidden && loadProjects(), 30000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, []);

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

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

      {/* 1 — what is happening right now */}
      <section aria-labelledby="now-h" className="-mt-2 space-y-4">
        <h2 id="now-h" className="sr-only">What is happening now</h2>
        {pipe ? <NowLine data={pipe} /> : <Skeleton className="h-12" />}

        {/* 2 — the current project, step by step */}
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
            <PipelineSteps data={pipe} />
            {pipe.queued.length > 0 && (
              <p className="mt-4 text-xs text-slate-500">
                Next in queue: {pipe.queued.slice(0, 5).map((q) => `“${q.keyword}”`).join(', ')}
                {pipe.queued.length > 5 && ` +${pipe.queued.length - 5}`}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 3 — totals */}
      <section aria-label="Totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats ? (
          <>
            <KpiCard label="Total leads" value={stats.total} icon={Users} tone="indigo" sub={`across ${formatNumber(projects?.length || 0)} projects`} />
            <KpiCard label="Phone / WhatsApp" value={stats.withPhone} icon={Phone} tone="emerald" sub={`${pct(stats.withPhone, stats.total)}% of leads have a number`} />
            <KpiCard label="Email" value={stats.withEmail} icon={AtSign} tone="blue" sub={`${pct(stats.withEmail, stats.total)}% of leads have an email`} />
            <KpiCard label="Queue" value={stats.pending} icon={Clock} tone="amber" sub={`${stats.scrapedToday}/${stats.dailyLimit} pages read today`} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[140px]" />)
        )}
      </section>

      {/* 4 — timeline + projects */}
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
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
