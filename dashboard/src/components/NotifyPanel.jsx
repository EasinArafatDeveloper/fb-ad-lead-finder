import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, CheckCircle2, Mail, Plus, Send, Server, Smartphone, X } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Button, Skeleton } from './ui';

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-white/10')}
    >
      <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}

function Box({ icon: Icon, title, text, right, children }) {
  return (
    <section className="card p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-display font-bold">{title}</h2>
            {text && <p className="text-xs text-slate-500">{text}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Settings → Notifications: an email and a phone/desktop notification when a search is fully done. */
export default function NotifyPanel() {
  const [d, setD] = useState(null);
  const [draft, setDraft] = useState(''); // the address being typed
  const [here, setHere] = useState(null); // this browser's push subscription
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [smtp, setSmtp] = useState(null);
  const [busy, setBusy] = useState('');

  const apply = (r) => {
    setD(r);
    if (r.smtp) setSmtp((s) => s || { ...r.smtp, pass: '' });
  };
  useEffect(() => {
    api('/notify').then(apply).catch((e) => toast.error(e.message));
    if (pushSupported()) navigator.serviceWorker.getRegistration('/').then((reg) => reg?.pushManager.getSubscription()).then((s) => setHere(s || null)).catch(() => {});
  }, []);

  const run = (key, fn) => async () => {
    setBusy(key);
    try {
      await fn();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy('');
    }
  };
  const savePrefs = (patch, msg = 'Saved') =>
    run('prefs', async () => {
      apply(await api('/notify/prefs', { method: 'PUT', body: { ...d.prefs, ...patch } }));
      toast.success(msg);
    })();
  // add one or several ("a@x.com, b@y.com") — the server checks each address
  const addEmails = () => {
    const add = draft.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!add.length) return;
    const list = [...new Set([...d.prefs.to, ...add])];
    savePrefs({ to: list }, `${add.length > 1 ? `${add.length} addresses` : add[0]} added`).then((ok) => ok && setDraft(''));
  };
  const removeEmail = (x) => savePrefs({ to: d.prefs.to.filter((y) => y !== x) }, `${x} removed`);

  const turnOnHere = run('push', async () => {
    if (!pushSupported()) throw new Error('This browser cannot show notifications. On iPhone: Share → Add to Home Screen, then open it from there.');
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p !== 'granted') throw new Error('Notifications are blocked — allow them for this site in the browser (🔒 next to the address).');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(d.vapidPublicKey) }));
    apply(await api('/notify/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }));
    setHere(sub);
    toast.success('Notifications are on for this device');
  });
  const turnOffHere = run('push', async () => {
    if (here) {
      apply(await api('/notify/unsubscribe', { method: 'POST', body: { endpoint: here.endpoint } }));
      await here.unsubscribe().catch(() => {});
    }
    setHere(null);
    toast.success('Notifications are off for this device');
  });
  const test = run('test', async () => {
    const r = await api('/notify/test', { method: 'POST' });
    const parts = [r.email ? `email to ${r.email}` : null, r.push ? `${r.push} notification${r.push > 1 ? 's' : ''}` : null].filter(Boolean);
    if (parts.length) toast.success(`Test sent: ${parts.join(' and ')}`, { description: r.emailError ? `Email: ${r.emailError}` : undefined });
    else toast.error(r.emailError ? `Nothing sent — email: ${r.emailError}` : 'Nothing sent — turn on email or this device first');
  });
  const saveSmtp = run('smtp', async () => {
    apply(await api('/notify/smtp', { method: 'PUT', body: smtp }));
    setSmtp((s) => ({ ...s, pass: '' }));
    toast.success('Email server saved');
  });

  if (!d) return <Skeleton className="h-72" />;
  const setS = (k) => (e) => setSmtp((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="space-y-6">
      {/* what happens */}
      <div className="flex items-start gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/70 px-5 py-4 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-100">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p>
          Start a search and walk away. When it is <b>fully done</b> — ads collected and every page read — you get an <b>email</b> and a <b>notification on your phone or computer</b>,
          with how many leads have a phone or email and a button that opens them. Several searches that finish together come in one message.
        </p>
      </div>

      {/* push */}
      <Box
        icon={Smartphone}
        title="Notifications on this device"
        text="Phone or computer — shows up even when the dashboard is closed"
        right={<Switch checked={d.prefs.push} onChange={(v) => savePrefs({ push: v })} label="Push notifications" />}
      >
        {!d.prefs.push ? (
          <p className="text-sm text-slate-500">Push notifications are off for your account.</p>
        ) : here && perm === 'granted' ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> On for this device
            </span>
            <span className="text-xs text-slate-500">{d.devices} device{d.devices === 1 ? '' : 's'} in total</span>
            <Button size="sm" variant="ghost" onClick={turnOffHere} loading={busy === 'push'}>Turn off here</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={turnOnHere} loading={busy === 'push'}>
              <BellRing className="h-4 w-4" /> Turn on for this device
            </Button>
            <p className="text-xs text-slate-500">
              {perm === 'denied' ? 'Blocked in this browser — click 🔒 next to the address → Notifications → Allow, then try again.' : `The browser asks once. Do it on each phone / computer you want them on.${d.devices ? ` (${d.devices} device${d.devices === 1 ? '' : 's'} already on)` : ''}`}
            </p>
          </div>
        )}
        <p className="mt-3 text-[11px] text-slate-400">Android & computers: Chrome, Edge, Brave or Firefox. iPhone: open the dashboard in Safari → Share → Add to Home Screen, then turn it on from that icon.</p>
      </Box>

      {/* email */}
      <Box icon={Mail} title="Email" text="A short summary with a button to the leads" right={<Switch checked={d.prefs.email} onChange={(v) => savePrefs({ email: v })} label="Email notifications" />}>
        {!d.emailReady && (
          <p className="mb-3 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            {d.isAdmin ? 'Set up the email server below first — until then no email goes out.' : 'An admin has to set up email first (Settings → Notifications).'}
          </p>
        )}
        <div className="mb-1.5 flex items-end justify-between">
          <span className="label mb-0">Send to</span>
          <span className="text-[11px] text-slate-400">{d.prefs.to.length}/10 addresses</span>
        </div>
        <ul className={cn('space-y-1.5', !d.prefs.email && 'opacity-50')}>
          {(d.prefs.to.length ? d.prefs.to : [d.loginEmail]).map((x) => (
            <li key={x} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-white/10 dark:bg-white/5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold uppercase text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">{x[0]}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{x}</span>
              {!d.prefs.to.length ? (
                <span className="text-[11px] text-slate-400">your login email</span>
              ) : (
                <button type="button" onClick={() => removeEmail(x)} disabled={!d.prefs.email || busy === 'prefs'} aria-label={`Remove ${x}`} className="rounded-lg p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="nto"
            type="text"
            inputMode="email"
            className="input min-w-[240px] flex-1"
            placeholder="Add an email — or several, separated by commas"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEmails())}
            disabled={!d.prefs.email || d.prefs.to.length >= 10}
            aria-label="Add an email address"
          />
          <Button onClick={addEmails} loading={busy === 'prefs'} disabled={!d.prefs.email || !draft.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">Every address here gets the email. With none added, it goes to your login email ({d.loginEmail}).</p>
      </Box>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={test} loading={busy === 'test'}>
          <Send className="h-4 w-4" /> Send me a test
        </Button>
        <span className="text-xs text-slate-500">Sends a sample "search ready" email and notification to you only.</span>
      </div>

      {/* SMTP — admins */}
      {d.isAdmin && smtp && (
        <Box
          icon={Server}
          title="Email server (admin)"
          text="The account the emails are sent from — for everybody"
          right={d.emailReady ? <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Ready</span> : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 dark:bg-white/10">Not set up</span>}
        >
          <div className="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600 dark:bg-white/5 dark:text-slate-300">
            <b>With Gmail (easiest):</b> turn on 2-Step Verification in your Google account → open <b>myaccount.google.com/apppasswords</b> → create one named "FB Lead Finder" →
            paste the 16-letter password below. Host <code>smtp.gmail.com</code>, port <code>465</code>, user = that Gmail address.
            <button type="button" onClick={() => setSmtp((s) => ({ ...s, host: 'smtp.gmail.com', port: 465 }))} className="ml-1 font-semibold text-indigo-600 underline">Fill in Gmail</button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sh" className="label">SMTP host</label>
              <input id="sh" className="input" placeholder="smtp.gmail.com" value={smtp.host} onChange={setS('host')} />
            </div>
            <div>
              <label htmlFor="sp" className="label">Port</label>
              <input id="sp" type="number" className="input" placeholder="465" value={smtp.port} onChange={setS('port')} />
            </div>
            <div>
              <label htmlFor="suser" className="label">Username (email)</label>
              <input id="suser" className="input" autoComplete="off" placeholder="you@gmail.com" value={smtp.user} onChange={setS('user')} />
            </div>
            <div>
              <label htmlFor="spass" className="label">Password / App Password</label>
              <input id="spass" type="password" autoComplete="new-password" className="input" placeholder={smtp.hasPass ? '•••••••• saved — type to change' : '16-letter App Password'} value={smtp.pass} onChange={setS('pass')} />
            </div>
            <div>
              <label htmlFor="sfrom" className="label">From name (optional)</label>
              <input id="sfrom" className="input" placeholder="FB Lead Finder <you@gmail.com>" value={smtp.from} onChange={setS('from')} />
            </div>
            <div>
              <label htmlFor="sapp" className="label">Dashboard address (for the buttons)</label>
              <input id="sapp" className="input" placeholder="https://specter.monster" value={smtp.appUrl} onChange={setS('appUrl')} />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={saveSmtp} loading={busy === 'smtp'}>Save email server</Button>
          </div>
        </Box>
      )}
    </div>
  );
}
