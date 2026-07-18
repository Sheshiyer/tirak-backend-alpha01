# T-004 Backend Baseline Inventory

Status: classified; no files reverted
Captured: 2026-07-19 02:21–02:34 IST
Repository: `tirak-backend-alpha01`
Branch: `main`
Parent SHA: `9ea989b3e0d53661ab371de8825dd961cc11176d`
Upstream divergence: `0 ahead / 0 behind`

## Changed release inputs

| Classification | Paths | Purpose |
| --- | --- | --- |
| Worker composition | `src/index.ts` | Route allowlist, environment typing, and legacy surface removal |
| Booking/payment/chat behavior | `src/routes/bookings.ts`, `src/routes/chat.ts`, `src/routes/payments.ts`, `src/durable-objects/ChatRoom.ts` | Confirmed-booking payments, booking-scoped chat, and provider reconciliation |
| Provider integration | `src/services/omise.ts` | Server-only PromptPay requests, retrieval, signature verification, and status mapping |
| Response and user compatibility | `src/utils/response.ts`, `src/routes/users.ts` | Stable mobile envelopes and compatibility aliases |
| Data migrations | `migrations/008_omise_promptpay_payments.sql`, `migrations/009_booking_scoped_chat.sql` | Payment attempt/event persistence and proposed booking-scoped chat schema |
| Tests | `tests/routes/bookings.test.ts`, `tests/routes/chat.test.ts`, `tests/routes/payments.omise.test.ts`, `tests/routes/release-surface.test.ts` | Route, state, authorization, payment, webhook, and mounted-surface proof |
| Product documentation | `README.md`, `package.json` | Guided-experience identity and current scripts |
| Execution evidence | `docs/execution/phase-1/**` | Inventory, expected-red blocker ledger, and exact commands |

Snapshot: 10 tracked modifications and 6 untracked files before these evidence documents were added. No application path is excluded from the baseline.

## Unchanged but release-critical blocker inputs

These files are not currently modified, but Phase 1 treats them as release inputs because they ingest or mutate production state:

- `scripts/seed-data.sql` and public category reads.
- `scripts/deploy.sh` and `scripts/backup.sh`.
- `wrangler.toml` and `package.json` environment/database commands.
- the complete `migrations/*.sql` history, especially `001_initial_schema.sql` and `004_mobile_app_features.sql`.
- booking cancellation, payment reconciliation, serialization, notification, and cache invalidation paths.

## Ingestion-point classification

- Objectionable categories enter through SQL seed/import data; mobile filtering is not remediation.
- Migration failure enters through incompatible historical table definitions; skipping `004` is not remediation.
- False deployment success enters through fail-open scripts and ambiguous targets; a successful manual command is not remediation.
- Paid-cancelled ambiguity enters where booking transitions and payment settlement mutate independently; output renaming is not remediation.

## Commands

```sh
git status --short
git diff --stat
git diff --name-status
git ls-files --others --exclude-standard
git diff --check
git rev-parse HEAD
git rev-list --left-right --count HEAD...@{upstream}
```
