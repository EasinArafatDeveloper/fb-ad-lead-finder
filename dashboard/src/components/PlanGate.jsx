import { Link } from 'react-router-dom';
import { Lock, Sparkles } from 'lucide-react';
import { useStats } from './Layout';

export const PERK_TEXT = {
  excelExport: ['Excel export', 'Download your leads as an Excel file. CSV export is on every plan.'],
  notifications: ['Email & phone alerts', 'Get an email and a phone notification the moment a search is done.'],
  minAdsFilter: ['Bigger-advertisers filter', 'Collect only pages running 2+, 5+ or 10+ ads.'],
  sheetSync: ['Google Sheet sync', 'Keep a Google Sheet in sync with your leads, for your whole team.'],
};

/** Does the plan include this? (true while the plan is still loading — the server checks anyway) */
export function usePerk(key) {
  const { stats } = useStats();
  const perks = stats?.account?.perks;
  return perks ? !!perks[key] : true;
}

/** The place of a feature the plan doesn't include: what it does, and the way to get it. */
export function LockedFeature({ perk }) {
  const [title, text] = PERK_TEXT[perk] || [perk, ''];
  return (
    <section className="card relative overflow-hidden p-8 text-center">
      <span aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-indigo-500/10 blur-2xl" />
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-white/10">
        <Lock className="h-6 w-6" aria-hidden="true" />
      </span>
      <h2 className="mt-4 font-display text-xl font-bold">{title} is not in your plan</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{text}</p>
      <Link to="/billing" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700">
        <Sparkles className="h-4 w-4" /> See plans
      </Link>
    </section>
  );
}
