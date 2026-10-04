# FB Ad Lead Finder

Meta Ad Library-তে keyword দিয়ে search → active ads চালানো সব Page → প্রতিটা Page-এর About থেকে
Phone / WhatsApp / Email / Website → MongoDB → Web Dashboard → Excel + Google Sheet।

```
Chrome Extension (আপনার logged-in Chrome)  ──►  Node server (localhost:4000)  ──►  MongoDB Atlas
   • Ad Library auto-scroll + ad data           • API + Dashboard                   • leads, ads, jobs
   • Page About scrape                          • Website থেকে email (fallback)
                                                • Excel / CSV / Google Sheet
```

## ১. Server চালু করা
```bash
cd D:\FB-Ad-Lead-Finder\server
npm install        # প্রথমবার
npm start
```
Dashboard: http://localhost:4000 → login-এ `server/.env`-এর `API_KEY` দিন।

Dashboard-এর code বদলালে আবার build করতে হবে:
```bash
cd D:\FB-Ad-Lead-Finder\dashboard
npm install        # প্রথমবার
npm run build
```

> MongoDB connect না হলে: Atlas → Network Access → আপনার IP allow করুন।

## ১-ক. Vercel-এ host করা (online server)
Local server-এর বদলে Vercel-এ চালালে dashboard যেকোনো জায়গা থেকে খোলা যাবে, computer বন্ধ থাকলেও।
1. **MongoDB Atlas → Network Access → Add IP → `0.0.0.0/0`** (Vercel-এর IP বদলায়)
2. Project root (`D:FB-Ad-Lead-Finder`) থেকে: `npx vercel login` → `npx vercel` (প্রথমবার project বানাবে)
3. Environment variables (Vercel → Project → Settings → Environment Variables):
   `MONGODB_URI`, `DB_NAME` (= fb_ad_leads), `API_KEY`, `CRON_SECRET` (যেকোনো লম্বা random লেখা)
4. `npx vercel --prod` → যে URL পাবেন (যেমন `https://fb-ad-lead-finder.vercel.app`) সেটাই dashboard
5. Extension popup → Server URL-এ ওই URL + একই API key → Save & Connect

Vercel-এ যা আলাদা: Google Sheet auto-sync দিনে ১ বার (free plan-এর cron), আর একবারে ~4.5 MB-র বেশি data save হয় না (খুব বড় sheet)।


## ২. Extension install
1. Chrome → `chrome://extensions` → **Developer mode** ON
2. **Load unpacked** → `D:\FB-Ad-Lead-Finder\extension` folder
3. Extension icon → popup-এ Server URL `http://localhost:4000` + API key → **Save & Connect**
4. একই Chrome-এ Facebook-এ login থাকতে হবে (আলাদা account ভালো)

## ৩. ব্যবহার
- **Dashboard → Jobs** → keyword (একাধিক হলে প্রতি লাইনে একটা) + country → **Start search**
  - Extension ৩০ সেকেন্ডের মধ্যে Ad Library tab খুলে scroll করে সব ad নেবে
  - তারপর background tab-এ একটা একটা করে page-এর About খুলে contact নেবে (delay 6–12s, দিনে 150 limit)
- অথবা নিজে Ad Library-তে search করে ডান-নিচের panel-এ **Collect this search**
- **Leads** tab: filter, status/notes, ads দেখা, Excel/CSV, Sheet sync
- Checkpoint / login সমস্যা হলে নিজে থেকে Pause হবে → ঠিক করে header-এর **Resume**

## ৪. Google Sheet
Dashboard → Settings-এ step-by-step লেখা আছে (`apps-script/Code.gs` paste → Web app deploy → URL + secret)।

## Files
| Path | কাজ |
|---|---|
| `extension/content/adlibrary-hook.js` | Ad Library-র GraphQL/HTML থেকে ad data ধরে |
| `extension/content/adlibrary.js` | Panel, auto-scroll, server-এ পাঠানো |
| `extension/content/page-about.js` | Page About থেকে phone/email/link বের করা (FB layout বদলালে এটা update) |
| `extension/background.js` | Server থেকে job নেওয়া, tab চালানো |
| `server/src/routes.js` | API (leads, jobs, worker, export, sheet) |
| `server/src/leads.js` | Merge logic, Excel/Sheet columns |
| `dashboard/` | React dashboard (Vite + Tailwind + FortuneSheet) — build হয়ে `dashboard/dist`, server সেটা serve করে |
| `server/src/projects.js` | Project → folder → sheet, live sheet merge |
| `apps-script/Code.gs` | Google Sheet endpoint |

⚠ `server/.env`-এ database password আছে — এটা কখনো GitHub-এ push করবেন না (`.gitignore`-এ আছে)।
