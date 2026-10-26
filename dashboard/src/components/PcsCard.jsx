import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Laptop, Loader2, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';
import { Skeleton } from './ui';

/**
 * Settings → Worker: every computer that runs the extension. Name them, and choose which ones run the
 * searches started in the Dashboard (the others can still press "Collect" in their own Ad Library tab).
 */
export default function PcsCard() {
  const [pcs, setPcs] = useState(null);
  const [names, setNames] = useState({});
  const load = () => api('/pcs').then(setPcs).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 15000);
    return () => clearInterval(t);
  }, []);

  const save = async (pc, body, msg) => {
    try {
      setPcs(await api(`/pcs/${encodeURIComponent(pc.id)}`, { method: 'PUT', body }));
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const forget = async (pc) => {
    try {
      setPcs(await api(`/pcs/${encodeURIComponent(pc.id)}`, { method: 'DELETE' }));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const takers = (pcs || []).filter((p) => p.takeQueue && p.online).length;
  return (
    <section className="card p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Laptop className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-display font-bold">Computers running the extension</h2>
          <p className="text-xs text-slate-500">
            A search started in the Dashboard opens the Ad Library on one of the computers that has <b>"Runs Dashboard searches"</b> on.
            Turn it off on a computer where nobody should see that window — its user can still press "Collect" in their own Ad Library tab.
          </p>
        </div>
      </div>

      {!pcs ? (
        <Skeleton className="h-28" />
      ) : !pcs.length ? (
        <p className="text-sm text-slate-500">No computer has connected yet.</p>
      ) : (
        <>
          {takers > 1 && (
            <p className="mb-3 rounded-xl bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              {takers} computers take Dashboard searches — each search opens on whichever asks first. Leave it on for one computer only, so you always know where it runs.
            </p>
          )}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
            {pcs.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="relative flex h-2.5 w-2.5 shrink-0" title={p.online ? 'Online' : 'Offline'}>
                  {p.online && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />}
                  <span className={cn('relative h-2.5 w-2.5 rounded-full', p.online ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')} />
                </span>
                <div className="min-w-[200px] flex-1">
                  <input
                    className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold hover:border-slate-200 focus:border-indigo-400 focus:outline-none dark:hover:border-white/10"
                    placeholder={p.label}
                    aria-label="Computer name"
                    value={names[p.id] ?? p.name}
                    onChange={(e) => setNames((n) => ({ ...n, [p.id]: e.target.value }))}
                    onBlur={(e) => e.target.value.trim() !== p.name && save(p, { name: e.target.value }, 'Name saved')}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <p className="px-1 text-[11px] text-slate-500">
                    {p.browser} · v{p.version} · {p.ip} · {p.online ? 'online now' : `seen ${timeAgo(p.lastSeen)}`}
                    {p.oldVersion && ' · old extension — update it to tell the PCs apart for sure'}
                  </p>
                  {p.collecting.length > 0 && (
                    <p className="mt-1 inline-flex items-center gap-1 px-1 text-xs font-semibold text-indigo-600 dark:text-indigo-300">
                      <Loader2 className="h-3 w-3 animate-spin" /> Collecting “{p.collecting.join('”, “')}”
                    </p>
                  )}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                  Runs Dashboard searches
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.takeQueue}
                    onClick={() => save(p, { takeQueue: !p.takeQueue }, p.takeQueue ? `${p.label} won't open Dashboard searches` : `${p.label} runs Dashboard searches`)}
                    className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', p.takeQueue ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10')}
                  >
                    <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', p.takeQueue && 'translate-x-5')} />
                  </button>
                </label>
                {/* for a server / datacenter computer that Facebook limits sooner (server: worker.js GENTLE) */}
                <label
                  className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300"
                  title="For a server (datacenter) computer: at most 2,000 ads per search, slower pages, 10 minutes between searches, and a 1-hour rest when Facebook asks to slow down"
                >
                  Gentle mode
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.gentle}
                    onClick={() => save(p, { gentle: !p.gentle }, p.gentle ? `${p.label}: normal speed` : `${p.label}: gentle mode on`)}
                    className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', p.gentle ? 'bg-amber-500' : 'bg-slate-200 dark:bg-white/10')}
                  >
                    <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', p.gentle && 'translate-x-5')} />
                  </button>
                </label>
                {p.restingUntil && (
                  <p className="w-full px-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                    Resting after Facebook asked to slow down — next search after {new Date(p.restingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
                {!p.online && (
                  <button type="button" onClick={() => forget(p)} title="Forget this computer" aria-label="Forget this computer" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
