import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Receipt, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, formatNumber, timeAgo } from '../../lib/utils';
import { Button, EmptyState, Modal, PageHeader, Skeleton } from '../../components/ui';

const TABS = [
  ['pending', 'Waiting for payment'],
  ['paid', 'Paid'],
  ['canceled', 'Canceled'],
  ['', 'All'],
];

/** /admin/orders — until a payment gateway is connected, the team confirms payments here. */
export default function AdminOrders() {
  const [tab, setTab] = useState('pending');
  const [orders, setOrders] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [ref, setRef] = useState('');
  const load = () => api(`/admin/orders${tab ? `?status=${tab}` : ''}`).then(setOrders).catch((e) => toast.error(e.message));
  useEffect(() => {
    setOrders(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const paid = async () => {
    const o = confirm;
    try {
      const r = await api(`/admin/orders/${o.id}/paid`, { method: 'POST', body: { ref } });
      toast.success(`Paid — ${r.invoiceNo}`, { description: `${formatNumber(o.credits)} credits added to ${o.email}` });
      setConfirm(null);
      setRef('');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const cancel = async (o) => {
    try {
      await api(`/admin/orders/${o.id}/cancel`, { method: 'POST' });
      toast.success('Order canceled');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div>
      <PageHeader icon={Receipt} title="Orders" subtitle="No payment gateway yet: when a customer's money arrives (bank, bKash …), mark the order paid — the plan starts and the credits arrive at once" />
      <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-white/10 dark:bg-slate-900" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold transition', tab === k ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-white')}>
            {label}
          </button>
        ))}
      </div>
      {!orders ? (
        <Skeleton className="h-64" />
      ) : !orders.length ? (
        <EmptyState icon={Receipt} title="No orders here" text={tab === 'pending' ? 'Nothing waiting for payment.' : ''} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">What</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-slate-50 last:border-0 dark:border-white/5">
                  <td className="px-4 py-3">
                    <div className="font-semibold">{o.userName || '—'}</div>
                    <div className="text-xs text-slate-500">{o.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{o.name}</div>
                    <div className="text-xs text-slate-500">{formatNumber(o.credits)} credits{o.invoiceNo ? ` · ${o.invoiceNo}` : ''}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">${formatNumber(o.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold', o.status === 'paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : o.status === 'pending' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
                      {o.status}
                    </span>
                    {o.paidBy && <div className="mt-1 text-[11px] text-slate-400">by {o.paidBy}</div>}
                    {o.cancelReason && <div className="mt-1 text-[11px] text-slate-400">{o.cancelReason}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(o.paidAt || o.createdAt)}</td>
                  <td className="px-4 py-3">
                    {o.status === 'pending' && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="primary" onClick={() => setConfirm(o)}><CheckCircle2 className="h-3.5 w-3.5" /> Mark paid</Button>
                        <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => cancel(o)} title="Cancel"><XCircle className="h-3.5 w-3.5" /></Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Mark this order paid?"
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" onClick={paid}><CheckCircle2 className="h-4 w-4" /> Yes, the money arrived</Button>
          </>
        }
      >
        {confirm && (
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <p><b>{confirm.email}</b> — {confirm.name}, <b>${formatNumber(confirm.amount)}</b></p>
            <p className="mt-2">{formatNumber(confirm.credits)} credits are added{confirm.kind === 'plan' ? ' and the plan starts for 30 days' : ''}, and an invoice number is made. This can't be undone.</p>
            <label htmlFor="ref" className="label mt-4">Payment reference (optional)</label>
            <input id="ref" className="input" placeholder="e.g. bKash TrxID, bank transfer note" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
        )}
      </Modal>
    </div>
  );
}
