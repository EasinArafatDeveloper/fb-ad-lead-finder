import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, DollarSign, Plus, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button, PageHeader, Skeleton } from '../../components/ui';

function PlanCard({ plan, perkNames = {}, onSave }) {
  const [f, setF] = useState(() => ({ ...plan, features: (plan.features || []).join('\n') }));
  const dirty = JSON.stringify({ ...plan, features: (plan.features || []).join('\n') }) !== JSON.stringify(f);
  const set = (k, num) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : num ? e.target.value : e.target.value }));
  const field = (k, label, props = {}) => (
    <div>
      <label className="label" htmlFor={`${plan._id}-${k}`}>{label}</label>
      <input id={`${plan._id}-${k}`} className="input" value={f[k] ?? ''} onChange={set(k, props.type === 'number')} {...props} />
    </div>
  );
  return (
    <div className={cn('card p-5', plan.unlimited && 'opacity-80')}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-lg font-bold">{plan.name} <span className="text-xs font-normal text-slate-400">({plan._id})</span></h3>
        {plan.unlimited ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500 dark:bg-white/10">team · unlimited</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('name', 'Name')}
        {field('price', 'Price (USD / 30 days)', { type: 'number', min: 0, step: '0.01', disabled: plan._id === 'free' || plan.unlimited })}
        {field('credits', plan._id === 'free' ? 'Credits (once, at sign-up)' : 'Credits per period', { type: 'number', min: 0, disabled: plan.unlimited })}
        {field('searchesPerDay', 'Searches per day', { type: 'number', min: 0 })}
        {field('maxAdsPerSearch', 'Max ads per search', { type: 'number', min: 10, max: 50000 })}
        {field('seats', 'Team members', { type: 'number', min: 1 })}
        {field('queueShare', 'Pages per turn in the queue (1–10)', { type: 'number', min: 1, max: 10 })}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Customers take turns while pages are read. With 2 here a customer on this plan gets 2 pages read for every 1 of a
        customer with 1 (free plan default: 1, paid: 2).
      </p>
      {!plan.unlimited && (
        <div className="mt-4 rounded-xl bg-slate-50 p-3 dark:bg-white/5">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Included in this plan</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(perkNames).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={!!f.perks?.[k]} onChange={(e) => setF((x) => ({ ...x, perks: { ...x.perks, [k]: e.target.checked } }))} />
                {label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">CSV export and the lead filters are on every plan. The server checks these — a plan without one shows a lock.</p>
        </div>
      )}
      <label className="label mt-3" htmlFor={`${plan._id}-features`}>Extra lines on the pricing page (one per line)</label>
      <textarea id={`${plan._id}-features`} rows={3} className="input text-sm" value={f.features} onChange={set('features')} />
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        {!plan.unlimited && (
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.public} onChange={set('public')} className="h-4 w-4 accent-indigo-600" /> On the pricing page</label>
        )}
        {!plan.unlimited && plan._id !== 'free' && (
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.popular} onChange={set('popular')} className="h-4 w-4 accent-indigo-600" /> "Most popular"</label>
        )}
        <Button size="sm" variant="primary" className="ml-auto" disabled={!dirty} onClick={() => onSave(plan._id, f)}>Save</Button>
      </div>
    </div>
  );
}

/** /admin/plans — prices, credits and limits; sign-up on/off; payment provider. */
export default function AdminPlans() {
  const [d, setD] = useState(null);
  const [packs, setPacks] = useState([]);
  const load = () =>
    api('/admin/plans')
      .then((x) => {
        setD(x);
        setPacks(x.packs);
      })
      .catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);

  const savePlan = async (id, f) => {
    try {
      await api(`/admin/plans/${id}`, { method: 'PUT', body: { ...f, price: Number(f.price), credits: Number(f.credits), searchesPerDay: Number(f.searchesPerDay), maxAdsPerSearch: Number(f.maxAdsPerSearch), seats: Number(f.seats), queueShare: Number(f.queueShare) || 1 } });
      toast.success('Plan saved', { description: 'The pricing page shows it at once. Customers already on it get the new limits now, the new credits from their next period.' });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const saveSettings = async (body, msg) => {
    try {
      const s = await api('/admin/billing-settings', { method: 'PUT', body });
      setD((x) => ({ ...x, ...s }));
      setPacks(s.packs);
      toast.success(msg);
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!d) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-8">
      <PageHeader icon={DollarSign} title="Plans & prices" subtitle="What customers pay and get — changes show on the home page at once" />

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card flex items-start gap-4 p-5">
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', d.signupOpen ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}><UserPlus className="h-5 w-5" /></span>
          <div className="flex-1">
            <h3 className="font-display font-bold">New sign-ups</h3>
            <p className="text-sm text-slate-500">{d.signupOpen ? 'Open — anybody can create an account on specter.monster.' : 'Closed — only the team can create accounts (Customers → New).'}</p>
          </div>
          <Button variant={d.signupOpen ? undefined : 'primary'} onClick={() => saveSettings({ signupOpen: !d.signupOpen }, d.signupOpen ? 'Sign-up closed' : 'Sign-up is open')}>
            {d.signupOpen ? 'Close' : 'Open sign-up'}
          </Button>
        </div>
        <div className="card flex items-start gap-4 p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15"><CreditCard className="h-5 w-5" /></span>
          <div className="flex-1">
            <h3 className="font-display font-bold">Payment provider</h3>
            <select className="input mt-2" value={d.provider} onChange={(e) => saveSettings({ provider: e.target.value }, 'Payment provider saved')}>
              {d.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <p className="mt-1.5 text-xs text-slate-500">A card gateway (Paddle, Lemon Squeezy, Stripe, SSLCommerz …) is added later in server/src/payments.js — then it appears here.</p>
          </div>
        </div>
      </section>

      <section className="card flex flex-wrap items-start gap-4 p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/15"><CreditCard className="h-5 w-5" /></span>
        <div className="min-w-[240px] flex-1">
          <h3 className="font-display font-bold">Credit below zero (overdraft)</h3>
          <p className="text-sm text-slate-500">
            A search that is already running isn't cut off when the credits run out — it goes on down to <b>-{d.overdraft}</b>, then everything stops.
            New searches always need a balance above 0. The minus is paid back from the customer's next credits.
          </p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveSettings({ overdraft: Number(new FormData(e.currentTarget).get('od')) }, 'Overdraft saved');
          }}
        >
          <span className="text-sm font-semibold text-slate-500">down to −</span>
          <input name="od" type="number" min={0} max={100000} defaultValue={d.overdraft} key={d.overdraft} className="input w-24" aria-label="Overdraft in credits" />
          <Button type="submit">Save</Button>
        </form>
      </section>

      <section>
        <h2 className="mb-4 font-display text-lg font-bold">Plans</h2>
        <div className="grid gap-5 xl:grid-cols-2">
          {d.plans.map((p) => <PlanCard key={`${p._id}-${JSON.stringify(p)}`} plan={p} perkNames={d.perkNames} onSave={savePlan} />)}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-display font-bold">Credit packs</h2>
        <p className="mb-4 text-sm text-slate-500">One-off packs customers can buy on top of their plan.</p>
        <div className="space-y-2">
          {packs.map((k, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_120px_auto] items-center gap-2">
              <input className="input" aria-label="Name" value={k.name} onChange={(e) => setPacks((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
              <input className="input" type="number" aria-label="Credits" value={k.credits} onChange={(e) => setPacks((x) => x.map((y, j) => (j === i ? { ...y, credits: e.target.value } : y)))} />
              <input className="input" type="number" step="0.01" aria-label="Price USD" value={k.price} onChange={(e) => setPacks((x) => x.map((y, j) => (j === i ? { ...y, price: e.target.value } : y)))} />
              <button type="button" onClick={() => setPacks((x) => x.filter((_, j) => j !== i))} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove pack"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_120px_120px_auto] gap-2 px-1 text-[11px] text-slate-400"><span>Name</span><span>Credits</span><span>Price (USD)</span><span /></div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => setPacks((x) => [...x, { id: `pack-${Date.now()}`, name: 'New pack', credits: 1000, price: 10 }])}><Plus className="h-3.5 w-3.5" /> Add a pack</Button>
          <Button size="sm" variant="primary" onClick={() => saveSettings({ packs }, 'Credit packs saved')}>Save packs</Button>
        </div>
      </section>
    </div>
  );
}
