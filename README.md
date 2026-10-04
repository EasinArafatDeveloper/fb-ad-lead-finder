# FB Ad Lead Finder (multi-user)

Meta Ad Library-তে keyword দিয়ে search → active ads চালানো সব Page → প্রতিটা Page-এর public Intro থেকে
Phone / WhatsApp / Email / Website / Instagram → Dashboard → Excel / CSV / Google Sheet।
একাধিক user — প্রত্যেকের নিজের workspace, কেউ অন্যের lead দেখে না।

```
Chrome extension (worker, WORKER_KEY)  ──►  fb-leads container (127.0.0.1:3002)  ──►  shared MongoDB (db: fb_ad_leads)
  • Ad Library collect                        • login, workspaces, admin                • pages / ads  (shared, একবার পড়া)
  • Page Intro read                           • dashboard + API                         • leads / projects / sheets (per workspace)
                                              • website email crawler
```

## Server-এ চালানো (home server, Docker)
এই project `~/apps/fb-ad-lead-finder`-এ থাকে (server নিয়ম: `~/server/PROJECTS.md`)।

```bash
cd ~/apps/fb-ad-lead-finder
docker compose up -d --build        # build + start (code বদলালে আবার এটাই)
docker compose logs -f app          # logs
```
- `.env` (chmod 600): `MONGODB_URI`, `DB_NAME`, `WORKER_KEY`, `ALLOW_SIGNUP` — নমুনা `.env.example`
- প্রথম admin: `docker compose exec app node src/create-admin.js you@example.com "Name"` → temporary password দেখায়, login করে বদলান
- Backup: প্রতি রাত 3টায় সব MongoDB database নিজে থেকেই (`~/server/backup`)
- সময়: `TZ=Asia/Dhaka` (daily limit বাংলাদেশ সময় রাত 12টায় reset)

### Public করা (Cloudflare Tunnel)
Container আগে থেকেই `proxy` network-এ আছে। Cloudflare → Zero Trust → Networks → Tunnels → **home-server** →
Published applications → Add: hostname (যেমন `leads.example.com`) → Service `http://fb-leads:4000`।

## Users
- **Admin**: Users page (user বানানো / disable / password / প্রতিদিনের search limit), worker settings, Pause/Resume, Server logs
- **Member**: নিজের searches, projects, leads, sheets, Google Sheet
- Sign-up page চাইলে `.env`-এ `ALLOW_SIGNUP=true` (default: শুধু admin user বানায়)

## Extension (worker)
1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension` folder
2. Popup: Server URL `http://localhost:3002` + **Worker key** (`.env`-এর `WORKER_KEY`) → Save & Connect
3. একটা worker সবার জন্য কাজ করে: সবার search পুরোনোটা আগে; একটা page একবার পড়লে যাদের lead-এ আছে সবাই পায়।

## Data model
| Collection | কার | কী |
|---|---|---|
| `pages`, `ads` | সবার (shared) | Facebook থেকে পড়া data — একবারই পড়া হয় |
| `leads` | workspace | নিজের copy + Status / Notes; হাতে বদলানো field (`overrides`) কখনো overwrite হয় না |
| `projects`, `items`, `sheets`, `jobs` | workspace | keyword project → folder → sheet; searches |
| `users`, `sessions`, `workspaces` | — | login (scrypt), cookie session (30 দিন), limits |

## Test
`server/test/e2e.mjs` — চলমান server-এর উপর পুরো flow (isolation, worker, overrides, sheet delete, CSV, SSRF, CSRF):
```bash
docker cp server/test/e2e.mjs fb-leads:/app/server/e2e.mjs && docker exec fb-leads node e2e.mjs
```

## Files
| Path | কাজ |
|---|---|
| `server/src/auth.js` | login, sessions, roles, worker key, CSRF check, login throttle |
| `server/src/routes.js` | user API (leads, searches, settings, export, sheet) — সব workspace-এর ভেতরে |
| `server/src/worker.js` | extension API (`/api/worker/*`) |
| `server/src/admin.js` | admin API (users, logs) |
| `server/src/leads.js` | ads → pages → leads, page result parse, sync |
| `server/src/projects.js` | projects / folders / live sheets, delete |
| `server/src/contacts.js` | website email/phone (শুধু public internet — internal address block) |
| `apps-script/Code.gs` | Google Sheet endpoint (Status/Notes overwrite করে না) |
| `extension/` | Chrome worker |
| `dashboard/` | React dashboard (Vite + Tailwind + FortuneSheet) |
