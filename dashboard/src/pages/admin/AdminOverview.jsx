import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, BellRing, CheckCircle2, Coins, DollarSign, FileSearch, Gauge, PlugZap, Receipt, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, formatNumber } from '../../lib/utils';
import { Button, KpiCard, PageHeader, Skeleton } from '../../components/ui';

/** 14 days as small bars — sign-ups, pages read, money. */
function Bars({ data, field, color, label, money }) {
  const max = Math.max(1, ...data.map((d) => d[field]));
  const total = data.reduce((a, d) => a + d[field], 0);
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-500">{label}</h3>
        <span className="font-display text-lg font-extrabold tabular-nums">{money ? '$' : ''}{formatNumber(total)}</span>
      </div>
      <div className="mt-4 flex h-28 items-end gap-1" role="img" aria-label={`${label}: ${total} in 14 days`}>
        {data.map((d) => (
          <div key={d.day} className="group relative flex-1" title={`${d.day}: ${money ? '$' : ''}${d[field]}`}>
            <div className={cn('w-full rounded-t-md transition-all', color)} style={{ height: `${Math.max(2, (d[field] / max) * 112)}px`, opacity: d[field] ? 1 : 0.25 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{data[0]?.day.slice(5)}</span>
        <span>today</span>
      </div>
    </div>
  );
}

const ago = (d) => {
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

/** Who still runs an old Chrome extension — and a reminder in their bell, one click. */
function ExtensionUpdates() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api('/admin/extensions').then(setD).catch((e) => toast.error(e.message));
  }, []);
  const remind = async (body, key) => {
    setBusy(key);
    try {
      const r = await api('/admin/extensions/remind', { method: 'POST', body });
      setD(r);
      toast.success(r.sent ? `Reminder sent to ${r.sent} account${r.sent > 1 ? 's' : ''}` : 'Already reminded in the last hour — nothing sent');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  if (!d) return null;
  const total = d.accounts.length + (d.teamKey.length ? 1 : 0);
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-2 font-display font-bold"><PlugZap className="h-4 w-4 text-indigo-500" /> Extension updates</h3>
        <span className="text-xs text-slate-500">Latest version {d.latest} · computers seen in the last {d.days} days</span>
        {d.accounts.length > 1 && (
          <Button size="sm" className="ml-auto" loading={busy === 'all'} onClick={() => remind({ all: true }, 'all')}>
            <BellRing className="h-3.5 w-3.5" /> Remind everybody
          </Button>
        )}
      </div>
      {!total ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Everybody runs the latest extension.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 text-sm dark:border-white/10">
          <table className="w-full">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-800">
              <tr>
                <th className="px-3 py-2 font-semibold">Account</th>
                <th className="px-3 py-2 font-semibold">Computers on an old version</th>
                <th className="px-3 py-2 font-semibold">Reminder</th>
              </tr>
            </thead>
            <tbody>
              {d.accounts.map((a) => (
                <tr key={a.workspaceId} className="border-t border-slate-100 align-top dark:border-white/5">
                  <td className="px-3 py-2">
                    <span className="block font-semibold">{a.name || a.account || 'Account'}{a.team && <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500 dark:bg-white/10">TEAM</span>}</span>
                    <span className="block text-xs text-slate-500">{a.email}</span>
                  </td>
                  <td className="px-3 py-2">
                    {a.pcs.map((p) => (
                      <span key={p.id} className="block text-xs">
                        <b className="tabular-nums">v{p.version}</b> · {p.name || p.browser} · IP {p.ip || '?'} ·{' '}
                        {p.online ? <span className="font-semibold text-emerald-600">online now</span> : <span className="text-slate-500">seen {ago(p.lastSeen)}</span>}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    <Button size="sm" loading={busy === a.workspaceId} onClick={() => remind({ workspaceId: a.workspaceId }, a.workspaceId)}>
                      <BellRing className="h-3.5 w-3.5" /> Send reminder
                    </Button>
                    {a.remindedAt && <span className="mt-1 block text-[11px] text-slate-500">Reminded {ago(a.remindedAt)}</span>}
                  </td>
                </tr>
              ))}
              {d.teamKey.length > 0 && (
                <tr className="border-t border-slate-100 align-top dark:border-white/5">
                  <td className="px-3 py-2">
                    <span className="block font-semibold">Team computers</span>
                    <span className="block text-xs text-slate-500">the server's worker key — no account to remind</span>
                  </td>
                  <td className="px-3 py-2">
                    {d.teamKey.map((p) => (
                      <span key={p.id} className="block text-xs"><b className="tabular-nums">v{p.version}</b> · {p.name || p.browser} · IP {p.ip || '?'} · {p.online ? 'online now' : `seen ${ago(p.lastSeen)}`}</span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">Update them yourself</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">The reminder lands in their bell (top right) with a link to the download. Each account also sees its own reminder on its Dashboard.</p>
    </section>
  );
}

const PLAN_TONE ={ free: 'bg-sky-400', starter: 'bg-indigo-400', pro: 'bg-violet-500', agency: 'bg-fuchsia-500', internal: 'bg-slate-400' };

/** /admin — the business at a glance. */
export default function AdminOverview() {
  const [d, setD] = useState(null);
  useEffect(() => {
    const load = () => api('/admin/overview').then(setD).catch((e) => toast.error(e.message));
    load();
    const t = setInterval(() => !document.hidden && load(), 30000);
    return () => clearInterval(t);
  }, []);

  if (!d) return <Skeleton className="h-96" />;
  const totalWs = Object.values(d.byPlan).reduce((a, n) => a + n, 0) || 1;
  const links = [
    ['/admin/users', Users, 'Customers', 'Plans, credits, accounts'],
    ['/admin/orders', Receipt, 'Orders', d.pendingOrders ? `${d.pendingOrders} waiting for payment` : 'Payments and invoices'],
    ['/admin/plans', DollarSign, 'Plans & prices', 'Prices, credits, limits, sign-up'],
    ['/settings?tab=proxy', ShieldCheck, 'Engine', 'Proxy IPs, worker, computers'],
    ['/admin/logs', FileSearch, 'Server logs', 'Errors and events'],
  ];
  return (
    <div className="space-y-8">
      <PageHeader icon={Gauge} title="Admin" subtitle="Customers, money and usage — the whole service at a glance" />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Customers" value={d.users} icon={Users} tone="indigo" sub={`${d.signups7} new this week · ${d.active7} searched this week`} />
        <KpiCard label="Monthly recurring (USD)" value={d.mrr} icon={DollarSign} tone="emerald" sub={`$${formatNumber(d.revenueMonth)} paid this month (${d.ordersMonth} orders)`} />
        <KpiCard label="Pages read today" value={d.pagesToday} icon={FileSearch} tone="blue" sub={`${formatNumber(d.pages30)} in the last 30 days`} />
        <KpiCard label="Credits out there" value={d.creditsOutstanding} icon={Coins} tone="amber" sub="Unused credits on customer accounts" />
      </section>

      {d.pendingOrders > 0 && (
        <Link to="/admin/orders" className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <Receipt className="h-5 w-5" /> {d.pendingOrders} order{d.pendingOrders > 1 ? 's are' : ' is'} waiting for payment — confirm them when the money arrives
          <ArrowRight className="ml-auto h-4 w-4" />
        </Link>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <Bars data={d.daily} field="signups" color="bg-indigo-500" label="Sign-ups · 14 days" />
        <Bars data={d.daily} field="pages" color="bg-sky-500" label="Pages read · 14 days" />
        <Bars data={d.daily} field="revenue" color="bg-emerald-500" label="Money in · 14 days" money />
      </section>

      <ExtensionUpdates />

      <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="card p-5">
          <h3 className="flex items-center gap-2 font-display font-bold"><UserPlus className="h-4 w-4 text-indigo-500" /> Accounts by plan</h3>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
            {Object.entries(d.byPlan).map(([p, n]) => <div key={p} className={PLAN_TONE[p] || 'bg-slate-300'} style={{ width: `${(n / totalWs) * 100}%` }} title={`${p}: ${n}`} />)}
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {Object.entries(d.byPlan).sort((a, b) => b[1] - a[1]).map(([p, n]) => (
              <li key={p} className="flex items-center gap-2">
                <span className={cn('h-2.5 w-2.5 rounded-full', PLAN_TONE[p] || 'bg-slate-300')} />
                <span className="flex-1 capitalize">{p}</span>
                <b className="tabular-nums">{formatNumber(n)}</b>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-500">{d.verified} of {d.users} accounts confirmed their email.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {links.map(([to, Icon, t, s]) => (
            <Link key={to} to={to} className="card group flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-lg">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{t}</span>
                <span className="block truncate text-xs text-slate-500">{s}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
