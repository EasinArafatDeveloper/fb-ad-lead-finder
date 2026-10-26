import { useState } from 'react';
import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * The Ad Library's own filters and sort. They go into the Ad Library link (server: util.js adLibraryUrl),
 * so the search opens with them already applied — the same as choosing them on facebook.com.
 */
export const EMPTY_FILTERS = { status: 'active', media: 'all', platforms: [], languages: [], from: '', to: '', exact: false, sort: '' };

const STATUS = [['active', 'Active ads'], ['inactive', 'Inactive ads'], ['all', 'All ads']];
const MEDIA = [['all', 'All media'], ['image', 'Images'], ['video', 'Videos'], ['meme', 'Memes'], ['none', 'No image or video']];
const PLATFORMS = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['messenger', 'Messenger'], ['audience_network', 'Audience Network'], ['threads', 'Threads']];
const SORTS = [['', 'Facebook default'], ['impressions', 'Impressions: high to low'], ['impressions_asc', 'Impressions: low to high'], ['recent', 'Most recent']];
export const LANGUAGES = [
  ['bn', 'Bengali'], ['en', 'English'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['pt', 'Portuguese'], ['id', 'Indonesian'], ['ms', 'Malay'], ['tr', 'Turkish'], ['ru', 'Russian'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['it', 'Italian'], ['nl', 'Dutch'],
];

/** How many filters differ from the Ad Library's defaults. */
export const filterCount = (f) =>
  (f.status && f.status !== 'active' ? 1 : 0) + (f.media && f.media !== 'all' ? 1 : 0) + (f.platforms?.length ? 1 : 0) +
  (f.languages?.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.exact ? 1 : 0) + (f.sort ? 1 : 0);

/** A short line for a search card: "Videos · Instagram · Bengali · Most recent". */
export function filterSummary(f) {
  if (!f) return '';
  const name = (list, k) => list.find((x) => x[0] === k)?.[1] || k;
  const out = [];
  if (f.status && f.status !== 'active') out.push(name(STATUS, f.status));
  if (f.media && f.media !== 'all') out.push(name(MEDIA, f.media));
  if (f.platforms?.length) out.push(f.platforms.map((p) => name(PLATFORMS, p)).join('+'));
  if (f.languages?.length) out.push(f.languages.map((l) => name(LANGUAGES, l)).join('+'));
  if (f.from || f.to) out.push(`started ${f.from || '…'} – ${f.to || 'now'}`);
  if (f.exact) out.push('exact phrase');
  if (f.sort) out.push(name(SORTS, f.sort));
  return out.join(' · ');
}

function Pills({ options, value, onChange, multi, label }) {
  const on = (k) => (multi ? value.includes(k) : value === k);
  const click = (k) => (multi ? onChange(on(k) ? value.filter((x) => x !== k) : [...value, k]) : onChange(k));
  return (
    <div className="flex flex-wrap gap-1.5" role={multi ? 'group' : 'radiogroup'} aria-label={label}>
      {options.map(([k, text]) => (
        <button
          key={k || 'default'}
          type="button"
          role={multi ? undefined : 'radio'}
          aria-checked={multi ? undefined : on(k)}
          aria-pressed={multi ? on(k) : undefined}
          onClick={() => click(k)}
          className={cn(
            'rounded-lg border px-2.5 py-1 text-xs font-semibold transition',
            on(k) ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300 dark:border-white/10 dark:text-slate-300',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export default function AdFilters({ value, onChange }) {
  const count = filterCount(value);
  const [open, setOpen] = useState(count > 0);
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="relative mt-6 rounded-2xl border border-slate-200 dark:border-white/10">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <SlidersHorizontal className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
        <span className="text-sm font-bold">Ad Library filters &amp; sort</span>
        {count > 0 ? (
          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-bold text-white">{count} on</span>
        ) : (
          <span className="text-xs text-slate-400">Active ads · all media · all platforms · all languages</span>
        )}
        <ChevronDown className={cn('ml-auto h-4 w-4 text-slate-400 transition', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open && (
        <div className="space-y-4 border-t border-slate-100 px-4 py-4 dark:border-white/10">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <span className="label">Ads</span>
              <Pills label="Active status" options={STATUS} value={value.status} onChange={set('status')} />
            </div>
            <div>
              <span className="label">Media type</span>
              <Pills label="Media type" options={MEDIA} value={value.media} onChange={set('media')} />
            </div>
            <div>
              <span className="label">Platforms <span className="font-normal text-slate-400">(none chosen = all)</span></span>
              <Pills label="Platforms" multi options={PLATFORMS} value={value.platforms} onChange={set('platforms')} />
            </div>
            <div>
              <span className="label">Sort by</span>
              <Pills label="Sort by" options={SORTS} value={value.sort} onChange={set('sort')} />
            </div>
            <div>
              <label htmlFor="adlang" className="label">Language <span className="font-normal text-slate-400">(the ad's text)</span></label>
              <div className="flex flex-wrap items-center gap-1.5">
                {value.languages.map((l) => (
                  <button key={l} type="button" onClick={() => set('languages')(value.languages.filter((x) => x !== l))} className="rounded-lg border border-indigo-500 bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white" aria-label={`Remove ${l}`}>
                    {LANGUAGES.find((x) => x[0] === l)?.[1] || l} ×
                  </button>
                ))}
                <select
                  id="adlang"
                  className="input h-8 w-auto py-0 text-xs"
                  value=""
                  onChange={(e) => e.target.value && set('languages')([...value.languages, e.target.value])}
                >
                  <option value="">{value.languages.length ? '+ add another' : 'All languages'}</option>
                  {LANGUAGES.filter(([k]) => !value.languages.includes(k)).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select>
              </div>
            </div>
            <div>
              <span className="label">Ads that started between</span>
              <div className="flex items-center gap-2">
                <input type="date" aria-label="Started from" className="input h-8 py-0 text-xs" max={value.to || today} value={value.from} onChange={(e) => set('from')(e.target.value)} />
                <span className="text-xs text-slate-400">and</span>
                <input type="date" aria-label="Started until" className="input h-8 py-0 text-xs" min={value.from || undefined} max={today} value={value.to} onChange={(e) => set('to')(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600" checked={value.exact} onChange={(e) => set('exact')(e.target.checked)} />
              <span><b>Exact phrase</b> <span className="text-xs text-slate-500">— only ads with the words in this order</span></span>
            </label>
            <button type="button" disabled={!count} onClick={() => onChange(EMPTY_FILTERS)} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-600 disabled:opacity-40">
              <RotateCcw className="h-3.5 w-3.5" /> Reset filters
            </button>
          </div>
          <p className="text-[11px] text-slate-400">The Ad Library opens with these already applied — the same as choosing them on Facebook. They apply to every keyword above and are kept when you collect more.</p>
        </div>
      )}
    </div>
  );
}
