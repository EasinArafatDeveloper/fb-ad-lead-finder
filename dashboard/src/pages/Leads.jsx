import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AtSign, ChevronDown, ChevronLeft, ChevronRight, CloudUpload, Download, ExternalLink, Globe, MessageCircle, Pencil, Phone, Plus, RotateCw, Search, Trash2, Users,
} from 'lucide-react';
import { api, download, qs } from '../lib/api';
import { STATUSES, cn, formatNumber, host } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';

const SCRAPE_TONE = { done: 'emerald', pending: 'amber', working: 'indigo', failed: 'rose', stopped: 'slate' };
const STATUS_TONE = { New: 'slate', Contacted: 'indigo', Interested: 'emerald', 'Not Interested': 'rose', Closed: 'amber' };
const wa = (p) => `https://wa.me/${String(p).replace(/\D/g, '')}`;
const pageLink = (l) => l.pageUrl || (/^\d+$/.test(l.pageId) ? `https://www.facebook.com/${l.pageId}` : '');

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
  const links = [l.instagram, ...(l.socials || [])].filter(Boolean);
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
              <Badge tone="indigo" className="text-[10px]">{ad.keyword}</Badge>
            </div>
            {ad.title && <p className="mt-1.5 font-semibold">{ad.title}</p>}
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{ad.body}</p>
            <div className="mt-2 flex gap-3 text-xs font-semibold">
              {ad.linkUrl && <a className="text-indigo-600 hover:underline" href={ad.linkUrl} target="_blank" rel="noreferrer">{host(ad.linkUrl)}</a>}
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

export default function Leads() {
  const { refresh: refreshStats } = useStats();
  const [meta, setMeta] = useState({ keywords: [] });
  const [filters, setFilters] = useState({ q: '', kw: '', status: '', has: '', scrape: '', sort: 'updatedAt' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null);
  const [edit, setEdit] = useState(undefined); // undefined = closed, null = new, lead = edit
  const [bulkStatus, setBulkStatus] = useState('Contacted');
  const [confirmDel, setConfirmDel] = useState(false);
  const qTimer = useRef(null);
  const per = 50;

  const query = { ...filters, dir: filters.sort === 'pageName' ? 'asc' : 'desc' };
  const load = useCallback(async () => {
    try {
      setData(await api(`/leads?${qs({ ...query, page, per })}`));
    } catch (e) {
      toast.error(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), page]);

  useEffect(() => {
    load();
  }, [load]);
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

  const setFilter = (k, v) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };
  const onSearch = (v) => {
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setFilter('q', v), 300);
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
        subtitle={`${formatNumber(total)} leads · across all projects`}
        actions={
          <>
            <Button onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add lead</Button>
            <Button
              onClick={async () => {
                const t = toast.loading('Syncing to Google Sheet…');
                try {
                  const r = await api('/sheet/sync', { method: 'POST', body: {} });
                  toast.success(`Sheet sync ✓ ${r.inserted} new, ${r.updated} updated`, { id: t });
                } catch (e) {
                  toast.error(e.message, { id: t });
                }
              }}
            >
              <CloudUpload className="h-4 w-4" /> Sheet
            </Button>
            <Button onClick={() => download(`/export.csv?${qs(query)}`, `fb-leads-${today}.csv`).catch((e) => toast.error(e.message))}>CSV</Button>
            <Button variant="primary" onClick={() => download(`/export.xlsx?${qs(query)}`, `fb-leads-${today}.xlsx`).catch((e) => toast.error(e.message))}>
              <Download className="h-4 w-4" /> Excel
            </Button>
          </>
        }
      />

      {/* filters */}
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input className="input pl-9" placeholder="Name, phone, email, address…" aria-label="Search leads" onChange={(e) => onSearch(e.target.value)} />
        </div>
        {[
          ['kw', 'All keywords', meta.keywords.map((k) => [k, k])],
          ['status', 'All status', STATUSES.map((s) => [s, s])],
          ['has', 'Any contact', [['any', 'Has phone or email'], ['email', 'Has email'], ['phone', 'Has phone/WhatsApp'], ['none', 'No contact']]],
          ['scrape', 'All scrape', [['done', 'Done'], ['pending', 'Pending'], ['stopped', 'Stopped'], ['failed', 'Failed']]],
        ].map(([k, all, opts]) => (
          <select key={k} className="input w-auto" aria-label={all} value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
            <option value="">{all}</option>
            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
        <select className="input w-auto" aria-label="Sort" value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
          <option value="updatedAt">Recently updated</option>
          <option value="createdAt">Newest</option>
          <option value="adCount">Most ads</option>
          <option value="followers">Most followers</option>
          <option value="pageName">Name A–Z</option>
        </select>
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
        <EmptyState icon={Users} title="No leads found" text="Change the filters, or start a new search." />
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
                      <td className="max-w-[260px] px-3 py-3">
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer" className="font-semibold text-slate-900 hover:text-indigo-600 dark:text-white">{l.pageName || l.pageId}</a>
                        ) : (
                          <span className="font-semibold">{l.pageName || l.pageId}</span>
                        )}
                        <p className="mt-0.5 text-xs text-slate-500">{[l.category, l.followers && `${l.followers} followers`].filter(Boolean).join(' · ')}</p>
                        {l.address && <p className="mt-0.5 line-clamp-1 text-xs text-slate-400" title={l.address}>{l.address}</p>}
                        <div className="mt-1 flex flex-wrap gap-1">{(l.keywords || []).map((k) => <Badge key={k} tone="indigo" className="px-2 py-0 text-[10px]">{k}</Badge>)}</div>
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
                        {l.website && (
                          <a href={l.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-indigo-600 hover:underline">
                            <Globe className="h-3.5 w-3.5" aria-hidden="true" /> {host(l.website)}
                          </a>
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
                          <Badge tone={SCRAPE_TONE[l.scrapeStatus] || 'slate'} className="text-[10px]" >{l.scrapeStatus}</Badge>
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

      {total > per && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span className="tabular-nums">{from}–{to} of {formatNumber(total)}</span>
          <div className="flex gap-2">
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
