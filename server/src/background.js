/**
 * Run work after the response has been sent (e.g. searching a website for an email).
 * Locally the process keeps running anyway. On Vercel a function is frozen right after it responds,
 * so there we hand the promise to Vercel's waitUntil(), which keeps the function alive until it finishes.
 */
let waitUntil = null;
if (process.env.VERCEL) {
  try {
    ({ waitUntil } = await import('@vercel/functions'));
  } catch {
    /* package missing — fall back to plain fire-and-forget */
  }
}

export function runInBackground(promise) {
  const p = Promise.resolve(promise).catch(() => {});
  if (waitUntil) waitUntil(p);
  return p;
}
