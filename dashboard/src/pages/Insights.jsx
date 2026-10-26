import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Copy, ExternalLink, FileSpreadsheet, Lightbulb, Lock, Printer } from 'lucide-react';
import { api, download } from '../lib/api';
import { cn, formatNumber } from '../lib/utils';
import { Button, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { usePerk } from '../components/PlanGate';

/**
 * A project's ad insights — read from the ads' own text and dates, no AI (server: insights.js):
 * the hooks of the ads that keep running, the offers, the prices, formats, how they take orders, top advertisers.
 */
const adLink = (id) => `https://www.facebook.com/ads/library/?id=${id}`;
const taka = (n) => `৳${Number(n).toLocaleString('en')}`;

function Bars({ title, rows, label = (r) => r.name, hint }) {
  if (!rows?.length) return null;
  return (
    <section className="card p-5">
      <h2 className="font-display font-bold">{title}</h2>
      {hint && <p className="mb-3 text-xs text-slate-500">{hint}</p>}
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={label(r)}>
            <div className="flex justify-between text-sm">
              <span className="font-medium">{label(r)}</span>
              <span className="tabular-nums text-slate-500">
                {formatNumber(r.ads)} ads · <b className="text-slate-700 dark:text-slate-200">{r.pct}%</b>
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, r.pct)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Insights() {
  const { pid } = useParams();
  const [d, setD] = useState(null);
  const [onlyLong, setOnlyLong] = useState(true);
  const [busy, setBusy] = useState(false);
  // Excel like every other Excel export (a plan perk); Print / PDF works on every plan
  const canExcel = usePerk('excelExport');
  const excel = async () => {
    if (!canExcel) return toast.message('Excel export is not in your plan', { description: 'Print / Save as PDF works on every plan.' });
    setBusy(true);
    try {
      await download(`/projects/${pid}/insights.xlsx`, `${d?.project?.name || 'project'} - ad insights.xlsx`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api(`/projects/${pid}/insights`).then(setD).catch((e) => toast.error(e.message));
  }, [pid]);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Hook copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  if (!d) return <Skeleton className="h-[70vh]" />;
  const hooks = (d.hooks || []).filter((h) => !onlyLong || h.days >= 30);
  const withOffer = d.offers?.length ? Math.max(...d.offers.map((o) => o.pct)) : 0;

  return (
    <div className="space-y-6">
      <Link to={`/projects/${pid}`} className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:underline print:hidden dark:text-indigo-400">
        <ArrowLeft className="h-4 w-4" /> {d.project.name}
      </Link>
      <PageHeader icon={Lightbulb} title="Ad insights" subtitle={`What the advertisers for “${d.project.keyword}” (${d.project.country}) say in their ads — read from their own text, nothing estimated`}
        actions={
          d.ads > 0 && (
            <div className="flex gap-2 print:hidden">
              <Button onClick={excel} loading={busy}>
                {canExcel ? <FileSpreadsheet className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Excel (all hooks)
              </Button>
              <Button onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> Print / PDF
              </Button>
            </div>
          )
        }
      />

      {!d.ads ? (
        <EmptyState icon={Lightbulb} title="No ads yet" text="Insights appear when the search has collected ads." />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Ads', formatNumber(d.ads), `${formatNumber(d.analysed)} read for insights`],
              ['Running 30+ days', formatNumber(d.longRunning), 'An advertiser keeps paying only for an ad that works'],
              ['Most used offer', d.offers?.[0]?.ads ? d.offers[0].offer : '—', d.offers?.[0]?.ads ? `${d.offers[0].pct}% of the ads` : 'No offers found'],
              ['Typical price', d.prices ? taka(d.prices.median) : '—', d.prices ? `Most between ${taka(d.prices.low)} and ${taka(d.prices.high)}` : 'No prices in the ads'],
            ].map(([k, v, sub]) => (
              <div key={k} className="card p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{k}</p>
                <p className="mt-1 font-display text-2xl font-extrabold">{v}</p>
                <p className="mt-1 text-xs text-slate-500">{sub}</p>
              </div>
            ))}
          </section>

          <section className="card p-5">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="font-display font-bold">Hooks — the opening lines</h2>
                <p className="text-xs text-slate-500">Longest-running first. The same line used in several ads counts once.</p>
              </div>
              <div className="flex rounded-xl border border-slate-200 p-0.5 dark:border-white/10">
                {[[true, 'Running 30+ days'], [false, 'All']].map(([k, label]) => (
                  <button key={label} type="button" onClick={() => setOnlyLong(k)} className={cn('rounded-lg px-3 py-1 text-xs font-semibold transition', onlyLong === k ? 'bg-indigo-600 text-white' : 'text-slate-500')}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!hooks.length ? (
              <p className="py-6 text-center text-sm text-slate-500">{onlyLong ? 'No ad has run 30 days yet — look at All.' : 'No hooks found.'}</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-white/5">
                {hooks.map((h) => (
                  <li key={h.hook} className="flex items-start gap-3 py-3">
                    <span className={cn('mt-0.5 shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold tabular-nums', h.days >= 90 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200' : h.days >= 30 ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200' : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300')}>
                      {h.days} d
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">“{h.hook}”</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {h.pageName}
                        {h.ads > 1 && ` · in ${h.ads} ads`}
                        {h.pages > 1 && ` · used by ${h.pages} advertisers`}
                      </p>
                    </div>
                    <button type="button" onClick={() => copy(h.hook)} title="Copy the hook" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10">
                      <Copy className="h-4 w-4" />
                    </button>
                    <a href={adLink(h.adId)} target="_blank" rel="noreferrer" title="See the ad" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Bars title="Offers in the ads" hint={withOffer ? 'Share of the ads that name each offer' : 'No offers named in these ads'} rows={(d.offers || []).filter((o) => o.ads > 0)} label={(r) => r.offer} />
            {d.prices && (
              <section className="card p-5">
                <h2 className="font-display font-bold">Prices in the ads</h2>
                <p className="mb-4 text-xs text-slate-500">From {formatNumber(d.prices.count)} prices written in the ads (delivery charges left out)</p>
                <dl className="grid grid-cols-5 gap-2 text-center">
                  {[['Lowest', d.prices.min], ['Low', d.prices.low], ['Typical', d.prices.median], ['High', d.prices.high], ['Highest', d.prices.max]].map(([k, v]) => (
                    <div key={k} className={cn('rounded-xl p-2', k === 'Typical' ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'bg-slate-50 dark:bg-white/5')}>
                      <dt className="text-[10px] font-semibold uppercase text-slate-400">{k}</dt>
                      <dd className="mt-0.5 text-sm font-bold tabular-nums">{taka(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <Bars title="Ad formats" rows={d.formats} />
            <Bars title="How they take orders" hint="From each ad's button and link" rows={d.orderVia} />
            <Bars title="Language of the ads" rows={d.languages} />
            <section className="card p-5">
              <h2 className="font-display font-bold">Top advertisers</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {[['Most ads', d.topByAds, (p) => `${formatNumber(p.ads)} ads`], ['Advertising longest', d.topByDays, (p) => `${p.days} days`]].map(([t, rows, v]) => (
                  <div key={t}>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t}</p>
                    <ol className="space-y-1 text-sm">
                      {rows.map((p) => (
                        <li key={p.pageId} className="flex justify-between gap-2">
                          <span className="truncate">{p.pageName || p.pageId}</span>
                          <span className="shrink-0 tabular-nums text-slate-500">{v(p)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
