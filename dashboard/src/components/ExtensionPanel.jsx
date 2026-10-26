import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { api, extensionHere } from '../lib/api';
import { timeAgo } from '../lib/utils';
import { Button, Skeleton } from './ui';
import PcsCard from './PcsCard';

/** Settings → Extension: connect Chrome on this computer, see the computers and keys of this account. */
export default function ExtensionPanel() {
  const [keys, setKeys] = useState(null);
  const load = () => api('/extension/keys').then(setKeys).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const remove = async (k) => {
    try {
      await api(`/extension/keys/${k.id}`, { method: 'DELETE' });
      toast.success('Disconnected — that extension can no longer use your account');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const here = extensionHere();
  return (
    <div className="space-y-6">
      <section className="card flex flex-wrap items-center gap-4 p-6">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/25"><PlugZap className="h-5 w-5" /></span>
        <div className="min-w-[220px] flex-1">
          <h2 className="font-display font-bold">This computer</h2>
          <p className="text-sm text-slate-500">{here ? `The extension is installed here (v${here}).` : 'The extension is not installed in this browser.'} Your searches run in the Chrome that is connected to your account.</p>
        </div>
        <Link to="/connect-extension"><Button variant="primary"><PlugZap className="h-4 w-4" /> Connect this computer</Button></Link>
      </section>

      <PcsCard />

      <section className="card p-6">
        <h2 className="mb-1 flex items-center gap-2 font-display font-bold"><KeyRound className="h-4 w-4 text-indigo-500" /> Connected extensions</h2>
        <p className="mb-4 text-sm text-slate-500">Each one has its own key that works only for your account. Remove one you no longer use (an old computer, a lost laptop).</p>
        {!keys ? (
          <Skeleton className="h-16" />
        ) : !keys.length ? (
          <p className="text-sm text-slate-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <KeyRound className="h-4 w-4 text-slate-400" />
                <span className="flex-1">
                  <b>{k.label || 'Chrome'}</b> <span className="font-mono text-xs text-slate-400">…{k.hint}</span>
                  <span className="block text-xs text-slate-500">connected {timeAgo(k.createdAt)} · {k.lastUsed ? `last used ${timeAgo(k.lastUsed)}` : 'not used yet'}</span>
                </span>
                <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(k)}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
