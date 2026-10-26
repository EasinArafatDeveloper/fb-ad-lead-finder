import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Coins, CreditCard, History, Receipt, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useStats } from '../components/Layout';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Button, Modal, PageHeader, Skeleton } from '../components/ui';

const money = (n, c = 'USD') => (c === 'USD' ? `$${formatNumber(n)}` : `${formatNumber(n)} ${c}`);
const STATUS = {
  trial: ['Free trial', 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'],
  active: ['Active', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'],
  expired: ['Ended — renew to keep the limits', 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'],
};
const KIND = { usage: 'Used', grant: 'Gift', plan: 'Plan', purchase: 'Bought', adjust: 'Adjusted' };

/** /billing — the customer's plan, credits, history and orders. */
export default function Billing() {
  const { refreshMe } = useAuth();
  const { refresh } = useStats();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null); // { order, message }
  const load = () => api('/billing').then(setD).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);

  const buy = async (kind, id) => {
    setBusy(`${kind}:${id}`);
    try {
      const r = await api('/billing/checkout', { method: 'POST', body: { kind, id } });
      if (r.url) window.location.href = r.url; // a payment gateway takes over
      else setResult(r);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const cancel = async (o) => {
    try {
      await api(`/billing/orders/${o.id}/cancel`, { method: 'POST' });
      toast.success('Order canceled');
      load();
      refresh();
      refreshMe?.();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!d) return <Skeleton className="h-96" />;
  const a = d.account;
  const [statusText, statusCls] = STATUS[a.planStatus] || STATUS.trial;
  const pending = d.orders.find((o) => o.status === 'pending');

  return (
    <div className="space-y-8">
      <PageHeader icon={CreditCard} title="Billing" subtitle="Your plan and credits — 1 credit = 1 Facebook Page read" />

      {/* balance + plan */}
      <div className="grid gap-5 md:grid-cols-3">
        <div className="card relative overflow-hidden p-6 md:col-span-1">
          <span aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-indigo-500/10 blur-2xl" />
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-500"><Coins className="h-4 w-4" /> Credits left</p>
          <p className={cn('mt-2 font-display text-5xl font-extrabold tabular-nums', !a.unlimited && a.credits <= 0 && 'text-rose-600')}>{a.unlimited ? '∞' : formatNumber(a.credits)}</p>
          <p className="mt-1 text-xs text-slate-500">
            {a.unlimited
              ? 'Unlimited (team account)'
              : a.credits < 0
                ? `Running on credit — a running search may go down to -${a.overdraft}. The minus is paid back from your next credits.`
                : `pages you can still have read · a running search may go down to -${a.overdraft}`}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm dark:border-white/10">
            <div><p className="text-xs text-slate-500">Used today</p><p className="font-bold tabular-nums">{formatNumber(d.usage.today)}</p></div>
            <div><p className="text-xs text-slate-500">This month</p><p className="font-bold tabular-nums">{formatNumber(d.usage.month)}</p></div>
          </div>
        </div>
        <div className="card p-6 md:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-500">Your plan</p>
              <p className="mt-1 font-display text-3xl font-extrabold">{a.planName}</p>
            </div>
            <span className={cn('rounded-full px-3 py-1 text-xs font-bold', statusCls)}>{statusText}</span>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ['Searches a day', formatNumber(a.searchesPerDay)],
              ['Ads per search', formatNumber(a.maxAdsPerSearch)],
              [a.periodEnd ? (a.planStatus === 'expired' ? 'Ended' : 'Renews / ends') : 'Period', a.periodEnd ? new Date(a.periodEnd).toLocaleDateString() : '—'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-white/5">
                <p className="text-xs text-slate-500">{k}</p>
                <p className="mt-0.5 font-bold">{v}</p>
              </div>
            ))}
          </div>
          {pending && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <Receipt className="h-4 w-4 shrink-0" />
              <span className="flex-1">Order waiting for payment: <b>{pending.name}</b> — {money(pending.amount, pending.currency)}</span>
              <button type="button" onClick={() => cancel(pending)} className="text-xs font-semibold underline">Cancel order</button>
            </div>
          )}
        </div>
      </div>

      {/* plans */}
      {!a.unlimited && (
        <section>
          <h2 className="mb-4 font-display text-lg font-bold">Plans</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {d.plans.filter((p) => p.price > 0).map((p) => {
              const current = a.plan === p.id && a.planStatus === 'active';
              return (
                <div key={p.id} className={cn('flex flex-col rounded-2xl border bg-white p-5 dark:bg-slate-900', p.popular ? 'border-indigo-400 ring-2 ring-indigo-500/15' : 'border-slate-200 dark:border-white/10')}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-display font-bold">{p.name}</h3>
                    {p.popular && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">Popular</span>}
                  </div>
                  <p className="mt-2"><span className="font-display text-3xl font-extrabold">{money(p.price, d.currency)}</span><span className="text-xs text-slate-500"> / {d.periodDays} days</span></p>
                  <ul className="mt-3 flex-1 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
                    {[`${formatNumber(p.credits)} credits`, `${formatNumber(p.searchesPerDay)} searches a day`, `Up to ${formatNumber(p.maxAdsPerSearch)} ads per search`, ...p.features.slice(1)].map((x) => (
                      <li key={x} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />{x}</li>
                    ))}
                    {(p.perks || []).map((k) => (
                      <li key={k.key} className={cn('flex gap-2', !k.on && 'text-slate-400 dark:text-slate-500')}>
                        {k.on ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <X className="mt-0.5 h-4 w-4 shrink-0" aria-label="Not included" />}
                        {k.name}
                      </li>
                    ))}
                  </ul>
                  <Button variant={p.popular ? 'primary' : undefined} className="mt-4 w-full" loading={busy === `plan:${p.id}`} onClick={() => buy('plan', p.id)}>
                    {current ? 'Renew for another period' : a.plan === p.id ? 'Renew' : 'Choose ' + p.name}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* packs */}
      {!a.unlimited && d.packs.length > 0 && (
        <section>
          <h2 className="mb-1 font-display text-lg font-bold">Credit packs</h2>
          <p className="mb-4 text-sm text-slate-500">One-off — added on top of your plan, they stay on your account.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {d.packs.map((k) => (
              <div key={k.id} className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-slate-900">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/15"><Sparkles className="h-5 w-5" /></span>
                <div className="flex-1">
                  <p className="font-bold">{formatNumber(k.credits)} credits</p>
                  <p className="text-xs text-slate-500">{money(k.price, d.currency)} · ${((k.price / k.credits) * 1000).toFixed(2)} per 1,000</p>
                </div>
                <Button size="sm" loading={busy === `pack:${k.id}`} onClick={() => buy('pack', k.id)}>Buy</Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* history */}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 font-display font-bold"><History className="h-4 w-4 text-indigo-500" /> Credit history</h2>
          {!d.ledger.length ? (
            <p className="text-sm text-slate-500">Nothing yet.</p>
          ) : (
            <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto pr-1 dark:divide-white/5">
              {d.ledger.map((l) => (
                <li key={l.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className={cn('w-16 shrink-0 text-right font-bold tabular-nums', l.delta > 0 ? 'text-emerald-600' : l.delta < 0 ? 'text-rose-600' : 'text-slate-400')}>
                    {l.delta > 0 ? '+' : ''}{formatNumber(l.delta)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={l.reason}>
                    <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-500 dark:bg-white/10">{KIND[l.kind] || l.kind}</span>
                    {l.reason}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{timeAgo(l.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 font-display font-bold"><Receipt className="h-4 w-4 text-indigo-500" /> Orders & invoices</h2>
          {!d.orders.length ? (
            <p className="text-sm text-slate-500">No orders yet.</p>
          ) : (
            <ul className="space-y-2">
              {d.orders.map((o) => (
                <li key={o.id} className="flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2.5 text-sm dark:border-white/10">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{o.name}</p>
                    <p className="text-xs text-slate-500">{o.invoiceNo || 'No invoice yet'} · {new Date(o.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className="font-bold tabular-nums">{money(o.amount, o.currency)}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', o.status === 'paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : o.status === 'pending' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
                    {o.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Modal
        open={!!result}
        onClose={() => setResult(null)}
        title="Order saved"
        width="max-w-md"
        footer={<Button variant="primary" onClick={() => setResult(null)}>OK</Button>}
      >
        {result && (
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <p className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
              <Check className="h-4 w-4 text-emerald-500" /> {result.order.name} — {money(result.order.amount, result.order.currency)}
            </p>
            <p className="mt-3">{result.message}</p>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400"><X className="h-3 w-3" /> You can cancel it any time on this page.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
