import { forwardRef, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, animate } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';

// ---------------- Button ----------------
const VARIANTS = {
  primary: 'bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow-md shadow-indigo-600/25 hover:shadow-lg hover:shadow-indigo-600/30 hover:-translate-y-px',
  outline: 'border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:border-slate-300 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-white/5',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
  soft: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25',
};
const SIZES = { sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg', md: 'h-10 px-4 text-sm gap-2 rounded-xl', lg: 'h-11 px-5 text-sm gap-2 rounded-xl', icon: 'h-9 w-9 rounded-xl' };

export const Button = forwardRef(function Button({ variant = 'outline', size = 'md', loading, className, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});

/** Primary CTA with a light sweep (same as the SMS app's "New campaign" button). */
export function ShimmerButton({ className, children, ...props }) {
  return (
    <button
      className={cn(
        'group relative inline-flex h-11 items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 px-5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98] disabled:opacity-60',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent motion-safe:animate-shimmer" />
      <span className="relative inline-flex items-center gap-2">{children}</span>
    </button>
  );
}

// ---------------- Badge ----------------
const TONES = {
  slate: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/5 dark:text-slate-300 dark:ring-white/10',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30',
};
export function Badge({ tone = 'slate', dot, className, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', TONES[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full bg-current', dot === 'pulse' && 'animate-pulse')} />}
      {children}
    </span>
  );
}

// ---------------- Number ticker ----------------
export function NumberTicker({ value }) {
  const ref = useRef(null);
  const prev = useRef(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const to = Number(value) || 0;
    if (reduce) {
      node.textContent = to.toLocaleString('en-US');
      prev.current = to;
      return;
    }
    const controls = animate(prev.current, to, {
      duration: 0.9,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => (node.textContent = Math.round(v).toLocaleString('en-US')),
    });
    prev.current = to;
    return () => controls.stop();
  }, [value]);
  return <span ref={ref} className="tabular-nums">0</span>;
}

// ---------------- KPI card ----------------
const KPI = {
  indigo: { tile: 'from-indigo-500 to-violet-600 shadow-indigo-500/30', glow: 'bg-indigo-500' },
  blue: { tile: 'from-blue-500 to-sky-600 shadow-blue-500/30', glow: 'bg-blue-500' },
  emerald: { tile: 'from-emerald-500 to-teal-600 shadow-emerald-500/30', glow: 'bg-emerald-500' },
  amber: { tile: 'from-amber-500 to-orange-600 shadow-amber-500/30', glow: 'bg-amber-500' },
  rose: { tile: 'from-rose-500 to-red-600 shadow-rose-500/30', glow: 'bg-rose-500' },
};
export function KpiCard({ label, value, sub, icon: Icon, tone = 'indigo', suffix }) {
  const t = KPI[tone];
  return (
    <div className="group relative h-full overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/10 dark:border-white/10 dark:bg-slate-900">
      <span aria-hidden="true" className={cn('pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full opacity-[0.14] blur-2xl transition-opacity group-hover:opacity-25', t.glow)} />
      <div className="relative flex items-start justify-between">
        <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</span>
        <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg ring-1 ring-white/30', t.tile)}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
      <p className="relative mt-3 font-display text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        <NumberTicker value={value} />
        {suffix && <span className="text-lg font-bold text-slate-400">{suffix}</span>}
      </p>
      {sub && <p className="relative mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">{sub}</p>}
    </div>
  );
}

// ---------------- Page header ----------------
export function PageHeader({ title, subtitle, icon: Icon, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-lg shadow-indigo-500/25">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
        )}
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------- Modal ----------------
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // rendered on <body> so a parent with blur/transform (e.g. the sticky header) can't clip it
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn('relative w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-slate-900', width)}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-bold">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10">
                <X className="h-5 w-5" />
              </button>
            </div>
            {children}
            {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Small prompt modal (rename / new folder). */
export function PromptModal({ open, title, label, initial = '', confirmText = 'Save', onClose, onSubmit }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-md">
      <form onSubmit={submit}>
        <label className="label" htmlFor="prompt-input">{label}</label>
        <input id="prompt-input" autoFocus className="input" value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!value.trim()}>{confirmText}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------- misc ----------------
export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-16 text-center dark:border-white/10 dark:bg-slate-900/40">
      {Icon && (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Icon className="h-7 w-7" aria-hidden="true" />
        </span>
      )}
      <h3 className="font-display text-base font-bold">{title}</h3>
      {text && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cn('animate-pulse rounded-xl bg-slate-200/70 dark:bg-white/5', className)} />;
}

export function Progress({ value }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <motion.div
        className="h-full w-full origin-left rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: Math.min(100, Math.max(0, value)) / 100 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
    </div>
  );
}
