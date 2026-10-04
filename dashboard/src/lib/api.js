// Talks to the server. The login is an httpOnly session cookie, sent automatically with every request.
export class AuthError extends Error {}

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return r;
}

export async function api(path, opts) {
  const r = await call(path, opts);
  if (r.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('fblf:logout'));
    throw new AuthError('Please log in again');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

/** Download a file from the API and save it with this name. */
export async function download(path, filename) {
  const r = await call(path);
  if (r.status === 401) window.dispatchEvent(new Event('fblf:logout'));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
