import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Megaphone, Send, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, timeAgo } from '../../lib/utils';
import { Button, PageHeader, Skeleton } from '../../components/ui';

const LEVELS = [
  ['info', 'News', 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'],
  ['success', 'Good news', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'],
  ['warn', 'Important', 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'],
  ['error', 'Urgent', 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'],
];

/** /admin/notices — a message in the customers' bell: to everybody, or to one account. */
export default function AdminNotices() {
  const empty = { to: 'all', email: '', level: 'info', title: '', body: '', link: '' };
  const [f, setF] = useState(empty);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/admin/notices').then(setList).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/admin/notices', { method: 'POST', body: { to: f.to === 'all' ? 'all' : f.email, level: f.level, title: f.title, body: f.body, link: f.link } });
      toast.success(f.to === 'all' ? 'Sent to everybody' : `Sent to ${f.email}`, { description: 'It is in their bell now.' });
      setF(empty);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n) => {
    try {
      await api(`/admin/notices/${n.id}`, { method: 'DELETE' });
      toast.success('Notice removed from every bell');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader icon={Megaphone} title="Notices" subtitle="A message in your customers' notification bell — news, a maintenance window, an offer, or a note to one account" />

      <form onSubmit={send} className="card space-y-4 p-6">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
          <div>
            <span className="label">Send to</span>
            <div className="flex rounded-xl border border-slate-200 p-0.5 dark:border-white/10">
              {[['all', 'Everybody'], ['one', 'One account']].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setF((x) => ({ ...x, to: k }))} className={cn('flex-1 rounded-lg px-2 py-1.5 text-sm font-semibold transition', f.to === k ? 'bg-indigo-600 text-white' : 'text-slate-500')}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {f.to === 'one' ? (
            <div>
              <label htmlFor="nemail" className="label">Their login email</label>
              <input id="nemail" type="email" required className="input" placeholder="customer@example.com" value={f.email} onChange={set('email')} />
            </div>
          ) : (
            <div>
              <span className="label">Kind</span>
              <div className="flex flex-wrap gap-1.5">
                {LEVELS.map(([k, label, cls]) => (
                  <button key={k} type="button" onClick={() => setF((x) => ({ ...x, level: k }))} className={cn('rounded-full px-3 py-1 text-xs font-bold ring-2 transition', cls, f.level === k ? 'ring-indigo-500' : 'ring-transparent opacity-70')}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="ntitle" className="label">Title</label>
          <input id="ntitle" required maxLength={160} className="input" placeholder="e.g. New: Google Sheet sync on the Pro plan" value={f.title} onChange={set('title')} />
        </div>
        <div>
          <label htmlFor="nbody" className="label">Message (optional)</label>
          <textarea id="nbody" rows={3} maxLength={2000} className="input" value={f.body} onChange={set('body')} />
        </div>
        <div>
          <label htmlFor="nlink" className="label">Opens when clicked (optional)</label>
          <input id="nlink" className="input" placeholder="/billing · /search · https://…" value={f.link} onChange={set('link')} />
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}><Send className="h-4 w-4" /> Send</Button>
        </div>
      </form>

      <section>
        <h2 className="mb-3 font-display text-lg font-bold">Sent</h2>
        {!list ? (
          <Skeleton className="h-32" />
        ) : !list.length ? (
          <p className="text-sm text-slate-500">No notices yet.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((n) => (
              <li key={n.id} className="card flex items-start gap-3 p-4">
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', (LEVELS.find((l) => l[0] === n.level) || LEVELS[0])[2])}>{(LEVELS.find((l) => l[0] === n.level) || LEVELS[0])[1]}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{n.title}</p>
                  {n.body && <p className="mt-0.5 whitespace-pre-line text-sm text-slate-500">{n.body}</p>}
                  <p className="mt-1 text-xs text-slate-400">To {n.to} · {timeAgo(n.at)} · by {n.by}{n.link ? ` · opens ${n.link}` : ''}</p>
                </div>
                <button type="button" onClick={() => remove(n)} title="Remove from every bell" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
