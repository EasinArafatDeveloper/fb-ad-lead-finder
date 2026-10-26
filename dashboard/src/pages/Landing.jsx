import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight, BellRing, Check, ChevronDown, Download, FileSpreadsheet, Filter, Globe2, MousePointerClick, Phone, Search, ShieldCheck, Sparkles, X, Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, formatNumber } from '../lib/utils';
import { BrandMark } from './Auth';

const STEPS = [
  [Search, 'Search a keyword', 'Type what your customers sell — "skin care", "gadget shop", "travel agency" — and pick a country.'],
  [MousePointerClick, 'We collect the advertisers', 'Our Chrome extension gathers every business running ads for it in the Meta Ad Library. It works in the background.'],
  [Phone, 'Get their contacts', 'We read each business\'s Facebook Page and give you the phone, WhatsApp, email and website they publish.'],
];
const FEATURES = [
  [Zap, 'Fresh, active advertisers', 'Only businesses spending on ads right now — the ones with budget and intent.'],
  [Phone, 'Phone, WhatsApp, email', 'The contact details the business itself shows on its Page, cleaned and de-duplicated.'],
  [Filter, 'Shortlist in seconds', 'Filter by contact type, followers, ads running, category, country — then export.'],
  [FileSpreadsheet, 'Excel, CSV, Google Sheets', 'Download your list or keep a Google Sheet in sync for your team.'],
  [BellRing, 'Alerts when it is ready', 'Start a search and walk away — get an email and a phone notification when it is done.'],
  [ShieldCheck, 'Your data stays yours', 'Every account is private. Nobody else sees your searches or your leads.'],
];
const FAQ = [
  ['What is 1 credit?', 'One Facebook Page read for you. A page that cannot be read costs nothing. Collecting the ads themselves is free.'],
  ['Do I need to install anything?', 'Yes — a small Chrome extension. It opens the Meta Ad Library in your own browser and collects the advertisers; you can keep working in other tabs.'],
  ['Which countries work?', 'Every country the Meta Ad Library covers. You choose the country for each search.'],
  ['Do unused credits expire?', 'Plan credits are added every period. Credits you buy as a pack stay on your account.'],
  ['Can I cancel?', 'Any time — your plan simply does not renew. Your leads stay in your account.'],
];

function Plans({ data }) {
  if (!data) return <div className="h-80 animate-pulse rounded-3xl bg-slate-100 dark:bg-white/5" />;
  return (
    <>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((p) => (
          <div
            key={p.id}
            className={cn(
              'relative flex flex-col rounded-3xl border bg-white p-6 shadow-sm dark:bg-slate-900',
              p.popular ? 'border-indigo-400 shadow-xl shadow-indigo-500/15 ring-2 ring-indigo-500/20' : 'border-slate-200 dark:border-white/10',
            )}
          >
            {p.popular && <span className="absolute -top-3 left-6 rounded-full bg-indigo-600 px-3 py-1 text-xs font-bold text-white">Most popular</span>}
            <h3 className="font-display text-lg font-bold">{p.name}</h3>
            <p className="mt-3">
              <span className="font-display text-4xl font-extrabold tracking-tight">${formatNumber(p.price)}</span>
              <span className="text-sm text-slate-500">{p.price ? ` / ${data.periodDays} days` : ' · once'}</span>
            </p>
            <p className="mt-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">{formatNumber(p.credits)} pages {p.price ? 'every period' : 'to try'}</p>
            <ul className="mt-5 flex-1 space-y-2.5 text-sm text-slate-600 dark:text-slate-300">
              {[...p.features, `${formatNumber(p.searchesPerDay)} searches a day`, `Up to ${formatNumber(p.maxAdsPerSearch)} ads per search`, 'CSV export'].map((x) => (
                <li key={x} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" /> {x}
                </li>
              ))}
              {(p.perks || []).map((k) => (
                <li key={k.key} className={cn('flex gap-2', !k.on && 'text-slate-400 dark:text-slate-500')}>
                  {k.on ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" /> : <X className="mt-0.5 h-4 w-4 shrink-0" aria-label="Not included" />} {k.name}
                </li>
              ))}
            </ul>
            <Link
              to={p.price ? `/signup?plan=${p.id}` : '/signup'}
              className={cn(
                'mt-6 flex h-11 items-center justify-center rounded-xl text-sm font-bold transition',
                p.popular ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'border border-slate-200 hover:border-indigo-300 hover:text-indigo-700 dark:border-white/10',
              )}
            >
              {p.price ? 'Choose ' + p.name : 'Start free'}
            </Link>
          </div>
        ))}
      </div>
      {data.packs?.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-600 dark:text-slate-300">
          <span className="font-semibold">Need more? Credit packs:</span>
          {data.packs.map((k) => (
            <span key={k.id} className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-white/10 dark:bg-slate-900">
              {formatNumber(k.credits)} pages · <b>${formatNumber(k.price)}</b>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export default function Landing({ scrollTo }) {
  const { me } = useAuth();
  const [plans, setPlans] = useState(null);
  const [open, setOpen] = useState(0);
  const pricingRef = useRef(null);
  useEffect(() => {
    api('/public/plans').then(setPlans).catch(() => {});
  }, []);
  useEffect(() => {
    if (scrollTo === 'pricing') setTimeout(() => pricingRef.current?.scrollIntoView({ behavior: 'smooth' }), 150);
  }, [scrollTo]);
  const signupOpen = plans?.signupOpen;
  const free = plans?.plans.find((p) => p.id === 'free');
  const cta = me ? (
    <Link to="/dashboard" className="inline-flex h-12 items-center gap-2 rounded-xl bg-indigo-600 px-6 font-bold text-white shadow-lg shadow-indigo-600/30 transition hover:-translate-y-0.5 hover:bg-indigo-700">
      Open your dashboard <ArrowRight className="h-4 w-4" />
    </Link>
  ) : (
    <Link to={signupOpen === false ? '/login' : '/signup'} className="inline-flex h-12 items-center gap-2 rounded-xl bg-indigo-600 px-6 font-bold text-white shadow-lg shadow-indigo-600/30 transition hover:-translate-y-0.5 hover:bg-indigo-700">
      {signupOpen === false ? 'Log in' : `Start free${free?.credits ? ` — ${free.credits} pages` : ''}`} <ArrowRight className="h-4 w-4" />
    </Link>
  );

  return (
    <div className="min-h-dvh bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-slate-100 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-slate-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark size={34} />
            <span className="font-display text-lg font-extrabold tracking-tight">FB Lead Finder</span>
          </Link>
          <nav className="ml-6 hidden gap-6 text-sm font-medium text-slate-600 md:flex dark:text-slate-300">
            <a href="#how" className="hover:text-indigo-600">How it works</a>
            <a href="#features" className="hover:text-indigo-600">Features</a>
            <a href="#pricing" className="hover:text-indigo-600">Pricing</a>
            <a href="#faq" className="hover:text-indigo-600">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {me ? (
              <Link to="/dashboard" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700">Dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="rounded-xl px-3 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-white/10">Log in</Link>
                {signupOpen !== false && <Link to="/signup" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700">Start free</Link>}
              </>
            )}
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-indigo-400/20 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-40 top-20 h-[30rem] w-[30rem] rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200">
              <Sparkles className="h-3.5 w-3.5" /> Leads from the Meta Ad Library
            </span>
            <h1 className="mt-5 font-display text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              Find businesses that are <span className="bg-gradient-to-r from-indigo-600 to-cyan-500 bg-clip-text text-transparent">advertising right now</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-slate-600 dark:text-slate-300">
              Type a keyword. Get every business running Facebook & Instagram ads for it — with the phone, WhatsApp and email they publish. Ready to call, ready to export.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              {cta}
              <a href="#pricing" className="text-sm font-semibold text-slate-600 hover:text-indigo-600 dark:text-slate-300">See pricing →</a>
            </div>
            <p className="mt-4 text-xs text-slate-500">No card needed · works in any country · cancel any time</p>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="relative">
            <img src="/landing/leads.jpg" alt="The dashboard with leads and their contacts" className="w-full rounded-2xl border border-slate-200 shadow-2xl shadow-indigo-500/10 dark:border-white/10" />
          </motion.div>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/60 py-20 dark:border-white/5 dark:bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight">How it works</h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-slate-600 dark:text-slate-300">Three steps from a keyword to a list you can call.</p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map(([Icon, t, d], i) => (
              <div key={t} className="rounded-3xl border border-slate-200 bg-white p-6 dark:border-white/10 dark:bg-slate-900">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/25"><Icon className="h-5 w-5" /></span>
                  <span className="font-display text-sm font-bold text-indigo-600">STEP {i + 1}</span>
                </div>
                <h3 className="mt-4 font-display text-lg font-bold">{t}</h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{d}</p>
              </div>
            ))}
          </div>
          <img src="/landing/collect.jpg" alt="Collecting advertisers in the Ad Library with the extension" className="mx-auto mt-12 w-full max-w-4xl rounded-2xl border border-slate-200 shadow-xl dark:border-white/10" loading="lazy" />
        </div>
      </section>

      {/* features */}
      <section id="features" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight">Everything you need to prospect</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([Icon, t, d]) => (
              <div key={t} className="rounded-3xl border border-slate-200 p-6 transition hover:-translate-y-0.5 hover:shadow-lg dark:border-white/10">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"><Icon className="h-5 w-5" /></span>
                <h3 className="mt-4 font-display font-bold">{t}</h3>
                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" ref={pricingRef} className="scroll-mt-20 border-t border-slate-100 bg-slate-50/60 py-20 dark:border-white/5 dark:bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight">Simple pricing</h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-slate-600 dark:text-slate-300">
            <b>1 credit = 1 Facebook Page read.</b> Pages that can't be read are free. Collecting ads is always free.
          </p>
          <div className="mt-12"><Plans data={plans} /></div>
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-3xl px-4">
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight">Questions</h2>
          <div className="mt-10 divide-y divide-slate-200 rounded-3xl border border-slate-200 dark:divide-white/10 dark:border-white/10">
            {FAQ.map(([q, a], i) => (
              <div key={q}>
                <button type="button" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i} className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left font-semibold">
                  {q}
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open === i && 'rotate-180')} />
                </button>
                {open === i && <p className="px-6 pb-5 text-sm text-slate-600 dark:text-slate-300">{a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* final call */}
      <section className="px-4 pb-20">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-blue-600 to-cyan-500 px-6 py-14 text-center text-white shadow-2xl shadow-indigo-600/25">
          <h2 className="font-display text-3xl font-extrabold tracking-tight">Your next customers are advertising today</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">Start with free credits. Install the extension, type a keyword, and have a list before your coffee is cold.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to={me ? '/dashboard' : signupOpen === false ? '/login' : '/signup'} className="inline-flex h-12 items-center gap-2 rounded-xl bg-white px-6 font-bold text-indigo-700 hover:bg-indigo-50">
              {me ? 'Open your dashboard' : signupOpen === false ? 'Log in' : 'Create a free account'} <ArrowRight className="h-4 w-4" />
            </Link>
            <span className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/30 px-5 text-sm font-semibold"><Download className="h-4 w-4" /> Chrome extension included</span>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-100 py-8 text-sm text-slate-500 dark:border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4">
          <span className="flex items-center gap-2"><BrandMark size={22} /> © {new Date().getFullYear()} FB Lead Finder</span>
          <span className="flex items-center gap-1.5"><Globe2 className="h-4 w-4" /> specter.monster</span>
          <div className="ml-auto flex gap-5">
            <a href="/privacy.html" className="hover:text-indigo-600">Privacy</a>
            <Link to="/login" className="hover:text-indigo-600">Log in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
