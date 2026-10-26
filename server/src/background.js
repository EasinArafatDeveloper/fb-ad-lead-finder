/** Run work after the response has been sent (e.g. searching a website for an email). Errors are swallowed. */
export function runInBackground(promise) {
  return Promise.resolve(promise).catch(() => {});
}

/**
 * Like runInBackground, but at most `max` at a time; the rest wait in line. The server reader finishes pages
 * fast — without a limit every page would start its own website search at once (docs/ENGINE.md §4 #12).
 */
export function limited(max) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= max || !waiting.length) return;
    running++;
    const job = waiting.shift();
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        running--;
        next();
      });
  };
  const run = (job) => {
    if (waiting.length > 5000) return; // a runaway queue is dropped rather than eating the memory
    waiting.push(job);
    next();
  };
  run.stats = () => ({ running, waiting: waiting.length });
  return run;
}
