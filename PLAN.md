# FB Ad Lead Finder — Chrome Extension Plan

> **Update (2026-09-25):** Storage বদলে MongoDB Atlas + Node server করা হয়েছে। Dashboard এখন web app
> (`server/public`), extension শুধু worker। Google Sheet sync server থেকে হয়। Setup-এর জন্য README.md দেখুন।
> নিচের IndexedDB/extension-dashboard অংশ পুরনো design।

Keyword দিয়ে Meta Ad Library search → active ads থেকে unique FB Page → প্রতিটা Page-এর About থেকে
Name / Phone / Email / Website → Dashboard-এ manage → Excel export + Google Sheet sync.

---

## 1. Overall Flow

```
[Popup / Dashboard]  keyword + country দিয়ে "Start"
        │
        ▼
[Ad Library tab]  auto-scroll + GraphQL response intercept
        │   → page_id, page_name, ad landing URL, ad count
        ▼
[Queue (IndexedDB)]  page_id দিয়ে dedupe
        │
        ▼
[Background tab]  facebook.com/{page_id}/about  (5–10s random delay)
        │   → phone, email, website, category, address, followers
        ▼
[Fallback]  page-এ email না থাকলে website/landing page → contact page থেকে email/phone
        │
        ▼
[Leads DB (IndexedDB)]  ──►  Dashboard (manual view/edit)
                         ──►  Excel (.xlsx) export
                         ──►  Google Sheet sync (Apps Script Web App)
```

---

## 2. Folder Structure

```
D:\FB-Ad-Lead-Finder\
├── manifest.json                 # Manifest V3
├── background/
│   └── service-worker.js         # job runner, queue, rate limit, tab control, sheet sync
├── content/
│   ├── adlibrary-hook.js         # page world: fetch/XHR hook → GraphQL ad data ধরে
│   ├── adlibrary.js              # auto-scroll, data background-এ পাঠায়
│   ├── page-about.js             # FB Page About থেকে contact extract
│   └── website-contact.js        # fallback: website থেকে email/phone
├── popup/                        # ছোট control: keyword, Start/Pause, progress, "Open Dashboard"
│   ├── popup.html / popup.js / popup.css
├── dashboard/                    # full page manual dashboard
│   ├── dashboard.html / dashboard.js / dashboard.css
├── lib/
│   ├── db.js                     # IndexedDB wrapper (leads, jobs, queue, logs)
│   ├── extract.js                # email/phone/url regex + BD phone normalize
│   ├── sheets.js                 # Google Sheet sync client
│   └── xlsx.full.min.js          # SheetJS (Excel export)
├── apps-script/
│   └── Code.gs                   # Google Sheet-এ paste করার script (Web App)
└── icons/
```

---

## 3. Data Model (IndexedDB)

**leads** (key = `pageId`)
| field | details |
|---|---|
| pageId, pageName, pageUrl | Page identity |
| category, followers, address | About থেকে |
| phones[], emails[], website | Contact (একাধিক থাকতে পারে) |
| adCount, adLinks[], adSample | Ad Library থেকে |
| keywords[], country | কোন search থেকে এসেছে |
| **status** | New / Contacted / Interested / Not Interested / Closed (manual) |
| **notes, tags[]** | manual |
| contactSource | page / website / manual |
| scrapedAt, updatedAt, syncedAt | sync-এর জন্য |

**jobs** — keyword, country, status (running/paused/done), found, processed, failed, createdAt
**queue** — pageId, jobId, state (pending/done/failed), retries
**logs** — error/checkpoint log

---

## 4. Manual Dashboard (`dashboard.html`)

**Top — Stats cards:** Total leads · Email আছে · Phone আছে · Today scraped · Contacted · Interested

**Jobs panel:**
- নতুন search: keyword (একসাথে একাধিক, comma দিয়ে) + country + max pages
- প্রতিটা job-এর progress bar, Start / Pause / Resume / Delete
- Settings: delay (min–max sec), daily limit, website fallback on/off

**Leads table:**
- Search box + filter: keyword, status, "email আছে", "phone আছে", category, date
- Sort: followers, adCount, date
- Row-তে inline edit: status dropdown, notes, phone/email manually ঠিক করা
- Click করলে FB page / website নতুন tab-এ খুলবে; phone-এ click করলে WhatsApp link
- Bulk: select → status change / delete / re-scrape
- Manual lead add button

**Export / Sync:**
- Download Excel (.xlsx) — সব বা শুধু filtered rows
- Download CSV
- "Sync to Google Sheet" button + auto-sync toggle + last sync time

**Logs tab:** failed pages, checkpoint warning, retry button

---

## 5. Google Sheet Connection

**পদ্ধতি: Google Apps Script Web App** (free, Google Cloud project/OAuth setup লাগে না)

Setup (একবার, ~২ মিনিট):
1. নতুন Google Sheet → Extensions → Apps Script
2. `apps-script/Code.gs` paste → Deploy → Web app (Execute as: Me, Access: Anyone with link)
3. Web App URL + একটা secret key extension Settings-এ paste
4. "Test connection" চাপলে sheet-এ header বানিয়ে দেবে

কীভাবে কাজ করবে:
- Extension → `POST {secret, rows[]}` → script `pageId` দিয়ে **upsert** করে (থাকলে update, না থাকলে নতুন row)
- শুধু `updatedAt > syncedAt` rows পাঠানো হবে (incremental)
- Auto-sync: প্রতি N টা নতুন lead পর বা job শেষ হলে
- **Two-way (optional, Phase 6):** Sheet-এ team যদি Status/Notes বদলায়, "Pull from Sheet" দিয়ে dashboard-এ আনা যাবে (`doGet`)

Sheet columns:
`Page ID | Page Name | Page URL | Category | Phone | Email | Website | Address | Followers | Ad Count | Keyword | Status | Notes | Scraped At | Updated At`

---

## 6. Build Phases

| Phase | কাজ | Output |
|---|---|---|
| **1** | Manifest, IndexedDB, popup; Ad Library GraphQL hook + auto-scroll + dedupe | keyword দিলে unique page list আসবে |
| **2** | Queue runner + Page About extractor + delay/daily limit + resume | phone/email/website আসবে |
| **3** | Dashboard: stats, table, filter, inline edit, manual add, Excel/CSV export | পুরো manual dashboard |
| **4** | Google Sheet sync (Apps Script + extension settings + auto-sync) | Sheet-এ live data |
| **5** | Website fallback email/phone | আরো বেশি contact |
| **6** | Polish: two-way sync, logs/retry, checkpoint detect → auto-pause | Stable version |

প্রতিটা phase শেষে Chrome-এ "Load unpacked" দিয়ে test করা হবে।

---

## 7. Safety / Limits
- আলাদা FB account-এ চালানো ভালো (Meta ToS automated collection allow করে না)
- Random delay 5–10s, daily limit default 150 page, মানুষের মতো scroll
- Checkpoint/login page detect হলে সাথে সাথে auto-pause + notification
- FB-এর HTML বদলালে শুধু `page-about.js` / `extract.js` update করতে হবে
