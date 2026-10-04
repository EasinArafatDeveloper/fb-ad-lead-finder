// Injected by the background worker into a Facebook Page tab. Defines window.__fblfRead().
// It only READS the page (no clicking — clicking FB's menu can trigger a full navigation that kills
// the script). The background opens each About sub-section by URL and calls this on every one.
window.__fblfRead = async function () {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const NAV = [
      'intro', 'overview', 'category', 'details', 'links', 'contact info', 'contact and basic info', 'basic info',
      'privacy and legal info', 'page transparency', 'websites and social links', 'services',
    ];
    const mainEl = () => document.querySelector('[role="main"]') || document.body;
    const readText = () => (mainEl() && mainEl().innerText) || '';

    // wait until the page has rendered and the text stops changing (checks every 350 ms; as soon as a
    // contact label is on screen one stable check is enough)
    let last = '';
    let stable = 0;
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const t = readText();
      if (t.length > 150 && t === last) {
        stable++;
        if (stable >= 2 || (stable >= 1 && /\n(mobile|phone|email|whatsapp|email address|contact info|website)\n/i.test(t))) break;
      } else stable = 0;
      last = t;
      await sleep(350);
    }

    const href = location.href;
    const bodyText = document.body ? document.body.innerText : '';
    if (/\/(checkpoint|login)(\/|\.php|$)/.test(location.pathname) || /you(?:'|’)re temporarily blocked|temporarily blocked from/i.test(bodyText)) {
      return { blocked: true, finalUrl: href };
    }
    if (document.querySelector('input[name="pass"]') && bodyText.length < 5000 && !/contact|about/i.test(readText())) {
      return { loggedOut: true, finalUrl: href };
    }
    if (/(this content isn(?:'|’)t available|this page isn(?:'|’)t available)/i.test(bodyText) && bodyText.length < 4000) {
      return { notFound: true, finalUrl: href };
    }

    const links = [];
    const navLinks = [];
    const seenNav = new Set();
    mainEl().querySelectorAll('a[href]').forEach((a) => {
      const text = (a.innerText || '').trim();
      links.push([a.href, text.slice(0, 200)]);
      const key = text.toLowerCase();
      if (NAV.includes(key) && !seenNav.has(key) && /facebook\.com/.test(a.hostname) && /about|sk=about/.test(a.href) && a.href !== href) {
        seenNav.add(key);
        navLinks.push({ label: text, href: a.href });
      }
    });

    const pageName =
      [...mainEl().querySelectorAll('h1')].map((h) => h.innerText.trim()).filter((t) => t && !/^(notifications|chats|menu|facebook)$/i.test(t))[0] || '';
    const followers = bodyText.match(/([\d.,]+\s*[KkMm]?)\s+followers/);
    const likes = bodyText.match(/([\d.,]+\s*[KkMm]?)\s+likes/);

    // ---- the Page's own info block (main tab): header under the name + the Intro / Details / Contact info box.
    // Posts come after it and are left out, so numbers/emails from other people's posts don't sneak in.
    // (invisible zero-width characters removed — Facebook sometimes puts them at the start of the bio)
    const lines = readText().split('\n').map((x) => x.replace(/[​-‍﻿]/g, '').trim()).filter(Boolean);
    // buttons in the Page header (logged in) — never a bio or category
    const BUTTON = /^(message|follow|following|search|like|liked|share|send message|message us|whatsapp|send whatsapp message|call now|call|book now|shop now|order now|start order|contact us|sign up|learn more|get quote|send email|email|visit website|see menu|get directions|apply now|donate|play game|use app|watch video|listen|subscribe|join|invite|more)$/i;
    const NOT_BIO = /^(not yet rated|\d+% recommend|\d+(\.\d)? \(|\d+ reviews?|always open|open now|closed now|opens |closes |price range)/i;
    const TAB = /^(all|posts|about|reels|photos|videos|mentions|more|events|reviews|community|live|groups)$/i;
    const fIdx = lines.findIndex((l) => /\bfollowers\b|\blikes\b/i.test(l));
    const header = [];
    if (fIdx >= 0) {
      for (let i = fIdx + 1; i < lines.length && i < fIdx + 10 && !TAB.test(lines[i]); i++) {
        if (!/status indicator/i.test(lines[i]) && !BUTTON.test(lines[i])) header.push(lines[i]);
      }
    }
    const start = lines.findIndex((l, i) => i > fIdx && /^(intro|details|contact info)$/i.test(l));
    const introBlock = [];
    if (start >= 0) {
      for (let i = start; i < lines.length && i < start + 40; i++) {
        if (i > start && /^(photos|see all photos|featured|posts|privacy|filters|see all|reels|followers)$/i.test(lines[i])) break;
        introBlock.push(lines[i]);
      }
    }
    const cand = [...header, ...introBlock.filter((l) => !/^(intro|details|contact info|links|services)$/i.test(l))];
    const pageBio =
      cand.find((l) => l.length >= 25 && !NOT_BIO.test(l) && !/^Page\s*[·•]/.test(l) && !/^[+\d\s()-]+$/.test(l) && !/^\S+@\S+$/.test(l) && !/,\s*(dhaka|bangladesh)/i.test(l)) || '';
    // category: "Page · X", else the short line in the header after the bio (Facebook puts it last)
    // Facebook categories are plain English words ("Computer shop", "Health/beauty") — not prices, emoji text or usernames
    const isCat = (l) =>
      l !== pageBio && l.split(' ').length <= 5 && !BUTTON.test(l) && !NOT_BIO.test(l) && /^[A-Z][A-Za-z &/,'().-]{1,40}$/.test(l) && !/[a-z][A-Z]/.test(l);
    const pageCat = cand.map((l) => l.match(/^Page\s*[·•]\s*(.+)$/)?.[1]).find(Boolean) || [...header].reverse().find(isCat) || '';

    return {
      finalUrl: href,
      intro: [...header, ...introBlock].join('\n'),
      pageBio,
      pageCategory: pageCat,
      text: readText().slice(0, 20000),
      links: links.slice(0, 300),
      navLinks,
      pageName,
      followers: followers ? followers[1].trim() : '',
      likes: likes ? likes[1].trim() : '',
    };
  } catch (e) {
    return { error: 'Extractor: ' + String((e && e.message) || e) };
  }
};
