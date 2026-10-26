import { useMemo } from 'react';
import { getCountries, getCountryCallingCode, isValidPhoneNumber } from 'libphonenumber-js';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';

const names = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/** Every country: { code: 'BD', name: 'Bangladesh', dial: '880', flag: '🇧🇩' }, by name. */
export const PHONE_COUNTRIES = getCountries()
  .map((code) => ({ code, name: names?.of(code) || code, dial: getCountryCallingCode(code), flag: flag(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Country select + phone input that shows the dialing code and formats the number while typing. */
export default function PhoneField({ country, onCountry, phone, onPhone, idPrefix = 'ph' }) {
  const c = useMemo(() => PHONE_COUNTRIES.find((x) => x.code === country) || null, [country]);
  const valid = !!(c && phone && isValidPhoneNumber(phone, country));
  return (
    <>
      <label htmlFor={`${idPrefix}-country`} className="label mt-4">Country</label>
      <select id={`${idPrefix}-country`} className="input" value={country} onChange={(e) => onCountry(e.target.value)} required>
        <option value="" disabled>Choose your country</option>
        {PHONE_COUNTRIES.map((x) => (
          <option key={x.code} value={x.code}>{x.flag} {x.name} (+{x.dial})</option>
        ))}
      </select>

      <label htmlFor={`${idPrefix}-phone`} className="label mt-4">Phone number</label>
      <div className={cn('input flex items-center gap-2 py-0 pr-2 focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10', !c && 'opacity-60')}>
        <span className="flex shrink-0 items-center gap-1.5 border-r border-slate-200 py-2.5 pr-2.5 text-sm font-semibold text-slate-600 dark:border-white/10 dark:text-slate-300">
          <span aria-hidden="true">{c?.flag || '🌐'}</span> +{c?.dial || '…'}
        </span>
        <input
          id={`${idPrefix}-phone`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          disabled={!c}
          placeholder={c ? 'Your number' : 'Choose your country first'}
          className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-sm outline-none focus:ring-0"
          value={phone}
          onChange={(e) => onPhone(e.target.value.replace(/[^\d+\s()-]/g, '').slice(0, 24))}
          required
        />
        {valid && <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Valid number" />}
      </div>
      {c && phone && !valid && <p className="mt-1 text-[11px] text-slate-500">Type the full number (e.g. {c.code === 'BD' ? '01712 345678' : 'your mobile number'}) — the +{c.dial} is added for you.</p>}
    </>
  );
}
