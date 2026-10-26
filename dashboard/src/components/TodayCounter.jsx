import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatNumber } from '../lib/utils';

const OPEN_KEY = 'fblf_today_open';

/**
 * Sidebar: "Pages read today 3790/25000" — the arrow opens the same number split by keyword
 * (pages read today and how many had a contact), with the sum at the bottom.
 */
export default function TodayCounter({ stats, onNavigate }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let stop = false;
    const load = () => api('/stats/today').then((d) => !stop && setData(d)).catch(() => {});
    load();
    const t = setInterval(() => !document.hidden && load(), 20000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !o;
    });
  };

  const max = Math.max(1, ...(data?.keywords || []).map((k) => k.pages), data?.other?.pages || 0);
  const sumContacts = (data?.keywords || []).reduce((a, k) => a + k.contacts, 0) + (data?.other?.contacts || 0);

  return (
    <div className="m-3 rounded-2xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title="Pages the server read today, for every user together — click to see them by keyword"
        className="w-full rounded-2xl p-3.5 text-left transition hover:bg-slate-100/70 dark:hover:bg-white/5"
      >
        <div className="flex items-center justify-between gap-2 text-xs font-semibold">
          {/* the team: every page the server read today, against the daily limit; a customer: their own pages (= credits used) */}
          <span className="text-slate-500 dark:text-slate-400">{stats.dailyLimit == null ? 'Pages read for you today' : 'Pages read today'}</span>
          <span className="flex items-center gap-1">
            <span className="tabular-nums">
              {formatNumber(stats.workerVisitsToday)}
              {stats.dailyLimit != null && `/${formatNumber(stats.dailyLimit)}`}
            </span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </span>
        </div>
        {stats.dailyLimit != null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
            <div
              className="h-full w-full origin-left rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-transform duration-700"
              style={{ transform: `scaleX(${Math.min(1, stats.workerVisitsToday / Math.max(1, stats.dailyLimit))})` }}
            />
          </div>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="border-t border-slate-200 px-2 pb-2 pt-2 dark:border-white/10">
              <div className="flex justify-between px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <span>Keyword</span>
                <span>Pages · contacts</span>
              </div>
              {!data ? (
                <p className="px-1.5 py-2 text-xs text-slate-400">Loading…</p>
              ) : !data.total ? (
                <p className="px-1.5 py-2 text-xs text-slate-400">No page read yet today.</p>
              ) : (
                <ul className="max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
                  {data.keywords.map((k) => (
                    <li key={`${k.keyword}|${k.country}`}>
                      <Link
                        to={k.projectId ? `/projects/${k.projectId}` : '/search'}
                        onClick={onNavigate}
                        className="group block rounded-lg px-1.5 py-1 hover:bg-white dark:hover:bg-white/10"
                        title={`${k.keyword} (${k.country}) — ${k.pages} pages read today, ${k.contacts} with a phone or email${k.failed ? `, ${k.failed} could not be read` : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="min-w-0 truncate font-medium text-slate-700 group-hover:text-indigo-600 dark:text-slate-200">{k.keyword}</span>
                          <span className="shrink-0 tabular-nums">
                            <b>{formatNumber(k.pages)}</b>
                            <span className="text-emerald-600 dark:text-emerald-400"> · {formatNumber(k.contacts)}</span>
                          </span>
                        </div>
                        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/10">
                          <div className="h-full rounded-full bg-indigo-400/80" style={{ width: `${(k.pages / max) * 100}%` }} />
                        </div>
                      </Link>
                    </li>
                  ))}
                  {data.other && (
                    <li className="px-1.5 py-1" title="Pages from older searches, or from another user's searches">
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                        <span className="italic">Older / other searches</span>
                        <span className="tabular-nums">
                          {formatNumber(data.other.pages)} · {formatNumber(data.other.contacts)}
                        </span>
                      </div>
                    </li>
                  )}
                </ul>
              )}
              {data?.total > 0 && (
                <div className="mt-1.5 flex items-center justify-between rounded-lg bg-white px-1.5 py-1.5 text-xs font-bold shadow-sm dark:bg-slate-900">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatNumber(data.total)}
                    <span className="text-emerald-600 dark:text-emerald-400"> · {formatNumber(sumContacts)}</span>
                  </span>
                </div>
              )}
              <p className="mt-1 px-1.5 text-[10px] text-slate-400">Pages read · <span className="text-emerald-600 dark:text-emerald-400">with phone/email</span></p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
