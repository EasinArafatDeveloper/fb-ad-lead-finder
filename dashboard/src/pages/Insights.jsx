import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, Copy, ExternalLink, FileSpreadsheet, Lightbulb, Loader2, Lock, Printer, RefreshCw, Search } from 'lucide-react';
import { api, download } from '../lib/api';
import { cn, formatNumber } from '../lib/utils';
import { Button, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { usePerk } from '../components/PlanGate';

/**
 * Ad insights — read from the ads' own text and dates, no AI (server: insights.js). Everything is analysed and
 * everything can be seen: the short lists whole, the two long ones (every hook, every advertiser) a page at a time
 * with "Show more" and a search.
 *   scope 'project': one project's ads (/projects/:pid/insights)
 *   scope 'leads':   every ad of the leads in view on All Leads (/leads/insights?<the All Leads filters>)
 */
const adLink = (id) => `https://www.facebook.com/ads/library/?id=${id}`;
const pageAdsLink = (pageId) => (/^\d+$/.test(pageId) ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=${pageId}` : '');
const taka = (n) => `৳${Number(n).toLocaleString('en')}`;
const PER = 50;

function Bars({ title, rows, label = (r) => r.name, hint, unit = 'ads', count = (r) => r.ads, extra, first = Infinity }) {
  const [all, setAll] = useState(false);
  if (!rows?.length) return null;
  const shown = all ? rows : rows.slice(0, first);
  return (
    <section className="card p-5">
      <h2 className="font-display font-bold">{title} <span className="text-xs font-semibold text-slate-400">({formatNumber(rows.length)})</span></h2>
      {hint && <p className="mb-3 text-xs text-slate-500">{hint}</p>}
      <ul className="mt-2 space-y-2">
        {shown.map((r) => (
          <li key={label(r)}>
            <div className="flex justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium" title={label(r)}>{label(r)}</span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {formatNumber(count(r))} {unit} · <b className="text-slate-700 dark:text-slate-200">{r.pct}%</b>
                {extra && extra(r)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, r.pct)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > first && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline print:hidden dark:text-indigo-400">
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', all && 'rotate-180')} /> {all ? 'Show fewer' : `Show all ${formatNumber(rows.length)}`}
        </button>
      )}
    </section>
  );
}

/**
 * One long list (every hook / every advertiser), fetched a page at a time from the server: a search box,
 * optional switches (30+ days, sort), "Show more" — nothing is left out, it just isn't drawn all at once.
 */
function LongList({ listUrl, kind, total, params, search, renderRow, empty, children }) {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const query = (p) => {
    const q = new URLSearchParams({ kind, page: String(p), per: String(PER), ...params });
    if (search.trim()) q.set('find', search.trim());
    return `${listUrl}${listUrl.includes('?') ? '&' : '?'}${q}`;
  };
  // a new search / switch: start again from the first rows
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api(query(1))
        .then((r) => {
          if (n !== seq.current) return;
          setRows(r.rows);
          setCount(r.total);
          setPage(1);
        })
        .catch((e) => toast.error(e.message))
        .finally(() => n === seq.current && setLoading(false));
    }, search ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl, kind, search, JSON.stringify(params)]);
  const more = async () => {
    setLoading(true);
    try {
      const r = await api(query(page + 1));
      setRows((x) => [...x, ...r.rows]);
      setPage(page + 1);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div>
      {children}
      <p className="mb-2 text-xs text-slate-500">
        {count == null ? '…' : `Showing ${formatNumber(rows.length)} of ${formatNumber(count)}`}
        {count != null && count !== total && ` (${formatNumber(total)} in all)`}
      </p>
      {!rows.length && !loading ? (
        <p className="py-6 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-white/5">{rows.map(renderRow)}</ul>
      )}
      {count != null && rows.length < count && (
        <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
          <Button size="sm" onClick={more} loading={loading}>
            Show {formatNumber(Math.min(PER, count - rows.length))} more
          </Button>
          <span className="text-xs text-slate-500">{formatNumber(count - rows.length)} more — every one is also in the Excel file</span>
        </div>
      )}
      {loading && !rows.length && <Loader2 className="mx-auto mt-4 h-5 w-5 animate-spin text-slate-400" />}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="input h-9 pl-9 text-sm" />
    </div>
  );
}

function Switch({ options, value, onChange }) {
  return (
    <div className="flex rounded-xl border border-slate-200 p-0.5 dark:border-white/10">
      {options.map(([k, label]) => (
        <button key={label} type="button" onClick={() => onChange(k)} className={cn('rounded-lg px-3 py-1 text-xs font-semibold transition', value === k ? 'bg-indigo-600 text-white' : 'text-slate-500')}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Insights({ scope = 'project' }) {
  const { pid } = useParams();
  const [params] = useSearchParams();
  const leadsView = scope === 'leads';
  const search = params.toString();
  const filtered = [...params.keys()].some((k) => !['sort', 'dir', 'page'].includes(k));
  const [d, setD] = useState(null);
  const [onlyLong, setOnlyLong] = useState(false);
  const [hookFind, setHookFind] = useState('');
  const [advFind, setAdvFind] = useState('');
  const [advSort, setAdvSort] = useState('ads');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0); // a new calculation → the long lists start again
  // Excel like every other Excel export (a plan perk); Print / PDF works on every plan
  const canExcel = usePerk('excelExport');
  const excel = async () => {
    if (!canExcel) return toast.message('Excel export is not in your plan', { description: 'Print / Save as PDF works on every plan.' });
    setBusy(true);
    try {
      if (leadsView) await download(`/leads/insights.xlsx?${search}`, 'All leads - ad insights.xlsx');
      else await download(`/projects/${pid}/insights.xlsx`, `${d?.project?.name || 'project'} - ad insights.xlsx`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(
    (fresh = false) => {
      setLoading(true);
      const url = leadsView ? `/leads/insights?${search}${fresh ? `${search ? '&' : ''}fresh=1` : ''}` : `/projects/${pid}/insights`;
      return api(url)
        .then((r) => {
          setD(r);
          setVersion((v) => v + 1);
        })
        .catch((e) => toast.error(e.message))
        .finally(() => setLoading(false));
    },
    [leadsView, search, pid],
  );
  useEffect(() => {
    setD(null);
    load();
  }, [load]);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Hook copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  if (!d) {
    return (
      <div className="space-y-3">
        {leadsView && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4 animate-spin" /> Reading every ad of {filtered ? 'the leads in view' : 'all your leads'} — a big list takes a few seconds…
          </p>
        )}
        <Skeleton className="h-[70vh]" />
      </div>
    );
  }
  const listUrl = leadsView ? `/leads/insights/list${search ? `?${search}` : ''}` : `/projects/${pid}/insights/list`;
  const back = leadsView ? { to: `/leads${search ? `?${search}` : ''}`, label: 'All Leads' } : { to: `/projects/${pid}`, label: d.project.name };
  const subtitle = leadsView
    ? `What the advertisers among ${filtered ? 'the leads in view' : 'all your leads'} say in their ads — read from their own text, nothing estimated`
    : `What the advertisers for “${d.project.keyword}” (${d.project.country}) say in their ads — read from their own text, nothing estimated`;
  const coverage = [
    leadsView && [formatNumber(d.leads), 'leads'],
    leadsView && [formatNumber(d.leadsWithAds), 'of them have ads'],
    [formatNumber(d.ads), 'ads — every one read'],
    [formatNumber(d.advertiserCount), 'advertisers'],
    [formatNumber(d.hookCount), 'different hooks'],
    [formatNumber(d.adsWithOffer), 'ads name an offer'],
    [formatNumber(d.adsWithPrice), 'ads show a price'],
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <Link to={back.to} className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:underline print:hidden dark:text-indigo-400">
        <ArrowLeft className="h-4 w-4" /> {back.label}
      </Link>
      <PageHeader icon={Lightbulb} title={leadsView ? 'Ad insights — All Leads' : 'Ad insights'} subtitle={subtitle}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            {leadsView && (
              <Button onClick={() => load(true)} loading={loading} title={d.at ? `Worked out at ${new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : undefined}>
                {!loading && <RefreshCw className="h-4 w-4" />} Refresh
              </Button>
            )}
            {d.ads > 0 && (
              <>
                <Button onClick={excel} loading={busy}>
                  {canExcel ? <FileSpreadsheet className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Excel (everything)
                </Button>
                <Button onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Print / PDF
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* what was analysed — all of it */}
      <section className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-sm">
        <span className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Analysed</span>
        {coverage.map(([n, label]) => (
          <span key={label}>
            <b className="tabular-nums">{n}</b> <span className="text-slate-500">{label}</span>
          </span>
        ))}
        {leadsView && filtered && (
          <span className="text-xs text-slate-500 print:hidden">
            Only the leads matching your All Leads filters · <Link to="/leads/insights" className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400">all leads</Link>
          </span>
        )}
      </section>

      {!d.ads ? (
        <EmptyState
          icon={Lightbulb}
          title="No ads yet"
          text={leadsView ? 'None of these leads has ads — leads from pasted links or added by hand have none. Try other filters.' : 'Insights appear when the search has collected ads.'}
        />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Ads', formatNumber(d.ads), `From ${formatNumber(d.advertiserCount)} advertisers · all ${formatNumber(d.analysed)} read`],
              ['Running 30+ days', formatNumber(d.longRunning), 'An advertiser keeps paying only for an ad that works'],
              ['Most used offer', d.offers?.[0]?.ads ? d.offers[0].offer : '—', d.offers?.[0]?.ads ? `${d.offers[0].pct}% of all ads · ${d.offers[0].pctOfOffers}% of the ads with an offer` : 'No offers found'],
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
            <LongList
              key={`hooks-${version}`}
              listUrl={listUrl}
              kind="hooks"
              total={d.hookCount}
              params={onlyLong ? { minDays: '30' } : {}}
              search={hookFind}
              empty={onlyLong ? 'No hook has run 30 days — look at All.' : 'No hooks found.'}
              renderRow={(h) => (
                <li key={h.hook} className="flex items-start gap-3 py-3">
                  <span className={cn('mt-0.5 shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold tabular-nums', h.days >= 90 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200' : h.days >= 30 ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200' : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300')}>
                    {h.days} d
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">“{h.hook}”</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {h.pageName}
                      {h.ads > 1 && ` · in ${formatNumber(h.ads)} ads`}
                      {h.pages > 1 && ` · used by ${formatNumber(h.pages)} advertisers`}
                    </p>
                  </div>
                  <button type="button" onClick={() => copy(h.hook)} title="Copy the hook" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 print:hidden dark:hover:bg-white/10">
                    <Copy className="h-4 w-4" />
                  </button>
                  <a href={adLink(h.adId)} target="_blank" rel="noreferrer" title="See the ad" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 print:hidden dark:hover:bg-white/10">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </li>
              )}
            >
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="font-display font-bold">Hooks — the opening lines <span className="text-xs font-semibold text-slate-400">({formatNumber(d.hookCount)})</span></h2>
                  <p className="text-xs text-slate-500">Longest-running first. The same line used in several ads counts once. {formatNumber(d.longHookCount)} have run 30+ days.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 print:hidden">
                  <SearchBox value={hookFind} onChange={setHookFind} placeholder="Search the hooks" />
                  <Switch options={[[false, 'All'], [true, 'Running 30+ days']]} value={onlyLong} onChange={setOnlyLong} />
                </div>
              </div>
            </LongList>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Bars
              title="Offers in the ads"
              hint={d.adsWithOffer ? `${formatNumber(d.adsWithOffer)} of ${formatNumber(d.ads)} ads name an offer · % of all ads (and of the ads with an offer)` : 'No offers named in these ads'}
              rows={d.offers || []}
              label={(r) => r.offer}
              extra={(r) => <span className="ml-1 text-slate-400">({r.pctOfOffers}%)</span>}
            />
            {d.prices && (
              <section className="card p-5">
                <h2 className="font-display font-bold">Prices in the ads</h2>
                <p className="mb-4 text-xs text-slate-500">{formatNumber(d.prices.count)} prices from {formatNumber(d.adsWithPrice)} ads (delivery charges left out)</p>
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
            {leadsView && <Bars title="Categories of the leads" hint="The Page category Facebook shows (the first one)" rows={d.categories} unit="leads" count={(r) => r.leads} first={15} />}
          </div>

          <section className="card p-5">
            <LongList
              key={`adv-${version}`}
              listUrl={listUrl}
              kind="advertisers"
              total={d.advertiserCount}
              params={{ sort: advSort }}
              search={advFind}
              empty="No advertiser found."
              renderRow={(a, i) => (
                <li key={a.pageId} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium" title={a.pageName || a.pageId}>{a.pageName || a.pageId}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">{formatNumber(a.ads)} ads</span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-slate-500">{a.days} days</span>
                  {pageAdsLink(a.pageId) ? (
                    <a href={pageAdsLink(a.pageId)} target="_blank" rel="noreferrer" title="Its ads in the Ad Library" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 print:hidden dark:hover:bg-white/10">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  ) : (
                    <span className="w-7" />
                  )}
                </li>
              )}
            >
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="font-display font-bold">Advertisers <span className="text-xs font-semibold text-slate-400">({formatNumber(d.advertiserCount)})</span></h2>
                  <p className="text-xs text-slate-500">Every advertiser in these ads — how many ads it runs and how long it has been advertising.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 print:hidden">
                  <SearchBox value={advFind} onChange={setAdvFind} placeholder="Search advertisers" />
                  <Switch options={[['ads', 'Most ads'], ['days', 'Advertising longest']]} value={advSort} onChange={setAdvSort} />
                </div>
              </div>
            </LongList>
          </section>
        </>
      )}
    </div>
  );
}
