import { useState } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Eye, EyeOff } from 'lucide-react';
import { api, setKey } from '../lib/api';
import { ShimmerButton } from '../components/ui';
import { FolderIcon, SheetIcon } from '../components/FileIcons';

export default function Login({ onLogin }) {
  const [key, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setKey(key.trim());
    try {
      await api('/stats');
      onLogin();
    } catch {
      setKey('');
      setError('Wrong API key. Use the API_KEY from server/.env.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-50 p-4 dark:bg-slate-950">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-400/25 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-cyan-400/20 blur-3xl" />

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} className="relative w-full max-w-md">
        <div className="mb-6 flex items-end justify-center gap-1">
          <FolderIcon size={72} peek />
          <SheetIcon size={60} />
        </div>
        <form onSubmit={submit} className="card p-7">
          <h1 className="font-display text-2xl font-extrabold tracking-tight">FB Ad Lead Finder</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">All your leads from the Ad Library in one place.</p>

          <label htmlFor="key" className="label mt-6">API key</label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              id="key"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              className="input pl-9 pr-10"
              value={key}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? 'key-err' : undefined}
              autoFocus
            />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide key' : 'Show key'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-600">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {error && <p id="key-err" role="alert" className="mt-2 text-sm text-rose-600">{error}</p>}

          <ShimmerButton type="submit" disabled={busy || !key.trim()} className="mt-6 w-full">
            {busy ? 'Checking…' : 'Login'}
          </ShimmerButton>
        </form>
      </motion.div>
    </div>
  );
}
