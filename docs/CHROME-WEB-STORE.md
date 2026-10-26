# Chrome Web Store — জমা দেওয়ার গাইড

ZIP বানানো: `sh scripts/build-extension.sh` → `dist/fb-lead-finder-extension-<version>.zip`
(Store-এর build-এ proxy / webRequest permission নেই, server URL আগে থেকে `https://specter.monster`।)

নতুন version জমা দিতে: `extension/manifest.json`-এ `version` বাড়ান → আবার build → Developer Dashboard → item → **Package → Upload new package**।

---

## ১. Store listing (ফর্মে কপি করুন)

**Name**
```
FB Lead Finder
```

**Short description** (Summary, ≤132 অক্ষর)
```
Collect active advertisers from the Meta Ad Library into your FB Lead Finder dashboard, with their public business contacts.
```

**Detailed description**
```
FB Lead Finder helps marketing and sales teams find businesses that are actively advertising on Facebook and Instagram.

How it works:
1. Open the Meta Ad Library and search for a keyword (for example "online shop").
2. Press "Collect this search" in the FB Lead Finder panel.
3. The extension collects the ads on the page and sends them to your FB Lead Finder dashboard.
4. The dashboard reads each advertiser's public Facebook Page and shows the business contact details the business itself published: phone, WhatsApp, email, website and address.

Features:
• One click to collect a whole Ad Library search
• Condition: keep only advertisers running at least N ads
• Live progress, and "Open in Dashboard" when done
• Export to Excel, CSV or Google Sheets from the dashboard

Requires an FB Lead Finder account (server address and worker key from your administrator).
The extension only works on the Meta Ad Library and on Facebook Pages it is asked to read. It never logs in to Facebook and does not read your browsing history.
```

**Category:** `Productivity` (বা `Tools`) · **Language:** English

**Graphics** (আপনাকে বানাতে হবে)
- Icon 128×128: `extension/icons/icon128.png` (ZIP-এর ভেতরেই আছে)
- Screenshot: কমপক্ষে ১টা, **1280×800** বা 640×400 PNG/JPG — Ad Library পেজে প্যানেলসহ, আর Dashboard-এর Live বোর্ড
- Small promo tile 440×280 (ঐচ্ছিক)

---

## ২. Privacy practices ট্যাব

**Single purpose**
```
Collect advertisers from the Meta Ad Library, and the business contact details they publish on their Facebook Pages, into the user's FB Lead Finder dashboard.
```

**Permission justification** (প্রতিটা ঘরে)

| Permission | Justification |
|---|---|
| storage | Saves the extension's settings (server address, worker key, on/off) and the state of a running collection. |
| tabs | Opens the Ad Library for a queued search and the dashboard ("Open in Dashboard"); knows which tab belongs to which collection. |
| scripting | Reads the public business details (Intro section) of a Facebook Page that the dashboard asks for. |
| alarms | Checks the dashboard every 30 seconds for new searches to collect. |
| notifications | Tells the user when collecting stops because Facebook asked for a check. |
| declarativeNetRequest | Blocks images and videos only in the extension's own background tab, so pages load faster and use less data. |
| webNavigation | Detects when a page failed to load, so the page is retried instead of being marked as failed. |
| Host: facebook.com | The Ad Library and the Facebook Pages it reads. |
| Host: specter.monster, localhost | The user's FB Lead Finder server, which receives the collected data. A small script on the dashboard lets a search started there begin right away. |

**Remote code:** `No, I am not using remote code`

**Data usage** — টিক দিন:
- ✅ **Website content** (Ad Library-র বিজ্ঞাপন আর Facebook Page-এর ব্যবসায়িক তথ্য)
- বাকিগুলো (personal info, health, financial, authentication, personal communications, location, web history, user activity) — ❌ না

তিনটা ঘোষণাতেই টিক:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
```
https://specter.monster/privacy.html
```
(`[contact email]` জায়গায় আপনার যোগাযোগের ইমেইল বসাতে হবে — `dashboard/public/privacy.html`)

---

## ৩. Distribution ট্যাব

| Visibility | মানে | কখন |
|---|---|---|
| **Private** | শুধু আপনি যাদের ইমেইল দেবেন (trusted testers) | নিজের টিমের জন্য — **শুরুতে এটা** |
| Unlisted | লিংক যার কাছে আছে সে install করতে পারে, সার্চে আসে না | কাস্টমারদের লিংক দিয়ে |
| Public | Store-এ সবাই খুঁজে পায় | প্রতি ইউজারের নিজের লগইন হওয়ার পরে |

Regions: Bangladesh (বা All regions)।

---

## ৪. জেনে রাখুন

- Review সাধারণত কয়েক দিন লাগে; Facebook পেজ পড়া এক্সটেনশন বেশি খুঁটিয়ে দেখা হয় — বাতিল হলে কারণ ইমেইলে আসে।
- Facebook-এর নিজের নিয়মে স্ক্র্যাপিং নিষেধ; Store review পাস করলেও সেই ঝুঁকি থাকে।
- **Worker key সবার জন্য একটাই।** Store থেকে install করা প্রত্যেককে একই key দিতে হবে, আর "Collect this search" admin-এর workspace-এ জমা হয়। বাইরের কাস্টমারদের দেওয়ার আগে এক্সটেনশনে প্রতিটা ইউজারের নিজের লগইন দরকার।
- Store-এর version proxy ব্যবহার করে না; পেজ server-এ proxy list দিয়ে পড়া হয় (Settings → Proxy → "Read pages on the server" চালু থাকতে হবে)।
