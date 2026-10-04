import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Workbook } from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import { toast } from 'sonner';
import { ArrowLeft, Check, ChevronRight, CloudUpload, Download, Loader2, RefreshCw, Zap } from 'lucide-react';
import { api, download, getKey } from '../lib/api';
import { cn, formatNumber } from '../lib/utils';
import { Button, Skeleton } from '../components/ui';
import { SheetIcon } from '../components/FileIcons';

/** FortuneSheet keeps cells in a 2-D `data` matrix while editing; store them sparse (`celldata`). */
function toSaved(sheets) {
  return sheets.map((s) => {
    const { data, luckysheet_select_save, ...rest } = s;
    if (!data) return { ...rest, celldata: s.celldata || [] };
    const celldata = [];
    data.forEach((row, r) =>
      row?.forEach((cell, c) => {
        if (!cell) return;
        const hasValue = cell.v !== undefined && cell.v !== null && cell.v !== '';
        if (hasValue || cell.bg || cell.bl || cell.it || cell.fc || cell.fs || cell.mc || cell.ct?.s) celldata.push({ r, c, v: cell });
      }),
    );
    return { ...rest, celldata };
  });
}

export default function SheetView() {
  const { pid, sid } = useParams();
  const [meta, setMeta] = useState(null); // { item, project, path }
  const [sheets, setSheets] = useState(null);
  const [version, setVersion] = useState(0);
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error
  const [busy, setBusy] = useState('');
  const pending = useRef(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const r = await api(`/sheets/${sid}`);
    setMeta({ item: r.item, project: r.project, path: r.path });
    // start with A1 selected — without a selection FortuneSheet's name box shows "NaN"
    setSheets(r.sheets.map((s) => ({ ...s, luckysheet_select_save: s.luckysheet_select_save || [{ row: [0, 0], column: [0, 0] }] })));
    setVersion((v) => v + 1);
  }, [sid]);

  useEffect(() => {
    setSheets(null);
    load().catch((e) => toast.error(e.message));
  }, [load]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    const body = { sheets: toSaved(pending.current) };
    pending.current = null;
    setSaveState('saving');
    try {
      const res = await api(`/sheets/${sid}`, { method: 'PUT', body });
      setSaveState((s) => (s === 'saving' ? 'saved' : s));
      if (res.deleted) toast.success(`${res.deleted} row(s) deleted`, { description: 'Removed everywhere — All Leads, other sheets and exports.' });
    } catch (e) {
      setSaveState('error');
      toast.error(`Could not save: ${e.message}`);
    }
  }, [sid]);

  const onChange = useCallback(
    (data) => {
      pending.current = data;
      setSaveState('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 1200);
    },
    [flush],
  );

  // save on leave / tab close
  useEffect(() => {
    const beforeUnload = () => {
      if (!pending.current) return;
      fetch(`/api/sheets/${sid}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-api-key': getKey() },
        body: JSON.stringify({ sheets: toSaved(pending.current) }),
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      flush();
    };
  }, [sid, flush]);

  const refreshData = async () => {
    setBusy('refresh');
    try {
      await flush();
      await load();
      toast.success('New data added');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const exportXlsx = async () => {
    setBusy('export');
    try {
      await flush();
      await download(`/sheets/${sid}/export.xlsx`, `${meta?.item.name || 'sheet'}.xlsx`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const live = meta && meta.item.kind !== 'custom';
  const parent = meta?.path?.length > 1 ? meta.path[meta.path.length - 2] : null;
  const backTo = parent ? `/projects/${pid}/f/${parent.id}` : `/projects/${pid}`;

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col">
      {/* ---------- sheet header ---------- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-white/10 dark:bg-slate-900">
        <Link to={backTo} aria-label="Back to folder" className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <SheetIcon size={34} tone={meta?.item.kind === 'ads' ? 'blue' : 'green'} />
        <div className="min-w-0">
          <h1 className="truncate font-display text-base font-extrabold leading-tight">{meta?.item.name || '…'}</h1>
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 truncate text-xs text-slate-500">
            <Link to="/projects" className="hover:text-indigo-600">Projects</Link>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <Link to={`/projects/${pid}`} className="hover:text-indigo-600">{meta?.project.name}</Link>
            {parent && (
              <>
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
                <Link to={backTo} className="hover:text-indigo-600">{parent.name}</Link>
              </>
            )}
          </nav>
        </div>

        {live && (
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30 md:inline-flex" title="New leads are added to this sheet automatically. Your edits are kept.">
            <Zap className="h-3.5 w-3.5" /> Live · {formatNumber(meta.item.count)} rows
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span role="status" aria-live="polite" className={cn('flex items-center gap-1.5 text-xs font-medium', saveState === 'error' ? 'text-rose-600' : 'text-slate-500')}>
            {saveState === 'saving' && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>}
            {saveState === 'dirty' && <><CloudUpload className="h-3.5 w-3.5" /> Unsaved</>}
            {saveState === 'saved' && <><Check className="h-3.5 w-3.5 text-emerald-500" /> Saved</>}
            {saveState === 'error' && 'Save failed'}
          </span>
          {live && (
            <Button size="sm" onClick={refreshData} loading={busy === 'refresh'} title="Load new leads from the database">
              {busy !== 'refresh' && <RefreshCw className="h-3.5 w-3.5" />} New data
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={exportXlsx} loading={busy === 'export'}>
            {busy !== 'export' && <Download className="h-3.5 w-3.5" />} Excel
          </Button>
        </div>
      </div>

      {/* ---------- spreadsheet ---------- */}
      <div className="relative flex-1 bg-white">
        {sheets ? (
          <Workbook key={`${sid}-${version}`} data={sheets} onChange={onChange} lang="en" showFormulaBar allowEdit />
        ) : (
          <div className="space-y-2 p-6">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
