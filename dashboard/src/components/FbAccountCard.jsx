import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, MessageCircle, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cn, timeAgo } from '../lib/utils';
import { Button } from './ui';

/**
 * Settings → Proxy → Facebook account: the team's own account, used only to read comments of posts,
 * videos and reels. The cookies go to the server and are never shown again.
 */
export default function FbAccountCard() {
  const [acc, setAcc] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');

  const load = () => api('/admin/fb-account').then(setAcc).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);

  const run = (key, fn, ok) => async () => {
    setBusy(key);
    try {
      const r = await fn();
      setAcc(r);
      if (ok) ok(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const save = run('save', () => api('/admin/fb-account', { method: 'PUT', body: { cookies: text } }), (r) => {
    setText('');
    if (r.status === 'ok') toast.success(`Connected as ${r.name || r.userId}`);
    else toast.error(r.statusNote || 'The cookies did not log in');
  });
  const check = run('check', () => api('/admin/fb-account/check', { method: 'POST' }), (r) =>
    r.status === 'ok' ? toast.success(`Still logged in as ${r.name || r.userId}`) : toast.error(r.statusNote),
  );
  const remove = run('remove', () => api('/admin/fb-account', { method: 'DELETE' }), () => toast.success('Facebook account removed'));

  if (!acc) return <div className="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" />;
  const ok = acc.connected && acc.status === 'ok';

  return (
    <div className="space-y-4">
      {acc.connected && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm',
            ok ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
          )}
        >
          {ok ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {ok ? (
                <>
                  Connected as{' '}
                  <a href={`https://www.facebook.com/profile.php?id=${acc.userId}`} target="_blank" rel="noreferrer" className="underline">
                    {acc.name || acc.userId}
                  </a>
                </>
              ) : (
                'The account needs attention'
              )}
            </p>
            <p className="text-xs opacity-80">
              {ok ? 'Used only to read comments of posts, videos and reels — from this server\'s own internet, never through the proxies.' : acc.statusNote}
              {acc.checkedAt && ` · checked ${timeAgo(acc.checkedAt)}`}
              {acc.lastUsedAt && ` · last used ${timeAgo(acc.lastUsedAt)}`}
            </p>
          </div>
          <Button onClick={check} loading={busy === 'check'}>
            {busy !== 'check' && <RefreshCw className="h-3.5 w-3.5" />} Check
          </Button>
          <Button variant="danger" onClick={remove} loading={busy === 'remove'}>
            {busy !== 'remove' && <Trash2 className="h-3.5 w-3.5" />} Remove
          </Button>
        </div>
      )}

      <div>
        <label htmlFor="fbck" className="label">{acc.connected ? 'Replace with fresh cookies' : 'Paste the account\'s cookies'}</label>
        <textarea
          id="fbck"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'c_user=1000…; xs=12%3A…; datr=…; fr=…\n— or the JSON exported by the Cookie-Editor extension'}
          className="input font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[11px] text-slate-500">
          <li>In Chrome, log in to the Facebook account you want to use (a separate Chrome profile is best).</li>
          <li>Install <b>Cookie-Editor</b>, open facebook.com, click it → <b>Export → JSON</b> (or copy <code>c_user</code>, <code>xs</code>, <code>datr</code>, <code>fr</code>).</li>
          <li>Paste here and press Connect. The cookies are stored on the server only and never shown again.</li>
          <li>Don&apos;t press &quot;Log out&quot; in that browser afterwards — that ends this session too (just close the tab).</li>
        </ol>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!text.trim()}>
            {busy !== 'save' && <MessageCircle className="h-4 w-4" />} Connect account
          </Button>
        </div>
      </div>
    </div>
  );
}
