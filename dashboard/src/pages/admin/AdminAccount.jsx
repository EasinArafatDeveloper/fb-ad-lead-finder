import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, AtSign, ChevronLeft, ChevronRight, Download, Eye, FolderOpen, Globe, Link2, MessageCircle, Phone, Search } from 'lucide-react';
import { api, download, qs } from '../../lib/api';
import { cn, formatNumber, PHASE, timeAgo } from '../../lib/utils';
import { Badge, Button, PageHeader, Skeleton } from '../../components/ui';

/**
 * Admin → one account: its projects and the leads it collected — read only (server: adminLive.js).
 * Opened from Admin → Overview → Live → "Projects & leads".
 */
const NEED = [
  ['phone', 'Phone', Phone],
  ['whatsapp', 'WhatsApp', MessageCircle],
  ['email', 'Email', AtSign],
  ['website', 'Website', Globe],
];

export default function AdminAccount() {
  const { ws } = useParams();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || '';
  const [d, setD] = useState(null);
  const [leads, setLeads] = useState(null);
  const [q, setQ] = useState('');
  const [need, setNeed] = useState([]);
  const [page, setPage] = useState(1);
  const per = 50;

  useEffect(() => {
    api(`/admin/accounts/${ws}`).then(setD).catch((e) => toast.error(e.message));
  }, [ws]);

  const filters = { ...(project ? { projectId: project } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(need.length ? { need: need.join(',') } : {}) };
  useEffect(() => {
    setPage(1);
  }, [project, q, need.join(',')]);
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/admin/accounts/${ws}/leads?${qs({ ...filters, page, per })}`).then(setLeads).catch((e) => toast.error(e.message));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, project, q, need.join(','), page]);

  if (!d) return <Skeleton className="h-[70vh]" />;
  const a = d.account;
  const current = d.projects.find((p) => p.id === project);
  const pages = leads ? Math.max(1, Math.ceil(leads.total / per)) : 1;
  const csv = () => download(`/admin/accounts/${ws}/export.csv?${qs(filters)}`, `leads-${a.email || 'account'}${current ? `-${current.name}` : ''}.csv`).catch((e) => toast.error(e.message));

  return (
    <div className="space-y-6">
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>
      <PageHeader
        icon={Eye}
        title={a.name || a.email}
        subtitle={`${a.email} · ${a.planName || a.plan}${a.unlimited ? '' : ` · ${formatNumber(a.credits)} credits`} · ${formatNumber(d.totals.leads)} leads (${formatNumber(d.totals.withContact)} with a contact) · ${formatNumber(d.totals.searches)} searches${a.lastLoginAt ? ` · last login ${timeAgo(a.lastLoginAt)}` : ''} — view only`}
        actions={<Button onClick={csv}><Download className="h-4 w-4" /> CSV{current ? ' (this project)' : ''}</Button>}
      />

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 font-display font-bold"><FolderOpen className="h-4 w-4 text-amber-500" /> Projects ({d.projects.length})</h2>
        {!d.projects.length ? (
          <p className="text-sm text-slate-500">No projects yet.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <button
              type="button"
              onClick={() => setParams({}, { replace: true })}
              className={cn('rounded-xl border p-3 text-left text-sm transition', !project ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10')}
            >
              <b>All leads</b>
              <span className="block text-xs text-slate-500">{formatNumber(d.totals.leads)} leads · {formatNumber(d.totals.withContact)} with a contact</span>
            </button>
            {d.projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setParams({ project: p.id }, { replace: true })}
                className={cn('rounded-xl border p-3 text-left text-sm transition', project === p.id ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10')}
              >
                <span className="flex items-center gap-1.5 font-semibold">
                  {p.source === 'links' ? <Link2 className="h-3.5 w-3.5 text-sky-500" /> : <Search className="h-3.5 w-3.5 text-slate-400" />}
                  <span className="truncate">{p.name}</span>
                  {p.phase !== 'done' && <Badge tone={PHASE[p.phase]?.tone} className="ml-auto px-1.5 py-0 text-[10px]">{PHASE[p.phase]?.label || p.phase}</Badge>}
                </span>
                <span className="block text-xs text-slate-500">
                  {p.source === 'links' ? 'pasted links' : p.country} · {formatNumber(p.leads)} leads · {formatNumber(p.withContact)} contacts{p.source === 'links' ? '' : ` · ${formatNumber(p.ads)} ads`} · {timeAgo(p.createdAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-display font-bold">{current ? `Leads in “${current.name}”` : 'All leads'} <span className="text-xs font-semibold text-slate-400">({leads ? formatNumber(leads.total) : '…'})</span></h2>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email…" className="input h-9 pl-9 text-sm" aria-label="Search leads" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {NEED.map(([k, label, Icon]) => (
              <button
                key={k}
                type="button"
                onClick={() => setNeed((n) => (n.includes(k) ? n.filter((x) => x !== k) : [...n, k]))}
                className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition', need.includes(k) ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200' : 'border-slate-200 text-slate-600 dark:border-white/10 dark:text-slate-300')}
              >
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
        </div>
        {!leads ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-slate-200 text-sm dark:border-white/10">
              <table className="w-full">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-800">
                  <tr>
                    <th className="px-3 py-2">Page</th>
                    <th className="px-3 py-2">Phone / WhatsApp</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Website</th>
                    <th className="px-3 py-2 text-right">Ads</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.items.map((l) => (
                    <tr key={l.pageId} className="border-t border-slate-100 align-top dark:border-white/5">
                      <td className="px-3 py-2">
                        <a href={/^https:\/\/([a-z0-9-]+\.)*(facebook|fb)\.com\//i.test(l.pageUrl || '') ? l.pageUrl : /^\d+$/.test(l.pageId) ? `https://www.facebook.com/${l.pageId}` : undefined} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{l.pageName || l.pageId}</a>
                        <span className="block text-[11px] text-slate-500">{[l.category, l.followers && `${l.followers} followers`].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="px-3 py-2 text-xs">{[...(l.phones || []), ...(l.whatsapp || []).map((w) => `${w} (WA)`)].join(', ') || '—'}</td>
                      <td className="px-3 py-2 text-xs">{(l.emails || []).join(', ') || '—'}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 text-xs">{l.website || '—'}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">{formatNumber(l.adCount || 0)}</td>
                      <td className="px-3 py-2 text-xs">
                        {l.status || 'New'}
                        {l.scrapeStatus && l.scrapeStatus !== 'done' && <span className="block text-[11px] text-slate-500">{l.scrapeStatus === 'pending' ? 'waiting' : l.scrapeStatus}</span>}
                      </td>
                    </tr>
                  ))}
                  {!leads.items.length && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-slate-500">No leads here.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-500">
              Page {page} of {formatNumber(pages)}
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
