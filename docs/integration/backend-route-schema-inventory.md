# Backend Route And Schema Inventory

Date: 2026-05-18

This inventory supports INT-001. It maps the current backend surface before Muse AI work starts.

## Runtime Shape

- Framework: Hono on Cloudflare Workers.
- Entry point: `src/index.ts`.
- Data/storage bindings: D1 `DB`, R2 `STORAGE`, KV `CACHE`, KV `SESSIONS`.
- Background bindings: `MODERATION_QUEUE`, `ANALYTICS_QUEUE`, `NOTIFICATION_QUEUE`.
- Durable Objects: `CHAT_ROOM`, `NOTIFICATION_SERVICE`.
- Public Worker endpoints: `/health`, `/ws`, `/api/auth`, `/api/public`.

## Mounted Route Groups

| Mount | Source | Auth posture | Primary tables/bindings | Wave 1 notes |
|---|---|---:|---|---|
| `/health` | `src/index.ts` | public | Worker env | Basic status and connected WebSocket count. |
| `/ws` | `src/index.ts` | token query | `CHAT_ROOM`, WebSocket service | Tests fail in Node because status `101` is not accepted by standard `Response`. |
| `/api/auth` | `src/routes/auth.ts` | public/rate-limited | `users`, `customer_profiles`, `supplier_profiles`, `CACHE`, `ANALYTICS_QUEUE` | Uses legacy `customer` / `supplier` roles. |
| `/api/public` | `src/routes/public.ts` | public | `users`, `supplier_profiles`, `categories`, `regions`, `CACHE` | Provides public stats, categories, regions, featured suppliers, config, health. |
| `/api/users` | `src/routes/users.ts` | protected | `users`, profiles, `STORAGE` | Profile and settings endpoints. Type drift exists around mobile-only fields. |
| `/api/suppliers` | `src/routes/suppliers.ts` | mixed | `supplier_profiles`, `supplier_services`, `supplier_availability` | Legacy supplier profile surface. |
| `/api/customers` | `src/routes/customers.ts` | protected | `customer_profiles`, `bookings`, favourites/reviews paths | Legacy customer surface. |
| `/api/uploads` | `src/routes/uploads.ts` | protected | `STORAGE`, upload metadata | File typing errors currently block typecheck. |
| `/api/chat` | `src/routes/chat.ts` | protected | `chat_rooms`, `chat_messages`, `CHAT_ROOM` | Room/message APIs plus room WebSocket path. |
| `/api/bookings` | `src/routes/bookings.ts` | protected | `bookings`, `booking_timeline`, `supplier_services`, `notifications` | Payment-first booking model needs compliance gating. |
| `/api/reviews` | `src/routes/reviews.ts` | protected | `reviews`, `bookings`, profiles | Public rating/review model conflicts with Tirak Plus public UX. |
| `/api/payments` | `src/routes/payments.ts` | protected | `payment_methods`, bookings/payments views | Must remain behind payment compliance gate. |
| `/api/notifications` | `src/routes/notifications.ts` | protected | `notifications`, user preferences | Uses mobile notification assumptions. |
| `/api/companions` | `src/routes/companions.ts` | optional auth | `supplier_profiles`, `supplier_services`, `supplier_availability`, `reviews` | Product-facing companion API exists but still depends on ratings/reviews. |
| `/api/conversations` | `src/routes/conversations.ts` | protected | `chat_rooms`, `chat_messages` | Useful for Muse-to-inquiry handoff and admin monitoring. |
| `/api/search` | `src/routes/search.ts` | optional auth | `supplier_profiles`, `supplier_services`, `regions`, `categories`, `analytics_events`, `CACHE` | Search suggestions and discovery support. |
| `/api/admin` | `src/routes/admin/index.ts` | admin | admin subroutes | Production admin API baseline. |

## Admin Subroutes

| Mount | Source | Current purpose | Admin app dependency |
|---|---|---|---|
| `/api/admin/dashboard` | `src/routes/admin/dashboard.ts` | overview, health, metrics | Dashboard and command health. |
| `/api/admin/users` | `src/routes/admin/users.ts` | user list/detail/update/bulk actions | Customers, companions, verification operations. |
| `/api/admin/moderation` | `src/routes/admin/moderation.ts` | moderation queue, actions, stats, rules, reports | Moderation and safety queue. |
| `/api/admin/analytics` | `src/routes/admin/analytics.ts` | user/booking/performance analytics, reports, export | Analytics and reports pages. |
| `/api/admin/subscriptions` | `src/routes/admin/subscriptions.ts` | subscription overview/list/detail/update/billing analytics | Subscription/payment oversight only. |

## Database Inventory

Existing migrations define or attempt to define:

- Identity/profile: `users`, `supplier_profiles`, `customer_profiles`, `user_sessions`.
- Discovery/content: `categories`, `regions`, `supplier_services`, `supplier_availability`.
- Chat/conversations: `chat_rooms`, `chat_messages`.
- Commerce: `bookings`, `booking_timeline`, `reviews`, `payment_methods`.
- Notifications: `notifications`, `notification_results`, `in_app_notifications`, `user_devices`.
- Admin/moderation/analytics: `analytics_events`, `moderation_queue`, `moderation_results`, `flagged_content`, `manual_review_queue`, `daily_metrics`, `hourly_metrics`, `user_activity_summary`, `business_metrics`, `system_config`.

## Schema Risks

- There are two migration files numbered `004`: `004_background_jobs_tables.sql` and `004_mobile_app_features.sql`.
- `analytics_events`, `bookings`, `reviews`, `supplier_services`, and `supplier_availability` are defined in more than one migration path with incompatible columns.
- `customer_profiles.date_of_birth` already exists in `004_mobile_app_features.sql`, but Muse should not depend on raw date of birth as a recommendation label; consent and retention rules are needed first.
- `supplier_profiles.rating_average` and `rating_count` appear in base and mobile migrations. Public rating use should be suppressed or remapped to admin-only quality signals.

## Missing For Muse Wave 1

- No `/api/muse` route group.
- No persisted Muse session/message/consent/recommendation tables.
- No explicit AI consent event ledger.
- No traveller/companion contract adapter document in repo before this wave.
- No Cloudflare resource IDs for D1/KV staging or production.

## Verification Commands

- `rg -n "^[a-zA-Z]+\\.(get|post|put|patch|delete)\\(" src/routes src/index.ts`
- `rg -n "CREATE TABLE|ALTER TABLE|CREATE INDEX" migrations`
