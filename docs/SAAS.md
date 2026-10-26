# SaaS: accounts, credits, plans, payments

## Addresses
| URL | Who | What |
|---|---|---|
| `/` (`/pricing`) | everybody | Home page with live prices (`GET /api/public/plans`) |
| `/login` `/signup` `/forgot` `/reset-password` | everybody | Accounts (`server/src/auth.js`) |
| `/dashboard` … `/billing` `/connect-extension` | customers | The app |
| `/admin` `/admin/users` `/admin/orders` `/admin/plans` `/admin/logs` | the team (role `admin`) | Admin panel (`server/src/admin.js`) |

## Credits — `server/src/billing.js`
- **1 credit = 1 Facebook Page read** for a workspace (its lead becomes `done`). Failed / "Page not available" = free. A page already read for another customer still costs 1 (a page delivered).
- `chargeReadPages()` runs every 10 s: marks the leads `charged` first, then takes the credits — a crash undercharges, never double-charges.
- Every balance change is a line in `ledger` (`usage`, `grant`, `plan`, `purchase`, `adjust`); the balance is `workspaces.credits` (atomic `$inc`).
- **No credits → no reading:** `claimPage()` only takes pages whose `wantedBy` has a funded workspace (`fundedWorkspaces()`); the rest wait in the queue. New searches are refused with 402.
- Plan `internal` (the team, every admin) = unlimited, usage is logged with delta 0.
- Start of billing (`migrateBilling`, once): everything read before is free; admins → `internal`; others → free trial.

## Plans — editable in `/admin/plans` (collection `plans`)
`free` (100 credits once, 3 searches/day, 500 ads/search) · `starter` $19 · `pro` $49 · `agency` $149 · `internal`. A period is 30 days; when it ends without renewal the plan is `expired` → the free plan's limits, credits stay. Credit packs: `settings.billing.packs`.

## Payments — `server/src/payments.js`
An order is made `pending` (`createOrder`), a provider marks it paid (`markOrderPaid` — idempotent: plan starts/extends 30 days, credits arrive, invoice number `INV-YYYY-NNNNN`).
Today: provider **manual** — the team clicks **Mark paid** in `/admin/orders`.
**To add a gateway** (Paddle, Lemon Squeezy, Stripe, SSLCommerz …): add it to `providers` in `payments.js` with
`checkout(order) → { url }` (the payment page) and `webhook(req) → { orderId, paid, ref }`, point the provider's webhook at
`POST /api/public/payments/webhook/<name>`, choose it in `/admin/plans`. Nothing else changes.

## Customers' own Chrome — extension keys
- `/connect-extension` makes a key `ext_…` (only its hash is stored, `extokens`) and hands it to the extension (`extension/content/dashboard.js` → `ext:connect`).
- A customer key: `next-collect` gives only that account's searches; "Collect" in the Ad Library saves into that account; Chrome page reading only that account's pages.
- The team's `WORKER_KEY`: only the `internal` accounts' searches.

## Sign-up
Closed until an admin opens it (`/admin/plans` → New sign-ups). New accounts get the free trial, must confirm their email before searching (link valid 7 days), can reset a forgotten password (link valid 1 h). Emails go through Settings → Notifications → Email server.
