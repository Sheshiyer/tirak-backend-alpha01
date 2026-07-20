# T-025 Staging Resource Identity and Ledger Evidence

Status: **PENDING HUMAN CONFIRMATION — AUTHENTICATED ACCOUNT MISMATCH, FAIL-CLOSED**

Generated: `2026-07-20`

Contract: `tirak-payments-v1`

Authority: T-024 permits authenticated read-only staging discovery. It does not authorize production access, resource creation/deletion, deployment, migration application, secret changes, live Omise charging, or App Store submission.

## Outcome

Wrangler is authenticated, but its current account membership does not include the account pinned in `wrangler.toml` (`2c0c96c68f0ee73b6d980054557bca5b`). The audit halted after one redacted `wrangler whoami --json` call. No Worker, D1, KV, R2, Queue, Durable Object, migration-ledger, or row-count command was attempted against the wrong account.

The authenticated non-target account identity and account name are deliberately omitted. The JSON ledger retains only the membership count and a SHA-256 digest so the mismatch can be reproduced without publishing personal account metadata.

## Configured staging candidates

These are configuration claims, not verified remote resources:

| Resource | Configured staging candidate | Remote status |
| --- | --- | --- |
| Account | `2c0c96c68f0ee73b6d980054557bca5b` | Not present in authenticated memberships |
| Worker | `tirak-backend-staging` | Not queried; account gate failed |
| D1 `DB` | `tirak-staging` / `placeholder-staging-db-id` | Placeholder; not queried |
| KV `CACHE` | `placeholder-cache-staging-id` | Placeholder; not queried |
| KV `SESSIONS` | `placeholder-sessions-staging-id` | Placeholder; not queried |
| R2 `STORAGE` | `tirak-storage-staging` | Not queried |
| Moderation queue / DLQ | `tirak-moderation-staging` / `tirak-moderation-dlq-staging` | Not queried |
| Analytics queue / DLQ | `tirak-analytics-staging` / `tirak-analytics-dlq-staging` | Not queried |
| Notification queue / DLQ | `tirak-notification-staging` / `tirak-notification-dlq-staging` | Not queried |
| Durable Object | `CHAT_ROOM` / `ChatRoom` | Declaration only; deployment not queried |
| Durable Object | `NOTIFICATION_SERVICE` / `NotificationService` | Declaration only; deployment not queried |
| Durable Object storage migration | tag `v1`, SQLite classes | Declaration only; deployment not queried |
| D1 storage version | unknown | Not queried |
| `d1_migrations` ledger | unknown | Not queried |
| Per-table row counts | unknown | Not queried |

`wrangler.toml` remains unchanged. Replacing placeholders with identities from the currently authenticated, non-target account would violate the frozen target boundary.

## Fail-closed workflow

`scripts/staging/collect-staging-ledger.mjs`:

1. accepts only the literal `staging` environment;
2. requires `TIRAK_STAGING_READ_ONLY_AUTHORIZATION=T-024_APPROVED_READ_ONLY`;
3. rejects production-like arguments and any SQL other than a single `SELECT`;
4. confirms authenticated membership includes the pinned account before any resource command;
5. uses only list, info, Worker version, migration-list, schema-name `SELECT`, migration-ledger `SELECT`, and `COUNT(*)` commands;
6. stores normalized resource metadata, never command output containing identity names, tokens, or secrets;
7. requires exact unique D1, KV, R2, queue/DLQ, and Durable Object matches;
8. requires D1 storage version, migration ledger, and row counts;
9. computes a target fingerprint only after the remote evidence is complete; and
10. keeps `mutationAllowed: false` even after exact human identity confirmation.

When the correct account is available, rerun:

```bash
TIRAK_STAGING_READ_ONLY_AUTHORIZATION=T-024_APPROVED_READ_ONLY npm run staging:discover
```

The resulting target fingerprint must then be confirmed verbatim by the human release owner using the statement exported as `CONFIRMATION_STATEMENT` in `scripts/staging/staging-ledger-lib.mjs`. That identity confirmation still does not authorize any deployment or migration.

## Verification

- Manifest: `docs/execution/phase-2/t-025-staging-resource-ledger.json`
- Manifest SHA-256: `aa1160f234e9abfb7127c5afce2785ec0da0e82943871a4d9c46e095652892fa`
- Authenticated commands executed: `1` (`whoami` only)
- Production commands executed: `0`
- Remote mutations executed: `0`
- Secrets captured: `false`
- Positive evidence fixture: `PASS`
- Exact human gate fixture: `PASS`
- Mutation boundary fixture: `PASS`
- Negative fixtures: `10/10 PASS`

Negative cases prove refusal for authenticated account mismatch, duplicate D1 identity, missing DLQ, Durable Object class mismatch, production-like resource naming, a configured placeholder, absent row counts, wrong human-confirmation fingerprint, a production CLI target, and missing T-024 read-only authorization.

## Blocker requiring human action

Authenticate Wrangler into the Cloudflare account pinned by the approved Tirak configuration, or explicitly correct the pinned account through a separate reviewed decision. Then rerun this read-only audit. Until the authenticated membership contains the pinned account and every resource is uniquely verified, T-025 remains open and `wrangler.toml` placeholders must remain unchanged.
