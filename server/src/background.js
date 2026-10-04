/** Run work after the response has been sent (e.g. searching a website for an email). Errors are swallowed. */
export function runInBackground(promise) {
  return Promise.resolve(promise).catch(() => {});
}
