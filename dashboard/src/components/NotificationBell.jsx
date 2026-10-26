import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { BadgeDollarSign, Bell, CheckCheck, CheckCircle2, Coins, Info, Megaphone, Receipt, Sparkles, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';
import { useStats } from './Layout';

const KIND_ICON = { search: CheckCircle2, credits: Coins, order: Receipt, payment: Receipt, plan: BadgeDollarSign, notice: Megaphone, welcome: Sparkles };
const LEVEL = {
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  error: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  info: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
};

/**
 * The bell in the header: everything for this account in one place — searches ready, credits, orders and
 * payments, the plan, and notices from the team. The red number comes with the stats the app polls anyway;
 * a new one also pops up as a toast.
 */
export default function NotificationBell() {
  const { stats, refresh } = useStats();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const unread = stats?.inboxUnread || 0;
  const prev = useRef(null);
  const box = useRef(null);

  const load = () => api('/inbox').then((d) => setItems(d.items)).catch(() => {});

  // a new notification while the app is open: show it once as a toast
  useEffect(() => {
    if (prev.current !== null && unread > prev.current) {
      api('/inbox')
        .then((d) => {
          setItems(d.items);
          const newest = d.items.find((x) => x.unread);
          if (newest) {
            toast(newest.title, {
              description: newest.body || undefined,
              icon: <Bell className="h-4 w-4" />,
              action: newest.link ? { label: 'Open', onClick: () => navigate(newest.link) } : undefined,
            });
          }
        })
        .catch(() => {});
    }
    prev.current = unread;
  }, [unread, navigate]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await load();
      // opening the box = read
      if (unread) api('/inbox/read', { method: 'POST' }).then(() => refresh()).catch(() => {});
    }
  };
  const go = (x) => {
    setOpen(false);
    if (!x.link) return;
    if (/^https?:\/\//.test(x.link)) window.open(x.link, '_blank', 'noopener');
    else navigate(x.link);
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread ? `${unread} new notifications` : 'Notifications'}
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-slate-900">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-11 z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-dropdown dark:border-white/10 dark:bg-slate-900"
            role="dialog"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/10">
              <h2 className="font-display font-bold">Notifications</h2>
              {items?.some((x) => x.unread) && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400"><CheckCheck className="h-3.5 w-3.5" /> marked as read</span>
              )}
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {!items ? (
                <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
              ) : !items.length ? (
                <div className="px-6 py-10 text-center">
                  <Bell className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-2 text-sm font-semibold">Nothing yet</p>
                  <p className="text-xs text-slate-500">Finished searches, credits, payments and news from us show up here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-white/5">
                  {items.map((x) => {
                    const Icon = KIND_ICON[x.kind] || (x.level === 'warn' || x.level === 'error' ? TriangleAlert : Info);
                    return (
                      <li key={x.id}>
                        <button
                          type="button"
                          onClick={() => go(x)}
                          className={cn('flex w-full gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-white/5', x.unread && 'bg-indigo-50/50 dark:bg-indigo-500/5', !x.link && 'cursor-default')}
                        >
                          <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl', LEVEL[x.level] || LEVEL.info)}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-start gap-2">
                              <span className="flex-1 text-sm font-semibold leading-snug">{x.title}</span>
                              {x.unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-500" aria-label="New" />}
                            </span>
                            {x.body && <span className="mt-0.5 block whitespace-pre-line text-xs leading-relaxed text-slate-500">{x.body}</span>}
                            <span className="mt-1 block text-[11px] text-slate-400">
                              {x.fromTeam && <span className="mr-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">From the team</span>}
                              {timeAgo(x.at)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
