# Wrangler Binding Audit

Date: 2026-05-18

This audit supports INT-003. No Cloudflare deployment was attempted.

## Summary

The current `wrangler.toml` is structurally close to the intended Worker runtime but is not staging-ready.

## Binding Status

| Binding | Development | Staging | Production | Status |
|---|---|---|---|---|
| Worker name | `tirak-backend-dev` | `tirak-backend-staging` | `tirak-backend-production` | Named. |
| D1 `DB` | `placeholder-dev-db-id` | `placeholder-staging-db-id` | `placeholder-production-db-id` | Blocking placeholders. |
| R2 `STORAGE` | `tirak-storage-dev` | `tirak-storage-staging` | `tirak-storage-production` | Names present; existence not validated. |
| KV `CACHE` | `placeholder-cache-dev-id` | `placeholder-cache-staging-id` | `placeholder-cache-production-id` | Blocking placeholders. |
| KV `SESSIONS` | `placeholder-sessions-dev-id` | `placeholder-sessions-staging-id` | `placeholder-sessions-production-id` | Blocking placeholders. |
| Queue producers | moderation, analytics, notification | moderation, analytics, notification | moderation, analytics, notification | Names present; existence not validated. |
| Queue DLQs | moderation, analytics, notification | moderation, analytics, notification | moderation, analytics, notification | Names present; existence not validated. |
| Durable Objects | `CHAT_ROOM`, `NOTIFICATION_SERVICE` | inherited | inherited | Migration tag `v1` present. |
| `JWT_SECRET` | plaintext var | plaintext var | plaintext var | Must move to Wrangler secret before staging/prod. |
| `FRONTEND_URLS` | localhost | `https://staging.tirak.app` | `https://tirak.app,https://www.tirak.app` | Needs alignment with actual customer/admin URLs. |

## Blockers Before Staging Deploy

1. Replace D1 and KV placeholder IDs for the target staging account.
2. Confirm R2 buckets exist.
3. Confirm Queue and dead-letter queue resources exist.
4. Move staging/production `JWT_SECRET` out of checked-in vars and into Wrangler secrets.
5. Decide whether admin command center URL must be added to `FRONTEND_URLS`.
6. Resolve backend typecheck and test failures.
7. Resolve remaining dev-tool advisories before relying on Wrangler-driven deploy automation.

## Cloudflare Manager Gate

Use the Cloudflare Manager workflow only after credentials are present outside the repo. Required local condition:

- `.env` or shell environment provides `CLOUDFLARE_API_KEY` or an approved Wrangler auth path.
- Active account is confirmed.
- Target environment is staging, not production.

## Verification Commands

- `sed -n '1,260p' wrangler.toml`
- `npm audit --omit=dev --json`
