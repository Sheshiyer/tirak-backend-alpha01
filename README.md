# Tirak Core API

Backend for Tirak's guided-experience marketplace: one Cloudflare Worker
(Hono + TypeScript) that serves the mobile app, the website's supplier
application form and the admin panel. Legacy `companion` / `supplier` /
`customer` identifiers remain internal compatibility names; public contracts
use local-guide and traveler language.

Start with `PROJECT.md`, `AGENTS.md` and `.project/HANDOFF.md`. Release and
verification history lives in `docs/execution/`.

## Local commands

```bash
npm install          # bun.lock is the pinned lockfile; `bun install --frozen-lockfile` reproduces it exactly
npm run test         # vitest (use `npm run test:run` for a single non-watch run)
npm run typecheck    # tsc --noEmit
npm run dev          # wrangler dev (needs JWT_SECRET in an untracked .dev.vars)
```

Some tests shell out to the `sqlite3` CLI, so install it locally. There is no
hosted CI: GitHub Actions were removed on 2026-10-08 for local job migration.
Deployment, migrations and secrets are owner-gated and out of scope for
routine changes. Do not run the `deploy:*` or `db:migrate:*` scripts without
a separately approved release.

## Runtime bindings (`src/index.ts` `Env`, `wrangler.toml`)

| Binding | Kind | Purpose |
|---|---|---|
| `DB` | D1 | All relational data (migrations in `migrations/`) |
| `STORAGE` | R2 | Uploads, avatars, onboarding evidence |
| `CACHE`, `SESSIONS` | KV | Cache, OTP codes, rate limits, sessions |
| `PAYMENT_CONFIG_KV` | KV (staging only) | Runtime payment-policy override |
| `MODERATION_QUEUE`, `ANALYTICS_QUEUE`, `NOTIFICATION_QUEUE` | Queues | Background jobs (`src/background/`) |
| `CHAT_ROOM` | Durable Object `ChatRoom` | Booking chat WebSocket rooms |
| `NOTIFICATION_SERVICE` | Durable Object `NotificationService` | In-app real-time notifications |
| `EMAIL` | Cloudflare email binding | Transactional email (provider chosen by `EMAIL_PROVIDER`) |

Key vars: `ENVIRONMENT`, `FRONTEND_URLS` (CORS allow-list), `PAYMENT_MODE`,
`PROMPTPAY_ENABLED`, `PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED`,
`EMAIL_PROVIDER`, `SUPPORT_NOTIFICATIONS_ENABLED`, `CORE_QA_MODE`. Secrets
(`JWT_SECRET`, provider keys) are Worker secrets and never belong in Git.

The default Worker (`tirak-backend`) is the live target: `ENVIRONMENT` is
`production` but it keeps the retained `tirak-development` D1 and
`tirak-storage-dev` R2 so existing users are preserved. `env.staging` and
`env.production` are separate, not-yet-live targets.

## CORS

Allowed origins are `FRONTEND_URLS` (comma-separated), any
`http(s)://localhost` / `127.0.0.1` port, and the `tirak://` app scheme.
Allowed headers: `Content-Type`, `Authorization`, `Idempotency-Key`.
`/api/admin/*` additionally applies an admin CORS layer (same
`FRONTEND_URLS` plus localhost, credentials allowed).

## Mounted routes

`/health` is public. Unless noted, `/api/*` groups require a bearer JWT. In
`ENVIRONMENT=core-qa` with `CORE_QA_MODE=cohort`, `src/middleware/coreQa.ts`
additionally restricts every API route to the QA cohort.

| Mount | Source | Notes |
|---|---|---|
| `/api/auth` | `routes/auth.ts` | register, login, logout, email verification, phone OTP, password reset (public) |
| `/auth` | `routes/passwordResetPage.ts` | browser password-reset page (public) |
| `/api/public` | `routes/public.ts` | stats, categories, regions, featured suppliers, config, health, vendor application (public) |
| `/api/supplier-onboarding` | `routes/supplierOnboarding.ts`, `routes/evidence.ts` | application submit/status (public), evidence upload (status token) |
| `/api/support-requests` | `routes/supportRequests.ts` | public support form |
| `/api/interest` | `routes/interest.ts` | public interest/waitlist capture |
| `/api/users` | `routes/users.ts` | profile, settings, consents, avatar, account deletion |
| `/api/suppliers` | `routes/suppliers.ts` | guide profile, services, stats |
| `/api/customers` | `routes/customers.ts` | traveler profile, bookings, favourites |
| `/api/uploads` | `routes/uploads.ts` | image/document upload, public file reads |
| `/api/chat` | `routes/chat.ts` | booking-scoped rooms, messages, socket ticket, WebSocket |
| `/api/bookings` | `routes/bookings.ts` | create (Idempotency-Key), list, detail, status |
| `/api/reviews` | `routes/reviews.ts` | create, list by guide |
| `/api/payments` | `routes/payments.ts` | Omise charges and webhook; disabled while `PAYMENT_MODE=disabled` |
| `/api/notifications` | `routes/notifications.ts` | list/read/delete, preferences, Expo push token |
| `/api/companions` | `routes/companions.ts` | guide discovery and detail |
| `/api/search` | `routes/search.ts` | suggestions, categories, locations, popular, tracking |
| `/api/referrals` | `routes/referrals.ts` | own code, apply |
| `/api/admin` | `routes/admin/` | admin role only: dashboard, users, moderation, analytics, subscriptions, operations, supplier-onboarding, payments provider policy, interest, support-requests, acquisition |

`routes/paymentIntentsV2.ts` is source-only and deliberately unmounted until a
separate payment review. `tests/routes/release-surface.test.ts` pins that no
legacy general-conversation (`/api/conversations`) or unscoped `/ws` route is
mounted.

## Current gaps

- **Payments:** Omise PromptPay source exists but every environment ships with
  `PAYMENT_MODE=disabled`; bookings are non-payment today.
- **SMS:** no provider is integrated. Phone OTP resend and SMS notification
  jobs report failure rather than a simulated send.
- **Push:** delivered through the Expo Push service from the notification
  queue. The `NotificationService` Durable Object's own FCM/APNS path is a
  placeholder and nothing registers device tokens with it.
- **Moderation:** queue jobs use keyword heuristics; no AI moderation service
  is wired.
- **Scheduled jobs:** `scheduled()` processes support notifications only when
  `SUPPORT_NOTIFICATIONS_ENABLED=true` (default `false`). `wrangler.toml`
  declares no cron; the live Worker keeps an existing five-minute provider
  trigger that is held as-is (see
  `docs/execution/retained-core-release-preparation.md`).

## Historical documents

`IMPLEMENTATION_COMPLETE_SUMMARY.md`, `PHASE3_COMPLETION_SUMMARY.md`,
`done.md`, `todo-backend.md`, `mobile-app-backend.md`,
`tirak_implementation_guide.md`, `webapp-admin-implementation.md` and
`_PROJECT-STATUS.md` are early planning and status snapshots. They are kept
for history and do not describe the current API.
