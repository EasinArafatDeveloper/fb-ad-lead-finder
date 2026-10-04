import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, FileSpreadsheet, Gauge, Save, Settings as SettingsIcon, PlugZap, ArrowDownToLine, CloudUpload } from 'lucide-react';
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
  const [s, setS] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api('/settings').then(setS).catch((e) => toast.error(e.message));
    fetch('/apps-script.gs').then((r) => r.text()).then(setCode).catch(() => {});
  }, []);

  const set = (k) => (v) => setS((x) => ({ ...x, [k]: v?.target ? (v.target.type === 'number' ? Number(v.target.value) : v.target.value) : v }));
  const save = async () => {
    setBusy('save');
    try {
      setS(await api('/settings', { method: 'PUT', body: s }));
      toast.success('Settings saved');
      refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const sheet = (path, body, ok) => async () => {
    setBusy(path);
    try {
      await api('/settings', { method: 'PUT', body: s });
      toast.success(ok(await api(path, { method: 'POST', body })));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!s) return <Skeleton className="h-96" />;
  return (
    <div>
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Scraping speed, limits and Google Sheet" actions={<Button variant="primary" onClick={save} loading={busy === 'save'}><Save className="h-4 w-4" /> Save</Button>} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section icon={Gauge} title="Scraping" text="Paced slowly so Facebook doesn't block the account">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['delayMin', 'Delay min (sec)'],
              ['delayMax', 'Delay max (sec)'],
              ['dailyLimit', 'Daily page limit'],
              ['maxAds', 'Default max ads / keyword'],
            ].map(([k, label]) => (
              <div key={k}>
                <label htmlFor={k} className="label">{label}</label>
                <input id={k} type="number" min={1} className="input" value={s[k]} onChange={set(k)} />
              </div>
            ))}
          </div>
          <div className="mt-4">
            <span className="label">Pages read at the same time</span>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Parallel tabs">
              {[
                [1, 'Slow, safest'],
                [2, 'Fast · recommended'],
                [3, 'Fastest, higher risk'],
              ].map(([n, hint]) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={s.parallel === n}
                  onClick={() => set('parallel')(n)}
                  className={`rounded-xl border p-3 text-left transition ${
                    s.parallel === n
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
            <Toggle id="wf" checked={s.websiteFallback} onChange={set('websiteFallback')} label="Find email on the website" help="If the page has no email, check their website's contact page" />
            <Toggle id="ct" checked={s.closeAdTab} onChange={set('closeAdTab')} label="Close the Ad Library tab after collecting" />
          </div>
        </Section>

        <Section icon={FileSpreadsheet} title="Google Sheet" text="Sync through an Apps Script Web App">
          <div className="space-y-4">
            <div>
              <label htmlFor="su" className="label">Web App URL</label>
              <input id="su" className="input" placeholder="https://script.google.com/macros/s/…/exec" value={s.sheetUrl} onChange={set('sheetUrl')} />
            </div>
            <div>
              <label htmlFor="ss" className="label">Secret key</label>
              <input id="ss" className="input" placeholder="SECRET from Code.gs" value={s.sheetSecret} onChange={set('sheetSecret')} />
            </div>
            <Toggle id="as" checked={s.autoSync} onChange={set('autoSync')} label="Auto-sync every 5 minutes (daily on Vercel's free plan)" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy === '/sheet/test'} onClick={sheet('/sheet/test', {}, (r) => `Connected ✓ ${r.sheet}`)}><PlugZap className="h-3.5 w-3.5" /> Test</Button>
              <Button size="sm" loading={busy === '/sheet/sync'} onClick={sheet('/sheet/sync', { all: true }, (r) => `Synced ✓ ${r.inserted} new, ${r.updated} updated`)}><CloudUpload className="h-3.5 w-3.5" /> Sync all</Button>
              <Button size="sm" loading={busy === '/sheet/pull'} onClick={sheet('/sheet/pull', {}, (r) => `${r.changed} lead updated`)}><ArrowDownToLine className="h-3.5 w-3.5" /> Pull Status/Notes</Button>
            </div>
          </div>
        </Section>
      </div>

      <section className="card mt-6 p-6">
        <h2 className="font-display font-bold">Google Sheet setup (one time)</h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Open a new Google Sheet → <b>Extensions → Apps Script</b></li>
          <li>Paste all of the code below, change <code className="rounded bg-indigo-50 px-1 text-indigo-700">SECRET</code> → Save</li>
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
