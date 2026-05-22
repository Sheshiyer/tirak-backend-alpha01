# ADR 0001: Tirak Plus Source Of Truth

Date: 2026-05-18

## Status

Accepted for Wave 1 implementation.

## Decision

`tirak-backend-alpha01` is the production backend baseline for Tirak Plus. The Muse AI, traveller, companion, admin, moderation, chat, storage, and Cloudflare deployment work should extend this backend instead of creating a parallel backend inside the customer web app.

`tirak-admin-command-center` is the production admin frontend baseline. The older `tirakplus0admin` repo remains useful as a spec-kit planning baseline, but it is not the implementation target unless this ADR is superseded.

`standalone-repos/tirakplus` is the responsive customer web frontend baseline. Its existing Worker routes can remain as staged development rails or become a deliberately thin BFF, but they must not grow into the source-of-truth production API without a new ADR.

## Rationale

- The backend already owns Hono route groups for auth, users, suppliers, customers, companions, conversations, search, chat, bookings, reviews, payments, notifications, uploads, admin, queues, Durable Objects, D1, KV, and R2.
- The admin command center already has the richer routed operator shell and a backend auth connection.
- Duplicating backend behavior in the customer app would create incompatible contracts for auth, user roles, moderation, payments, and privacy.
- Muse needs a single place to enforce consent, birth-date handling, recommendation retention, and admin auditability.

## Consequences

- Customer app work must consume the backend contract through an API client or an explicit BFF adapter.
- Backend vocabulary must be adapted from `customer` / `supplier` to the product language `traveller` / `companion`.
- Existing booking, review/rating, and payment-first surfaces must be guarded so they do not violate the Tirak Plus design and compliance rules.
- Cloudflare deployment work starts in the backend repo and must validate real D1, KV, R2, Queue, and Durable Object resources before staging deploy.

## Verification

- Backend remote: `https://github.com/Sheshiyer/tirak-backend-alpha01.git`
- Admin remote: `https://github.com/pineappleinnovationlabs/tirak-admin-command-center.git`
- Customer remote: `https://github.com/Sheshiyer/tirakplus.git`
- GitHub issue sync completed with backend issues `#1` through `#14` and admin issues `#1` through `#11`.
