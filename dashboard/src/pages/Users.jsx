import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, KeyRound, Plus, Trash2, UserCog } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatNumber, timeAgo } from '../lib/utils';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton } from '../components/ui';

function NewUserModal({ open, onClose, onCreated }) {
  const empty = { name: '', email: '', password: '', role: 'member', searchesPerDay: 20 };
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
      const u = await api('/admin/users', { method: 'POST', body: { ...f, searchesPerDay: Number(f.searchesPerDay) } });
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
            <label htmlFor="nu-limit" className="label">Searches per day</label>
            <input id="nu-limit" type="number" min={0} max={1000} className="input" value={f.searchesPerDay} onChange={set('searchesPerDay')} />
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

export default function Users() {
  const { me } = useAuth();
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState(null);
  const [del, setDel] = useState(null);

  const load = () => api('/admin/users').then(setUsers).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);

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
        title="Users"
        subtitle="Everybody who can log in. Each user has their own workspace — they never see each other's leads."
        actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> New user</Button>}
      />
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
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3 text-right">Leads</th>
                <th className="px-4 py-3">Searches today / limit</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me.user.id;
                return (
                  <tr key={u.id} className="border-b border-slate-50 last:border-0 dark:border-white/5">
                    <td className="px-4 py-3">
                      <div className="font-semibold">{u.name}{self && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                      {u.disabled && <Badge tone="rose" className="mt-1 px-2 py-0 text-[10px]">Disabled</Badge>}
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
                          key={`${u.id}-${u.searchesPerDay}`}
                          type="number"
                          min={0}
                          max={1000}
                          aria-label={`Daily search limit of ${u.email}`}
                          defaultValue={u.searchesPerDay}
                          onBlur={(e) => Number(e.target.value) !== u.searchesPerDay && patch(u, { searchesPerDay: Number(e.target.value) }, 'Limit saved')}
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
