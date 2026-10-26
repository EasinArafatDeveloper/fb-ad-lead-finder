import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { MailCheck, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ShimmerButton } from '../components/ui';
import { BrandMark } from './Auth';

const LEN = 6;

/**
 * /verify-email — a new account types the 6-digit code from the email. Until then nothing else of the app
 * opens (the server refuses everything but this: requireVerified).
 */
export default function VerifyEmail() {
  const { me, setMe, logout } = useAuth();
  const navigate = useNavigate();
  const [digits, setDigits] = useState(Array(LEN).fill(''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(60); // seconds until "send a new code" (one was just sent at sign-up)
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(me?.user.email || '');
  const boxes = useRef([]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);

  if (!me) return <Navigate to="/login" replace />;
  if (me.user.emailVerified !== false) return <Navigate to="/dashboard" replace />;

  const submit = async (code) => {
    if (code.length !== LEN || busy) return;
    setBusy(true);
    setError('');
    try {
      const out = await api('/auth/verify-code', { method: 'POST', body: { code } });
      setMe(out);
      toast.success('Email confirmed — welcome!');
      navigate('/dashboard?welcome=1', { replace: true });
    } catch (e) {
      setError(e.message);
      setDigits(Array(LEN).fill(''));
      boxes.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };
  const type = (i, v) => {
    const only = v.replace(/\D/g, '');
    if (only.length > 1) {
      // pasted the whole code
      const next = only.slice(0, LEN).split('');
      const full = [...next, ...Array(LEN).fill('')].slice(0, LEN);
      setDigits(full);
      boxes.current[Math.min(next.length, LEN - 1)]?.focus();
      if (next.length === LEN) submit(next.join(''));
      return;
    }
    const next = [...digits];
    next[i] = only;
    setDigits(next);
    if (only && i < LEN - 1) boxes.current[i + 1]?.focus();
    if (next.every(Boolean)) submit(next.join(''));
  };
  const resend = async () => {
    try {
      await api('/auth/verify/resend', { method: 'POST' });
      toast.success(`A new code was sent to ${me.user.email}`);
      setWait(60);
      setError('');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const changeEmail = async (e) => {
    e.preventDefault();
    try {
      const out = await api('/auth/change-email', { method: 'POST', body: { email } });
      setMe(out);
      setEditing(false);
      setWait(60);
      setDigits(Array(LEN).fill(''));
      toast.success(`Code sent to ${out.user.email}`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-50 p-4 dark:bg-slate-950">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-400/25 blur-3xl" />
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <BrandMark size={44} />
          <span className="font-display text-xl font-extrabold tracking-tight">FB Lead Finder</span>
        </div>
        <div className="card p-7 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <MailCheck className="h-7 w-7" aria-hidden="true" />
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold tracking-tight">Check your email</h1>
          {!editing ? (
            <p className="mt-2 text-sm text-slate-500">
              We sent a 6-digit code to <b className="text-slate-800 dark:text-slate-100">{me.user.email}</b>
              <button type="button" onClick={() => setEditing(true)} className="ml-1.5 inline-flex items-center gap-1 font-semibold text-indigo-600 hover:underline">
                <Pencil className="h-3 w-3" /> wrong email?
              </button>
            </p>
          ) : (
            <form onSubmit={changeEmail} className="mt-3 flex gap-2 text-left">
              <input type="email" required className="input flex-1" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Your email" autoFocus />
              <Button type="submit" variant="primary">Send code</Button>
            </form>
          )}

          <div className="mt-6 flex justify-center gap-2" onPaste={(e) => { e.preventDefault(); type(0, e.clipboardData.getData('text')); }}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => (boxes.current[i] = el)}
                value={d}
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                maxLength={i === 0 ? LEN : 1}
                aria-label={`Digit ${i + 1}`}
                onChange={(e) => type(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus();
                }}
                className="h-14 w-11 rounded-xl border border-slate-300 bg-white text-center font-display text-2xl font-extrabold tabular-nums outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-white/15 dark:bg-slate-900"
              />
            ))}
          </div>
          {error && <p role="alert" className="mt-3 text-sm font-semibold text-rose-600">{error}</p>}

          <ShimmerButton type="button" disabled={busy || digits.some((x) => !x)} onClick={() => submit(digits.join(''))} className="mt-6 w-full">
            {busy ? 'Checking…' : 'Confirm my email'}
          </ShimmerButton>

          <p className="mt-5 text-sm text-slate-500">
            Didn't get it? Check the spam folder, or{' '}
            {wait > 0 ? (
              <span className="text-slate-400">send a new code in {wait}s</span>
            ) : (
              <button type="button" onClick={resend} className="font-semibold text-indigo-600 hover:underline">send a new code</button>
            )}
          </p>
          <button type="button" onClick={logout} className="mt-4 text-xs text-slate-400 hover:text-slate-600">Log out</button>
        </div>
      </motion.div>
    </div>
  );
}
