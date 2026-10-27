import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowDownWideNarrow, AtSign, Check, ChevronDown, ChevronLeft, ChevronRight, CloudUpload, Download, ExternalLink, Globe, MessageCircle, Pencil, Phone, PhoneOff,
  Lightbulb, Lock, Plus, RotateCcw, RotateCw, Search, SlidersHorizontal, Trash2, Users, X,
} from 'lucide-react';
import { api, download, qs } from '../lib/api';
import { STATUSES, cn, formatNumber, host, safeUrl } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';
import { usePerk } from '../components/PlanGate';

const SCRAPE_TONE = { done: 'emerald', pending: 'amber', working: 'indigo', failed: 'rose', stopped: 'slate' };
const STATUS_TONE = { New: 'slate', Contacted: 'indigo', Interested: 'emerald', 'Not Interested': 'rose', Closed: 'amber' };
const wa = (p) => `https://wa.me/${String(p).replace(/\D/g, '')}`;
const pageLink = (l) => safeUrl(l.pageUrl) || (/^\d+$/.test(l.pageId) ? `https://www.facebook.com/${l.pageId}` : '');

function LeadDetails({ pageId }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    api(`/leads/${encodeURIComponent(pageId)}`).then(setD).catch((e) => toast.error(e.message));
  }, [pageId]);
  if (!d) return <Skeleton className="h-32" />;
  const { lead: l, ads } = d;
  const a = l.about || {};
  const info = [
    ['Address', l.address], ['Bio', a.bio], ['Category', l.category], ['Hours', a.hours], ['Price range', a.priceRange],
    ['Service area', a.serviceArea], ['Services', a.services], ['Rating', a.rating], ['Page info', a.pageInfo],
  ].filter(([, v]) => v);
  const links = [l.instagram, ...(l.socials || [])].map(safeUrl).filter(Boolean);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,380px)_1fr]">
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-slate-900">
        <h4 className="mb-2 font-display font-bold">Business info</h4>
        {info.length ? (
          <dl className="space-y-1.5">
            {info.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[96px_1fr] gap-2">
                <dt className="text-slate-500">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-slate-500">Not scraped yet.</p>
        )}
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {links.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline">
                {host(u)} <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="grid max-h-80 gap-3 overflow-y-auto sm:grid-cols-2">
        {ads.map((ad) => (
          <div key={ad.adId} className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-white/10 dark:bg-slate-900">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{ad.startDate} · {(ad.platforms || []).join(', ')}</span>
              {ad.keyword && <Badge tone="indigo" className="text-[10px]">{ad.keyword}</Badge>}
            </div>
            {ad.title && <p className="mt-1.5 font-semibold">{ad.title}</p>}
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{ad.body}</p>
            <div className="mt-2 flex gap-3 text-xs font-semibold">
              {safeUrl(ad.linkUrl) && <a className="text-indigo-600 hover:underline" href={safeUrl(ad.linkUrl)} target="_blank" rel="noreferrer">{host(ad.linkUrl)}</a>}
              <a className="text-slate-500 hover:text-indigo-600" href={`https://www.facebook.com/ads/library/?id=${ad.adId}`} target="_blank" rel="noreferrer">View ad</a>
            </div>
          </div>
        ))}
        {!ads.length && <p className="text-sm text-slate-500">No ads saved</p>}
      </div>
    </div>
  );
}

function LeadForm({ lead, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    pageName: lead?.pageName || '', pageUrl: lead?.pageUrl || '', phones: (lead?.phones || []).join(', '), whatsapp: (lead?.whatsapp || []).join(', '),
    emails: (lead?.emails || []).join(', '), website: lead?.website || '', category: lead?.category || '', status: lead?.status || 'New', notes: lead?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (lead) await api(`/leads/${encodeURIComponent(lead.pageId)}`, { method: 'PATCH', body: f });
      else await api('/leads', { method: 'POST', body: f });
      toast.success('Saved');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const fields = [
    ['pageName', 'Page name'], ['pageUrl', 'Page link'], ['phones', 'Phone(s)'], ['whatsapp', 'WhatsApp'],
    ['emails', 'Email(s)'], ['website', 'Website'], ['category', 'Category'],
  ];
  return (
    <form onSubmit={save}>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([k, label]) => (
          <div key={k}>
            <label className="label" htmlFor={`lf-${k}`}>{label}</label>
            <input id={`lf-${k}`} className="input" value={f[k]} onChange={set(k)} />
          </div>
        ))}
        <div>
          <label className="label" htmlFor="lf-status">Status</label>
          <select id="lf-status" className="input" value={f.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <label className="label mt-4" htmlFor="lf-notes">Notes</label>
      <textarea id="lf-notes" rows={3} className="input" value={f.notes} onChange={set('notes')} />
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Save</Button>
      </div>
    </form>
  );
}

// ---------------- shortlist: filters & sort ----------------
const EMPTY = { q: '', kw: '', status: '', need: '', has: '', scrape: '', cat: '', country: '', minFollowers: '', minAds: '', days: '', via: '', format: '', site: '', platform: '', minRunDays: '', offer: '', source: '', sort: 'updatedAt', dir: 'desc' };
const SORT_OPTIONS = [
  ['updatedAt:desc', 'Recently updated'],
  ['contacts:desc', 'Most contacts (phone + email)'],
  ['followers:desc', 'Most followers'],
  ['followers:asc', 'Fewest followers'],
  ['adCount:desc', 'Most ads running'],
  ['running:desc', 'Advertising the longest'],
  ['createdAt:desc', 'Newest added'],
  ['createdAt:asc', 'Oldest added'],
  ['scrapedAt:desc', 'Recently read'],
  ['pageName:asc', 'Name A → Z'],
];
const CHIPS = [
  ['phone', 'Phone', Phone, 'emerald'],
  ['whatsapp', 'WhatsApp', MessageCircle, 'green'],
  ['email', 'Email', AtSign, 'blue'],
  ['website', 'Website', Globe, 'indigo'],
];
const CHIP_ON = {
  emerald: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200',
  green: 'border-green-300 bg-green-50 text-green-800 dark:border-green-500/40 dark:bg-green-500/15 dark:text-green-200',
  blue: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200',
  indigo: 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200',
  slate: 'border-slate-400 bg-slate-100 text-slate-800 dark:border-white/30 dark:bg-white/10 dark:text-white',
};
const SELECTS = (meta) => [
  // where the lead came from: a keyword search or a pasted list of links (server: leads.js buildFilter)
  ['source', 'From anywhere', [['search', 'From searches'], ['links', 'From pasted links']]],
  ['kw', 'All keywords', meta.keywords.map((k) => [k, k])],
  ['status', 'Any status', STATUSES.map((s) => [s, s])],
  ['minFollowers', 'Any followers', [['1000', '1K+ followers'], ['10000', '10K+ followers'], ['100000', '100K+ followers'], ['1000000', '1M+ followers']]],
  ['minAds', 'Any ads', [['2', '2+ ads'], ['5', '5+ ads'], ['10', '10+ ads'], ['50', '50+ ads']]],
  ['days', 'Added any time', [['1', 'Added today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 3 months']]],
  // from the ads — real Facebook data (server: adFacts.js)
  ['via', 'Takes orders any way', [['WhatsApp', 'Orders via WhatsApp'], ['Messenger', 'Orders via Messenger'], ['Call', 'Orders by phone call'], ['Website', 'Orders on own website'], ['Marketplace', 'Sells on a marketplace'], ['App', 'Has an app']]],
  ['minRunDays', 'Advertising any time', [['7', 'Advertising 7+ days'], ['30', 'Advertising 30+ days'], ['90', 'Advertising 3+ months'], ['180', 'Advertising 6+ months'], ['365', 'Advertising 1+ year']]],
  // read from the ads' own text (server: insights.js)
  ['offer', 'Any offer', [['Free delivery', 'Free delivery'], ['Cash on delivery', 'Cash on delivery'], ['Discount', 'Discount / sale'], ['EMI', 'EMI / installments'], ['Warranty', 'Warranty'], ['Gift', 'Gift'], ['Buy 1 get 1', 'Buy 1 get 1'], ['Limited time', 'Limited-time offer']]],
  ['format', 'Any ad format', [['Video', 'Video ads'], ['Image', 'Image ads'], ['Carousel', 'Carousel ads'], ['Multi-image', 'Multi-image ads'], ['Catalog', 'Catalog ads']]],
  ['site', 'Any website', [['Own website', 'Has own website'], ['Marketplace', 'Marketplace only'], ['WhatsApp only', 'WhatsApp only'], ['Facebook only', 'Facebook only'], ['App', 'App']]],
  ['platform', 'Any site platform', [['Shopify', 'Shopify'], ['WooCommerce', 'WooCommerce'], ['WordPress', 'WordPress'], ['Wix', 'Wix'], ['Custom', 'Custom-built'], ['Squarespace', 'Squarespace'], ['Webflow', 'Webflow'], ['Magento', 'Magento'], ['OpenCart', 'OpenCart']]],
  ...(meta.countries?.length > 1 ? [['country', 'All countries', meta.countries.map((c) => [c, c])]] : []),
  ['scrape', 'Any read state', [['done', 'Read'], ['pending', 'Waiting'], ['failed', 'Failed'], ['stopped', 'Stopped']]],
];
/** Days since the first ad started (YYYY-MM-DD) — counted today, so it is always current. */
const runDays = (d) => (d && !Number.isNaN(Date.parse(d)) ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 86400e3)) : null);
const initials = (n) => (n || '?').trim().slice(0, 1).toUpperCase();
const AVATAR = ['from-indigo-500 to-violet-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500', 'from-sky-500 to-blue-500', 'from-rose-500 to-pink-500'];
const avatarTone = (s) => AVATAR[[...(s || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length];

export default function Leads() {
  // what the plan includes: CSV for everybody, Excel and Google Sheet on the paid plans
  const canExcel = usePerk('excelExport');
  const canSheet = usePerk('sheetSync');
  const navigateTo = useNavigate();
  const locked = (what) => toast.message(` is not in your plan`, { description: 'CSV export works on every plan.', action: { label: 'See plans', onClick: () => navigateTo('/billing') } });
  const { stats, refresh: refreshStats } = useStats();
  const [meta, setMeta] = useState({ keywords: [], countries: [] });
  // the filters live in the address bar: a reload keeps them, and a shortlist can be shared as a link
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(Object.entries(EMPTY).map(([k, v]) => [k, params.get(k) ?? v])), [params]);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [per, setPer] = useState(50);
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null);
  const [edit, setEdit] = useState(undefined); // undefined = closed, null = new, lead = edit
  const [bulkStatus, setBulkStatus] = useState('Contacted');
  const [confirmDel, setConfirmDel] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const qTimer = useRef(null);
  const [qText, setQText] = useState(filters.q);

  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''));
  const load = useCallback(async () => {
    try {
      setData(await api(`/leads?${qs({ ...query, page, per })}`));
    } catch (e) {
      toast.error(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString(), per]);
  const loadCounts = useCallback(() => {
    const { need, has, page: _p, ...rest } = query;
    api(`/leads/counts?${qs(rest)}`).then(setCounts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify({ ...query, need: '', has: '', sort: '', dir: '' })]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadCounts();
  }, [loadCounts]);
  useEffect(() => {
    api('/meta').then(setMeta).catch(() => {});
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      const a = document.activeElement;
      if (document.hidden || edit !== undefined || (a && ['TEXTAREA', 'SELECT'].includes(a.tagName))) return;
      load();
    }, 20000);
    return () => clearInterval(t);
  }, [load, edit]);

  const setFilters = (changes) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) (v === '' || v == null || v === EMPTY[k] ? n.delete(k) : n.set(k, v));
        if (!('page' in changes)) n.delete('page');
        return n;
      },
      { replace: true },
    );
  const setFilter = (k, v) => setFilters({ [k]: v });
  const setPage = (fn) => setFilters({ page: String(typeof fn === 'function' ? fn(page) : fn) });
  const onSearch = (v) => {
    setQText(v);
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setFilter('q', v.trim()), 300);
  };
  const needs = filters.need ? filters.need.split(',') : [];
  const toggleNeed = (k) => {
    const n = needs.includes(k) ? needs.filter((x) => x !== k) : [...needs, k];
    setFilters({ need: n.join(','), has: '' });
  };
  const toggleNone = () => setFilters({ has: filters.has === 'none' ? '' : 'none', need: '' });
  // the filters that narrow the list (not the sort) — shown as removable tags
  const active = [
    filters.q && ['q', `“${filters.q}”`],
    ...needs.map((n) => [`need:${n}`, `Has ${CHIPS.find((c) => c[0] === n)?.[1] || n}`]),
    filters.has === 'none' && ['has', 'No contact'],
    filters.has && filters.has !== 'none' && ['has', `Has ${filters.has}`],
    filters.cat && ['cat', `Category: ${filters.cat}`],
    ...SELECTS(meta)
      .filter(([k]) => filters[k])
      .map(([k, , opts]) => [k, opts.find(([v]) => v === filters[k])?.[1] || filters[k]]),
  ].filter(Boolean);
  const removeActive = (key) => {
    if (key === 'q') setQText('');
    if (key.startsWith('need:')) return toggleNeed(key.slice(5));
    setFilter(key, '');
  };
  const clearAll = () => {
    setQText('');
    setParams(new URLSearchParams(filters.sort !== EMPTY.sort || filters.dir !== EMPTY.dir ? { sort: filters.sort, dir: filters.dir } : {}), { replace: true });
  };
  // one click back to the start: every filter, the search box and the sort
  const changed = active.length > 0 || filters.sort !== EMPTY.sort || filters.dir !== EMPTY.dir;
  const resetAll = () => {
    clearTimeout(qTimer.current);
    setQText('');
    setParams(new URLSearchParams(), { replace: true });
    toast.success('Filters reset');
  };

  const patch = async (l, body, msg) => {
    try {
      await api(`/leads/${encodeURIComponent(l.pageId)}`, { method: 'PATCH', body });
      Object.assign(l, body);
      toast.success(msg);
      refreshStats();
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const bulk = async (action) => {
    try {
      await api('/leads/bulk', { method: 'POST', body: { ids: [...selected], action, value: bulkStatus } });
      if (action === 'delete') setSelected(new Set());
      toast.success('Done');
      load();
      refreshStats();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const items = data?.items || [];
  const total = data?.total || 0;
  const from = total ? (page - 1) * per + 1 : 0;
  const to = Math.min(total, page * per);
  const allSel = items.length > 0 && items.every((l) => selected.has(l.pageId));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <PageHeader
        icon={Users}
        title="All Leads"
        subtitle={`${formatNumber(stats?.total ?? total)} leads · across all projects`}
        actions={
          <>
            <Button onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add lead</Button>
            <Button
              title={canSheet ? 'Send the leads to your Google Sheet' : 'Google Sheet sync is not in your plan'}
              onClick={async () => {
                if (!canSheet) return locked('Google Sheet sync');
                const t = toast.loading('Syncing to Google Sheet…');
                try {
                  const r = await api('/sheet/sync', { method: 'POST', body: {} });
                  toast.success(`Sheet sync ✓ ${r.inserted} new, ${r.updated} updated`, { id: t });
                } catch (e) {
                  toast.error(e.message, { id: t });
                }
              }}
            >
              {canSheet ? <CloudUpload className="h-4 w-4" /> : <Lock className="h-4 w-4 text-slate-400" />} Sheet
            </Button>
            <Button
              title="Hooks, offers, prices, formats and top advertisers of the leads in view (all leads when no filter is on)"
              onClick={() => {
                const { sort, dir, ...f } = query;
                const s = qs(f);
                navigateTo(`/leads/insights${s ? `?${s}` : ''}`);
              }}
            >
              <Lightbulb className="h-4 w-4 text-amber-500" /> Ad insights
            </Button>
            <Button onClick={() => download(`/export.csv?${qs(query)}`, `fb-leads-${today}.csv`).catch((e) => toast.error(e.message))}>CSV</Button>
            <Button
              variant={canExcel ? 'primary' : undefined}
              title={canExcel ? 'Download as Excel' : 'Excel export is not in your plan — CSV is'}
              onClick={() => (canExcel ? download(`/export.xlsx?${qs(query)}`, `fb-leads-${today}.xlsx`).catch((e) => toast.error(e.message)) : locked('Excel export'))}
            >
              {canExcel ? <Download className="h-4 w-4" /> : <Lock className="h-4 w-4 text-slate-400" />} Excel
            </Button>
          </>
        }
      />

      {/* ---------- shortlist: search, "has" chips, more filters, sort ---------- */}
      <div className="card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input className="input pl-9" placeholder="Search name, phone, email, address, category, note…" aria-label="Search leads" value={qText} onChange={(e) => onSearch(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <ArrowDownWideNarrow className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sort</span>
            <select
              className="input w-auto"
              aria-label="Sort"
              value={`${filters.sort}:${filters.dir}`}
              onChange={(e) => {
                const [sort, dir] = e.target.value.split(':');
                setFilters({ sort, dir });
              }}
            >
              {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>

        {/* must have */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-bold uppercase tracking-wider text-slate-400">Must have</span>
          {CHIPS.map(([k, label, Icon, tone]) => {
            const on = needs.includes(k);
            return (
              <button
                key={k}
                onClick={() => toggleNeed(k)}
                aria-pressed={on}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition',
                  on ? CHIP_ON[tone] : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5',
                )}
              >
                {on ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                {label}
                {counts && <span className="tabular-nums text-xs font-medium opacity-70">{formatNumber(counts[k])}</span>}
              </button>
            );
          })}
          <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-white/10" />
          <button
            onClick={toggleNone}
            aria-pressed={filters.has === 'none'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition',
              filters.has === 'none' ? CHIP_ON.slate : 'border-dashed border-slate-300 text-slate-500 hover:bg-slate-50 dark:border-white/15 dark:hover:bg-white/5',
            )}
          >
            <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" /> No contact
            {counts && <span className="tabular-nums text-xs font-medium opacity-70">{formatNumber(counts.none)}</span>}
          </button>
          <button
            type="button"
            onClick={resetAll}
            disabled={!changed}
            title={changed ? 'Clear every filter and the sort' : 'Nothing to reset'}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-semibold text-slate-600 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-default disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:bg-transparent disabled:hover:text-slate-600 dark:border-white/10 dark:text-slate-300 dark:hover:bg-rose-500/10"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset
          </button>
          <button
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> More filters
            <ChevronDown className={cn('h-4 w-4 transition-transform', moreOpen && 'rotate-180')} aria-hidden="true" />
          </button>
        </div>

        {/* keyword, status, followers, ads, date, category… */}
        {(moreOpen || SELECTS(meta).some(([k]) => filters[k]) || filters.cat) && (
          <div className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4 dark:border-white/10">
            {SELECTS(meta).map(([k, all, opts]) => (
              <select key={k} className={cn('input', filters[k] && 'border-indigo-300 bg-indigo-50/50 font-semibold dark:bg-indigo-500/10')} aria-label={all} value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
                <option value="">{all}</option>
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ))}
            <input
              key={`cat-${filters.cat}`}
              className={cn('input', filters.cat && 'border-indigo-300 bg-indigo-50/50 font-semibold dark:bg-indigo-500/10')}
              placeholder="Category contains… (e.g. Restaurant)"
              aria-label="Category"
              defaultValue={filters.cat}
              onKeyDown={(e) => e.key === 'Enter' && setFilter('cat', e.currentTarget.value.trim())}
              onBlur={(e) => e.target.value.trim() !== filters.cat && setFilter('cat', e.target.value.trim())}
            />
          </div>
        )}

        {/* result line + active filters */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm dark:border-white/10">
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            {data ? formatNumber(total) : '…'} <span className="font-normal text-slate-500">{active.length ? `matching lead${total === 1 ? '' : 's'}` : 'leads'}</span>
          </span>
          {active.map(([key, label]) => (
            <button
              key={key}
              onClick={() => removeActive(key)}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-200"
              title="Remove this filter"
            >
              {label} <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
          {active.length > 0 && (
            <button onClick={clearAll} className="text-xs font-semibold text-slate-500 underline-offset-2 hover:text-rose-600 hover:underline">
              Clear all
            </button>
          )}
          {active.length > 0 && <span className="ml-auto hidden text-xs text-slate-400 md:inline">Excel / CSV export only these</span>}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-500/30 dark:bg-indigo-500/10">
          <b className="px-1 text-sm text-indigo-800 dark:text-indigo-200">{selected.size} selected</b>
          <select className="input h-9 w-auto" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label="Status for selected">
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <Button size="sm" onClick={() => bulk('status')}>Set status</Button>
          <Button size="sm" onClick={() => bulk('rescrape')}><RotateCw className="h-3.5 w-3.5" /> Re-scrape</Button>
          <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-100" onClick={() => setConfirmDel(true)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {!data ? (
        <Skeleton className="h-96" />
      ) : !items.length ? (
        <EmptyState
          icon={Users}
          title="No leads found"
          text={active.length ? 'No lead matches all of these filters together.' : 'Start a new search to find leads.'}
          action={active.length ? <Button onClick={clearAll}><X className="h-4 w-4" /> Clear all filters</Button> : null}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSel}
                    onChange={(e) => setSelected((s) => { const n = new Set(s); items.forEach((l) => (e.target.checked ? n.add(l.pageId) : n.delete(l.pageId))); return n; })}
                    className="h-4 w-4 rounded accent-indigo-600"
                  />
                </th>
                <th className="px-3 py-3">Page</th>
                <th className="px-3 py-3">Contact</th>
                <th className="px-3 py-3">Website</th>
                <th className="px-3 py-3">Ads</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Notes</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((l) => {
                const link = pageLink(l);
                const open = expanded === l.pageId;
                const extraWa = (l.whatsapp || []).filter((w) => !(l.phones || []).some((p) => p.replace(/\D/g, '').slice(-10) === w.replace(/\D/g, '').slice(-10)));
                return (
                  <Fragment key={l.pageId}>
                    <tr className={cn('border-b border-slate-50 align-top transition-colors dark:border-white/5', selected.has(l.pageId) ? 'bg-indigo-50/60 dark:bg-indigo-500/10' : 'hover:bg-slate-50/60 dark:hover:bg-white/5')}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${l.pageName}`}
                          checked={selected.has(l.pageId)}
                          onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(l.pageId) : n.delete(l.pageId); return n; })}
                          className="h-4 w-4 rounded accent-indigo-600"
                        />
                      </td>
                      <td className="max-w-[300px] px-3 py-3">
                        <div className="flex gap-3">
                          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-bold text-white shadow-sm', avatarTone(l.pageName))} aria-hidden="true">
                            {initials(l.pageName)}
                          </span>
                          <div className="min-w-0">
                            {link ? (
                              <a href={link} target="_blank" rel="noreferrer" className="line-clamp-2 font-semibold leading-snug text-slate-900 hover:text-indigo-600 dark:text-white">{l.pageName || l.pageId}</a>
                            ) : (
                              <span className="line-clamp-2 font-semibold leading-snug">{l.pageName || l.pageId}</span>
                            )}
                            <p className="mt-0.5 line-clamp-1 text-xs text-slate-500" title={l.category}>
                              {l.category}
                              {l.followers && <span className="font-semibold text-slate-600 dark:text-slate-300">{l.category ? ' · ' : ''}{l.followers} followers</span>}
                            </p>
                            {l.address && <p className="mt-0.5 line-clamp-1 text-xs text-slate-400" title={l.address}>{l.address}</p>}
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {(l.keywords || []).slice(0, 3).map((k) => (
                                <button key={k} onClick={() => setFilter('kw', k)} title="Show only this keyword">
                                  <Badge tone="indigo" className="px-2 py-0 text-[10px] hover:ring-1 hover:ring-indigo-300">{k}</Badge>
                                </button>
                              ))}
                              {(l.keywords || []).length > 3 && <span className="text-[10px] text-slate-400">+{l.keywords.length - 3}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          {(l.phones || []).map((p) => (
                            <div key={p} className="flex items-center gap-1.5 whitespace-nowrap">
                              <Phone className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                              <a href={`tel:${p}`} className="tabular-nums hover:text-indigo-600">{p}</a>
                              <a href={wa(p)} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${p}`} className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50"><MessageCircle className="h-3.5 w-3.5" /></a>
                            </div>
                          ))}
                          {extraWa.map((w) => (
                            <a key={w} href={wa(w)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 whitespace-nowrap text-emerald-700 hover:underline dark:text-emerald-400">
                              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> <span className="tabular-nums">{w}</span>
                            </a>
                          ))}
                          {(l.emails || []).map((em) => (
                            <a key={em} href={`mailto:${em}`} className="flex items-center gap-1.5 whitespace-nowrap hover:text-indigo-600">
                              <AtSign className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" /> {em}
                            </a>
                          ))}
                          {!l.phones?.length && !l.emails?.length && !extraWa.length && <span className="text-slate-400">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {safeUrl(l.website) && (
                          <a href={safeUrl(l.website)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-indigo-600 hover:underline">
                            <Globe className="h-3.5 w-3.5" aria-hidden="true" /> {host(l.website)}
                          </a>
                        )}
                        {(l.siteType || l.sitePlatform) && (
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {l.siteType && <button onClick={() => setFilter('site', l.siteType)} className="hover:text-indigo-600" title="Show only these">{l.siteType}</button>}
                            {l.sitePlatform && <button onClick={() => setFilter('platform', l.sitePlatform)} className="ml-1 rounded bg-slate-100 px-1.5 font-semibold text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 dark:bg-white/10 dark:text-slate-300" title="Show only this platform">{l.sitePlatform}</button>}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => setExpanded(open ? null : l.pageId)}
                          aria-expanded={open}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold transition hover:border-indigo-300 hover:text-indigo-600 dark:border-white/10"
                        >
                          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} /> {l.adCount || 0} ads
                        </button>
                        {runDays(l.firstAdDate) !== null && (
                          <p className="mt-1 whitespace-nowrap text-[11px] text-slate-500" title={`First ad started ${l.firstAdDate}`}>
                            Advertising <b className="text-slate-700 dark:text-slate-200">{runDays(l.firstAdDate)}</b> days
                          </p>
                        )}
                        {(l.orderVia || []).length > 0 && (
                          <div className="mt-1 flex max-w-[160px] flex-wrap gap-1">
                            {l.orderVia.map((v) => (
                              <button key={v} onClick={() => setFilter('via', v)} title={`Takes orders via ${v} — show only these`}>
                                <Badge tone={v === 'WhatsApp' ? 'emerald' : v === 'Messenger' ? 'indigo' : 'slate'} className="px-1.5 py-0 text-[10px]">{v}</Badge>
                              </button>
                            ))}
                          </div>
                        )}
                        {(l.adFormats || []).length > 0 && <p className="mt-1 text-[10px] text-slate-400">{l.adFormats.join(' · ')}</p>}
                        {l.ins?.bestHook && (
                          <p className="mt-1.5 line-clamp-2 max-w-[220px] text-[11px] italic leading-snug text-slate-600 dark:text-slate-300" title={`Opening line of its longest-running ad: ${l.ins.bestHook}`}>
                            “{l.ins.bestHook}”
                          </p>
                        )}
                        {(l.ins?.offers || []).length > 0 && (
                          <div className="mt-1 flex max-w-[200px] flex-wrap gap-1">
                            {l.ins.offers.map((o) => (
                              <button key={o} onClick={() => setFilter('offer', o)} title={`Offers ${o} — show only these`}>
                                <Badge tone="amber" className="px-1.5 py-0 text-[10px]">{o}</Badge>
                              </button>
                            ))}
                          </div>
                        )}
                        {l.ins?.priceMin != null && (
                          <p className="mt-1 text-[10px] font-semibold text-slate-500">
                            ৳{l.ins.priceMin.toLocaleString('en')}{l.ins.priceMax !== l.ins.priceMin ? ` – ৳${l.ins.priceMax.toLocaleString('en')}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <select
                          key={`st-${l.status}`}
                          aria-label="Status"
                          defaultValue={l.status}
                          onChange={(e) => patch(l, { status: e.target.value }, 'Status saved')}
                          className={cn('h-8 rounded-lg border-0 px-2 text-xs font-semibold ring-1 ring-inset focus:ring-2 focus:ring-indigo-500', {
                            slate: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10',
                            indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
                            emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
                            rose: 'bg-rose-50 text-rose-700 ring-rose-200',
                            amber: 'bg-amber-50 text-amber-700 ring-amber-200',
                          }[STATUS_TONE[l.status] || 'slate'])}
                        >
                          {STATUSES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <textarea
                          key={`nt-${l.notes || ''}`}
                          aria-label="Notes"
                          rows={1}
                          defaultValue={l.notes}
                          placeholder="Note…"
                          onBlur={(e) => e.target.value !== (l.notes || '') && patch(l, { notes: e.target.value }, 'Note saved')}
                          className="input min-h-[34px] w-44 resize-y py-1.5 text-xs"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1">
                          {/* "done" is the normal case — only the others are worth a badge */}
                          {l.scrapeStatus !== 'done' && <Badge tone={SCRAPE_TONE[l.scrapeStatus] || 'slate'} className="text-[10px]">{l.scrapeStatus === 'pending' ? 'waiting' : l.scrapeStatus}</Badge>}
                          <button onClick={() => setEdit(l)} aria-label="Edit lead" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/80 dark:bg-white/[0.02]">
                        <td colSpan={8} className="px-4 py-4">
                          <LeadDetails pageId={l.pageId} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}</span>
            <select className="input h-8 w-auto py-0 text-xs" aria-label="Rows per page" value={per} onChange={(e) => { setPer(Number(e.target.value)); setPage(1); }}>
              {[50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
          </span>
          <div className="flex items-center gap-2">
            <span className="tabular-nums text-xs">Page {page} of {formatNumber(Math.max(1, Math.ceil(total / per)))}</span>
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /> Prev</Button>
            <Button size="sm" disabled={to >= total} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      <Modal open={edit !== undefined} onClose={() => setEdit(undefined)} title={edit ? 'Edit lead' : 'Add lead'} width="max-w-2xl">
        {edit !== undefined && <LeadForm lead={edit} onClose={() => setEdit(undefined)} onSaved={load} />}
      </Modal>
      <Modal
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title={`Delete ${selected.size} leads?`}
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setConfirmDel(false); bulk('delete'); }}><Trash2 className="h-4 w-4" /> Delete</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">The leads and their ads will be removed everywhere — every project, sheet and export. This cannot be undone.</p>
      </Modal>
    </div>
  );
}
