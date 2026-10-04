import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, FileSpreadsheet, Gauge, Save, Settings as SettingsIcon, PlugZap, ArrowDownToLine, CloudUpload, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button, PageHeader, Skeleton } from '../components/ui';
import { useStats } from '../components/Layout';

function Section({ icon: Icon, title, text, children }) {
  return (
    <section className="card p-6">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-lg shadow-indigo-500/25">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-display font-bold">{title}</h2>
          {text && <p className="text-xs text-slate-500">{text}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Toggle({ id, checked, onChange, label, help }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        {help && <p className="text-xs text-slate-500">{help}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-gradient-to-r from-indigo-600 to-blue-600' : 'bg-slate-200 dark:bg-white/10'}`}
      >
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export default function Settings() {
  const { refresh } = useStats();
  const [ws, setWs] = useState(null); // this workspace: Google Sheet
  const [worker, setWorker] = useState(null); // the shared worker (admins)
  const [admin, setAdmin] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');

  const apply = (r) => {
    setWs(r.workspace);
    setWorker(r.worker);
    setAdmin(!!r.isAdmin);
  };
  useEffect(() => {
    api('/settings').then(apply).catch((e) => toast.error(e.message));
    fetch('/apps-script.gs').then((r) => r.text()).then(setCode).catch(() => {});
  }, []);

  const field = (setter) => (k) => (v) => setter((x) => ({ ...x, [k]: v?.target ? (v.target.type === 'number' ? Number(v.target.value) : v.target.value) : v }));
  const setW = field(setWs);
  const setK = field(setWorker);
  const body = () => ({
    workspace: { sheetUrl: ws.sheetUrl, sheetSecret: ws.sheetSecret, autoSync: ws.autoSync },
    ...(admin ? { worker: {
      delayMin: worker.delayMin, delayMax: worker.delayMax, dailyLimit: worker.dailyLimit, maxAds: worker.maxAds, parallel: worker.parallel,
      websiteFallback: worker.websiteFallback, closeAdTab: worker.closeAdTab,
      proxyEnabled: Boolean(worker.proxyEnabled), proxyHost: worker.proxyHost || '', proxyPort: Number(worker.proxyPort) || 44445,
      proxyUser: worker.proxyUser || '', proxyPass: worker.proxyPass || ''
    } } : {}),
  });
  const testProxy = async () => {
    setBusy('test-proxy');
    try {
      const res = await api('/admin/test-proxy', {
        method: 'POST',
        body: {
          host: worker.proxyHost,
          port: worker.proxyPort,
          user: worker.proxyUser,
          pass: worker.proxyPass,
        },
      });
      toast.success(`Proxy working! Connected via IP: ${res.ip || 'OK'} (${res.country || 'Global'})`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      apply(await api('/settings', { method: 'PUT', body: body() }));
      toast.success('Settings saved');
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const sheet = (path, payload, ok) => async () => {
    setBusy(path);
    try {
      apply(await api('/settings', { method: 'PUT', body: { workspace: body().workspace } }));
      toast.success(ok(await api(path, { method: 'POST', body: payload })));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!ws) return <Skeleton className="h-96" />;
  return (
    <div>
      <PageHeader icon={SettingsIcon} title="Settings" subtitle={admin ? 'Your Google Sheet, and the worker for everybody' : 'Your Google Sheet'} actions={<Button variant="primary" onClick={save} loading={busy === 'save'}><Save className="h-4 w-4" /> Save</Button>} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section icon={FileSpreadsheet} title="Google Sheet" text="Your own Sheet, synced through an Apps Script Web App">
          <div className="space-y-4">
            <div>
              <label htmlFor="su" className="label">Web App URL</label>
              <input id="su" className="input" placeholder="https://script.google.com/macros/s/…/exec" value={ws.sheetUrl} onChange={setW('sheetUrl')} />
            </div>
            <div>
              <label htmlFor="ss" className="label">Secret key</label>
              <input id="ss" type="password" autoComplete="off" className="input" placeholder="SECRET from Code.gs" value={ws.sheetSecret} onChange={setW('sheetSecret')} />
            </div>
            <Toggle id="as" checked={ws.autoSync} onChange={setW('autoSync')} label="Auto-sync every 5 minutes" help="Status and Notes your team types in the Sheet are never overwritten" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy === '/sheet/test'} onClick={sheet('/sheet/test', {}, (r) => `Connected ✓ ${r.sheet}`)}><PlugZap className="h-3.5 w-3.5" /> Test</Button>
              <Button size="sm" loading={busy === '/sheet/sync'} onClick={sheet('/sheet/sync', { all: true }, (r) => `Synced ✓ ${r.inserted} new, ${r.updated} updated`)}><CloudUpload className="h-3.5 w-3.5" /> Sync all</Button>
              <Button size="sm" loading={busy === '/sheet/pull'} onClick={sheet('/sheet/pull', {}, (r) => `${r.changed} lead updated`)}><ArrowDownToLine className="h-3.5 w-3.5" /> Pull Status/Notes</Button>
            </div>
          </div>
        </Section>

        {admin && worker && (
          <Section icon={Gauge} title="Worker (all users)" text="One Chrome worker reads pages for everybody — paced so Facebook doesn't block it">
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ['delayMin', 'Delay min (sec)'],
                ['delayMax', 'Delay max (sec)'],
                ['dailyLimit', 'Daily page limit (whole server)'],
                ['maxAds', 'Default max ads / keyword'],
              ].map(([k, label]) => (
                <div key={k}>
                  <label htmlFor={k} className="label">{label}</label>
                  <input id={k} type="number" min={1} className="input" value={worker[k]} onChange={setK(k)} />
                </div>
              ))}
            </div>
            <div className="mt-4">
              <span className="label">Pages read at the same time</span>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Parallel tabs">
                {[
                  [1, 'Recommended (no login)'],
                  [2, 'Faster, more login walls'],
                  [3, 'Fastest, most walls'],
                ].map(([n, hint]) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={worker.parallel === n}
                    onClick={() => setK('parallel')(n)}
                    className={`rounded-xl border p-3 text-left transition ${
                      worker.parallel === n
                        ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-500/20 dark:border-indigo-500/50 dark:bg-indigo-500/10'
                        : 'border-slate-200 hover:border-slate-300 dark:border-white/10'
                    }`}
                  >
                    <span className="block font-display text-lg font-extrabold">{n} tab</span>
                    <span className="text-[11px] text-slate-500">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 divide-y divide-slate-100 dark:divide-white/10">
              <Toggle id="wf" checked={worker.websiteFallback} onChange={setK('websiteFallback')} label="Find email on the website" help="If the page has no email, check their website's contact page" />
              <Toggle id="ct" checked={worker.closeAdTab} onChange={setK('closeAdTab')} label="Close the Ad Library tab after collecting" />
            </div>
          </Section>
        )}

        {admin && worker && (
          <Section icon={ShieldCheck} title="Rotating Proxy (Bright Data / ISP)" text="Routes Facebook scraping through rotating residential IPs to prevent login walls">
            <Toggle id="pe" checked={worker.proxyEnabled} onChange={setK('proxyEnabled')} label="Enable Proxy for Facebook scraping" help="Only Facebook traffic is routed through the proxy. Localhost and other sites stay direct." />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="ph" className="label">Proxy Host</label>
                <input id="ph" className="input" placeholder="brd.superproxy.io" value={worker.proxyHost || ''} onChange={setK('proxyHost')} />
              </div>
              <div>
                <label htmlFor="pp" className="label">Proxy Port</label>
                <input id="pp" type="number" className="input" placeholder="44445" value={worker.proxyPort || 44445} onChange={setK('proxyPort')} />
              </div>
              <div>
                <label htmlFor="pu" className="label">Username</label>
                <input id="pu" className="input" placeholder="brd-customer-..." value={worker.proxyUser || ''} onChange={setK('proxyUser')} />
              </div>
              <div>
                <label htmlFor="pw" className="label">Password</label>
                <input id="pw" type="password" className="input" placeholder="Password" value={worker.proxyPass || ''} onChange={setK('proxyPass')} />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" loading={busy === 'test-proxy'} onClick={testProxy}><PlugZap className="h-3.5 w-3.5" /> Test Proxy Connection</Button>
            </div>
          </Section>
        )}
      </div>

      <section className="card mt-6 p-6">
        <h2 className="font-display font-bold">Google Sheet setup (one time)</h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Open a new Google Sheet → <b>Extensions → Apps Script</b></li>
          <li>Paste all of the code below, change <code className="rounded bg-indigo-50 px-1 text-indigo-700">SECRET</code> to your own long random text → Save</li>
          <li><b>Deploy → New deployment → Web app</b> · Execute as: <b>Me</b> · Who has access: <b>Anyone</b></li>
          <li>Enter the Web App URL and SECRET above → <b>Save</b> → <b>Test</b></li>
        </ol>
        <div className="relative mt-4">
          <Button size="sm" className="absolute right-3 top-3" onClick={() => navigator.clipboard.writeText(code).then(() => toast.success('Code copied'))}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </Button>
          <pre className="max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-200">{code}</pre>
        </div>
      </section>
    </div>
  );
}
