import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  CheckCircle2, CircleStop, Clock, ExternalLink, FileSearch, FolderOpen, Hourglass, Link2, Loader2, Lock, RotateCw, Search, Sparkles, Trash2, X,
} from 'lucide-react';
import { api, extensionHere, kickExtension } from '../lib/api';
import { COUNTRIES, cn, formatNumber, timeAgo } from '../lib/utils';
import { Button, EmptyState, Modal, PageHeader, Progress, ShimmerButton, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';
import { useAuth } from '../lib/auth';
import AdFilters, { EMPTY_FILTERS, filterSummary } from '../components/AdFilters';

// the last filters used stay for next time (this browser only)
const savedFilters = () => {
  try {
    return { ...EMPTY_FILTERS, ...JSON.parse(localStorage.getItem('fblf:adFilters') || '{}') };
  } catch {
    return EMPTY_FILTERS;
  }
};

const splitKeywords = (text) => text.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** Where a search is: waiting → collecting ads → reading pages → done (or stopped). */
function stageOf(j) {
  if (j.phase === 'queued') return 'waiting';
  if (j.phase === 'collecting') return 'collecting';
  if (j.phase === 'stopped') return j.pending > 0 ? 'reading' : 'stopped';
  if (j.pending > 0) return 'reading';
  return 'done';
}
const STAGE = {
  waiting: { label: 'Waiting', icon: Hourglass, dot: 'bg-slate-400', text: 'text-slate-600 dark:text-slate-300', chip: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200' },
  collecting: { label: 'Collecting ads', icon: Loader2, dot: 'bg-indigo-500', text: 'text-indigo-600 dark:text-indigo-300', chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200' },
  reading: { label: 'Reading pages', icon: FileSearch, dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-300', chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200' },
  done: { label: 'Done', icon: CheckCircle2, dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-300', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200' },
  stopped: { label: 'Stopped', icon: CircleStop, dot: 'bg-rose-400', text: 'text-rose-600 dark:text-rose-300', chip: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200' },
};

function StageChip({ stage }) {
  const s = STAGE[stage];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', s.chip)}>
      <s.icon className={cn('h-3.5 w-3.5', stage === 'collecting' && 'animate-spin')} aria-hidden="true" />
      {s.label}
    </span>
  );
}

// ---------------- keywords as chips ----------------
function KeywordInput({ value, onChange, inputRef, invalid, onSubmit }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const have = new Set(value.map((k) => k.toLowerCase()));
    const next = [...value];
    let dupes = 0;
    for (const k of splitKeywords(raw)) {
      if (have.has(k.toLowerCase())) dupes++;
      else {
        have.add(k.toLowerCase());
        next.push(k.slice(0, 200));
      }
    }
    if (dupes) toast.message(`${dupes} keyword${dupes > 1 ? 's were' : ' was'} already in the list`);
    onChange(next.slice(0, 50));
  };
  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        'input flex min-h-[120px] cursor-text flex-wrap content-start items-start gap-1.5 py-2.5 focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10',
        invalid && 'border-rose-400 focus-within:border-rose-500',
      )}
    >
      <AnimatePresence initial={false}>
        {value.map((k, i) => (
          <motion.span
            key={k}
            layout
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 py-1 pl-2 pr-1 text-sm font-semibold text-indigo-800 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-100 dark:ring-indigo-500/30"
          >
            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-md bg-indigo-600 px-1 text-[10px] font-bold text-white">{i + 1}</span>
            {k}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== k));
              }}
              aria-label={`Remove ${k}`}
              className="rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700 dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        id="kw"
        ref={inputRef}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\n]/.test(v)) {
            add(v);
            setText('');
          } else setText(v);
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            add(text + t);
            setText('');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (text.trim()) add(text);
            setText('');
            onSubmit(text);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) add(text);
            setText('');
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => {
          if (text.trim()) add(text);
          setText('');
        }}
        placeholder={value.length ? 'Add another…' : 'Type a keyword and press Enter — or paste a list'}
        className="min-w-[200px] flex-1 border-0 bg-transparent p-1 text-sm outline-none focus:ring-0"
        aria-invalid={invalid}
        aria-describedby="kw-help kw-err"
      />
    </div>
  );
}

// ---------------- the board: what runs now, what comes next ----------------
function BoardCard({ j, stage, position, onStop, onRemove, admin }) {
  const s = STAGE[stage];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        'rounded-xl border bg-white p-3 shadow-sm dark:bg-slate-900',
        stage === 'collecting' ? 'border-indigo-300 ring-2 ring-indigo-500/15 dark:border-indigo-500/40' : 'border-slate-200 dark:border-white/10',
      )}
    >
      <div className="flex items-start gap-2">
        {position != null && (
          <span className="flex h-6 min-w-[1.5rem] shrink-0 items-center justify-center rounded-md bg-slate-100 px-1 text-[11px] font-bold text-slate-600 dark:bg-white/10 dark:text-slate-300">#{position}</span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight" title={j.keyword}>
            {j.kind === 'links' && <Link2 className="mr-1 inline h-3.5 w-3.5 text-sky-500" aria-label="Pasted links" />}
            {j.keyword}
          </p>
          <p className="text-[11px] text-slate-500">
            {j.kind === 'links' ? 'Pasted links' : j.country}
            {j.minAds > 1 && ` · ${j.minAds}+ ads per page`}
            {filterSummary(j.filters) && ` · ${filterSummary(j.filters)}`}
            {stage === 'waiting' && ` · added ${timeAgo(j.createdAt)}`}
            {stage === 'collecting' && j.startedAt && ` · started ${timeAgo(j.startedAt)}`}
            {admin && stage === 'collecting' && j.pc && <span className="font-semibold text-indigo-600 dark:text-indigo-300"> · on {j.pc}</span>}
            {stage === 'done' && ` · ${timeAgo(j.collectedAt || j.createdAt)}`}
          </p>
        </div>
        {stage === 'waiting' && (
          <button onClick={() => onRemove(j)} title="Remove from the queue" aria-label={`Remove ${j.keyword} from the queue`} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {stage === 'collecting' && (() => {
        const collected = j.adsSeen || 0;
        const totalOnFb = j.totalResults != null ? Math.max(j.totalResults, collected) : null;
        const target = totalOnFb != null && totalOnFb > 0 ? Math.min(j.maxAds || 20000, totalOnFb) : (j.maxAds || 20000);
        const remaining = totalOnFb != null ? Math.max(0, target - collected) : null;
        const progressPct = Math.min(100, pct(collected, target));
        const etaMin = remaining != null && remaining > 0 ? Math.max(1, Math.ceil(remaining / 750)) : null;
        return (
          <div className="mt-2.5">
            <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-slate-50 p-2 text-center ring-1 ring-inset ring-slate-200/70 dark:bg-white/[0.04] dark:ring-white/10">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">FB Results</div>
                <div className="mt-0.5 text-xs font-extrabold tabular-nums text-slate-800 dark:text-slate-100">
                  {totalOnFb != null ? formatNumber(totalOnFb) : <span className="text-[11px] font-medium text-slate-400">Scanning…</span>}
                </div>
              </div>
              <div className="border-x border-slate-200/70 px-1 dark:border-white/10">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500 dark:text-indigo-300">Collected</div>
                <div className="mt-0.5 text-xs font-extrabold tabular-nums text-indigo-700 dark:text-indigo-300">
                  {formatNumber(collected)}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Remaining</div>
                <div className="mt-0.5 text-xs font-extrabold tabular-nums text-amber-700 dark:text-amber-300">
                  {remaining != null ? formatNumber(remaining) : '…'}
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-baseline justify-between text-[11px]">
              <span className="font-semibold text-indigo-700 dark:text-indigo-300">
                {progressPct}% {totalOnFb != null ? `of ${formatNumber(target)} target` : `of max ${formatNumber(j.maxAds)}`}
              </span>
              <span className="text-slate-500">
                {etaMin ? `~${etaMin} min left · ` : ''}max {formatNumber(j.maxAds)}
              </span>
            </div>
            <div className="mt-1"><Progress value={progressPct} /></div>
            {j.tabHidden && (
              <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] font-semibold leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                Waiting — the Ad Library tab{admin && j.pc ? ` on ${j.pc}` : ''} is in the background. Bring it to the front: Facebook only loads more ads while it is visible.
              </p>
            )}
            {j.stuckNote && !j.tabHidden && (
              <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] font-semibold leading-snug text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                {admin ? j.stuckNote : 'Retrying connection in the background…'}
              </p>
            )}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-slate-500">
                <b className="text-slate-700 dark:text-slate-200">{formatNumber(j.pageCount)}</b> pages found{j.scraped > 0 ? ` · ${formatNumber(j.scraped)} read` : ''}
              </span>
              <button onClick={() => onStop(j)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                <CircleStop className="h-3 w-3" /> Stop
              </button>
            </div>
          </div>
        );
      })()}
      {stage === 'reading' && (
        <div className="mt-2.5">
          {j.adsSeen > 0 && (
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-500">
              <span>Ads collected: <b className=" tabular-nums text-slate-700 dark:text-slate-200">{formatNumber(j.adsSeen)}</b>{j.totalResults != null ? ` of ${formatNumber(j.totalResults)} on FB` : ''}</span>
              <span className="text-emerald-600 dark:text-emerald-400">0 left</span>
            </div>
          )}
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-semibold text-sky-700 dark:text-sky-300">{formatNumber(j.scraped)}/{formatNumber(j.pageCount)} pages read</span>
            <span className="text-slate-500">{formatNumber(j.withContact)} with contact</span>
          </div>
          <div className="mt-1"><Progress value={pct(j.scraped, j.pageCount)} /></div>
        </div>
      )}
      {stage === 'done' && (
        <div className="mt-2 space-y-0.5 text-xs">
          <p>
            <b className="text-emerald-700 dark:text-emerald-300">{formatNumber(j.withContact)}</b>{' '}
            <span className="text-slate-500">contacts from {formatNumber(j.pageCount)} pages</span>
          </p>
          {j.adsSeen > 0 && (
            <p className="text-[11px] text-slate-400">
              {formatNumber(j.adsSeen)} ads collected{j.totalResults != null ? ` of ${formatNumber(j.totalResults)} on FB` : ''}
            </p>
          )}
        </div>
      )}
      {j.projectId && stage !== 'waiting' && (
        <Link to={`/projects/${j.projectId}`} className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:underline dark:text-indigo-400">
          <FolderOpen className="h-3 w-3" /> Open project
        </Link>
      )}
    </motion.div>
  );
}

function Board({ jobs, onStop, onRemove, admin }) {
  const recent = Date.now() - 6 * 3600e3;
  const cols = {
    waiting: jobs.filter((j) => stageOf(j) === 'waiting').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    collecting: jobs.filter((j) => stageOf(j) === 'collecting'),
    reading: jobs.filter((j) => stageOf(j) === 'reading'),
    done: jobs.filter((j) => stageOf(j) === 'done' && new Date(j.collectedAt || j.createdAt) > recent).slice(0, 6),
  };
  const active = cols.waiting.length + cols.collecting.length + cols.reading.length;
  if (!active) return null;
  const pagesLeft = cols.reading.reduce((a, j) => a + (j.pending || 0), 0) + cols.collecting.reduce((a, j) => a + Math.max(0, j.pageCount - j.scraped), 0);
  const order = ['waiting', 'collecting', 'reading', 'done'];
  const hint = {
    waiting: 'Up to 2 searches run in parallel on the server, in this order',
    collecting: 'Cloud engine scanning the Meta Ad Library in background',
    reading: "Server reading each advertiser's page for phone, WhatsApp & email",
    done: 'Finished in the last 6 hours',
  };
  return (
    <section className="mt-8" aria-labelledby="board-h">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 id="board-h" className="flex items-center gap-2 font-display text-lg font-bold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
          </span>
          Working now
        </h2>
        <p className="text-xs text-slate-500">
          {active} search{active > 1 ? 'es' : ''} in progress{pagesLeft > 0 && <> · <b className="text-slate-700 dark:text-slate-200">{formatNumber(pagesLeft)}</b> pages left to read</>} · updates every 5 s
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {order.map((stage, i) => {
          const s = STAGE[stage];
          const list = cols[stage];
          return (
            <div key={stage} className="relative rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-3 flex items-center gap-2 px-1">
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-white', s.dot)}>{i + 1}</span>
                <span className={cn('text-sm font-bold', s.text)}>{s.label}</span>
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-bold tabular-nums text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-300">{list.length}</span>
              </div>
              <p className="-mt-2 mb-3 px-1 text-[11px] text-slate-500">{hint[stage]}</p>
              <div className="max-h-[420px] space-y-2 overflow-y-auto pr-0.5">
                <AnimatePresence initial={false}>
                  {list.map((j, idx) => (
                    <BoardCard key={j.id} j={j} stage={stage} position={stage === 'waiting' ? idx + 1 : null} onStop={onStop} onRemove={onRemove} admin={admin} />
                  ))}
                </AnimatePresence>
                {!list.length && <p className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400 dark:border-white/10">Nothing here</p>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------- the page ----------------
const FILTERS = [
  ['all', 'All'],
  ['active', 'In progress'],
  ['done', 'Done'],
  ['stopped', 'Stopped'],
];

export default function Searches() {
  const [params, setParams] = useSearchParams();
  const { stats, refresh } = useStats();
  const { me } = useAuth();
  const admin = me?.user.role === 'admin'; // computers, versions and engine notes are for the team only
  const [jobs, setJobs] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [country, setCountry] = useState('BD');
  const [maxAds, setMaxAds] = useState(200);
  const [minAds, setMinAds] = useState(1);
  const [filters, setFiltersState] = useState(savedFilters);
  const setFilters = (f) => {
    setFiltersState(f);
    try {
      localStorage.setItem('fblf:adFilters', JSON.stringify(f));
    } catch {
      /* private window — fine */
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [del, setDel] = useState(null);
  const [show, setShow] = useState('all');
  const [find, setFind] = useState('');
  const inputRef = useRef(null);
  const boardRef = useRef(null);

  // what the plan allows (billing.js accountOf): max ads per search, and the "N+ ads per page" condition
  const acc = stats?.account;
  const planMax = acc?.maxAdsPerSearch || 500;
  const fixedMax = !!acc && !acc.unlimited && acc.plan === 'free';
  const canFilter = acc ? !!acc.minAdsFilter : false;
  const maxChoices = [500, 2000, 5000, 10000, 20000].filter((n) => n <= planMax);

  const load = () => api('/jobs').then(setJobs).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  // start at the team's default (team) or the plan's maximum (customers); never above the plan
  const startedMax = useRef(false);
  useEffect(() => {
    if (!acc || startedMax.current) return;
    startedMax.current = true;
    if (acc.unlimited) api('/settings').then((s) => s.worker?.maxAds && setMaxAds(Math.min(s.worker.maxAds, planMax))).catch(() => {});
    else setMaxAds(planMax);
  }, [acc, planMax]);
  useEffect(() => {
    if (!canFilter && minAds !== 1) setMinAds(1);
    if (Number(maxAds) > planMax) setMaxAds(planMax);
  }, [canFilter, minAds, maxAds, planMax]);
  // every 5 s while something runs, every 15 s otherwise
  const running = (jobs || []).some((j) => ['waiting', 'collecting', 'reading'].includes(stageOf(j)));
  useEffect(() => {
    const t = setInterval(() => !document.hidden && load(), running ? 5000 : 15000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (params.get('new')) {
      inputRef.current?.focus();
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const submit = async (e, pendingText = '') => {
    e?.preventDefault?.();
    const list = [...keywords, ...splitKeywords(pendingText)];
    if (!list.length) {
      setError('Add at least one keyword — e.g. "organic food"');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api('/jobs', { method: 'POST', body: { keywords: list, country, maxAds: Number(maxAds), minAds, filters } });
      setKeywords([]);
      kickExtension();
      const skipped = r.skipped || [];
      if (skipped.length) {
        toast.message(`Already running — not added again: ${skipped.map((k) => `"${k}"`).join(', ')}`, {
          description: 'Watch it on the board below. Pressing Start twice would only collect the same ads twice.',
        });
      }
      if (r.created) {
        const ahead = (jobs || []).filter((j) => ['waiting', 'collecting'].includes(stageOf(j))).length;
        toast.success(`${r.created} search${r.created === 1 ? '' : 'es'} added`, {
          description: stats?.serverCollector
            ? ahead
              ? `${ahead} search${ahead > 1 ? 'es are' : ' is'} ahead in the queue — our cloud server runs up to 2 searches in parallel in the background.`
              : 'Collecting in the background on the server right now — no browser tab needed.'
            : ahead
              ? `${ahead} search${ahead > 1 ? 'es are' : ' is'} ahead in the queue — yours start${r.created > 1 ? '' : 's'} after ${ahead > 1 ? 'them' : 'it'}, one at a time.`
              : extensionHere()
                ? 'The Ad Library opens in a few seconds — they run one after the other.'
                : 'The extension picks them up within 30 seconds — they run one after the other.',
        });
      }
      await load();
      refresh();
      setTimeout(() => boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const addExample = (k) => {
    setError('');
    if (!keywords.some((x) => x.toLowerCase() === k)) setKeywords((v) => [...v, k]);
  };
  const stop = async (j) => {
    try {
      await api(`/jobs/${j.id}/stop`, { method: 'POST' });
      toast.success(`"${j.keyword}" stopped`, { description: 'Everything found so far is kept.' });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const removeQueued = async (j) => {
    try {
      await api(`/jobs/${j.id}`, { method: 'DELETE' });
      toast.success(`"${j.keyword}" removed from the queue`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const workerOk = stats?.worker && stats.worker.seenAgo < 120;
  const counts = useMemo(() => {
    const c = { all: 0, active: 0, done: 0, stopped: 0 };
    for (const j of jobs || []) {
      const st = stageOf(j);
      c.all++;
      if (st === 'done') c.done++;
      else if (st === 'stopped') c.stopped++;
      else c.active++;
    }
    return c;
  }, [jobs]);
  const history = (jobs || []).filter((j) => {
    const st = stageOf(j);
    if (show === 'active' && !['waiting', 'collecting', 'reading'].includes(st)) return false;
    if (show === 'done' && st !== 'done') return false;
    if (show === 'stopped' && st !== 'stopped') return false;
    return !find.trim() || j.keyword.toLowerCase().includes(find.trim().toLowerCase());
  });

  return (
    <div>
      <PageHeader icon={Search} title="Searches" subtitle="Add keywords — our cloud engine collects ads from the Meta Ad Library and reads every page for contacts automatically in the background" />

      {/* ---------- new searches ---------- */}
      <form onSubmit={submit} className="card relative overflow-hidden p-6">
        <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_260px]">
          <div>
            <div className="mb-1.5 flex items-end justify-between">
              <label htmlFor="kw" className="label mb-0">Keywords</label>
              {keywords.length > 0 && (
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  <b className="text-indigo-700 dark:text-indigo-300">{keywords.length}</b> keyword{keywords.length > 1 ? 's' : ''} → {keywords.length} project{keywords.length > 1 ? 's' : ''}
                  <button type="button" onClick={() => setKeywords([])} className="font-semibold text-slate-400 hover:text-rose-600">Clear</button>
                </span>
              )}
            </div>
            <KeywordInput value={keywords} onChange={(v) => { setKeywords(v); setError(''); }} inputRef={inputRef} invalid={!!error} onSubmit={(t) => submit(null, t)} />
            {error && <p id="kw-err" role="alert" className="mt-1.5 text-xs font-semibold text-rose-600">{error}</p>}
            <div id="kw-help" className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>Try:</span>
              {['organic food', 'skin care', 'online shop', 'gadget shop'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => addExample(k)}
                  className="rounded-full border border-slate-200 px-2.5 py-0.5 font-semibold text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-white/10 dark:text-slate-300 dark:hover:bg-indigo-500/10"
                >
                  + {k}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">Enter after each keyword · paste a whole list (one per line or comma-separated) · Ctrl+Enter starts · up to 50 at once</p>
          </div>

          <div className="space-y-4 lg:border-l lg:border-slate-100 lg:pl-6 dark:lg:border-white/10">
            <div>
              <label htmlFor="country" className="label">Country</label>
              <select id="country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="max" className="label flex items-center gap-1.5">
                Max ads per keyword {fixedMax && <Lock className="h-3 w-3 text-slate-400" aria-hidden="true" />}
              </label>
              {fixedMax ? (
                // the free plan: one fixed number
                <div className="input flex items-center justify-between bg-slate-50 text-slate-500 dark:bg-white/5">
                  <span className="font-semibold tabular-nums">{planMax.toLocaleString()}</span>
                  <span className="text-[11px]">{acc?.planName}</span>
                </div>
              ) : (
                <>
                  <input id="max" type="number" min={10} max={planMax} className="input tabular-nums" value={maxAds} onChange={(e) => setMaxAds(e.target.value)} onBlur={() => setMaxAds((v) => Math.min(planMax, Math.max(10, Number(v) || planMax)))} />
                  <div className="mt-1.5 flex gap-1">
                    {maxChoices.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setMaxAds(n)}
                        className={cn('flex-1 rounded-md border py-0.5 text-[11px] font-semibold tabular-nums transition', Number(maxAds) === n ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300 dark:border-white/10 dark:text-slate-300')}
                      >
                        {n >= 1000 ? `${n / 1000}K` : n}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!acc?.unlimited && (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Your plan: up to {planMax.toLocaleString()} ads per search.{' '}
                  <Link to="/billing" className="font-semibold text-indigo-600 hover:underline">Upgrade for more</Link>
                </p>
              )}
              {Number(maxAds) > 5000 && !fixedMax && (
                <p className="mt-1.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                  Large searches (5,000+ ads) paginate through the Ad Library in the background using rotating proxies (~6–15 min).
                </p>
              )}
            </div>
            <div className={cn(!canFilter && 'opacity-60')}>
              <label htmlFor="minads" className="label flex items-center gap-1.5">
                Only pages running at least {!canFilter && <Lock className="h-3 w-3 text-slate-400" aria-hidden="true" />}
              </label>
              <div className="flex gap-1">
                {[1, 2, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={!canFilter && n > 1}
                    onClick={() => setMinAds(n)}
                    aria-pressed={minAds === n}
                    className={cn('flex-1 rounded-lg border py-1.5 text-xs font-bold transition disabled:cursor-not-allowed', minAds === n ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300 disabled:hover:border-slate-200 dark:border-white/10 dark:text-slate-300')}
                  >
                    {n === 1 ? 'Any' : `${n}+ ads`}
                  </button>
                ))}
                <input id="minads" type="number" min={1} max={999} disabled={!canFilter} aria-label="Custom minimum ads" className="input w-14 px-1 text-center text-xs disabled:cursor-not-allowed" value={minAds} onChange={(e) => setMinAds(Math.max(1, Number(e.target.value) || 1))} />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {!canFilter ? (
                  <>Bigger advertisers only (2+, 5+ ads) is on paid plans. <Link to="/billing" className="font-semibold text-indigo-600 hover:underline">Upgrade</Link></>
                ) : minAds > 1 ? (
                  `Bigger advertisers only — pages with ${minAds}+ ads`
                ) : (
                  'Every page that runs an ad'
                )}
              </p>
            </div>
          </div>
        </div>

        <AdFilters value={filters} onChange={setFilters} />

        <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5 dark:border-white/10">
          {stats?.serverCollector ? (
            <p className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" /><span className="relative h-2 w-2 rounded-full bg-emerald-500" /></span>
              Cloud Background Engine active — searches &amp; page reading run automatically on the server (no browser tab needed)
            </p>
          ) : stats?.extensionUpdate ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Your extension (v{stats.extensionUpdate.running}) is too old to run searches — they wait until it is updated to v{stats.extensionUpdate.min} or newer.
              <Link to="/connect-extension" className="font-bold underline">Download the new version</Link>
              <span className="font-normal text-rose-600/80">then press Reload in chrome://extensions</span>
            </p>
          ) : stats?.queueWait ? (
            // the computer is taking a planned break (server: worker.js) — say why and until when
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {stats.queueWait.why === 'rest'
                ? 'Facebook asked to slow down, so the computer is resting'
                : 'A short planned break between searches, so Facebook does not block them'}
              {' — the next search starts around '}
              <b>{new Date(stats.queueWait.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
            </p>
          ) : workerOk ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" /><span className="relative h-2 w-2 rounded-full bg-emerald-500" /></span>
              Extension connected{admin ? ` (v${stats.worker.version})` : ''} — searches start right away
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Your Chrome extension is not connected — searches wait in the queue until it is.
              <Link to="/connect-extension" className="font-bold underline">Connect it</Link>
            </p>
          )}
          <ShimmerButton type="submit" disabled={busy}>
            <Search className="h-4 w-4" /> {busy ? 'Adding…' : keywords.length > 1 ? `Start ${keywords.length} searches` : 'Start search'}
          </ShimmerButton>
        </div>
      </form>

      {/* ---------- the board ---------- */}
      <div ref={boardRef} className="scroll-mt-24">{jobs && <Board jobs={jobs} onStop={stop} onRemove={removeQueued} admin={admin} />}</div>

      {/* ---------- history ---------- */}
      <div className="mb-3 mt-10 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-lg font-bold">Search history</h2>
        <div className="flex rounded-xl border border-slate-200 bg-white p-0.5 dark:border-white/10 dark:bg-slate-900" role="tablist">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={show === k}
              onClick={() => setShow(k)}
              className={cn('rounded-lg px-3 py-1 text-xs font-semibold transition', show === k ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-white')}
            >
              {label} <span className="tabular-nums opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a keyword" aria-label="Find a keyword" className="input h-9 pl-9" />
        </div>
      </div>
      {!jobs ? (
        <Skeleton className="h-48" />
      ) : !jobs.length ? (
        <EmptyState icon={Search} title="No searches yet" text="Add a keyword above to start your first search." />
      ) : !history.length ? (
        <p className="card px-4 py-8 text-center text-sm text-slate-500">No search matches.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">Keyword</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3 text-right">FB Results</th>
                <th className="px-4 py-3 text-right">Collected</th>
                <th className="px-4 py-3 text-right">Remaining</th>
                <th className="px-4 py-3 text-right">Pages</th>
                <th className="w-44 px-4 py-3">Read</th>
                <th className="px-4 py-3 text-right">Contacts</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {history.map((j) => {
                const st = stageOf(j);
                const empty = st === 'stopped' && !j.adsSeen && !j.pageCount;
                const collected = j.adsSeen || 0;
                const totalOnFb = j.totalResults != null ? Math.max(j.totalResults, collected) : null;
                const target = totalOnFb != null && totalOnFb > 0 ? Math.min(j.maxAds || 20000, totalOnFb) : (j.maxAds || 20000);
                const remaining = totalOnFb != null ? Math.max(0, target - collected) : null;
                return (
                  <tr key={j.id} className={cn('border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5', empty && 'opacity-60')}>
                    <td className="px-4 py-3">
                      <div className="font-semibold">
                        {j.kind === 'links' && <Link2 className="mr-1 inline h-3.5 w-3.5 text-sky-500" aria-label="Pasted links" />}
                        {j.keyword}
                      </div>
                      <div className="text-xs text-slate-500">
                        {j.kind === 'links' ? `Pasted links${j.linkStats ? ` · ${formatNumber(j.linkStats.valid)} Pages` : ''}` : j.country}
                        {j.manual ? ' · from the extension' : ''}
                        {admin && j.pc ? ` · on ${j.pc}` : ''}
                        {j.minAds > 1 ? ` · ${j.minAds}+ ads per page` : ''}
                      </div>
                      {filterSummary(j.filters) && <div className="mt-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-300">{filterSummary(j.filters)}</div>}
                    </td>
                    <td className="px-4 py-3"><StageChip stage={st} /></td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {j.kind === 'links' ? (
                        <span className="text-slate-400">—</span>
                      ) : totalOnFb != null ? (
                        <>
                          <span className="font-semibold text-slate-700 dark:text-slate-200">{formatNumber(totalOnFb)}</span>
                          <div className="text-[11px] text-slate-400">on FB Ad Library</div>
                        </>
                      ) : st === 'collecting' ? (
                        <span className="text-xs text-slate-400">Scanning…</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {j.kind === 'links' ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <>
                          <span className="font-semibold text-indigo-700 dark:text-indigo-300">{formatNumber(collected)}</span>
                          <div className="text-[11px] text-slate-400">max {formatNumber(j.maxAds)}</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {j.kind === 'links' ? (
                        <span className="text-slate-400">—</span>
                      ) : st === 'collecting' ? (
                        remaining != null ? (
                          <>
                            <span className="font-semibold text-amber-600 dark:text-amber-400">{formatNumber(remaining)}</span>
                            <div className="text-[11px] text-slate-400">{pct(collected, target)}% done</div>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">…</span>
                        )
                      ) : st === 'waiting' ? (
                        <span className="text-xs text-slate-400">up to {formatNumber(j.maxAds)}</span>
                      ) : st === 'stopped' ? (
                        remaining != null && remaining > 0 ? (
                          <span className="text-xs text-rose-500">{formatNumber(remaining)} skipped</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )
                      ) : (
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">0 left</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(j.pageCount)}
                      {j.minAds > 1 && j.pagesTotal > 0 && <div className="text-[11px] text-slate-400">of {formatNumber(j.pagesTotal)}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <Progress value={pct(j.scraped, j.pageCount)} />
                      <span className="mt-1 block text-[11px] tabular-nums text-slate-500">{formatNumber(j.scraped)}/{formatNumber(j.pageCount)}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className="font-semibold">{formatNumber(j.withContact)}</span>
                      {j.scraped > 0 && <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{pct(j.withContact, j.scraped)}% of pages</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                      <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      {timeAgo(j.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-0.5">
                        {j.projectId && (
                          <Link to={`/projects/${j.projectId}`} title="Open project" aria-label="Open project" className="rounded-lg p-2 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/15">
                            <FolderOpen className="h-4 w-4" />
                          </Link>
                        )}
                        {j.url && (
                          <a href={j.url} target="_blank" rel="noreferrer" title="Open in the Ad Library" aria-label="Open in the Ad Library" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                        {['waiting', 'collecting'].includes(st) ? (
                          <button title="Stop this search" aria-label="Stop this search" onClick={() => stop(j)} className="rounded-lg p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                            <CircleStop className="h-4 w-4" />
                          </button>
                        ) : j.kind === 'links' ? null : (
                          <button
                            title="Collect again"
                            aria-label="Collect again"
                            onClick={async () => {
                              try {
                                await api(`/jobs/${j.id}/requeue`, { method: 'POST' });
                                kickExtension();
                                toast.success(`"${j.keyword}" added to the queue again`);
                                load();
                              } catch (e) {
                                toast.error(e.message);
                              }
                            }}
                            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10"
                          >
                            <RotateCw className="h-4 w-4" />
                          </button>
                        )}
                        <button title="Remove from history" aria-label="Remove from history" disabled={st === 'collecting'} onClick={() => setDel(j)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 dark:hover:bg-rose-500/10">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!del}
        onClose={() => setDel(null)}
        title="Remove from search history?"
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setDel(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const j = del;
                setDel(null);
                try {
                  await api(`/jobs/${j.id}`, { method: 'DELETE' });
                  toast.success('Removed');
                  load();
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">Only removed from the history — the project and its leads stay.</p>
      </Modal>
    </div>
  );
}
