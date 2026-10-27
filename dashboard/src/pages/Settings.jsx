import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowDownToLine, BellRing, ChevronDown, Lock, CloudUpload, Copy, FileSpreadsheet, Gauge, Network, PlugZap, RotateCcw, Save, Server, Settings as SettingsIcon,
  ShieldCheck, Timer,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Button, PageHeader, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';
import NotifyPanel from '../components/NotifyPanel';
import PcsCard from '../components/PcsCard';
import ExtensionPanel from '../components/ExtensionPanel';
import { LockedFeature, usePerk } from '../components/PlanGate';

// ---------------- building blocks ----------------
function Card({ icon: Icon, title, text, children, right, className }) {
  return (
    <section className={cn('card p-6', className)}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {Icon && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <div>
            <h2 className="font-display font-bold">{title}</h2>
            {text && <p className="text-xs text-slate-500">{text}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Toggle({ id, checked, onChange, label, help }) {
  return (
    <div className={cn('flex items-start justify-between gap-4', help !== undefined || label.length > 3 ? 'py-3' : 'items-center py-0')}>
      <div>
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold">{label}</label>
        {help && <p className="mt-0.5 max-w-xl text-xs text-slate-500">{help}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10')}
      >
        <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
      </button>
    </div>
  );
}

/** A number box with its unit and a one-line explanation under it. */
function NumberField({ id, label, unit, help, value, onChange, min = 0, max }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        <input id={id} type="number" min={min} max={max} className={cn('input tabular-nums', unit && 'pr-16')} value={value ?? ''} onChange={onChange} />
        {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">{unit}</span>}
      </div>
      {help && <p className="mt-1 text-[11px] text-slate-500">{help}</p>}
    </div>
  );
}

function Disclosure({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-slate-200 dark:border-white/10">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold">
        {title}
        <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <div className="border-t border-slate-200 p-4 dark:border-white/10">{children}</div>}
    </div>
  );
}

const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------------- the proxy IPs: summary + table ----------------
function IpHealth({ status }) {
  const [show, setShow] = useState('all');
  const bad = status.filter((p) => p.bad);
  const resting = status.filter((p) => !p.bad && p.restingUntil);
  const ready = status.filter((p) => !p.bad && !p.restingUntil);
  const tiles = [
    ['all', 'All IPs', status.length, 'text-slate-900 dark:text-white', 'bg-slate-400'],
    ['ready', 'Ready', ready.length, 'text-emerald-600', 'bg-emerald-500'],
    ['resting', 'Short rest', resting.length, 'text-amber-600', 'bg-amber-400'],
    ['bad', 'Bad', bad.length, 'text-rose-600', 'bg-rose-500'],
  ];
  const rows = { all: status, ready, resting, bad }[show];
  const order = (p) => (p.bad ? 0 : p.restingUntil ? 1 : 2);
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([k, label, n, text, dot]) => (
          <button
            key={k}
            type="button"
            onClick={() => setShow(k)}
            aria-pressed={show === k}
            className={cn(
              'rounded-xl border p-3 text-left transition',
              show === k ? 'border-indigo-300 bg-indigo-50/60 ring-2 ring-indigo-500/15 dark:border-indigo-500/40 dark:bg-indigo-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10',
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <span className={cn('h-2 w-2 rounded-full', dot)} /> {label}
            </span>
            <span className={cn('mt-1 block font-display text-2xl font-extrabold tabular-nums', text)}>{n}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" aria-hidden="true">
        {[[ready, 'bg-emerald-500'], [resting, 'bg-amber-400'], [bad, 'bg-rose-500']].map(([l, cls], i) =>
          l.length ? <div key={i} className={cls} style={{ width: `${(l.length / status.length) * 100}%` }} /> : null,
        )}
      </div>

      {bad.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
          <p className="min-w-0 flex-1">
            <b>{bad.length} bad IPs</b> — Facebook blocks them most of the time. In Webshare: Proxy List → select them → <b>Replace Proxy</b>, then paste the new list above.
          </p>
          <Button
            size="sm"
            onClick={() => navigator.clipboard.writeText(bad.map((p) => (p.group === 'rotating' ? p.label.split(' · ')[1] : p.label.split(' · ')[0].split(':')[0])).join('\n')).then(() => toast.success(`${bad.length} bad IPs copied`))}
          >
            <Copy className="h-3.5 w-3.5" /> Copy bad IPs
          </Button>
        </div>
      )}

      <div className="mt-4 max-h-72 overflow-auto rounded-xl border border-slate-200 text-xs dark:border-white/10">
        <table className="w-full">
          <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-800">
            <tr>
              <th className="px-3 py-2 font-semibold">IP</th>
              <th className="px-3 py-2 text-right font-semibold">Pages read</th>
              <th className="px-3 py-2 text-right font-semibold">Login walls</th>
              <th className="px-3 py-2 text-right font-semibold" title="Recent share of tries that got a login wall">Wall %</th>
              <th className="px-3 py-2 font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].sort((a, b) => order(a) - order(b) || b.pages - a.pages).map((p) => (
              <tr key={p.label} className="border-t border-slate-100 dark:border-white/5">
                <td className="px-3 py-1.5 font-mono">
                  {p.group === 'rotating' ? (
                    <>
                      <span className="mr-1.5 rounded bg-sky-100 px-1 py-0.5 font-sans text-[10px] font-bold text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" title="Rotating residential">ROT</span>
                      {p.label.split(' · ')[1]}
                    </>
                  ) : (
                    p.label.split(' · ')[0]
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.pages}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.walls}</td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', p.wallRate >= 50 && 'font-semibold text-rose-600')}>{p.wallRate}%</td>
                <td className="px-3 py-1.5">
                  <span
                    className={cn(
                      'inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      p.bad ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : p.restingUntil ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
                    )}
                  >
                    {p.bad ? 'bad — replace' : p.restingUntil ? `rest until ${hhmm(p.restingUntil)}` : 'ready'}
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">None</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- the two proxy groups: Static and Rotating ----------------
function ProxyGroup({ id, title, hint, on, onToggle, value, onChange, count, placeholder, testing, onTest, note }) {
  return (
    <div className={cn('rounded-xl border p-4 transition', on ? 'border-indigo-200 bg-indigo-50/30 dark:border-indigo-500/30 dark:bg-indigo-500/5' : 'border-slate-200 dark:border-white/10')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{title}</h3>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-bold tabular-nums text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200">{count} lines</span>
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', on ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
              {on ? 'IN USE' : 'OFF'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        </div>
        <Toggle id={`${id}-on`} checked={on} onChange={onToggle} label={on ? 'On' : 'Off'} />
      </div>
      {note && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-500/10 dark:text-sky-100">{note}</p>}
      <label htmlFor={id} className="label mb-1.5 mt-3">One per line: host:port:user:pass</label>
      <textarea id={id} rows={5} spellCheck={false} className="input font-mono text-xs leading-relaxed" placeholder={placeholder} value={value} onChange={onChange} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" loading={testing} onClick={onTest}><PlugZap className="h-3.5 w-3.5" /> Test the first line</Button>
        <p className="text-xs text-slate-500">A login wall rests only the line that got it — the others keep reading.</p>
      </div>
    </div>
  );
}

function GroupCompare({ groups }) {
  const pct = (v) => (v == null ? '–' : `${v}%`);
  const used = groups.filter((g) => g.pages + g.walls > 0);
  // the group with the lower recent wall % (only once both have been tried a bit)
  const best = used.length === 2 && used.every((g) => g.pages + g.walls >= 50) ? [...used].sort((a, b) => a.recentWallRate - b.recentWallRate)[0] : null;
  const rows = [
    ['Switch', (g) => (g.on ? 'In use' : 'Off')],
    ['Lines', (g) => g.lines],
    ['Pages read', (g) => g.pages.toLocaleString()],
    ['Login walls', (g) => g.walls.toLocaleString()],
    ['Wall % (recent)', (g) => pct(g.recentWallRate), 'Each line\'s latest tries count most — this shows how it goes now'],
    ['Wall % (all time)', (g) => pct(g.wallRate)],
    ['Connection errors', (g) => g.netErrors.toLocaleString(), 'The page did not load (the line dropped) — the page goes back to the queue, nothing lost'],
    ['Bad lines now', (g) => g.bad],
    ['Resting now', (g) => g.resting],
    ['Last used', (g) => (g.lastUsedAt ? `${new Date(g.lastUsedAt).toLocaleDateString()} ${hhmm(g.lastUsedAt)}` : '–')],
  ];
  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 text-sm dark:border-white/10">
        <table className="w-full">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-800">
            <tr>
              <th className="px-3 py-2 font-semibold" />
              {groups.map((g) => (
                <th key={g.group} className="px-3 py-2 text-right font-semibold">{g.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, value, title]) => (
              <tr key={name} className="border-t border-slate-100 dark:border-white/5">
                <td className="px-3 py-1.5 text-slate-500" title={title}>{name}</td>
                {groups.map((g) => (
                  <td key={g.group} className={cn('px-3 py-1.5 text-right tabular-nums', name === 'Wall % (recent)' && best?.group === g.group && 'font-bold text-emerald-600')}>
                    {value(g)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        {best
          ? <><b>{best.label}</b> gets fewer login walls right now. Lower wall % = Facebook blocks it less. Data used by the rotating plan: see the Webshare dashboard.</>
          : 'Let both groups read at least ~50 pages each, then compare the wall %. Lower = Facebook blocks it less. Data used by the rotating plan: see the Webshare dashboard.'}
      </p>
    </div>
  );
}

// ---------------- the page ----------------
const TABS = [
  { id: 'proxy', label: 'Proxy & reading', icon: ShieldCheck, text: 'IPs that read the Facebook pages', admin: true },
  { id: 'worker', label: 'Worker', icon: Gauge, text: 'Speed, limits, the Chrome extension', admin: true },
  { id: 'sheet', label: 'Google Sheet', icon: FileSpreadsheet, text: 'Sync your leads to a Sheet' },
  { id: 'notify', label: 'Notifications', icon: BellRing, text: 'Email & phone when a search is done' },
  { id: 'extension', label: 'Extension', icon: PlugZap, text: 'Your Chrome and computers' },
];

export default function Settings() {
  const { refresh } = useStats();
  const [ws, setWs] = useState(null); // this workspace: Google Sheet
  const [worker, setWorker] = useState(null); // the shared worker (admins)
  const [admin, setAdmin] = useState(false);
  const [proxyStatus, setProxyStatus] = useState([]);
  const [proxyGroups, setProxyGroups] = useState([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState(''); // the last saved copy, to know if something changed
  const [params, setParams] = useSearchParams();

  const tabs = TABS.filter((t) => admin || !t.admin);
  // what the plan includes — the other tabs show what they would give, and the way to get it
  const canSheet = usePerk('sheetSync');
  const canNotify = usePerk('notifications');
  const tab = tabs.find((t) => t.id === params.get('tab'))?.id || tabs[0].id;
  const setTab = (id) => setParams({ tab: id }, { replace: true });

  const body = (w = ws, k = worker) => ({
    workspace: { sheetUrl: w.sheetUrl, sheetSecret: w.sheetSecret, autoSync: w.autoSync },
    ...(admin && k ? { worker: {
      delayMin: k.delayMin, delayMax: k.delayMax, dailyLimit: k.dailyLimit, maxAds: k.maxAds, parallel: k.parallel,
      websiteFallback: k.websiteFallback, closeAdTab: k.closeAdTab, insights: k.insights !== false,
      proxyEnabled: Boolean(k.proxyEnabled), proxyHost: k.proxyHost || '', proxyPort: Number(k.proxyPort) || 44445,
      proxyUser: k.proxyUser || '', proxyPass: k.proxyPass || '', proxyList: k.proxyList || '',
      proxyStaticOn: k.proxyStaticOn !== false, resiOn: Boolean(k.resiOn), resiList: k.resiList || '',
      serverReader: k.serverReader !== false, serverParallel: Number(k.serverParallel) || 5, ipGapSec: Number(k.ipGapSec) || 0,
    } } : {}),
  });
  const apply = (r) => {
    setWs(r.workspace);
    setWorker(r.worker);
    setAdmin(!!r.isAdmin);
    setProxyStatus(r.proxyStatus || []);
    setProxyGroups(r.proxyGroups || []);
    setSaved(JSON.stringify({ w: r.workspace, k: r.worker }));
  };
  useEffect(() => {
    api('/settings').then(apply).catch((e) => toast.error(e.message));
    fetch('/apps-script.gs').then((r) => r.text()).then(setCode).catch(() => {});
  }, []);

  const dirty = useMemo(() => {
    if (!ws || !saved) return false;
    const s = JSON.parse(saved);
    return JSON.stringify(body(ws, worker)) !== JSON.stringify(body(s.w, s.k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, worker, saved, admin]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const field = (setter) => (k) => (v) => setter((x) => ({ ...x, [k]: v?.target ? (v.target.type === 'number' ? Number(v.target.value) : v.target.value) : v }));
  const setW = field(setWs);
  const setK = field(setWorker);
  const linesOf = (text) => (text || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const proxyLines = linesOf(worker?.proxyList);
  const resiLines = linesOf(worker?.resiList);

  const testProxy = async (lines = proxyLines, which = 'test-proxy') => {
    setBusy(which);
    try {
      // with a list: test its first proxy
      const first = lines[0]?.trim();
      const [host, port, user, ...pass] = first ? first.split(':') : [];
      const res = await api('/admin/test-proxy', {
        method: 'POST',
        body: first ? { host, port, user, pass: pass.join(':') } : { host: worker.proxyHost, port: worker.proxyPort, user: worker.proxyUser, pass: worker.proxyPass },
      });
      toast.success(`Proxy works with Facebook ✓ IP: ${res.ip || 'OK'} (${res.country || 'Global'})`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      apply(await api('/settings', { method: 'PUT', body: body() }));
      toast.success('Settings saved');
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const discard = () => {
    const s = JSON.parse(saved);
    setWs(s.w);
    setWorker(s.k);
  };
  const sheet = (path, payload, ok) => async () => {
    setBusy(path);
    try {
      apply(await api('/settings', { method: 'PUT', body: { workspace: body().workspace } }));
      toast.success(ok(await api(path, { method: 'POST', body: payload })));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!ws) return <Skeleton className="h-96" />;
  const k = worker;
  const serverOn = k && k.serverReader !== false;

  return (
    <div className="pb-24">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle={admin ? 'Proxy, worker and Google Sheet — changes apply after Save' : 'Google Sheet, notifications and your Chrome extension'}
        actions={<Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!dirty}><Save className="h-4 w-4" /> Save</Button>}
      />

      <div className="grid gap-6 lg:grid-cols-[230px_1fr]">
        {/* ---------- menu ---------- */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-6 lg:self-start">
          <ul className="flex gap-2 overflow-x-auto lg:flex-col">
            {tabs.map((t) => (
              <li key={t.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                    tab === t.id ? 'bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-white/10' : 'hover:bg-white/60 dark:hover:bg-white/5',
                  )}
                >
                  <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', tab === t.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
                    <t.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-semibold', tab === t.id ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300')}>{t.label}</span>
                    <span className="hidden text-[11px] text-slate-500 lg:block">{t.text}</span>
                  </span>
                  {((t.id === 'sheet' && !canSheet) || (t.id === 'notify' && !canNotify)) && <Lock className="ml-auto h-3.5 w-3.5 text-slate-400" aria-label="Not in your plan" />}
                  {t.id === 'proxy' && proxyStatus.some((p) => p.bad) && (
                    <span className="ml-auto rounded-full bg-rose-100 px-1.5 text-[10px] font-bold text-rose-700 dark:bg-rose-500/20 dark:text-rose-200">{proxyStatus.filter((p) => p.bad).length}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* ---------- content ---------- */}
        <div className="min-w-0 space-y-6">
          {tab === 'proxy' && k && (
            <>
              <Card
                icon={Network}
                title="Proxy IPs"
                text="Facebook pages are read through these IPs — the Ad Library and your own browsing never use them"
                right={<Toggle id="pe" checked={k.proxyEnabled} onChange={setK('proxyEnabled')} label={k.proxyEnabled ? 'On' : 'Off'} />}
              >
                {!k.proxyEnabled && (
                  <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                    The proxy is <b>off</b> — pages are read from the server's own IP, which Facebook blocks quickly. Turn it on (switch on the right).
                  </p>
                )}
                <p className="mb-4 text-xs text-slate-500">
                  Two groups, each with its own switch. Pages are read through the groups that are <b>on</b> — turn one off and the other does all the work.
                  A group that is off keeps its counts, so you can switch back any time. Changes apply after Save.
                </p>
                <div className="space-y-4">
                  <ProxyGroup
                    id="pl"
                    title="Static IPs"
                    hint="Webshare Static Residential — fixed IPs, a lot of data included"
                    on={k.proxyStaticOn !== false}
                    onToggle={setK('proxyStaticOn')}
                    value={k.proxyList || ''}
                    onChange={setK('proxyList')}
                    count={proxyLines.length}
                    placeholder={'1.2.3.4:5678:user:password\n5.6.7.8:9012:user:password'}
                    testing={busy === 'test-proxy'}
                    onTest={() => testProxy(proxyLines, 'test-proxy')}
                  />
                  <ProxyGroup
                    id="rl"
                    title="Rotating residential"
                    hint="Webshare Rotating Residential — home IPs from many countries, paid per GB (every line shares the same data)"
                    on={Boolean(k.resiOn)}
                    onToggle={setK('resiOn')}
                    value={k.resiList || ''}
                    onChange={setK('resiList')}
                    count={resiLines.length}
                    placeholder={'p.webshare.io:80:username-gb-1:password\np.webshare.io:80:username-ca-2:password'}
                    testing={busy === 'test-resi'}
                    onTest={() => (resiLines.length ? testProxy(resiLines, 'test-resi') : toast.error('Paste the rotating list first'))}
                    note={
                      <>
                        Paste <b>sticky</b> lines (Webshare → Rotating Residential → Proxy List → Download), not the single <code>-rotate</code> line: each line
                        then works like its own IP. 5–20 lines are enough for a test.
                      </>
                    }
                  />
                </div>
              </Card>

              {proxyGroups.some((g) => g.lines > 0) && (
                <Card icon={Gauge} title="Static vs Rotating" text="What each group's IPs did — compare the wall % to see which one Facebook blocks less">
                  <GroupCompare groups={proxyGroups} />
                </Card>
              )}

              {proxyStatus.length > 1 && (
                <Card icon={ShieldCheck} title="How the IPs are doing" text="Click a box to list only those IPs">
                  <IpHealth status={proxyStatus} />
                </Card>
              )}

              <Card icon={Server} title="Reading on the server" text="The server reads several pages at once, each through its own IP — no Chrome needed">
                <div className="divide-y divide-slate-100 dark:divide-white/10">
                  <Toggle
                    id="sr"
                    checked={serverOn}
                    onChange={setK('serverReader')}
                    label="Read pages on the server (fast)"
                    help="~200 KB per page. Chrome then only collects ads from the Ad Library. Off = Chrome reads the pages one at a time."
                  />
                </div>
                {serverOn && (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <NumberField id="spar" label="Pages at the same time" unit="pages" min={1} max={20} value={k.serverParallel ?? 5} onChange={setK('serverParallel')} help="Each one uses its own IP (at most the number of IPs)" />
                    <NumberField id="gap" label="Rest per IP" unit="sec" min={0} max={600} value={k.ipGapSec ?? 20} onChange={setK('ipGapSec')} help="One IP opens at most one page every this many seconds" />
                  </div>
                )}
              </Card>

              <Disclosure title="Single proxy (old setup — used only when the list above is empty)">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="ph" className="label">Host</label>
                    <input id="ph" className="input" placeholder="p.webshare.io" value={k.proxyHost || ''} onChange={setK('proxyHost')} />
                  </div>
                  <div>
                    <label htmlFor="pp" className="label">Port</label>
                    <input id="pp" type="number" className="input" placeholder="80" value={k.proxyPort || 44445} onChange={setK('proxyPort')} />
                  </div>
                  <div>
                    <label htmlFor="pu" className="label">Username</label>
                    <input id="pu" className="input" autoComplete="off" value={k.proxyUser || ''} onChange={setK('proxyUser')} />
                  </div>
                  <div>
                    <label htmlFor="pw" className="label">Password</label>
                    <input id="pw" type="password" autoComplete="new-password" className="input" value={k.proxyPass || ''} onChange={setK('proxyPass')} />
                  </div>
                </div>
              </Disclosure>
            </>
          )}

          {tab === 'worker' && k && (
            <>
              <PcsCard />
              <Card icon={Timer} title="Limits" text="For the whole server — every user shares them">
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField id="dailyLimit" label="Daily page limit" unit="pages/day" value={k.dailyLimit} onChange={setK('dailyLimit')} help="After this many pages, reading continues tomorrow" />
                  <div>
                    <NumberField id="maxAds" label="Max ads per keyword" unit="ads" min={10} max={50000} value={k.maxAds} onChange={setK('maxAds')} help="The default for a new search (10 – 50,000) — each search can change it" />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[1000, 5000, 10000, 20000, 50000].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setK('maxAds')(n)}
                          className={cn(
                            'rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums transition',
                            k.maxAds === n ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200' : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-white/10 dark:text-slate-300',
                          )}
                        >
                          {n.toLocaleString()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>

              <Card icon={Gauge} title="Chrome extension" text={serverOn ? 'Collects ads from the Ad Library — and reads the few pages the server could not' : 'Collects ads and reads the pages'}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField id="delayMin" label="Wait between pages — min" unit="sec" value={k.delayMin} onChange={setK('delayMin')} />
                  <NumberField id="delayMax" label="Wait between pages — max" unit="sec" value={k.delayMax} onChange={setK('delayMax')} help="A random wait in between, so it looks like a person" />
                </div>
                <div className="mt-5">
                  <span className="label">Pages open at the same time in Chrome</span>
                  <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Parallel tabs">
                    {[
                      [1, 'Recommended'],
                      [2, 'Faster, more login walls'],
                      [3, 'Fastest, most walls'],
                    ].map(([n, hint]) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={k.parallel === n}
                        onClick={() => setK('parallel')(n)}
                        className={cn(
                          'rounded-xl border p-3 text-left transition',
                          k.parallel === n ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-500/20 dark:border-indigo-500/50 dark:bg-indigo-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10',
                        )}
                      >
                        <span className="block font-display text-lg font-extrabold">{n} tab{n > 1 ? 's' : ''}</span>
                        <span className="text-[11px] text-slate-500">{hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100 dark:divide-white/10 dark:border-white/10">
                  <Toggle id="wf" checked={k.websiteFallback} onChange={setK('websiteFallback')} label="Find email on the website" help="If the page has no email, check their website's contact page" />
                  <Toggle id="ct" checked={k.closeAdTab} onChange={setK('closeAdTab')} label="Close the Ad Library tab after collecting" />
                  <Toggle id="ins" checked={k.insights !== false} onChange={setK('insights')} label="Ad insights (hooks, offers, prices)" help="Read from each ad's own text, no AI. Off = new ads are not analysed; nothing else changes." />
                </div>
              </Card>
            </>
          )}

          {tab === 'notify' && (canNotify ? <NotifyPanel /> : <LockedFeature perk="notifications" />)}
          {tab === 'sheet' && !canSheet && <LockedFeature perk="sheetSync" />}
          {tab === 'extension' && <ExtensionPanel />}

          {tab === 'sheet' && canSheet && (
            <>
              <Card
                icon={FileSpreadsheet}
                title="Google Sheet"
                text="Your own Sheet, synced through an Apps Script Web App"
                right={ws.sheetUrl ? <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Connected</span> : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 dark:bg-white/10">Not set up</span>}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label htmlFor="su" className="label">Web App URL</label>
                    <input id="su" className="input" placeholder="https://script.google.com/macros/s/…/exec" value={ws.sheetUrl} onChange={setW('sheetUrl')} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="ss" className="label">Secret key</label>
                    <input id="ss" type="password" autoComplete="new-password" className="input" placeholder="SECRET from Code.gs" value={ws.sheetSecret} onChange={setW('sheetSecret')} />
                  </div>
                </div>
                <div className="mt-2 border-t border-slate-100 dark:border-white/10">
                  <Toggle id="as" checked={ws.autoSync} onChange={setW('autoSync')} label="Auto-sync every 5 minutes" help="Status and Notes your team types in the Sheet are never overwritten" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" loading={busy === '/sheet/test'} onClick={sheet('/sheet/test', {}, (r) => `Connected ✓ ${r.sheet}`)}><PlugZap className="h-3.5 w-3.5" /> Test</Button>
                  <Button size="sm" loading={busy === '/sheet/sync'} onClick={sheet('/sheet/sync', { all: true }, (r) => `Synced ✓ ${r.inserted} new, ${r.updated} updated`)}><CloudUpload className="h-3.5 w-3.5" /> Sync all</Button>
                  <Button size="sm" loading={busy === '/sheet/pull'} onClick={sheet('/sheet/pull', {}, (r) => `${r.changed} lead updated`)}><ArrowDownToLine className="h-3.5 w-3.5" /> Pull Status/Notes</Button>
                </div>
              </Card>

              <Disclosure title="How to set up the Google Sheet (one time)" defaultOpen={!ws.sheetUrl}>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
                  <li>Open a new Google Sheet → <b>Extensions → Apps Script</b></li>
                  <li>Paste all of the code below, change <code className="rounded bg-indigo-50 px-1 text-indigo-700">SECRET</code> to your own long random text → Save</li>
                  <li><b>Deploy → New deployment → Web app</b> · Execute as: <b>Me</b> · Who has access: <b>Anyone</b></li>
                  <li>Enter the Web App URL and SECRET above → <b>Save</b> → <b>Test</b></li>
                </ol>
                <div className="relative mt-4">
                  <Button size="sm" className="absolute right-3 top-3" onClick={() => navigator.clipboard.writeText(code).then(() => toast.success('Code copied'))}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                  <pre className="max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-200">{code}</pre>
                </div>
              </Disclosure>
            </>
          )}
        </div>
      </div>

      {/* ---------- unsaved changes ---------- */}
      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-[min(560px,calc(100%-2rem))] items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl dark:bg-slate-800 dark:ring-1 dark:ring-white/10"
            role="status"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
            <span className="flex-1 font-medium">You have unsaved changes</span>
            <button type="button" onClick={discard} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white">
              <RotateCcw className="h-3.5 w-3.5" /> Discard
            </button>
            <Button size="sm" variant="primary" onClick={save} loading={busy === 'save'}>
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
