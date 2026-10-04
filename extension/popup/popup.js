const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = 'msg ' + kind;
}

function renderStats(s) {
  const stats = [
    ['Pages', s.pages],
    ['Queue', s.pending],
    ['Today', `${s.doneToday}/${s.dailyLimit}`],
    ['Searches', s.queuedJobs + s.collecting],
  ];
  $('stats').replaceChildren(
    ...stats.map(([k, v]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      const span = document.createElement('span');
      b.textContent = v ?? '–';
      span.textContent = k;
      d.append(b, span);
      return d;
    }),
  );
  $('dot').className = 'dot ' + (s.running ? 'ok' : 'paused');
}

async function refresh() {
  const { cfg, status } = await send({ type: 'popup:status' });
  $('serverUrl').value = cfg.serverUrl;
  $('apiKey').value = cfg.apiKey;
  $('enabled').checked = cfg.enabled;
  const lines = [];
  if (status.collector) lines.push('Ad Library: ' + status.collector);
  if (status.scraper) lines.push('Pages: ' + status.scraper);
  if (status.error) lines.push('⚠ ' + status.error);
  $('state').textContent = lines.join('\n');
  if (!cfg.apiKey) return;
  const s = await send({ type: 'popup:stats' });
  if (s && s.ok === false) {
    $('dot').className = 'dot err';
    showMsg(s.error, 'err');
  } else renderStats(s);
}

$('save').onclick = async () => {
  let serverUrl = ($('serverUrl').value.trim() || 'http://localhost:3002').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(serverUrl)) serverUrl = 'https://' + serverUrl;
  // The extension only has access to Facebook, localhost and *.vercel.app by default.
  // A server on any other address (e.g. your own domain) needs a one-time permission.
  try {
    const origin = new URL(serverUrl).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return showMsg('Permission to connect to this server was not granted', 'err');
    }
  } catch {
    return showMsg('Invalid server URL', 'err');
  }
  showMsg('Connecting…');
  const r = await send({
    type: 'popup:saveCfg',
    cfg: { serverUrl, apiKey: $('apiKey').value.trim(), enabled: $('enabled').checked },
  });
  if (r.ok === false) return showMsg(r.error, 'err');
  renderStats(r.stats);
  showMsg('Connected ✓', 'ok');
};

$('open').onclick = async () => {
  const url = ($('serverUrl').value.trim() || 'http://localhost:3002').replace(/\/+$/, '');
  chrome.tabs.create({ url: url + '/' });
};

refresh();
