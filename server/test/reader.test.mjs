// Reader unit tests — no network, no database:  node --test test/reader.test.mjs
// Facebook's real pages are big; these fixtures keep only the parts the reader relies on (docs/ENGINE.md §3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, parsePageHtml } from '../src/pageReader.js';
import { allProxies, parseProxyLine, proxyPool } from '../src/proxies.js';

const item = (typename, text, extra = {}) => ({ timeline_context_item: { renderer: { __typename: typename, context_item: { title: { text } }, ...extra } } });
const pageHtml = (items, { bio = '', followers = '' } = {}) => `<!doctype html><html><head>
<meta property="og:title" content="Agora Travels | Dhaka " /></head><body>
<script type="application/json" data-sjs>${JSON.stringify({
  require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { queryName: 'ProfileCometHeaderQuery', result: { data: { profile_tile_items: { nodes: items.map((node) => ({ node })) } } } } }]]],
})}</script>
<script type="application/json">{"x":{"best_description":{"text":${JSON.stringify(bio)}}${followers ? `,"f":{"text":"${followers} followers"}` : ''}}}</script>
</body></html>`;

const AGORA = pageHtml(
  [
    item('InfluencerCategoryContextItemRenderer', 'Page · Immigration Lawyer · Educational Consultant'),
    item('AddressContextItemRenderer', 'Rupayan FPAB Tower, 1st Floor, Nayapaltan, Dhaka, Bangladesh'),
    item('ContextItemDefaultRenderer', '+880 1811-998884'),
    // Facebook reuses the next item's title for the WhatsApp item — only its link counts
    item('WhatsappNumberIntroCardItemRenderer', 'agoratravelsbd.com', { wa_link: 'https://api.whatsapp.com/send?phone=8801811998884&token=x' }),
    item('ContextItemDefaultRenderer', 'info@agoratravelsbd.com'),
    item('WebsiteContextItemRenderer', 'agoratravelsbd.com', { url: 'https://l.facebook.com/l.php?u=http%3A%2F%2Fwww.agoratravelsbd.com%2F&h=x' }),
    item('BusinessHoursContextItemRenderer', 'Always open'),
  ],
  { bio: 'First World visa process', followers: '133K' },
);

test('ok: the Intro card becomes phones, email, WhatsApp, address, category, website, bio', () => {
  const out = classify({ status: 200, url: 'https://www.facebook.com/agoratbd/', html: AGORA });
  assert.equal(out.kind, 'ok');
  const r = out.result;
  assert.equal(r.pageName, 'Agora Travels | Dhaka ');
  assert.equal(r.pageCategory, 'Immigration Lawyer · Educational Consultant');
  assert.match(r.address, /Rupayan FPAB Tower/);
  assert.deepEqual(r.phones, ['+880 1811-998884']);
  assert.deepEqual(r.emails, ['info@agoratravelsbd.com']);
  assert.deepEqual(r.whatsapp, ['8801811998884']);
  assert.ok(r.links.some((l) => l.includes('agoratravelsbd.com')));
  assert.equal(r.pageBio, 'First World visa process');
  assert.equal(r.followers, '133K');
  const lines = r.sections.Page.split('\n');
  assert.equal(lines.filter((l) => l === 'agoratravelsbd.com').length, 1, "the WhatsApp item's borrowed title is not a value of its own");
});

test('ok: a Page without an Intro card is a result with no contact — not an error', () => {
  const out = classify({ status: 200, url: 'u', html: pageHtml([]) });
  assert.equal(out.kind, 'ok');
  assert.deepEqual([out.result.phones, out.result.emails], [[], []]);
});

test('unavailable: "This content isn\'t available" (no profile + CometErrorRoot) and 404', () => {
  const err = '<html><script>{"__dr":"CometErrorRoot.react","props":{"title":"This content isn\'t available right now"}}</script></html>';
  assert.equal(classify({ status: 200, html: err }).kind, 'unavailable');
  assert.equal(classify({ status: 200, html: err }).result.notFound, true);
  assert.equal(classify({ status: 404, html: '' }).kind, 'unavailable');
});

test('wall: a redirect to the login page, or a login form without a profile', () => {
  assert.equal(classify({ login: true, url: 'https://www.facebook.com/login/' }).kind, 'wall');
  assert.equal(classify({ status: 200, html: '<form id="login_form"></form>' }).kind, 'wall');
  // a Page that merely contains a login form somewhere is still a Page
  assert.equal(classify({ status: 200, html: AGORA + '<form id="login_form"></form>' }).kind, 'ok');
});

test('neterror: no answer, 407 from the proxy, Facebook 5xx', () => {
  assert.equal(classify({ error: 'UND_ERR_CONNECT_TIMEOUT' }).kind, 'neterror');
  assert.equal(classify({ status: 407 }).kind, 'neterror');
  assert.equal(classify({ status: 0 }).kind, 'neterror');
  assert.equal(classify({ status: 502, html: 'x' }).kind, 'neterror');
});

test('unknown: an answer that is none of the above', () => {
  assert.equal(classify({ status: 200, html: '<html>something new</html>' }).kind, 'unknown');
});

test('parsePageHtml never throws on broken JSON', () => {
  const r = parsePageHtml('<script type="application/json">{"timeline_context_item": broken</script>ProfileCometHeaderQuery', 'u');
  assert.equal(r.introItems, 0);
});

test('proxy list lines', () => {
  assert.deepEqual(parseProxyLine('p.webshare.io:80:user-1:pa:ss'), { host: 'p.webshare.io', port: 80, user: 'user-1', pass: 'pa:ss' });
  assert.equal(parseProxyLine('not a proxy'), null);
  assert.equal(parseProxyLine('host:99999:u:p'), null);
  const pool = proxyPool({ proxyEnabled: true, proxyList: 'a.com:80:u1:p\n# comment\n\nb.com:81:u2:p' });
  assert.deepEqual(pool.map((p) => p.id), ['a.com:80:u1', 'b.com:81:u2']);
  assert.equal(proxyPool({ proxyEnabled: false, proxyList: 'a.com:80:u:p' }).length, 0, 'proxy off = no pool');
});

test('proxy groups: Static and Rotating, each switched on/off', () => {
  const s = { proxyEnabled: true, proxyList: 'a.com:80:u1:p\nb.com:81:u2:p', resiList: 'p.webshare.io:80:u-gb-1:p\np.webshare.io:80:u-ca-2:p' };
  assert.deepEqual(proxyPool(s).map((p) => p.group), ['static', 'static'], 'old settings (no switches): static only, as before');
  const both = proxyPool({ ...s, resiOn: true });
  assert.deepEqual(both.map((p) => p.id), ['a.com:80:u1', 'b.com:81:u2', 'p.webshare.io:80:u-gb-1', 'p.webshare.io:80:u-ca-2']);
  const rotOnly = proxyPool({ ...s, resiOn: true, proxyStaticOn: false });
  assert.deepEqual(rotOnly.map((p) => p.group), ['rotating', 'rotating'], 'static off → only the rotating lines');
  assert.equal(proxyPool({ ...s, resiOn: true, proxyEnabled: false }).length, 0, 'the main switch still turns everything off');
  assert.equal(allProxies({ ...s, proxyStaticOn: false, proxyEnabled: false }).length, 4, 'allProxies: both lists, switches ignored');
});
