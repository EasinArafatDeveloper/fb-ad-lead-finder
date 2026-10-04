import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ExternalLink, FolderOpen, RotateCw, Search, Trash2, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { COUNTRIES, PHASE, cn, formatNumber, timeAgo } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, PageHeader, Progress, ShimmerButton, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';

export default function Searches() {
  const [params, setParams] = useSearchParams();
  const { stats, refresh } = useStats();
  const [jobs, setJobs] = useState(null);
  const [keywords, setKeywords] = useState('');
  const [country, setCountry] = useState('BD');
  const [maxAds, setMaxAds] = useState(200);
  const [minAds, setMinAds] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [del, setDel] = useState(null);
  const inputRef = useRef(null);
  const liveRef = useRef(null);

  const load = () => api('/jobs').then(setJobs).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    api('/settings').then((s) => setMaxAds(s.maxAds)).catch(() => {});
    const t = setInterval(() => !document.hidden && load(), 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (params.get('new')) {
      inputRef.current?.focus();
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const count = keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean).length;

  const submit = async (e) => {
    e?.preventDefault();
    if (!count) {
      setError('Enter at least one keyword — e.g. "organic food"');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api('/jobs', { method: 'POST', body: { keywords, country, maxAds: Number(maxAds), minAds } });
      setKeywords('');
      toast.success(`${r.created} search(es) started`, { description: 'The extension opens the Ad Library within a minute. Watch the progress under "Running now" below.' });
      await load();
      refresh();
      setTimeout(() => liveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const addExample = (k) => {
    setError('');
    setKeywords((v) => (v.trim() ? `${v.replace(/\s+$/, '')}\n${k}` : k));
    inputRef.current?.focus();
  };

  // searches still working: waiting, collecting ads, or pages not all read yet
  // (pages cancelled with Stop don't count as running)
  const live = (jobs || []).filter((j) => ['queued', 'collecting'].includes(j.phase) || (j.phase === 'collected' && j.pending > 0));
  const workerOk = stats?.worker && stats.worker.seenAgo < 120;

  return (
    <div>
      <PageHeader icon={Search} title="Searches" subtitle="Enter keywords — the extension opens the Ad Library and collects every active ad and page" />

      <form onSubmit={submit} className="card relative overflow-hidden p-6">
        <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="relative grid gap-5 lg:grid-cols-[1fr_220px]">
          <div>
            <label htmlFor="kw" className="label">Keywords</label>
            <textarea
              id="kw"
              ref={inputRef}
              rows={4}
              className={cn('input resize-y', error && 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10')}
              placeholder="Type keywords here… (one per line)"
              value={keywords}
              onChange={(e) => {
                setKeywords(e.target.value);
                if (error) setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
              }}
              aria-invalid={!!error}
              aria-describedby="kw-help kw-err"
            />
            {error && (
              <p id="kw-err" role="alert" className="mt-1.5 text-xs font-semibold text-rose-600">
                {error}
              </p>
            )}
            <div id="kw-help" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>Examples (click to add):</span>
              {['organic food', 'skin care', 'online shop', 'gadget shop'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => addExample(k)}
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 font-semibold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
                >
                  + {k}
                </button>
              ))}
              <span className="w-full pt-0.5">One keyword per line (or comma-separated) · each keyword becomes its own project · Ctrl+Enter also starts</span>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label htmlFor="country" className="label">Country</label>
              <select id="country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map(([c, n]) => (
                  <option key={c} value={c}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="max" className="label">Max ads / keyword</label>
              <input id="max" type="number" min={10} max={5000} className="input" value={maxAds} onChange={(e) => setMaxAds(e.target.value)} />
            </div>
            <div>
              <label htmlFor="minads" className="label">Condition: minimum ads per page</label>
              <div className="flex gap-1.5">
                <input id="minads" type="number" min={1} max={999} className="input w-20 text-center" value={minAds} onChange={(e) => setMinAds(Math.max(1, Number(e.target.value) || 1))} />
                <div className="flex flex-1 gap-1" role="group" aria-label="Quick condition">
                  {[1, 2, 5, 10].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setMinAds(n)}
                      aria-pressed={minAds === n}
                      className={cn(
                        'flex-1 rounded-lg border text-xs font-bold transition',
                        minAds === n ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300 dark:border-white/10 dark:text-slate-300',
                      )}
                    >
                      {n === 1 ? 'All' : `${n}+`}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{minAds > 1 ? `Only pages running ${minAds}+ ads` : 'All pages'}</p>
            </div>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap items-center justify-between gap-3">
          {workerOk ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              Extension connected (v{stats.worker.version}) — searches start right away
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Extension not connected — check that Chrome is open, the extension is on and you are logged in to Facebook. Searches wait in the queue and start once it connects.
            </p>
          )}
          <ShimmerButton type="submit" disabled={busy}>
            <Search className="h-4 w-4" /> {busy ? 'Starting…' : count > 1 ? `Start ${count} searches` : 'Start search'}
          </ShimmerButton>
        </div>
      </form>

      {/* ---------- searches that are running right now ---------- */}
      <div ref={liveRef} className="scroll-mt-24">
        {live.length > 0 && (
          <section className="mt-8" aria-labelledby="live-h">
            <h2 id="live-h" className="mb-3 flex items-center gap-2 font-display text-lg font-bold">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
              </span>
              Running now
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {live.map((j) => {
                const step =
                  j.phase === 'queued'
                    ? { text: 'Waiting for the extension — it opens the Ad Library within a minute', pct: 5 }
                    : j.phase === 'collecting'
                      ? {
                          text:
                            j.minAds > 1
                              ? `Scrolling the Ad Library — pages with ${j.minAds}+ ads are picked at the end`
                              : `Scrolling the Ad Library — ${j.adsSeen || 0}/${j.maxAds} ads, ${j.pageCount} pages`,
                          pct: 10 + ((j.adsSeen || 0) / Math.max(1, j.maxAds)) * 30,
                        }
                      : { text: `Getting contacts from pages — ${j.scraped}/${j.pageCount} read, ${j.withContact} with contact`, pct: 40 + (j.scraped / Math.max(1, j.pageCount)) * 60 };
                return (
                  <div key={j.id} className="card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-display font-bold">{j.keyword}</p>
                        <p className="text-xs text-slate-500">{j.country} · {timeAgo(j.createdAt)}</p>
                      </div>
                      <Badge tone={(PHASE[j.phase] || PHASE.collected).tone} dot="pulse" className="shrink-0">
                        {j.phase === 'collected' ? 'Scraping pages' : (PHASE[j.phase] || PHASE.collected).label}
                      </Badge>
                    </div>
                    <div className="mt-3">
                      <Progress value={step.pct} />
                      <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300">{step.text}</p>
                    </div>
                    {j.projectId && (
                      <Link to={`/projects/${j.projectId}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
                        <FolderOpen className="h-3.5 w-3.5" /> Open project to see the data
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      <h2 className="mb-3 mt-8 font-display text-lg font-bold">Search history</h2>
      {!jobs ? (
        <Skeleton className="h-48" />
      ) : !jobs.length ? (
        <EmptyState icon={Search} title="No searches yet" text="Enter a keyword above to start your first search." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">Keyword</th>
                <th className="px-4 py-3">Phase</th>
                <th className="px-4 py-3 text-right">Ads</th>
                <th className="px-4 py-3 text-right">Pages</th>
                <th className="w-48 px-4 py-3">Scraped</th>
                <th className="px-4 py-3 text-right">Contact</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const ph = PHASE[j.phase] || PHASE.collected;
                return (
                  <tr key={j.id} className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{j.keyword}</div>
                      <div className="text-xs text-slate-500">{j.country}{j.manual ? ' · manual' : ''}</div>
                      {j.minAds > 1 && <Badge tone="indigo" className="mt-1 px-2 py-0 text-[10px]">Condition: {j.minAds}+ ads</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={ph.tone} dot={j.phase === 'collecting' ? 'pulse' : true}>{ph.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(j.adsSeen)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(j.pageCount)}
                      {j.minAds > 1 && j.pagesTotal > 0 && <div className="text-[11px] text-slate-400">of {j.pagesTotal}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <Progress value={j.pageCount ? (j.scraped / j.pageCount) * 100 : 0} />
                      <span className="mt-1 block text-[11px] tabular-nums text-slate-500">{j.scraped}/{j.pageCount}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(j.withContact)}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(j.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {j.projectId && (
                          <Link to={`/projects/${j.projectId}`} title="Open project" aria-label="Open project" className="rounded-lg p-2 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/15">
                            <FolderOpen className="h-4 w-4" />
                          </Link>
                        )}
                        {j.url && (
                          <a href={j.url} target="_blank" rel="noreferrer" title="Ad Library" aria-label="Open in Ad Library" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                        <button
                          title="Collect again"
                          aria-label="Run again"
                          onClick={async () => {
                            try {
                              await api(`/jobs/${j.id}/requeue`, { method: 'POST' });
                              toast.success('Queued again');
                              load();
                            } catch (e) {
                              toast.error(e.message);
                            }
                          }}
                          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/10"
                        >
                          <RotateCw className="h-4 w-4" />
                        </button>
                        <button title="Delete" aria-label="Delete search" onClick={() => setDel(j)} className={cn('rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10')}>
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
                  toast.success('Deleted');
                  load();
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">Only removed from the history — the project and leads stay.</p>
      </Modal>
    </div>
  );
}
