import { useId } from 'react';

/** Windows 11 style folder. `peek` shows a document sticking out (folder has content). */
export function FolderIcon({ size = 96, peek = false, accent = false, className }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size * 0.83} viewBox="0 0 96 80" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBBF24" />
          <stop offset="1" stopColor="#E9A006" />
        </linearGradient>
        <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE58A" />
          <stop offset="1" stopColor="#FFCB3D" />
        </linearGradient>
        <filter id={`s${id}`} x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#92400e" floodOpacity="0.18" />
        </filter>
      </defs>
      <path d="M6 11a6 6 0 0 1 6-6h21.6a6 6 0 0 1 4.4 1.9l4.6 5a6 6 0 0 0 4.4 1.9H84a6 6 0 0 1 6 6V70a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill={`url(#b${id})`} />
      {peek && (
        <g>
          <rect x="18" y="13" width="54" height="40" rx="3" fill="#fff" stroke="#e5e7eb" />
          <rect x="18" y="13" width="54" height="8" rx="3" fill={accent ? '#10b981' : '#6366f1'} />
          {[26, 32, 38, 44].map((y) => (
            <rect key={y} x="23" y={y} width={y % 12 ? 38 : 30} height="2.6" rx="1.3" fill="#cbd5e1" />
          ))}
        </g>
      )}
      <path filter={`url(#s${id})`} d="M4 29a6 6 0 0 1 6-6h76a6 6 0 0 1 6 6v41a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6Z" fill={`url(#f${id})`} />
      <path d="M10 23.9h76" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.4" />
    </svg>
  );
}

/** Spreadsheet file (Google Sheets–like green page with a table). */
export function SheetIcon({ size = 96, className, tone = 'green' }) {
  const id = useId().replace(/:/g, '');
  const [a, b] = tone === 'blue' ? ['#60a5fa', '#2563eb'] : ['#34d399', '#059669'];
  return (
    <svg width={size} height={size * 0.83} viewBox="0 0 96 80" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
        <filter id={`s${id}`} x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#064e3b" floodOpacity="0.2" />
        </filter>
      </defs>
      <g filter={`url(#s${id})`}>
        <path d="M26 4h32l16 16v52a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z" fill={`url(#g${id})`} />
        <path d="M58 4v12a4 4 0 0 0 4 4h12Z" fill="#fff" fillOpacity="0.45" />
      </g>
      <rect x="31" y="34" width="34" height="30" rx="2" fill="#fff" />
      <path d="M31 44h34M31 54h34M43 34v30" stroke={b} strokeWidth="2" />
    </svg>
  );
}
