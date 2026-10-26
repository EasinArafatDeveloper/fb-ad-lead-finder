const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = 'msg ' + kind;
}

// a customer's own key (ext_…) — the team's computers use the worker key
const isCustomerKey = (key) => /^ext_/.test(String(key || ''));

/** A customer sees only their own account; the worker switch, server and key are for the team's computers. */
function customerMode(on) {
  for (const el of document.querySelectorAll('.team-only')) el.hidden = on;
}

function renderStats(s) {
  if (s.customer) customerMode(true);
  const stats = s.customer
    ? [
        ['Leads', s.leads],
        ['Waiting', s.waiting],
        ['Read today', s.readToday],
        ['Searches', s.searches],
        ...(s.credits == null ? [] : [['Credits', s.credits]]),
      ]
    : [
        ['Pages', s.pages],
        ['Queue', s.pending],
        ['Today', `${s.doneToday}/${s.dailyLimit}`],
        ['Searches', s.queuedJobs + s.collecting],
      ];
  if (!s.customer && s.proxy) {
    stats.push(['Proxy', s.proxy.enabled ? 'Active' : 'Off']);
  }
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
  const customer = isCustomerKey(cfg.apiKey);
  customerMode(customer);
  const lines = [];
  if (customer) {
    // plain words for a customer — no engine terms
    const c = String(status.collector || '');
    if (/outdated/i.test(c)) lines.push('⚠ ' + c);
    else if (/collect|scroll/i.test(c)) lines.push('Searching the Ad Library…');
    else if (cfg.apiKey) lines.push('Connected — your searches start here automatically');
    if (status.error && !/proxy/i.test(status.error)) lines.push('⚠ ' + status.error);
  } else {
    if (status.collector) lines.push('Ad Library: ' + status.collector);
    if (status.scraper) lines.push('Pages: ' + status.scraper);
    if (status.error) lines.push('⚠ ' + status.error);
  }
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
  // The extension has access to Facebook, localhost and the default server by itself.
  // A server on any other address needs a one-time permission.
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
  chrome.tabs.create({ url: url + '/dashboard' });
};
// log in on the dashboard and press "Connect this computer" — the page hands this extension its own key
$('connect').onclick = async () => {
  const url = ($('serverUrl').value.trim() || 'http://localhost:3002').replace(/\/+$/, '');
  chrome.tabs.create({ url: url + '/connect-extension' });
};

refresh();
