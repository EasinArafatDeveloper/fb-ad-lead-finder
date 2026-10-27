import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ChevronDown, FolderOpen, Link2, Loader2, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { Button, PageHeader, Progress } from '../components/ui';
import { useStats } from '../components/Layout';

const EXAMPLE = [
  'https://www.facebook.com/ShopName',
  'https://www.facebook.com/profile.php?id=100064123456789',
  'https://www.facebook.com/p/Shop-Name-100064123456789/',
  'm.facebook.com/AnotherShop',
].join('\n');

const WORKS = [
  ['facebook.com/ShopName', true],
  ['profile.php?id=1000…', true],
  ['facebook.com/p/Shop-Name-1000…/', true],
  ['m.facebook.com / fb.com / web.facebook.com', true],
  ['A post or photo link of the Page', true],
  ['Just the username or the number', true],
  ['Group, event, share/short link', false],
];

/** One number of the preview. */
function Tile({ label, value, tone, hint }) {
  const tones = {
    green: 'text-emerald-600 dark:text-emerald-400',
    slate: 'text-slate-700 dark:text-slate-200',
    amber: 'text-amber-600 dark:text-amber-400',
    rose: 'text-rose-600 dark:text-rose-400',
    sky: 'text-sky-600 dark:text-sky-400',
  };
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10" title={hint}>
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <span className={cn('mt-0.5 block font-display text-2xl font-extrabold tabular-nums', tones[tone])}>{formatNumber(value)}</span>
    </div>
  );
}

/** Paste Facebook Page links → their contacts, in a project of its own (Projects → Pasted links). */
export default function PasteLinks() {
  const navigate = useNavigate();
  const { refresh } = useStats();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBad, setShowBad] = useState(false);
  const [recent, setRecent] = useState([]);
  const seq = useRef(0);

  // the preview follows the text (half a second after typing stops)
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return undefined;
    }
    const n = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      api('/links/preview', { method: 'POST', body: { text } })
        .then((r) => n === seq.current && setPreview(r))
        .catch((e) => n === seq.current && toast.error(e.message))
        .finally(() => n === seq.current && setChecking(false));
    }, 500);
    return () => clearTimeout(t);
  }, [text]);

  const loadRecent = () => api('/jobs').then((jobs) => setRecent(jobs.filter((j) => j.kind === 'links').slice(0, 8))).catch(() => {});
  useEffect(() => {
    loadRecent();
    const t = setInterval(() => !document.hidden && loadRecent(), 8000);
    return () => clearInterval(t);
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/links/import', { method: 'POST', body: { text, name } });
      toast.success(`"${r.name}" — ${formatNumber(r.pages)} Pages`, {
        description: r.alreadyRead ? `${formatNumber(r.alreadyRead)} were read already and are ready now; ${formatNumber(r.toRead)} are being read.` : `${formatNumber(r.toRead)} Pages are being read. You get a notification when it is done.`,
      });
      refresh();
      navigate(`/projects/${r.projectId}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const p = preview;
  const short = p && p.credits != null && p.toRead > p.credits;
  const canSubmit = p && p.valid > 0 && !p.tooMany && !checking && !busy;

  return (
    <div className="pb-16">
      <PageHeader icon={Link2} title="Paste links" subtitle="Facebook Page links → their phone, WhatsApp, email and website — in a project of its own" />

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <section className="card p-5">
            <label htmlFor="links" className="label">Facebook Page links — one per line (up to 500)</label>
            <textarea
              id="links"
              rows={12}
              spellCheck={false}
              className="input font-mono text-xs leading-relaxed"
              placeholder={EXAMPLE}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <label htmlFor="lname" className="label">Name of the list (optional)</label>
                <input id="lname" className="input" maxLength={120} placeholder="e.g. Clients from the WhatsApp group" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
                {!busy && <Zap className="h-4 w-4" />} {p?.valid ? `Read ${formatNumber(p.valid)} Page${p.valid === 1 ? '' : 's'}` : 'Read the Pages'}
              </Button>
            </div>
          </section>

          {(p || checking) && (
            <section className="card p-5" aria-live="polite">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="font-display font-bold">What will happen</h2>
                {checking && <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label="Checking" />}
              </div>
              {p && (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Tile label="Pages" value={p.valid} tone="green" hint="Different Facebook Pages found in the text" />
                    <Tile label="Ready now" value={p.alreadyRead} tone="sky" hint={`Read in the last 30 days — handed over at once`} />
                    <Tile label="To read" value={p.toRead} tone="slate" hint="Read now through the proxy IPs" />
                    <Tile label="Duplicates" value={p.duplicates} tone="slate" hint="The same Page more than once — counted once" />
                    <Tile label="Not a Page" value={p.invalidCount} tone={p.invalidCount ? 'rose' : 'slate'} hint="Lines that are not a Facebook Page link" />
                    <Tile label="Already in your leads" value={p.inLeads} tone="amber" hint="Not added twice — they also join this list" />
                  </div>
                  {p.tooMany > 0 && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> At most {p.max} Pages at a time — remove {formatNumber(p.tooMany)} and paste them as another list.
                    </p>
                  )}
                  {short && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        You have {formatNumber(p.credits)} credits and {formatNumber(p.toRead)} Pages to read (1 credit = 1 Page). The rest waits until you <Link to="/billing" className="font-semibold underline">add credits</Link>.
                      </span>
                    </p>
                  )}
                  {p.invalidCount > 0 && (
                    <div className="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/30">
                      <button type="button" onClick={() => setShowBad((v) => !v)} aria-expanded={showBad} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-rose-700 dark:text-rose-300">
                        {formatNumber(p.invalidCount)} line{p.invalidCount === 1 ? '' : 's'} will be skipped — why
                        <ChevronDown className={cn('h-4 w-4 transition-transform', showBad && 'rotate-180')} />
                      </button>
                      {showBad && (
                        <ul className="max-h-56 divide-y divide-rose-100 overflow-auto border-t border-rose-200 text-xs dark:divide-rose-500/10 dark:border-rose-500/30">
                          {p.invalid.map((x, i) => (
                            <li key={i} className="flex gap-3 px-3 py-1.5">
                              <span className="min-w-0 flex-1 truncate font-mono text-slate-600 dark:text-slate-300" title={x.input}>{x.input}</span>
                              <span className="shrink-0 text-rose-600 dark:text-rose-300">{x.reason}</span>
                            </li>
                          ))}
                          {p.invalidCount > p.invalid.length && <li className="px-3 py-1.5 text-slate-500">… and {formatNumber(p.invalidCount - p.invalid.length)} more</li>}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {recent.length > 0 && (
            <section className="card p-5">
              <h2 className="mb-3 font-display font-bold">Your pasted lists</h2>
              <ul className="divide-y divide-slate-100 dark:divide-white/5">
                {recent.map((j) => {
                  const done = j.pageCount && j.scraped >= j.pageCount;
                  return (
                    <li key={j.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <Link2 className="h-4 w-4 shrink-0 text-sky-500" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{j.keyword}</p>
                        <p className="text-[11px] text-slate-500">
                          {formatNumber(j.pageCount)} Pages · {formatNumber(j.withContact)} with contact · {timeAgo(j.createdAt)}
                        </p>
                      </div>
                      <div className="w-32">
                        {done ? (
                          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> Done</span>
                        ) : (
                          <>
                            <Progress value={j.pageCount ? (j.scraped / j.pageCount) * 100 : 0} />
                            <span className="mt-1 block text-[11px] tabular-nums text-slate-500">{formatNumber(j.scraped)}/{formatNumber(j.pageCount)} read</span>
                          </>
                        )}
                      </div>
                      {j.projectId && (
                        <Link to={`/projects/${j.projectId}`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10">
                          <FolderOpen className="h-3.5 w-3.5" /> Open
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Link to="/projects?source=links" className="mt-2 inline-block text-xs font-semibold text-slate-500 hover:text-indigo-600">All pasted lists in Projects →</Link>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <div className="card p-5">
            <h2 className="font-display font-bold">Which links work</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {WORKS.map(([t, ok]) => (
                <li key={t} className="flex items-start gap-2">
                  <span className={cn('mt-0.5 text-xs font-bold', ok ? 'text-emerald-600' : 'text-rose-500')}>{ok ? '✓' : '✗'}</span>
                  <span className={cn(!ok && 'text-slate-500')}>{t}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              Business Pages only — a personal profile usually shows nothing without a login. Links can be pasted with text around them; only the links are taken.
            </p>
          </div>
          <div className="card p-5 text-sm text-slate-600 dark:text-slate-300">
            <h2 className="font-display font-bold text-slate-900 dark:text-white">How it works</h2>
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs">
              <li>Each paste becomes its own project — Projects → <b>Pasted links</b>.</li>
              <li>Pages read in the last 30 days are ready at once; the others are read now.</li>
              <li>1 credit = 1 Page, like a search. A Page already in your leads is not added twice.</li>
              <li>You get a notification when every Page is read.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
