import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { api } from '../lib/api';
import { ShimmerButton } from '../components/ui';
import { FolderIcon, SheetIcon } from '../components/FileIcons';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); // login | signup
  const [signupOpen, setSignupOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/config').then((c) => setSignupOpen(!!c.signup)).catch(() => {});
  }, []);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const me = await api(mode === 'login' ? '/auth/login' : '/auth/signup', { method: 'POST', body: f });
      onLogin(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === 'signup';
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
          <h1 className="font-display text-2xl font-extrabold tracking-tight">{signup ? 'Create your account' : 'FB Ad Lead Finder'}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {signup ? 'Find businesses that are running ads right now.' : 'Log in to your workspace.'}
          </p>

          {signup && (
            <>
              <label htmlFor="name" className="label mt-6">Name</label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input id="name" className="input pl-9" autoComplete="name" value={f.name} onChange={set('name')} />
              </div>
            </>
          )}

          <label htmlFor="email" className="label mt-6">Email</label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input id="email" type="email" autoComplete="email" className="input pl-9" value={f.email} onChange={set('email')} autoFocus required />
          </div>

          <label htmlFor="password" className="label mt-4">Password</label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              id="password"
              type={show ? 'text' : 'password'}
              autoComplete={signup ? 'new-password' : 'current-password'}
              className="input pl-9 pr-10"
              value={f.password}
              onChange={set('password')}
              minLength={signup ? 8 : undefined}
              required
              aria-invalid={!!error}
              aria-describedby={error ? 'login-err' : undefined}
            />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-600">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {signup && <p className="mt-1.5 text-xs text-slate-500">At least 8 characters.</p>}
          {error && <p id="login-err" role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}

          <ShimmerButton type="submit" disabled={busy || !f.email.trim() || !f.password} className="mt-6 w-full">
            {busy ? 'Please wait…' : signup ? 'Create account' : 'Log in'}
          </ShimmerButton>

          {signupOpen && (
            <p className="mt-5 text-center text-sm text-slate-500">
              {signup ? 'Already have an account? ' : 'New here? '}
              <button type="button" className="font-semibold text-indigo-600 hover:underline" onClick={() => { setMode(signup ? 'login' : 'signup'); setError(''); }}>
                {signup ? 'Log in' : 'Create an account'}
              </button>
            </p>
          )}
          {!signupOpen && !signup && <p className="mt-5 text-center text-xs text-slate-400">No account? Ask the admin to create one for you.</p>}
        </form>
      </motion.div>
    </div>
  );
}
