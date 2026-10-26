// "New pages are waiting" — bumped wherever pages join the queue, so the page queue (pageQueue.js) sees a
// customer who just added pages at once instead of after its 5 s refresh. Its own module: no import cycle.
let version = 0;
export const queueChanged = () => {
  version++;
};
export const queueVersion = () => version;
