import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, KeyRound, Plus, Trash2, UserCog } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatNumber, timeAgo } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton } from '../components/ui';

function NewUserModal({ open, onClose, onCreated }) {
  const empty = { name: '', email: '', password: '', role: 'member', searchesPerDay: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setF(empty);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await api('/admin/users', { method: 'POST', body: { ...f, searchesPerDay: f.searchesPerDay === '' ? '' : Number(f.searchesPerDay) } });
      toast.success(`${u.email} created`, { description: 'Send them the email and password yourself.' });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New user" width="max-w-lg">
      <form onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="nu-name" className="label">Name</label>
            <input id="nu-name" className="input" value={f.name} onChange={set('name')} />
          </div>
          <div>
            <label htmlFor="nu-email" className="label">Email</label>
            <input id="nu-email" type="email" required className="input" value={f.email} onChange={set('email')} />
          </div>
          <div>
            <label htmlFor="nu-pw" className="label">Password (8+ characters)</label>
            <input id="nu-pw" type="text" autoComplete="new-password" minLength={8} required className="input" value={f.password} onChange={set('password')} />
          </div>
          <div>
            <label htmlFor="nu-role" className="label">Role</label>
            <select id="nu-role" className="input" value={f.role} onChange={set('role')}>
              <option value="member">Member</option>
              <option value="admin">Admin (manages users and the worker)</option>
            </select>
          </div>
          <div>
            <label htmlFor="nu-limit" className="label">Searches per day (empty = the plan's)</label>
            <input id="nu-limit" type="number" min={0} max={100000} className="input" placeholder="from the plan" value={f.searchesPerDay} onChange={set('searchesPerDay')} />
          </div>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-rose-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Create user</Button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordReset({ user, onClose }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setPw(''), [user]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { password: pw } });
      toast.success('Password changed', { description: `${user.email} was logged out everywhere.` });
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!user} onClose={onClose} title={`New password for ${user?.email || ''}`} width="max-w-md">
      <form onSubmit={submit}>
        <label htmlFor="rp" className="label">New password (8+ characters)</label>
        <input id="rp" type="text" autoComplete="new-password" minLength={8} required className="input" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Add or take credits by hand, with the reason the customer sees in their history. */
function CreditsModal({ user, onClose, onDone }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDelta('');
    setReason('');
  }, [user]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/users/${user.id}/credits`, { method: 'POST', body: { delta: Number(delta), reason } });
      toast.success(`${Number(delta) > 0 ? '+' : ''}${delta} credits for ${user.email}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!user} onClose={onClose} title={`Credits — ${user?.email || ''}`} width="max-w-md">
      <form onSubmit={submit}>
        <p className="text-sm text-slate-500">Now: <b className="text-slate-900 dark:text-white">{user?.unlimited ? 'unlimited' : formatNumber(user?.credits || 0)}</b></p>
        <label htmlFor="cd" className="label mt-4">Add (or take with a minus)</label>
        <input id="cd" type="number" required className="input" placeholder="e.g. 500 or -100" value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus />
        <div className="mt-2 flex gap-1.5">
          {[100, 500, 1000, 5000].map((n) => (
            <button key={n} type="button" onClick={() => setDelta(String(n))} className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-semibold hover:border-indigo-300 dark:border-white/10">+{formatNumber(n)}</button>
          ))}
        </div>
        <label htmlFor="cr" className="label mt-4">Reason (the customer sees it)</label>
        <input id="cr" className="input" placeholder="e.g. Bonus, refund, bKash payment" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!Number(delta)}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

const PLAN_IDS = ['free', 'starter', 'pro', 'agency', 'internal'];

export default function Users() {
  const { me } = useAuth();
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState(null);
  const [del, setDel] = useState(null);
  const [credits, setCredits] = useState(null);
  const [find, setFind] = useState('');

  const load = () => api('/admin/users').then(setUsers).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const setPlan = async (u, plan) => {
    try {
      await api(`/admin/users/${u.id}/plan`, { method: 'PUT', body: { plan, grantCredits: plan !== 'free' && plan !== 'internal' && window.confirm(`Also give ${u.email} this plan's credits now?`) } });
      toast.success(`${u.email} → ${plan}`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const shown = (users || []).filter((u) => !find.trim() || `${u.email} ${u.name}`.toLowerCase().includes(find.trim().toLowerCase()));

  const patch = async (u, body, msg) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      toast.success(msg);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async () => {
    const u = del;
    setDel(null);
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      toast.success(`${u.email} deleted`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div>
      <PageHeader
        icon={UserCog}
        title="Customers"
        subtitle="Every account, its plan and credits. Each one has its own workspace — they never see each other's leads."
        actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> New account</Button>}
      />
      <input className="input mb-4 max-w-xs" placeholder="Find by email or name" aria-label="Find a customer" value={find} onChange={(e) => setFind(e.target.value)} />
      {!users ? (
        <Skeleton className="h-64" />
      ) : !users.length ? (
        <EmptyState icon={UserCog} title="No users" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 dark:border-white/10">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3 text-right">Credits</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3 text-right">Leads</th>
                <th className="px-4 py-3">Searches today / limit</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const self = u.id === me.user.id;
                return (
                  <tr key={u.id} className="border-b border-slate-50 last:border-0 dark:border-white/5">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{u.name}{self && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                      {u.phone && <div className="text-xs text-slate-500">{u.phone}{u.country ? ` · ${u.country}` : ''}</div>}
                      <div className="mt-1 flex gap-1">
                        {u.disabled && <Badge tone="rose" className="px-2 py-0 text-[10px]">Disabled</Badge>}
                        {!u.emailVerified && (
                          <button type="button" onClick={() => patch(u, { emailVerified: true }, 'Email marked as confirmed')} title="Mark the email as confirmed">
                            <Badge tone="amber" className="px-2 py-0 text-[10px]">Email not confirmed</Badge>
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select aria-label={`Plan of ${u.email}`} className="input h-8 w-auto py-0 text-xs capitalize" value={u.plan} onChange={(e) => setPlan(u, e.target.value)}>
                        {PLAN_IDS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {u.planStatus}{u.periodEnd ? ` · until ${new Date(u.periodEnd).toLocaleDateString()}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => setCredits(u)} className="rounded-lg px-2 py-1 font-bold tabular-nums hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-500/10" title="Add or take credits">
                        {u.unlimited ? '∞' : formatNumber(u.credits)}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`Role of ${u.email}`}
                        className="input h-8 w-auto py-0 text-xs"
                        value={u.role}
                        disabled={self}
                        onChange={(e) => patch(u, { role: e.target.value }, 'Role changed')}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatNumber(u.leads)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-slate-500">{u.searchesToday} /</span>
                        <input
                          key={`${u.id}-${u.ownLimit}`}
                          type="number"
                          min={0}
                          max={100000}
                          aria-label={`Daily search limit of ${u.email}`}
                          title="Empty = the plan's limit"
                          placeholder={String(u.searchesPerDay)}
                          defaultValue={u.ownLimit ?? ''}
                          onBlur={(e) => e.target.value !== String(u.ownLimit ?? '') && patch(u, { searchesPerDay: e.target.value === '' ? '' : Number(e.target.value) }, 'Limit saved')}
                          className="input h-8 w-20 py-0 text-xs"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setReset(u)} title="Set a new password"><KeyRound className="h-3.5 w-3.5" /></Button>
                        {!self && (
                          <Button size="sm" variant="ghost" onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'Enabled' : 'Disabled — logged out everywhere')} title={u.disabled ? 'Enable' : 'Disable'}>
                            {u.disabled ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Ban className="h-3.5 w-3.5 text-amber-600" />}
                          </Button>
                        )}
                        {!self && (
                          <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDel(u)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <NewUserModal open={adding} onClose={() => setAdding(false)} onCreated={load} />
      <CreditsModal user={credits} onClose={() => setCredits(null)} onDone={load} />
      <PasswordReset user={reset} onClose={() => setReset(null)} />
      <Modal
        open={!!del}
        onClose={() => setDel(null)}
        title={`Delete ${del?.email || ''}?`}
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setDel(null)}>Cancel</Button>
            <Button variant="danger" onClick={remove}><Trash2 className="h-4 w-4" /> Delete user</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The account and its whole workspace — {formatNumber(del?.leads || 0)} leads, projects, sheets and searches — are deleted. This cannot be undone.
          To only block the login, use <b>Disable</b> instead.
        </p>
      </Modal>
    </div>
  );
}
