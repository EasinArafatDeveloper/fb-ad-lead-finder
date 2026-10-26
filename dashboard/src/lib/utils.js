import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs) => twMerge(clsx(inputs));

export const formatNumber = (n) => new Intl.NumberFormat('en-US').format(Number(n) || 0);

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export const timeAgo = (d) => {
  if (!d) return '';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** Only http(s) links may become an href — scraped data comes from strangers (no javascript: links). */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : undefined);

export const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

export const COUNTRIES = [
  ['BD', 'Bangladesh'], ['IN', 'India'], ['PK', 'Pakistan'], ['US', 'United States'], ['GB', 'United Kingdom'],
  ['CA', 'Canada'], ['AU', 'Australia'], ['AE', 'UAE'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'], ['KW', 'Kuwait'],
  ['OM', 'Oman'], ['MY', 'Malaysia'], ['SG', 'Singapore'], ['ALL', 'All countries'],
];

export const STATUSES = ['New', 'Contacted', 'Interested', 'Not Interested', 'Closed'];

export const PHASE = {
  collecting: { label: 'Collecting ads', tone: 'indigo' },
  queued: { label: 'Queued', tone: 'slate' },
  scraping: { label: 'Scraping pages', tone: 'amber' },
  done: { label: 'Done', tone: 'emerald' },
  collected: { label: 'Collected', tone: 'slate' },
  stopped: { label: 'Stopped', tone: 'rose' },
};
