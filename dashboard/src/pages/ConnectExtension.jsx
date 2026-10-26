import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Chrome, Copy, Download, Loader2, PlugZap } from 'lucide-react';
import { api, extensionHere } from '../lib/api';
import { Button, PageHeader } from '../components/ui';

const browserName = () => (navigator.brave ? 'Brave' : /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome');
const extPage = (b) => ({ Brave: 'brave://extensions', Edge: 'edge://extensions' })[b] || 'chrome://extensions';

/** Until the Chrome Web Store has it: download the ZIP and load it — step by step. */
function InstallSteps({ ext }) {
  const b = browserName();
  const page = extPage(b);
  const steps = [
    <>Download the extension <b>(v{ext.version})</b> with the button above.</>,
    <>Open your <b>Downloads</b> folder, right-click <b>fb-lead-finder-extension.zip</b> → <b>Extract All…</b> → <b>Extract</b>. You get a folder.</>,
    <>
      In a new tab open{' '}
      <button type="button" onClick={() => navigator.clipboard.writeText(page).then(() => toast.success(`${page} copied — paste it in the address bar`))} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-indigo-700 hover:bg-indigo-50 dark:bg-white/10 dark:text-indigo-300">
        {page} (copy)
      </button>{' '}
      — paste it into the address bar and press Enter.
    </>,
    <>Turn on <b>Developer mode</b> (the switch at the top right{b === 'Edge' ? ', or on the left' : ''}).</>,
    <>Click <b>Load unpacked</b> and choose the folder from step 2 (the one with <i>manifest.json</i> inside).</>,
    <>Come back to this page, <b>reload it</b> (F5), and press <b>Connect this computer</b>.</>,
  ];
  return (
    <ol className="mt-4 space-y-2.5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-bold text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300">{i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
      <li className="pt-1 text-xs text-slate-400">Works in Chrome, Brave and Edge. Do not delete the folder afterwards — the browser uses it.</li>
    </ol>
  );
}

/**
 * /connect-extension — links the Chrome extension on this computer to this account, without copying keys:
 * the page makes a key and hands it to the extension (extension/content/dashboard.js → background).
 */
export default function ConnectExtension() {
  const [state, setState] = useState('idle'); // idle | connecting | connected | no-extension
  const [manualKey, setManualKey] = useState('');
  const [ext, setExt] = useState(null); // { version, url, storeUrl }
  const here = extensionHere();
  useEffect(() => {
    api('/public/extension').then(setExt).catch(() => {});
  }, []);
  const outdated = here && ext?.version && here !== ext.version;

  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== window || !e.data || e.data.__fblf !== true) return;
      if (e.data.type === 'connected') {
        setState('connected');
        toast.success('The extension is connected to your account');
      }
      if (e.data.type === 'connect-failed') {
        setState('idle');
        toast.error(e.data.error || 'The extension could not save the key');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const connect = async () => {
    setState('connecting');
    try {
      const { key } = await api('/extension/keys', { method: 'POST', body: {} });
      if (!extensionHere()) {
        setManualKey(key);
        setState('no-extension');
        return;
      }
      window.postMessage({ __fblf: true, type: 'connect', key, server: window.location.origin }, window.location.origin);
      // no answer in 5 s → an older extension that doesn't know "connect": show the key to paste
      setTimeout(() => setState((s) => (s === 'connecting' ? (setManualKey(key), 'no-extension') : s)), 5000);
    } catch (e) {
      toast.error(e.message);
      setState('idle');
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader icon={PlugZap} title="Connect the Chrome extension" subtitle="Your searches run in your own Chrome — connect it once on each computer you use" />
      <div className="card p-7">
        <ol className="space-y-5">
          <li className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">1</span>
            <div>
              <p className="font-semibold">Install the extension in Chrome</p>
              {here && !outdated ? (
                <p className="mt-0.5 inline-flex items-center gap-1 text-sm font-semibold text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Installed on this computer (v{here})</p>
              ) : ext?.storeUrl ? (
                <a href={ext.storeUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">
                  <Chrome className="h-4 w-4" /> Add to Chrome — free
                </a>
              ) : (
                <>
                  {outdated && <p className="mt-0.5 text-sm font-semibold text-amber-700 dark:text-amber-400">You have v{here} — download v{ext.version} and load it the same way (replace the old folder).</p>}
                  <a href={ext?.url || '/downloads/fb-lead-finder-extension.zip'} download className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700">
                    <Download className="h-4 w-4" /> Download the extension{ext?.version ? ` (v${ext.version})` : ''}
                  </a>
                  {ext && <InstallSteps ext={ext} />}
                </>
              )}
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">2</span>
            <div className="flex-1">
              <p className="font-semibold">Connect it to your account</p>
              {state === 'connected' ? (
                <p className="mt-2 inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <CheckCircle2 className="h-5 w-5" /> Connected — searches you start now open in this Chrome.
                </p>
              ) : (
                <Button variant="primary" className="mt-2" onClick={connect} disabled={state === 'connecting'}>
                  {state === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Connect this computer
                </Button>
              )}
              {state === 'no-extension' && manualKey && (
                <div className="mt-4 rounded-xl border border-slate-200 p-4 text-sm dark:border-white/10">
                  <p className="text-slate-600 dark:text-slate-300">
                    The extension didn't answer from this page. Open the extension's window (its icon in Chrome), and paste this key under <b>Worker key</b>, with <b>Server URL</b> {window.location.origin}:
                  </p>
                  <div className="mt-3 flex gap-2">
                    <code className="flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-white/10">{manualKey}</code>
                    <Button size="sm" onClick={() => navigator.clipboard.writeText(manualKey).then(() => toast.success('Key copied'))}><Copy className="h-3.5 w-3.5" /> Copy</Button>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">The key is shown once. It only works for your account — you can remove it in Settings → Extension.</p>
                </div>
              )}
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">3</span>
            <div>
              <p className="font-semibold">Start your first search</p>
              <p className="mt-0.5 text-sm text-slate-500">Type a keyword — the Ad Library opens in a tab and collects in the background. <Link to="/search?new=1" className="font-semibold text-indigo-600 hover:underline">Go to Searches →</Link></p>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}
