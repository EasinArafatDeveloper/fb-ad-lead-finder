const KEY_NAME = 'fblf_key';

export const getKey = () => {
  try {
    return localStorage.getItem(KEY_NAME) || '';
  } catch {
    return '';
  }
};
export const setKey = (k) => {
  try {
    k ? localStorage.setItem(KEY_NAME, k) : localStorage.removeItem(KEY_NAME);
  } catch {
    /* storage blocked */
  }
};

export class AuthError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': getKey() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    window.dispatchEvent(new Event('fblf:logout'));
    throw new AuthError('Wrong API key');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

/** Download a file from the API (the key goes in a header, so a plain link won't do). */
export async function download(path, filename) {
  const r = await fetch('/api' + path, { headers: { 'x-api-key': getKey() } });
  if (!r.ok) throw new Error('Download failed');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
