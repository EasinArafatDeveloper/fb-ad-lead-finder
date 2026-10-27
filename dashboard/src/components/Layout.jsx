import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  BadgeDollarSign, Coins, Megaphone, CreditCard, FolderOpen, Gauge, KeyRound, LayoutDashboard, Link2, LogOut, MailCheck, Menu, Moon, Pause, Play, Plus, Receipt, Search, ScrollText, Settings, Square, Sun, UserCog, Users, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/utils';
import { Button, Modal } from './ui';
import TodayCounter from './TodayCounter';
import NotificationBell from './NotificationBell';

// ---------------- live stats shared by every page ----------------
const StatsCtx = createContext({ stats: null, refresh: () => {} });
export const useStats = () => useContext(StatsCtx);

const navFor = (admin) => [
  { label: null, items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    label: 'Data',
    items: [
      { to: '/projects', label: 'Projects', icon: FolderOpen },
      { to: '/leads', label: 'All Leads', icon: Users },
    ],
  },
  {
    label: 'Hunt',
    items: [
      { to: '/search', label: 'Searches', icon: Search },
      { to: '/links', label: 'Paste links', icon: Link2 },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/billing', label: 'Billing & credits', icon: CreditCard },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
  ...(admin
    ? [
        {
          label: 'Admin',
          items: [
            { to: '/admin', label: 'Overview', icon: Gauge, end: true },
            { to: '/admin/users', label: 'Customers', icon: UserCog },
            { to: '/admin/orders', label: 'Orders', icon: Receipt },
            { to: '/admin/plans', label: 'Plans & prices', icon: BadgeDollarSign },
            { to: '/admin/notices', label: 'Notices', icon: Megaphone },
            { to: '/admin/logs', label: 'Server logs', icon: ScrollText },
          ],
        },
      ]
    : []),
];

function Logo() {
  return <img src="/favicon.png" alt="" width={36} height={36} className="h-9 w-9 rounded-[22%] shadow-lg shadow-indigo-500/25" />;
}

/** Header: the credits left — a click opens Billing. Red when empty. */
function CreditsPill() {
  const { stats } = useStats();
  const a = stats?.account;
  if (!a) return null;
  const empty = !a.unlimited && a.credits <= 0; // 0 or below (a running search may go down to -overdraft)
  const low = !a.unlimited && a.credits > 0 && a.credits < 50;
  return (
    <NavLink
      to="/billing"
      title={a.unlimited ? 'Unlimited (team account)' : `${a.credits} credits left · ${a.planName} plan — 1 credit = 1 page read`}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-bold ring-1 ring-inset transition',
        empty
          ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30'
          : low
            ? 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30'
            : 'bg-white text-slate-700 ring-slate-200 hover:ring-indigo-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-white/10',
      )}
    >
      <Coins className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="tabular-nums">{a.unlimited ? '∞' : a.credits.toLocaleString()}</span>
      <span className="hidden font-medium opacity-70 sm:inline">credits</span>
      {(empty || low) && <span className="hidden sm:inline">· Buy</span>}
    </NavLink>
  );
}

/** A new account: confirm the email first (searches wait until then). */
function VerifyBanner() {
  const { me } = useAuth();
  const [sent, setSent] = useState(false);
  if (!me || me.user.emailVerified !== false) return null;
  const resend = async () => {
    try {
      await api('/auth/verify/resend', { method: 'POST' });
      setSent(true);
      toast.success(`Link sent to ${me.user.email}`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-100 sm:px-6">
      <MailCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span><b>Confirm your email</b> — we sent a link to {me.user.email}. Searches start once it is confirmed (check the spam folder too).</span>
      <button type="button" onClick={resend} disabled={sent} className="font-semibold underline disabled:no-underline disabled:opacity-60">{sent ? 'Sent' : 'Send it again'}</button>
    </div>
  );
}

function Sidebar({ open, onClose }) {
  const navigate = useNavigate();
  const { stats } = useStats();
  const { me } = useAuth();
  const NAV = navFor(me?.user.role === 'admin');
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white shadow-lg transition-transform duration-300 dark:border-white/10 dark:bg-slate-900 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-slate-100 px-5 dark:border-white/10">
        <NavLink to="/dashboard" className="flex items-center gap-3" onClick={onClose}>
          <Logo />
          <div className="leading-tight">
            <div className="font-display text-[15px] font-extrabold tracking-tight">FB Lead Finder</div>
            <div className="text-[11px] font-medium text-slate-400">Meta Ad Library</div>
          </div>
        </NavLink>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 lg:hidden" aria-label="Close navigation">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-4 pt-4">
        <button
          onClick={() => {
            navigate('/search?new=1');
            onClose();
          }}
          className="group relative flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
        >
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent motion-safe:animate-shimmer" />
          <Plus className="relative h-4 w-4" aria-hidden="true" />
          <span className="relative">New search</span>
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-5">
        {NAV.map((group, gi) => (
          <div key={gi}>
            {group.label && <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} onClick={onClose}>
                    {({ isActive }) => (
                      <span
                        className={cn(
                          'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                          isActive ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100',
                        )}
                      >
                        {isActive && (
                          <motion.span layoutId="sidebar-active" className="absolute inset-0 rounded-xl bg-indigo-50 dark:bg-indigo-500/15" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />
                        )}
                        {isActive && <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full bg-gradient-to-b from-indigo-500 to-cyan-400" />}
                        <item.icon className={cn('relative h-[18px] w-[18px]', isActive ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-400')} aria-hidden="true" />
                        <span className="relative">{item.label}</span>
                        {item.to === '/leads' && stats?.pending > 0 && (
                          <span className="relative ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" title="Pages in the queue">
                            {stats.pending}
                          </span>
                        )}
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {stats && <TodayCounter stats={stats} onNavigate={onClose} />}
    </aside>
  );
}

/**
 * Work control in the header — only shown while a project is being worked on:
 *   running → "Running · <project>"  [Pause] [Stop]
 *   paused  → "Paused"               [Resume] [Stop]
 * Nothing to do → hidden.
 */
function RunnerPill() {
  const { stats, refresh } = useStats();
  const { me } = useAuth();
  const admin = me?.user.role === 'admin';
  const [busy, setBusy] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  if (!stats?.active) return null;

  const toggle = async () => {
    setBusy('toggle');
    try {
      await api('/settings', { method: 'PUT', body: { worker: { running: !stats.running } } });
      await refresh();
      toast.success(stats.running ? 'Paused' : 'Resumed');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const stop = async () => {
    setBusy('stop');
    try {
      const r = await api('/runner/stop', { method: 'POST' });
      setConfirmStop(false);
      await refresh();
      toast.success('Stopped', { description: `${r.searches} searches and ${r.pages} pages cancelled. Everything found so far is kept.` });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const waitUntil = stats.cooldownUntil ? new Date(stats.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  // reading stops only at the end of the overdraft (e.g. -50)
  const noCredits = stats.account && !stats.account.unlimited && stats.account.credits <= -(stats.account.overdraft || 0);
  const doing = stats.collecting ? 'collecting ads' : noCredits && stats.pending ? 'waiting for credits' : waitUntil ? `break until ${waitUntil}` : stats.pending ? 'reading pages' : 'starting';
  const waiting = noCredits && stats.pending && !stats.collecting;
  return (
    <>
      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2">
        <span
          className={cn(
            'hidden max-w-[320px] items-center gap-2 truncate rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset sm:inline-flex',
            stats.running && !waiting
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'
              : 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
          )}
          title={stats.pausedReason || stats.activeName || ''}
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full bg-current', stats.running && !waiting && 'animate-pulse')} />
          <span className="truncate">
            {waiting ? 'Waiting' : stats.running ? 'Running' : 'Paused'}
            {stats.activeName && ` · ${stats.activeName}`}
            {stats.running ? ` — ${doing}` : stats.pausedReason ? ` — ${stats.pausedReason}` : ''}
          </span>
        </span>
        {admin && (
          <button
            onClick={toggle}
            disabled={!!busy}
            title="Pauses the worker for every user"
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold shadow-sm transition disabled:opacity-50',
              stats.running
                ? 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5'
                : 'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-indigo-600/25 hover:shadow-md',
            )}
          >
            {stats.running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {stats.running ? 'Pause' : 'Resume'}
          </button>
        )}
        <button
          onClick={() => setConfirmStop(true)}
          disabled={!!busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-600 shadow-sm transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:bg-slate-900 dark:hover:bg-rose-500/10"
        >
          <Square className="h-3 w-3 fill-current" /> Stop
        </button>
      </motion.div>

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop the work?"
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setConfirmStop(false)}>No, keep going</Button>
            <Button variant="danger" loading={busy === 'stop'} onClick={stop}>
              {busy !== 'stop' && <Square className="h-3.5 w-3.5 fill-current" />} Stop
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
          <p>Work that hasn't happened yet will be cancelled:</p>
          <ul className="grid grid-cols-2 gap-2">
            <li className="rounded-xl bg-rose-50 px-3 py-2 dark:bg-rose-500/10">
              <span className="block font-display text-lg font-extrabold tabular-nums text-rose-700 dark:text-rose-300">{stats.queuedJobs + stats.collecting}</span>
              <span className="text-xs text-rose-700/80 dark:text-rose-300/80">Search</span>
            </li>
            <li className="rounded-xl bg-rose-50 px-3 py-2 dark:bg-rose-500/10">
              <span className="block font-display text-lg font-extrabold tabular-nums text-rose-700 dark:text-rose-300">{stats.pending}</span>
              <span className="text-xs text-rose-700/80 dark:text-rose-300/80">Unread pages</span>
            </li>
          </ul>
          <p className="text-xs text-slate-500">
            Only your own searches are stopped. All leads and contacts found so far are kept, and you can restart the stopped pages later from the project folder.
          </p>
        </div>
      </Modal>
    </>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('fblf_theme', next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  };
  return (
    <button onClick={toggle} aria-label={dark ? 'Light mode' : 'Dark mode'} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white">
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}

function PasswordModal({ open, onClose }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setF({ current: '', next: '', again: '' });
      setError('');
    }
  }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    if (f.next !== f.again) return setError('The new passwords are not the same');
    setBusy(true);
    setError('');
    try {
      await api('/auth/password', { method: 'POST', body: { current: f.current, next: f.next } });
      toast.success('Password changed', { description: 'Other devices were logged out.' });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k, label, auto) => (
    <div>
      <label htmlFor={`pw-${k}`} className="label">{label}</label>
      <input id={`pw-${k}`} type="password" autoComplete={auto} className="input" value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} required />
    </div>
  );
  return (
    <Modal open={open} onClose={onClose} title="Change password" width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        {field('current', 'Current password', 'current-password')}
        {field('next', 'New password (8+ characters)', 'new-password')}
        {field('again', 'New password again', 'new-password')}
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  if (!me) return null;
  const initials = (me.user.name || me.user.email).slice(0, 2).toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-500 text-xs font-bold text-white shadow-sm"
      >
        {initials}
      </button>
      {open && (
        <div role="menu" onClick={(e) => e.stopPropagation()} className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-dropdown dark:border-white/10 dark:bg-slate-900">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold">{me.user.name}</p>
            <p className="truncate text-xs text-slate-500">{me.user.email}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-indigo-600">{me.user.role}</p>
          </div>
          <div className="my-1 h-px bg-slate-100 dark:bg-white/10" />
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true); }} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-slate-100 dark:hover:bg-white/5">
            <KeyRound className="h-4 w-4 opacity-70" /> Change password
          </button>
          <button role="menuitem" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
            <LogOut className="h-4 w-4 opacity-70" /> Log out
          </button>
        </div>
      )}
      <PasswordModal open={pw} onClose={() => setPw(false)} />
    </div>
  );
}

export default function Layout() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const location = useLocation();
  const isAdmin = useAuth().me?.user.role === 'admin';
  const fullBleed = /\/s\//.test(location.pathname); // sheet view uses the whole width

  const refresh = useCallback(async () => {
    try {
      setStats(await api('/stats'));
    } catch {
      /* auth errors are handled globally */
    }
  }, []);
  // the header pill and sidebar counter: every 3 s while something runs, every 15 s when idle
  const activeRef = useRef(false);
  activeRef.current = !!stats?.active;
  useEffect(() => {
    let timer;
    const loop = async () => {
      if (!document.hidden) await refresh();
      timer = setTimeout(loop, activeRef.current ? 3000 : 15000);
    };
    loop();
    return () => clearTimeout(timer);
  }, [refresh]);

  return (
    <StatsCtx.Provider value={{ stats, refresh }}>
      <div className="flex min-h-screen">
        {open && <div className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
        <Sidebar open={open} onClose={() => setOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur-md dark:border-white/10 dark:bg-slate-900/80 sm:px-6">
            <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex-1" />
            <RunnerPill />
            <CreditsPill />
            <NotificationBell />
            <ThemeToggle />
            <UserMenu />
          </header>
          <VerifyBanner />
          {isAdmin && stats?.worker?.outdated && stats.worker.seenAgo < 600 && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 sm:px-6">
              <b>An old extension version is running ({stats.worker.version}) — latest is {stats.worker.latest}.</b>
              {stats.worker.oldCopies?.length > 0 && (
                <span className="w-full text-xs">Online now: {stats.worker.oldCopies.join(' · ')}</span>
              )}
              <span>
                On that computer open <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">chrome://extensions</code>: if FB Ad Lead Finder is listed <b>twice</b>, Remove the old one; otherwise put the new ZIP in its folder and press <b>↻ Reload</b>.
              </span>
            </div>
          )}
          {!isAdmin && stats?.extensionOld && (
            <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 sm:px-6">
              <b>Your Chrome extension is out of date ({stats.extensionOld.running}) — the latest is {stats.extensionOld.latest}.</b>
              <span>
                It still works. To update: <Link to="/connect-extension" className="font-semibold underline">download the new version</Link>, put its files in the same folder, then press <b>↻ Reload</b> in <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">chrome://extensions</code>.
              </span>
            </div>
          )}
          <main id="main" className={cn('w-full flex-1', fullBleed ? 'p-0' : 'mx-auto max-w-7xl p-4 sm:p-6 lg:p-8')}>
            <Outlet />
          </main>
        </div>
      </div>
    </StatsCtx.Provider>
  );
}
