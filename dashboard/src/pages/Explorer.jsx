import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowDownWideNarrow, ArrowLeft, ArrowUp, ChevronRight, ExternalLink, FolderOpen, FolderPlus, FilePlus2, HardDrive, LayoutGrid, List,
  Pencil, Play, RefreshCw, Search, Trash2, RotateCw, Plus, Globe2, Lightbulb,
} from 'lucide-react';
import { api, kickExtension } from '../lib/api';
import { useFolderNav } from '../lib/nav';
import { cn, formatNumber, PHASE, timeAgo } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, Progress, PromptModal, Skeleton } from '../components/ui';
import { FolderIcon, SheetIcon } from '../components/FileIcons';

const VIEW_KEY = 'fblf_view';
const SORT_KEY = 'fblf_project_sort';
// How the project folders are ordered. `rank` = show #1, #2, #3… on the tiles (it means "biggest first").
const byTime = (i) => new Date(i.createdAt || 0).getTime();
const SORTS = {
  contacts: { label: 'Most contacts first', rank: true, cmp: (a, b) => (b.withContact || 0) - (a.withContact || 0) || (b.leads || 0) - (a.leads || 0) },
  leads: { label: 'Most leads first', rank: true, cmp: (a, b) => (b.leads || 0) - (a.leads || 0) || (b.withContact || 0) - (a.withContact || 0) },
  fewest: { label: 'Fewest leads first', cmp: (a, b) => (a.leads || 0) - (b.leads || 0) },
  newest: { label: 'Newest first', cmp: (a, b) => byTime(b) - byTime(a) },
  oldest: { label: 'Oldest first', cmp: (a, b) => byTime(a) - byTime(b) },
  name: { label: 'Name A → Z', cmp: (a, b) => a.name.localeCompare(b.name) },
};
const MEDAL = ['bg-amber-400 text-amber-950', 'bg-slate-300 text-slate-800', 'bg-orange-300 text-orange-950'];
const adLibUrl = (p) =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${p.country}&media_type=all&q=${encodeURIComponent(p.keyword)}&search_type=keyword_unordered`;

function subtitle(item) {
  if (item.type === 'project') return `${formatNumber(item.leads)} leads · ${formatNumber(item.withContact)} contact`;
  if (item.type === 'folder') return `${item.count} item${item.count === 1 ? '' : 's'}`;
  return `${formatNumber(item.count)} ${item.kind === 'ads' ? 'ads' : 'rows'}`;
}

function ItemIcon({ item, size }) {
  if (item.type === 'sheet') return <SheetIcon size={size} tone={item.kind === 'ads' ? 'blue' : 'green'} />;
  return <FolderIcon size={size} peek={item.type === 'project' ? item.leads > 0 : item.count > 0} accent={item.type === 'project'} />;
}

// #1 gold, #2 silver, #3 bronze, the rest plain
function RankBadge({ rank, className }) {
  return (
    <span
      title={`#${rank}`}
      className={cn(
        'inline-flex h-6 min-w-[1.5rem] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums shadow-sm',
        MEDAL[rank - 1] || 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300',
        className,
      )}
    >
      #{rank}
    </span>
  );
}

// ---------------- "Remove empty projects" ----------------
/**
 * The empty projects as a list to check before removing: each with what is (not) in it and a link that opens
 * the folder in a new tab, ticked by default — untick the ones to keep.
 */
function EmptyProjectsModal({ open, projects, busy, onClose, onRemove }) {
  const [picked, setPicked] = useState(() => new Set());
  useEffect(() => {
    if (open) setPicked(new Set(projects.map((p) => p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const toggle = (id) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const all = picked.size === projects.length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${formatNumber(projects.length)} empty projects`}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">{formatNumber(picked.size)} of {formatNumber(projects.length)} selected</span>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!picked.size} onClick={() => onRemove([...picked])}>
            <Trash2 className="h-4 w-4" /> Remove {formatNumber(picked.size)}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        These projects have <b>0 leads</b>. Open one to check it — untick the ones you want to keep. Projects still searching, and projects
        with a sheet you typed into, are never listed here.
      </p>
      <div className="mt-3 flex items-center justify-between text-xs">
        <button type="button" className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setPicked(all ? new Set() : new Set(projects.map((p) => p.id)))}>
          {all ? 'Select none' : 'Select all'}
        </button>
        <span className="text-slate-400">Open ↗ opens the folder in a new tab</span>
      </div>
      <ul className="mt-2 max-h-[52vh] divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 dark:divide-white/5 dark:border-white/10">
        {projects.map((p) => (
          <li key={p.id} className={cn('flex items-center gap-3 px-3 py-2.5 transition-colors', picked.has(p.id) ? 'bg-rose-50/50 dark:bg-rose-500/5' : 'bg-white dark:bg-slate-900')}>
            <input
              type="checkbox"
              checked={picked.has(p.id)}
              onChange={() => toggle(p.id)}
              aria-label={`Remove ${p.name}`}
              className="h-4 w-4 shrink-0 rounded accent-rose-600"
            />
            <FolderIcon size={34} peek={false} accent className="shrink-0" />
            <button type="button" onClick={() => toggle(p.id)} className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                {p.name} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-white/10">{p.country}</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                <span className="font-semibold text-rose-600">0 leads</span> · {formatNumber(p.ads)} ads · {p.searches} search{p.searches === 1 ? '' : 'es'} · created {timeAgo(p.createdAt)}
              </p>
            </button>
            <a
              href={`/projects/${p.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              Open <ExternalLink className="h-3 w-3" />
            </a>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------- context menu ----------------
function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);
  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          role="menu"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ duration: 0.12 }}
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - menu.actions.length * 40 - 16) }}
          className="fixed z-50 w-52 origin-top-left rounded-xl border border-slate-200 bg-white p-1.5 shadow-dropdown dark:border-white/10 dark:bg-slate-900"
        >
          {menu.actions.map((a, i) =>
            a === '-' ? (
              <div key={i} className="my-1 h-px bg-slate-100 dark:bg-white/10" />
            ) : (
              <button
                key={a.label}
                role="menuitem"
                onClick={() => {
                  onClose();
                  a.run();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors',
                  a.danger ? 'text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/5',
                )}
              >
                <a.icon className="h-4 w-4 opacity-70" aria-hidden="true" />
                <span className="flex-1">{a.label}</span>
                {a.hint && <kbd className="text-[10px] font-semibold text-slate-400">{a.hint}</kbd>}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------- details pane ----------------
/** Confirm dialog. For a project it first shows exactly what will be removed everywhere. */
function DeleteModal({ item, onClose, onConfirm }) {
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setImpact(null);
    if (item?.type === 'project') api(`/projects/${item.id}/impact`).then(setImpact).catch(() => {});
  }, [item]);
  const go = async () => {
    setBusy(true);
    await onConfirm(item);
    setBusy(false);
    onClose();
  };
  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title={item?.type === 'project' ? 'Delete the whole project?' : 'Delete?'}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={go}>
            {!busy && <Trash2 className="h-4 w-4" />} {item?.type === 'project' ? 'Delete everything' : 'Delete'}
          </Button>
        </>
      }
    >
      {item?.type === 'project' ? (
        <div className="text-sm text-slate-600 dark:text-slate-300">
          <p>
            <b>"{item.name}"</b> and everything in it will be removed <b>everywhere</b> — All Leads, sheets and Excel/Sheet exports:
          </p>
          {impact ? (
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {[
                ['Leads', impact.leads],
                ['Ads', impact.ads],
                ['Searches', impact.searches],
                ['Folders & sheets', impact.items],
              ].map(([k, v]) => (
                <li key={k} className="rounded-xl bg-rose-50 px-3 py-2 dark:bg-rose-500/10">
                  <span className="block font-display text-lg font-extrabold tabular-nums text-rose-700 dark:text-rose-300">{formatNumber(v)}</span>
                  <span className="text-xs text-rose-700/80 dark:text-rose-300/80">{k}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Skeleton className="mt-3 h-24" />
          )}
          {impact?.shared > 0 && <p className="mt-3 text-xs text-slate-500">{impact.shared} leads also belong to another project — they stay there and are only removed from this one.</p>}
          <p className="mt-3 text-xs font-semibold text-rose-600">This cannot be undone.</p>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <b>"{item?.name}"</b> {item?.type === 'folder' ? 'folder and every sheet inside it will be deleted.' : 'sheet and all edits in it will be deleted.'}{' '}
          <span className="text-slate-500">(The leads stay in the project — to delete a lead completely, delete its row in a sheet.)</span>
        </p>
      )}
    </Modal>
  );
}

function ProjectDetails({ project, onCollect, onDelete, onContinue }) {
  if (!project) return null;
  const phase = PHASE[project.phase] || PHASE.done;
  const scraped = Math.max(0, project.leads - project.pending);
  return (
    <div className="card sticky top-24 overflow-hidden">
      <div className="relative flex flex-col items-center bg-gradient-to-br from-indigo-50 via-white to-cyan-50 px-5 pb-5 pt-6 text-center dark:from-indigo-500/10 dark:via-slate-900 dark:to-cyan-500/10">
        <FolderIcon size={88} peek={project.leads > 0} accent />
        <h2 className="mt-3 font-display text-lg font-extrabold leading-tight">{project.name}</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {project.country} · {project.runs} search run{project.runs === 1 ? '' : 's'}
        </p>
        <Badge tone={phase.tone} dot={project.phase === 'done' ? true : 'pulse'} className="mt-3">
          {phase.label}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-slate-100 dark:bg-white/5">
        {[
          ['Leads', project.leads],
          ['With contact', project.withContact],
          ['Ads', project.ads],
          ['In queue', project.pending],
        ].map(([k, v]) => (
          <div key={k} className="bg-white p-3.5 dark:bg-slate-900">
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{k}</dt>
            <dd className="mt-0.5 font-display text-xl font-extrabold tabular-nums">{formatNumber(v)}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-3 p-4">
        <div>
          <div className="mb-1.5 flex justify-between text-xs font-medium text-slate-500">
            <span>Pages scraped</span>
            <span className="tabular-nums">{scraped}/{project.leads}</span>
          </div>
          <Progress value={project.leads ? (scraped / project.leads) * 100 : 0} />
        </div>
        {project.stopped > 0 && (
          <Button variant="primary" className="w-full" onClick={onContinue}>
            <Play className="h-4 w-4" /> Restart {project.stopped} stopped pages
          </Button>
        )}
        <Link to={`/projects/${project.id}/insights`} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">
          <Lightbulb className="h-4 w-4" /> Ad insights — hooks, offers, prices
        </Link>
        <Button variant="soft" className="w-full" onClick={onCollect}>
          <RotateCw className="h-4 w-4" /> Collect more ads
        </Button>
        <Button variant="ghost" className="w-full text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> Delete project
        </Button>
        <a href={adLibUrl(project)} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-indigo-600">
          View in the Ad Library <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <p className="text-center text-[11px] text-slate-400">Created {timeAgo(project.createdAt)}</p>
      </div>
    </div>
  );
}

// ---------------- main ----------------
export default function Explorer() {
  const { pid, fid } = useParams();
  const navigate = useNavigate();
  const { openTo, upTo, upClick } = useFolderNav();
  const [data, setData] = useState(null); // { project, path, items }
  const [projects, setProjects] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) || 'grid';
    } catch {
      return 'grid';
    }
  });
  const [sort, setSort] = useState(() => {
    try {
      const s = localStorage.getItem(SORT_KEY);
      return SORTS[s] ? s : 'newest';
    } catch {
      return 'newest';
    }
  });
  const setSortMode = (s) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* ignore */
    }
  };
  const [menu, setMenu] = useState(null);
  const [prompt, setPrompt] = useState(null); // {title,label,initial,onSubmit}
  const [confirm, setConfirm] = useState(null); // {item}
  // "Remove empty projects": projects with 0 leads (the server decides which — see emptyProjects)
  const [empty, setEmpty] = useState(null); // { count, names }
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [removingEmpty, setRemovingEmpty] = useState(false);

  const atRoot = !pid;

  // a project that is collecting or reading pages refreshes every 3 s, otherwise every 20 s
  const busyRef = useRef(false);
  const working = (p) => p && ['collecting', 'queued', 'scraping'].includes(p.phase);
  const load = useCallback(
    async (quiet) => {
      if (!quiet) setLoading(true);
      try {
        if (atRoot) {
          const [list, e] = await Promise.all([api('/projects'), api('/projects/empty').catch(() => null)]);
          busyRef.current = list.some(working);
          setProjects(list);
          setEmpty(e);
        } else {
          const d = await api(`/projects/${pid}/items${fid ? `?parent=${fid}` : ''}`);
          busyRef.current = working(d.project);
          setData(d);
        }
      } catch (e) {
        if (!quiet) toast.error(e.message);
      } finally {
        setLoading(false);
      }
    },
    [atRoot, pid, fid],
  );

  useEffect(() => {
    setSelected(null);
    setFilter('');
    load();
  }, [load]);

  const removeEmpty = async (ids) => {
    setRemovingEmpty(true);
    try {
      const r = await api('/projects/delete-empty', { method: 'POST', body: { ids } });
      toast.success(`${formatNumber(r.deleted)} empty project${r.deleted === 1 ? '' : 's'} removed`);
      setConfirmEmpty(false);
      setSelected(null);
      await load(true);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRemovingEmpty(false);
    }
  };
  useEffect(() => {
    let timer;
    const loop = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) await load(true);
        loop();
      }, busyRef.current ? 3000 : 20000);
    };
    loop();
    return () => clearTimeout(timer);
  }, [load]);

  const items = useMemo(() => {
    const list = atRoot ? (projects || []).map((p) => ({ ...p, type: 'project' })) : data?.items || [];
    // projects are ranked over the whole list, so "#3" stays #3 while you type in the search box
    if (atRoot) [...list].sort(SORTS[sort].cmp).forEach((p, i) => (p.rank = i + 1));
    const q = filter.trim().toLowerCase();
    const shown = q ? list.filter((i) => i.name.toLowerCase().includes(q)) : list;
    return atRoot ? shown.sort((a, b) => a.rank - b.rank) : shown;
  }, [atRoot, projects, data, filter, sort]);
  const showRank = atRoot && SORTS[sort].rank;

  const setViewMode = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  // ---------- actions ----------
  const open = (item) => {
    if (item.type === 'project') openTo(`/projects/${item.id}`);
    else if (item.type === 'folder') openTo(`/projects/${pid}/f/${item.id}`);
    else openTo(`/projects/${pid}/s/${item.id}`);
  };
  const goUp = () => {
    if (atRoot) return;
    const path = data?.path || [];
    if (!fid) upTo('/projects');
    else if (path.length > 1) upTo(`/projects/${pid}/f/${path[path.length - 2].id}`);
    else upTo(`/projects/${pid}`);
  };

  const rename = (item) =>
    setPrompt({
      title: 'Rename',
      label: 'New name',
      initial: item.name,
      onSubmit: async (name) => {
        await api(item.type === 'project' ? `/projects/${item.id}` : `/items/${item.id}`, { method: 'PATCH', body: { name } });
        toast.success('Renamed');
        load(true);
      },
    });
  const create = (type) =>
    setPrompt({
      title: type === 'folder' ? 'New folder' : 'New sheet',
      label: 'Name',
      initial: type === 'folder' ? 'New folder' : 'Untitled sheet',
      confirmText: 'Create',
      onSubmit: async (name) => {
        const it = await api('/items', { method: 'POST', body: { projectId: pid, parentId: fid || null, type, name } });
        toast.success(`${type === 'folder' ? 'Folder' : 'Sheet'} created`);
        await load(true);
        setSelected(it.id);
      },
    });
  const remove = async (item) => {
    const r = await api(item.type === 'project' ? `/projects/${item.id}` : `/items/${item.id}`, { method: 'DELETE' });
    toast.success(`"${item.name}" deleted`, {
      description: item.type === 'project' ? `${r.leads} leads, ${r.ads} ads and ${r.searches} searches removed everywhere` : undefined,
    });
    setSelected(null);
    if (item.type === 'project' && pid === item.id) navigate('/projects');
    else load(true);
  };
  const collectMore = async (project) => {
    try {
      await api(`/projects/${project.id}/search`, { method: 'POST', body: {} });
      kickExtension();
      toast.success(`"${project.name}" queued to search again`, { description: 'The worker opens the Ad Library within a minute.' });
      load(true);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const itemActions = (item) => [
    { label: 'Open', icon: FolderOpen, hint: 'Enter', run: () => open(item) },
    { label: 'Rename', icon: Pencil, hint: 'F2', run: () => rename(item) },
    ...(item.type === 'project' ? [{ label: 'Collect more ads', icon: RotateCw, run: () => collectMore(item) }] : []),
    '-',
    { label: 'Delete', icon: Trash2, hint: 'Del', danger: true, run: () => setConfirm({ item }) },
  ];
  const backgroundActions = () =>
    atRoot
      ? [
          { label: 'New search', icon: Plus, run: () => navigate('/search?new=1') },
          { label: 'Refresh', icon: RefreshCw, run: () => load() },
        ]
      : [
          { label: 'New folder', icon: FolderPlus, run: () => create('folder') },
          { label: 'New sheet', icon: FilePlus2, run: () => create('sheet') },
          '-',
          { label: 'Refresh', icon: RefreshCw, run: () => load() },
        ];

  const onTileKey = (e, item) => {
    if (e.key === 'Enter') open(item);
    else if (e.key === 'F2') {
      e.preventDefault();
      rename(item);
    } else if (e.key === 'Delete') setConfirm({ item });
  };

  const selectedItem = items.find((i) => i.id === selected);
  const detailProject = atRoot ? (selectedItem?.type === 'project' ? selectedItem : null) : data?.project;
  const crumbs = [
    { label: 'Projects', to: '/projects', icon: HardDrive },
    ...(data && !atRoot ? [{ label: data.project.name, to: `/projects/${pid}` }] : []),
    ...(!atRoot ? (data?.path || []).map((p) => ({ label: p.name, to: `/projects/${pid}/f/${p.id}` })) : []),
  ];

  return (
    <div>
      {/* ---------- address bar ---------- */}
      <div className="card mb-5 flex flex-wrap items-center gap-2 p-2">
        <div className="flex items-center">
          {/* ← walks up the path (sheet → Leads → project → Projects), like the user expects — not browser
              history, which bounced between a sheet and its folder */}
          <button onClick={goUp} disabled={atRoot} aria-label="Back" title="Back to the folder above" className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button onClick={goUp} disabled={atRoot} aria-label="Up one level" className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-white">
            <ArrowUp className="h-4 w-4" />
          </button>
          <button onClick={() => load()} aria-label="Refresh" className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5">
          {crumbs.map((c, i) => (
            <span key={c.to} className="flex shrink-0 items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />}
              <Link
                to={c.to}
                onClick={upClick(c.to)}
                className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium transition hover:bg-white dark:hover:bg-white/10', i === crumbs.length - 1 ? 'text-slate-900 dark:text-white' : 'text-slate-500')}
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
              >
                {c.icon && <c.icon className="h-4 w-4 text-indigo-500" aria-hidden="true" />}
                {c.label}
              </Link>
            </span>
          ))}
        </nav>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${crumbs[crumbs.length - 1].label}`} aria-label="Filter items" className="input h-9 pl-9" />
        </div>
      </div>

      {/* ---------- command bar ---------- */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {atRoot ? (
          <>
            <Button variant="primary" onClick={() => navigate('/search?new=1')}>
              <Plus className="h-4 w-4" /> New search
            </Button>
            {empty?.count > 0 && (
              <Button
                variant="ghost"
                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10"
                onClick={() => setConfirmEmpty(true)}
                title="Delete every project with 0 leads (not the ones still searching)"
              >
                <Trash2 className="h-4 w-4" /> Remove empty projects ({formatNumber(empty.count)})
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={() => create('folder')}>
              <FolderPlus className="h-4 w-4 text-amber-500" /> New folder
            </Button>
            <Button onClick={() => create('sheet')}>
              <FilePlus2 className="h-4 w-4 text-emerald-500" /> New sheet
            </Button>
          </>
        )}
        {selectedItem && (
          <>
            <span className="mx-1 h-6 w-px bg-slate-200 dark:bg-white/10" />
            <Button variant="ghost" size="sm" onClick={() => rename(selectedItem)}>
              <Pencil className="h-3.5 w-3.5" /> Rename
            </Button>
            <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => setConfirm({ item: selectedItem })}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </>
        )}
        {atRoot && (
          <label className="ml-auto flex items-center gap-2 text-xs font-medium text-slate-500">
            <ArrowDownWideNarrow className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSortMode(e.target.value)}
              aria-label="Sort projects"
              className="h-9 rounded-xl border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:focus:ring-indigo-500/20"
            >
              {Object.entries(SORTS).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className={cn('flex rounded-xl border border-slate-200 bg-white p-0.5 dark:border-white/10 dark:bg-slate-900', !atRoot && 'ml-auto')} role="group" aria-label="View">
          {[
            ['grid', LayoutGrid, 'Large icons'],
            ['list', List, 'Details'],
          ].map(([v, Icon, label]) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              aria-pressed={view === v}
              aria-label={label}
              title={label}
              className={cn('rounded-lg p-1.5 transition', view === v ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300' : 'text-slate-400 hover:text-slate-700')}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        {/* ---------- items ---------- */}
        <section
          aria-label="Files"
          className="min-h-[420px] rounded-2xl border border-slate-200 bg-white p-4 shadow-card dark:border-white/10 dark:bg-slate-900"
          onClick={(e) => e.target === e.currentTarget && setSelected(null)}
          onContextMenu={(e) => {
            if (e.target.closest('[data-item]')) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, actions: backgroundActions() });
          }}
        >
          {loading && !items.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 p-3">
                  <Skeleton className="h-20 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          ) : !items.length ? (
            <EmptyState
              icon={atRoot ? Globe2 : FolderOpen}
              title={filter ? 'Nothing found' : atRoot ? 'No projects yet' : 'This folder is empty'}
              text={atRoot ? 'Start a search with a keyword. Each keyword gets its own project folder.' : 'Right-click to create a new folder or sheet.'}
              action={
                atRoot ? (
                  <Button variant="primary" onClick={() => navigate('/search?new=1')}>
                    <Plus className="h-4 w-4" /> New search
                  </Button>
                ) : null
              }
            />
          ) : view === 'grid' ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
              {items.map((item, i) => (
                <motion.li key={item.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.2 }}>
                  <button
                    data-item
                    onClick={() => setSelected(item.id)}
                    onDoubleClick={() => open(item)}
                    onKeyDown={(e) => onTileKey(e, item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(item.id);
                      setMenu({ x: e.clientX, y: e.clientY, actions: itemActions(item) });
                    }}
                    title={`${item.name} — double-click to open`}
                    className={cn(
                      'group relative flex w-full flex-col items-center rounded-xl border px-2 pb-3 pt-3 text-center transition-all duration-150',
                      selected === item.id
                        ? 'border-indigo-200 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/15'
                        : 'border-transparent hover:bg-slate-50 dark:hover:bg-white/5',
                    )}
                  >
                    {showRank && <RankBadge rank={item.rank} className="absolute left-2 top-2" />}
                    <span className="transition-transform duration-200 group-hover:-translate-y-0.5 group-active:scale-95">
                      <ItemIcon item={item} size={84} />
                    </span>
                    <span className="mt-1.5 line-clamp-2 w-full break-words text-[13px] font-semibold leading-snug text-slate-800 dark:text-slate-100">{item.name}</span>
                    <span className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{subtitle(item)}</span>
                    {item.type === 'project' && item.phase !== 'done' && (
                      <Badge tone={PHASE[item.phase]?.tone} dot="pulse" className="mt-1.5 px-2 py-0 text-[10px]">
                        {PHASE[item.phase]?.label}
                      </Badge>
                    )}
                  </button>
                </motion.li>
              ))}
            </ul>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Contents</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    data-item
                    tabIndex={0}
                    onClick={() => setSelected(item.id)}
                    onDoubleClick={() => open(item)}
                    onKeyDown={(e) => onTileKey(e, item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(item.id);
                      setMenu({ x: e.clientX, y: e.clientY, actions: itemActions(item) });
                    }}
                    className={cn('cursor-default border-b border-slate-50 transition-colors last:border-0 dark:border-white/5', selected === item.id ? 'bg-indigo-50 dark:bg-indigo-500/15' : 'hover:bg-slate-50 dark:hover:bg-white/5')}
                  >
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2.5 font-medium">
                        {showRank && <RankBadge rank={item.rank} />}
                        <ItemIcon item={item} size={28} />
                        {item.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{item.type === 'sheet' ? 'Sheet' : item.type === 'project' ? 'Project' : 'Folder'}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{subtitle(item)}</td>
                    <td className="hidden px-3 py-2 text-slate-500 sm:table-cell">{timeAgo(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ---------- details ---------- */}
        <aside className="hidden lg:block" aria-label="Details">
          {detailProject ? (
            <ProjectDetails
              project={detailProject}
              onCollect={() => collectMore(detailProject)}
              onDelete={() => setConfirm({ item: { ...detailProject, type: 'project' } })}
              onContinue={async () => {
                try {
                  const r = await api(`/projects/${detailProject.id}/continue`, { method: 'POST' });
                  toast.success(`${r.pages} pages queued again`);
                  load(true);
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            />
          ) : (
            <div className="card sticky top-24 flex flex-col items-center p-6 text-center">
              <FolderIcon size={72} />
              <p className="mt-3 text-sm font-semibold">No project selected</p>
              <p className="mt-1 text-xs text-slate-500">Click once to see details here, double-click to open.</p>
            </div>
          )}
        </aside>
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <PromptModal
        open={!!prompt}
        title={prompt?.title}
        label={prompt?.label}
        initial={prompt?.initial}
        confirmText={prompt?.confirmText}
        onClose={() => setPrompt(null)}
        onSubmit={async (v) => {
          try {
            await prompt.onSubmit(v);
          } catch (e) {
            toast.error(e.message);
            throw e;
          }
        }}
      />
      <EmptyProjectsModal
        open={confirmEmpty}
        projects={empty?.projects || []}
        busy={removingEmpty}
        onClose={() => !removingEmpty && setConfirmEmpty(false)}
        onRemove={removeEmpty}
      />
      <DeleteModal
        item={confirm?.item}
        onClose={() => setConfirm(null)}
        onConfirm={async (it) => {
          try {
            await remove(it);
          } catch (e) {
            toast.error(e.message);
          }
        }}
      />
    </div>
  );
}
