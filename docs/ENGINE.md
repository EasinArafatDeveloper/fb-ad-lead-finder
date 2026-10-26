# Lead engine — নকশা (design)

এই ডকুমেন্ট বলে: কোন অংশ কী করে, একটা Facebook পেজ কোন কোন অবস্থার (state) মধ্য দিয়ে যায়, কী কী সমস্যা হতে পারে, আর
প্রতিটা সমস্যা **কে** সামলায় ও **কীভাবে**। কোড বদলালে এই ডকুমেন্টও বদলাতে হবে।

## ১. অংশগুলো (components) — কে কী করে

| অংশ | ফাইল | দায়িত্ব | কী করে না |
|---|---|---|---|
| **Collector** (Chrome extension) | `extension/` | Ad Library খুলে ad সংগ্রহ করে, server-এ পাঠায়। Proxy ছাড়া (সরাসরি)। | পেজ পড়ে না (server mode-এ) |
| **Queue** | `server/src/pageQueue.js` | পেজের অবস্থা বদলানোর **একমাত্র** জায়গা: claim, release, done, fail, Chrome-কে দেওয়া। নিজে থেকে সেরে ওঠা (janitor)। | Facebook-এ যায় না |
| **Reader** | `server/src/pageReader.js` | একটা পেজ একটা proxy IP দিয়ে আনে, HTML থেকে Intro কার্ড বের করে, উত্তরকে ৫ ভাগের একটায় ফেলে (নিচে দেখুন)। | অবস্থা বদলায় না |
| **Server reader** | `server/src/serverReader.js` | কয়েকটা lane একসাথে চালায়; প্রতিটা lane: IP নাও → পেজ নাও → পড়ো → ফল Queue-কে দাও। | সিদ্ধান্ত Queue/Proxy pool-এর |
| **Proxy pool** | `server/src/proxies.js` | কোন IP এখন ব্যবহার করা যাবে; login wall-এ IP বিশ্রাম; IP-প্রতি বিরতি (ipGapSec)। | পেজ চেনে না |
| **Results** | `server/src/leads.js` (`applyResult`) | পড়া ফল পেজে আর প্রতিটা workspace-এর লিডে লেখে; ওয়েবসাইট থেকে ইমেইল খোঁজে (সীমিত সংখ্যায়)। | |
| **Worker API** | `server/src/worker.js` | Extension-এর জন্য HTTP; ভেতরে Queue-এর একই function ডাকে। | নিজস্ব নিয়ম রাখে না |

**মূল নিয়ম:** server mode = proxy list আছে **এবং** "Read pages on the server" চালু। তখন server পেজ পড়ে, Chrome শুধু ad আনে
(আর খুব কম কিছু পেজ — নিচে "chrome")। Proxy list না থাকলে পুরনো পদ্ধতি: Chrome পেজ পড়ে।

## ২. একটা পেজের জীবন (state machine)

```
 Ad Library থেকে নতুন ─► pending ──claim──► working ──► done        (পড়া শেষ: কন্টাক্টসহ, কন্টাক্ট ছাড়া, বা "Page not available")
                           ▲   ▲               │
                           │   └──release──────┤  (network/proxy error, login wall, server restart — পেজের দোষ না, retry খরচ নেই)
                           │                   ├──► pending + needsBrowser   (server ৩ বার চিনতে পারেনি → Chrome পড়বে)
                           │                   └──► failed             (৩ বার সত্যিকারের error, ৬টা IP-তে login wall, বা ২৪ ঘণ্টায়ও Chrome পড়েনি)
                           │
 Stop ─► stopped ──Continue / নতুন সার্চে আবার পাওয়া গেলে──┘
```

| অবস্থা | মানে | কে বদলায় |
|---|---|---|
| `pending` | পড়ার অপেক্ষায় | Queue |
| `working` | একটা lane বা Chrome এখন পড়ছে (`claimedBy`: `server`/`chrome`, `claimedAt`) | Queue.claim |
| `done` | শেষ। `lastError: "Page not available"` হলে পেজটা বন্ধ/লুকানো | Results |
| `failed` | ছেড়ে দেওয়া হয়েছে, কারণ `lastError`-এ লেখা | Queue / Results |
| `stopped` | ইউজার Stop চেপেছেন, আর কেউ চায় না | projects.js |
| `needsBrowser: true` (pending-এর সাথে, `chromeSince`) | শুধু Chrome এটা পড়বে | Queue |

গণনা (page-এ রাখা): `retries` (সত্যিকারের error, ৩-এ failed), `loginWalls` (৬-এ failed), `serverMisses` (৩-এ chrome)।
Network/proxy error কোনো গণনা বাড়ায় না।

**কার page আগে পড়া হবে — পালা করে (fair queue):** প্রত্যেক customer-এর আলাদা লাইন। একটা lane খালি হলে
যে customer সবচেয়ে বেশি সময় পালা পায়নি, তার লাইনের সবচেয়ে পুরনো page নেয়। Paid plan প্রতি পালায় ২টা page
পায়, free ১টা (Admin → Plans → "Pages per turn")। একা থাকলে পুরো গতি; কিছুক্ষণ পরে ফিরলে জমানো পালা পায় না;
credit -overdraft-এ গেলে তার লাইন থামে। নিয়ম: `pageQueue.js` (`claimPage`), ভাগ: `billing.js` (`fundedShares`)।

## ৩. Reader-এর উত্তর — ৫ ভাগ

| ভাগ | কীভাবে চেনা হয় | Queue যা করে | IP-এর কী হয় |
|---|---|---|---|
| **ok** | HTML-এ `ProfileCometHeaderQuery` / `profile_tile_items` আছে | done (Intro কার্ড না থাকলে "no contact") | `pages+1`, wall-বিরতির ধাপ শূন্য |
| **unavailable** | প্রোফাইল নেই + `CometErrorRoot` ("This content isn't available"), বা HTTP 404 | done, "Page not available" | কিছু না |
| **wall** | `/login` বা `/checkpoint`-এ redirect, বা প্রোফাইল ছাড়া login form | release (`loginWalls+1`) | ওই IP বিশ্রাম: ৩০ → ৬০ → ১২০ → সর্বোচ্চ ২৪০ মিনিট |
| **neterror** | proxy connect হয়নি, 407, timeout, HTTP 5xx | release (কোনো গণনা না) | ওই IP ১০ মিনিট বিশ্রাম |
| **unknown** | প্রোফাইল নেই, error পাতাও না | release (`serverMisses+1`; ৩-এ chrome) | কিছু না |

## ৪. কী কী সমস্যা হতে পারে — আর কে সামলায়

| # | সমস্যা | কে টের পায় | কী হয় (নিজে থেকে) | আপনাকে কী দেখায় / কী করতে হয় |
|---|---|---|---|---|
| 1 | একটা IP-তে login wall | Reader (wall) | শুধু ওই IP বিশ্রামে, বাকিরা চলে | Settings → Proxy টেবিলে "resting" |
| 2 | সব IP একসাথে বিশ্রামে | Proxy pool | lane থামে, প্রথম IP ফিরলে নিজে থেকে চালু | Dashboard: "All N IPs are resting — continues at HH:MM" |
| 3 | কয়েকটা IP connect হচ্ছে না | Reader (neterror) | ওই IP ১০ মিনিট বিশ্রাম, পেজ অন্য IP-তে | Server logs |
| 4 | **পরপর ৬টা** network error (proxy account শেষ / পাসওয়ার্ড বদল / ইন্টারনেট নেই) | Server reader | worker **Paused**, কারণসহ | Dashboard-এ কারণ; proxy ঠিক করে Resume |
| 5 | Facebook পেজের ফরম্যাট বদলে গেছে | Server reader (**পরপর ১০টা unknown**) | চলতে থাকে (পেজগুলো Chrome-এ যায়), কিন্তু সতর্কবার্তা | Activity + Server logs: "Facebook changed its page format" — কোড আপডেট লাগবে |
| 6 | Server restart / crash পড়ার মাঝখানে | Queue (boot) | `claimedBy: server` সব `working` সাথে সাথে pending | কিছু না |
| 7 | Chrome বন্ধ / extension বন্ধ পড়ার মাঝখানে | Queue (janitor) | ৫ মিনিট পর `working` → pending | কিছু না |
| 8 | Chrome-এর পেজ কেউ পড়ছে না (Chrome বন্ধ দিনের পর দিন) | Queue (janitor) | ২৪ ঘণ্টা পর failed, কারণসহ | Leads-এ "failed"; চাইলে Re-scrape |
| 9 | Chrome-এ login wall (নিজের IP) | Worker API | শুধু Chrome ৩০ মিনিট বিরতি, server চলে | Dashboard: "Chrome reads them from HH:MM" |
| 10 | Ad Library tab বন্ধ / ঝুলে আছে / extension reload হওয়ায় সংযোগ হারিয়েছে | Heartbeat: tab প্রতি ~১০ সেকেন্ডে জানায় | ১ মিনিট চুপ → Dashboard-এ "not responding"; ৩ মিনিট চুপ → সার্চ যা এসেছে তা নিয়ে শেষ (প্রতি ৩০ সেকেন্ডে চেক)। Tab reload করলে সার্চ যেখানে ছিল সেখান থেকে চলে (১ ঘণ্টার মধ্যে), একই ad দুবার যায় না | প্যানেলে লাল "Reload this page" বাটন; Dashboard-এর Health |
| 10b | প্যানেলে বেশি ad দেখায়, server-এ কম যায় | — (নকশা অনুযায়ী) | Settings-এর "max ads per search" পর্যন্তই server-এ যায় | প্যানেল: "Sent to the server: X of max N", "N pages will be collected (the first N ads)" |
| 11 | দিনের সীমা (Daily limit) শেষ | Queue / Server reader | থামে, পরদিন নিজে থেকে চলে | Dashboard: "Today's limit reached" |
| 12 | ওয়েবসাইট-ইমেইল খোঁজায় অনেক কাজ জমে | Results | একসাথে সর্বোচ্চ ৪টা; বাকিরা লাইনে | কিছু না |
| 13 | Database সাময়িক বন্ধ | সব জায়গায় | lane-এর error log হয়, পেজ release; ৫ সেকেন্ড পর আবার চেষ্টা | Server logs |
| 14 | একই পেজ দুই জায়গায় (server + Chrome) | Queue.claim (atomic) | একটা পেজ একবারে শুধু একজন পায় | — |
| 15 | একই IP দুই lane-এ | Proxy pool (atomic take) | কখনো হয় না | — |
| 16 | Extension-এর দুটো কপি চলছে | Dashboard | পুরনো version দেখা গেলে হলুদ সতর্কবার্তা | একটা Remove করুন |

## ৪খ. Health — Dashboard যেন engine-এর আসল অবস্থাই বলে

`server/src/health.js` engine-এর সব অবস্থা দেখে একটা তালিকা বানায়; Dashboard-এ "Now" লাইনের ঠিক নিচে দেখায়। কিছু আটকে
না থাকলে সবুজ "Everything is working"। প্রতিটা লাইন: **কী** হয়েছে, **কেন**, আর **কী করতে হবে** (কিছু না করলে সেটাও লেখা)।

| মাত্রা | মানে | উদাহরণ |
|---|---|---|
| error (লাল) | থেমে আছে, আপনাকে কিছু করতে হবে | Paused (কারণসহ), extension connected না অথচ সার্চ অপেক্ষায়, গত ৩০ মিনিটের engine error |
| warn (হলুদ) | আটকে / ধীর, নিজে সেরে উঠতে পারে | Ad Library tab not responding, সব IP বিশ্রামে, login-wall বিরতি, পুরনো extension |
| info | নকশা অনুযায়ী অপেক্ষা | কিছু IP বিশ্রামে, Chrome-এর পেজ, দিনের সীমা শেষ |

## ৫. Settings (Settings → Worker / Proxy)

| Setting | মানে | ভালো মান |
|---|---|---|
| Read pages on the server | server mode | চালু |
| Pages at the same time | lane সংখ্যা (≤ IP সংখ্যা) | ৫ |
| Rest per IP (ipGapSec) | একটা IP কত সেকেন্ড পরপর | ২০–৪০ (wall বেশি হলে বাড়ান) |
| Delay min/max | প্রতিটা lane-এ দুই পেজের মাঝে বিরতি | ১–৩ |
| Daily page limit | দিনে সর্বোচ্চ পেজ (Facebook যত বার দেখল) | proxy data অনুযায়ী |

## ৬. টেস্ট

| টেস্ট | কী দেখে | কোথায় চলে | কমান্ড |
|---|---|---|---|
| `test/reader.test.mjs` | HTML → ৫ ভাগ, Intro কার্ড থেকে ফোন/ইমেইল/WhatsApp/ঠিকানা | শুধু Node, ইন্টারনেট/DB লাগে না | `npm test` |
| `test/engine.test.mjs` | উপরের ১৬টা পরিস্থিতির বেশিরভাগ: wall, সব IP বিশ্রাম, network error, ৬টায় pause, ফরম্যাট বদল, restart, Chrome fallback, ২৪ ঘণ্টা, atomic claim | আলাদা **খালি MongoDB** (Docker) — আসল ডেটা ছোঁয় না | `scripts/test-engine.sh` |
| `test/e2e.mjs` | লগইন, workspace আলাদা, worker API, export, sheet, নিরাপত্তা | আলাদা খালি MongoDB + app container | `scripts/test-engine.sh` |
