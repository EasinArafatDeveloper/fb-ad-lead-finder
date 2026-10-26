import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, Eye, EyeOff, Gift, Lock, Mail, User } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ShimmerButton } from '../components/ui';
import PhoneField from '../components/PhoneField';

export function BrandMark({ size = 36 }) {
  return <img src="/favicon.png" alt="" width={size} height={size} className="shrink-0 rounded-[22%] shadow-lg shadow-indigo-500/25" />;
}

const TEXT = {
  login: ['Welcome back', 'Log in to your account.', 'Log in'],
  signup: ['Create your account', 'Find businesses that run Facebook & Instagram ads right now — with their phone and email.', 'Create free account'],
  forgot: ['Forgot your password?', 'Enter your email — we send you a link to choose a new one.', 'Send me the link'],
  reset: ['Choose a new password', 'At least 8 characters.', 'Save and log in'],
};

/** /login · /signup · /forgot · /reset-password */
export default function Auth({ mode, onLogin }) {
  const { me } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [signupOpen, setSignupOpen] = useState(null);
  const [freeCredits, setFreeCredits] = useState(null);
  const [f, setF] = useState({ firstName: '', lastName: '', country: '', phone: '', email: '', password: '' });
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/public/plans')
      .then((p) => {
        setSignupOpen(!!p.signupOpen);
        if (p.country) setF((x) => (x.country ? x : { ...x, country: p.country }));
        setFreeCredits(p.plans.find((x) => x.id === 'free')?.credits ?? null);
      })
      .catch(() => setSignupOpen(false));
  }, []);
  useEffect(() => {
    setError('');
    setSent(false);
  }, [mode]);

  // only a path on this site: "//evil.com" or "/\evil.com" would leave it (open redirect)
  const next = /^\/(?![/\\])/.test(params.get('next') || '') ? params.get('next') : '/dashboard';
  if (me && (mode === 'login' || mode === 'signup')) return <Navigate to={next} replace />;

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'forgot') {
        await api('/auth/forgot', { method: 'POST', body: { email: f.email } });
        setSent(true);
      } else if (mode === 'reset') {
        const out = await api('/auth/reset', { method: 'POST', body: { token: params.get('token'), password: f.password } });
        onLogin(out);
        navigate('/dashboard', { replace: true });
      } else {
        const out = await api(mode === 'login' ? '/auth/login' : '/auth/signup', { method: 'POST', body: f });
        onLogin(out);
        // a new account confirms its email with the code first (/verify-email), then the dashboard
        navigate(mode === 'signup' ? '/verify-email' : next, { replace: true });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const [title, sub, button] = TEXT[mode];
  const needsPassword = mode !== 'forgot';
  const needsEmail = mode !== 'reset';
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-slate-50 p-4 dark:bg-slate-950">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-400/25 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-cyan-400/20 blur-3xl" />

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} className="relative w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center justify-center gap-3">
          <BrandMark size={44} />
          <span className="font-display text-xl font-extrabold tracking-tight">FB Lead Finder</span>
        </Link>

        {mode === 'signup' && signupOpen === false ? (
          <div className="card p-7 text-center">
            <h1 className="font-display text-xl font-extrabold">Sign-up opens soon</h1>
            <p className="mt-2 text-sm text-slate-500">We are getting ready for new customers. Already have an account?</p>
            <Link to="/login" className="mt-5 inline-block font-semibold text-indigo-600 hover:underline">Log in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="card p-7">
            <h1 className="font-display text-2xl font-extrabold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{sub}</p>

            {mode === 'signup' && freeCredits > 0 && (
              <p className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                <Gift className="h-4 w-4" aria-hidden="true" /> {freeCredits} free credits — no card needed
              </p>
            )}
            {mode === 'login' && params.get('verify') === 'expired' && (
              <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">That confirmation link has expired. Log in and ask for a new one.</p>
            )}

            {sent ? (
              <p className="mt-6 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                If {f.email} has an account, the link is on its way. Check your inbox (and the spam folder).
              </p>
            ) : (
              <>
                {mode === 'signup' && (
                  <>
                    <div className="mt-6 grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="first" className="label">First name</label>
                        <div className="relative">
                          <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                          <input id="first" className="input pl-9" autoComplete="given-name" value={f.firstName} onChange={set('firstName')} required autoFocus />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="last" className="label">Last name</label>
                        <input id="last" className="input" autoComplete="family-name" value={f.lastName} onChange={set('lastName')} required />
                      </div>
                    </div>
                    <PhoneField country={f.country} onCountry={(v) => setF((x) => ({ ...x, country: v }))} phone={f.phone} onPhone={(v) => setF((x) => ({ ...x, phone: v }))} />
                  </>
                )}
                {needsEmail && (
                  <>
                    <label htmlFor="email" className={mode === 'signup' ? 'label mt-4' : 'label mt-6'}>Email</label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                      <input id="email" type="email" autoComplete="email" className="input pl-9" value={f.email} onChange={set('email')} autoFocus={mode !== 'signup'} required />
                    </div>
                  </>
                )}
                {needsPassword && (
                  <>
                    <div className="mt-4 flex items-end justify-between">
                      <label htmlFor="password" className="label mb-1.5">{mode === 'reset' ? 'New password' : 'Password'}</label>
                      {mode === 'login' && <Link to="/forgot" className="mb-1.5 text-xs font-semibold text-indigo-600 hover:underline">Forgot it?</Link>}
                    </div>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                      <input
                        id="password"
                        type={show ? 'text' : 'password'}
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        className="input pl-9 pr-10"
                        value={f.password}
                        onChange={set('password')}
                        minLength={mode === 'login' ? undefined : 8}
                        required
                        autoFocus={mode === 'reset'}
                        aria-invalid={!!error}
                        aria-describedby={error ? 'auth-err' : undefined}
                      />
                      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-slate-600">
                        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    {mode !== 'login' && <p className="mt-1.5 text-xs text-slate-500">At least 8 characters.</p>}
                  </>
                )}
                {error && <p id="auth-err" role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
                <ShimmerButton type="submit" disabled={busy || (needsEmail && !f.email.trim()) || (needsPassword && !f.password) || (mode === 'signup' && (!f.firstName.trim() || !f.lastName.trim() || !f.country || !f.phone.trim()))} className="mt-6 w-full">
                  {busy ? 'Please wait…' : button}
                </ShimmerButton>
                {mode === 'signup' && (
                  <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-400">
                    By creating an account you agree to our <a href="/privacy.html" className="underline">privacy policy</a>.
                  </p>
                )}
              </>
            )}

            <p className="mt-5 text-center text-sm text-slate-500">
              {mode === 'login' ? (
                signupOpen ? (
                  <>New here? <Link to="/signup" className="font-semibold text-indigo-600 hover:underline">Create a free account</Link></>
                ) : null
              ) : (
                <>Have an account? <Link to="/login" className="font-semibold text-indigo-600 hover:underline">Log in</Link></>
              )}
            </p>
          </form>
        )}
      </motion.div>
    </div>
  );
}
