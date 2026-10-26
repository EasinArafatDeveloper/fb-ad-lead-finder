// Runs on the dashboard (specter.monster / localhost).
//  - "kick": a search was started there → the extension asks the server for work right away
//  - "connect": the account's own extension key from /connect-extension → saved in the extension
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__fblf !== true) return;
  try {
    if (e.data.type === 'kick') chrome.runtime.sendMessage({ type: 'popup:kick' }).catch(() => {});
    if (e.data.type === 'connect' && typeof e.data.key === 'string' && e.data.key.startsWith('ext_')) {
      chrome.runtime
        .sendMessage({ type: 'ext:connect', key: e.data.key, server: location.origin })
        .then((r) => window.postMessage({ __fblf: true, type: r && r.ok ? 'connected' : 'connect-failed', error: r && r.error }, location.origin))
        .catch((err) => window.postMessage({ __fblf: true, type: 'connect-failed', error: String(err && err.message) }, location.origin));
    }
  } catch {
    /* the extension was reloaded — reload the page */
  }
});
// tell the dashboard an extension is listening here
document.documentElement.dataset.fblfExtension = chrome.runtime.getManifest().version;
