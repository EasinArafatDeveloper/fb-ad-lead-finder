// Talks to the server. The login is an httpOnly session cookie, sent automatically with every request.
export class AuthError extends Error {}

/** JSON gzipped in the browser — a big workbook goes up ~10x smaller (the server unpacks it). */
async function gzipJson(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function call(path, { method = 'GET', body, gzip = false } = {}) {
  const zipped = gzip && body !== undefined && typeof CompressionStream === 'function';
  const headers = body !== undefined ? { 'content-type': 'application/json', ...(zipped ? { 'content-encoding': 'gzip' } : {}) } : undefined;
  const r = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : zipped ? await gzipJson(body) : JSON.stringify(body),
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

/** A search was queued: wake the extension on this PC so it starts now (extension/content/dashboard.js). */
export const kickExtension = () => {
  try {
    window.postMessage({ __fblf: true, type: 'kick' }, window.location.origin);
  } catch {
    /* no extension here — it picks the search up within 30 s */
  }
};
/** The extension version listening on this page, or '' (set by extension/content/dashboard.js). */
export const extensionHere = () => document.documentElement.dataset.fblfExtension || '';

export const qs =(o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
