# T-036 staging deployment preflight and approval gate

Date: 2026-08-01
Status: **AUTHORIZED / PARTIALLY EXECUTED — KV and JWT complete; application deploy and Custom Domain pending guard validation**
Target account: `2c0c96c68f0ee73b6d980054557bca5b`
Target Worker: `tirak-backend-staging`
Target D1: `tirak-staging` (`5132c8cc-8f23-4dd2-94d1-9d53edb92888`)
Backend source snapshot: `8d8148d9af19c7a477795b212ddb667a5bac9ab1`

## Authority boundary

The whole-plan instruction authorizes continued planning, read-only discovery, tests, and evidence capture. It does not silently authorize these independently persistent mutations:

1. create the account-level KV namespace `tirak-payment-config-staging`;
2. generate and provision a new staging-only `JWT_SECRET` Worker secret;
3. deploy a new `tirak-backend-staging` Worker version; and
4. attach `api-staging.tirak.app` as a Worker Custom Domain, which creates DNS and certificate state in the production `tirak.app` zone even though the Worker is staging.

Production Worker/D1 mutation, live Omise operations, payment enablement, PromptPay enablement, webhook registration, App Store mutation, payouts, subscriptions, and digital unlocks remain outside this gate.

## Authenticated read-only findings

- The owner-authorized full-scope credential source successfully lists the pinned account's staging deployments and secret names. No credential value was printed or copied into either repository.
- Current staging versions are:
  - version 1: `83af4a2f-a9a4-40ca-a1c8-8f40b51e8caa`, created 2026-07-21;
  - version 2: `d51b0c58-9718-4125-ba35-c76d5dcd6815`, created 2026-08-01 by the T-034 secret operation.
- Current staging secrets are exactly `OMISE_SECRET_KEY` and `OMISE_WEBHOOK_SECRET`; `JWT_SECRET` is absent.
- The current version binds the exact staging D1, `CACHE`, `SESSIONS`, R2 bucket, three producer queues, and two Durable Objects. It does not bind `PAYMENT_CONFIG_KV`.
- No KV namespace titled `tirak-payment-config-staging` exists.
- `api-staging.tirak.app` has no DNS record, and the `tirak.app` zone has zero Worker routes.
- The Omise test account still has no registered webhook URI; T-035 remains deferred until this route exists.

## Source/configuration blockers

### T-033 merge regression

Commit `693a378` added three inert `PAYMENT_CONFIG_KV` bindings to `wrangler.toml`, but a later supplier-onboarding branch merge replaced the file with a parent that omitted those 27 lines while retaining the kill-switch implementation. T-036 must restore a reviewed **staging** binding using the newly created namespace ID. Development and production remain unbound until their own gates.

### T-025 topology amendment

The T-025 verifier currently requires staging KV topology to be exactly `CACHE` and `SESSIONS`. Adding `PAYMENT_CONFIG_KV` without updating `scripts/staging/staging-ledger-lib.mjs`, its fixtures, and the signed topology record would correctly fail as unconfirmed drift. The amendment must preserve the existing account/resource identities and add exactly one remote-matched staging namespace.

### Deployment wrapper is prohibited for T-036

`scripts/deploy.sh staging` runs `wrangler d1 migrations apply` before deployment. Authenticated `wrangler d1 migrations list tirak-staging --env staging --remote` reports these pending files:

- `001_initial_schema.sql`
- `002_add_indexes.sql`
- `003_add_analytics_tables.sql`
- `004_background_jobs_tables.sql`
- `004_mobile_app_features.sql`
- `005_muse_ai_foundation.sql`
- `006_referrals_tirak_coins.sql`
- `007_registration_profile_persistence.sql`
- `009_booking_scoped_chat.sql`
- `012_supplier_onboarding.sql`
- `013_supplier_onboarding_review.sql`

Applying that set is not part of T-036 and includes the known duplicate `004` lineage. Therefore the wrapper must not run. After authorization and local verification, T-036 must use a direct, exact `wrangler deploy --env staging` path with no D1 migration command.

The configured staging Durable Object migration remains tag `v1` with only `new_sqlite_classes = ["ChatRoom", "NotificationService"]`; both classes already exist in the deployed binding set. A pre-deploy re-read must still prove no tag or destructive step changed.

## Route decision

Cloudflare recommends a Custom Domain when the Worker is the origin. A Custom Domain creates the DNS record and certificate automatically. The reviewed Worker configuration deliberately contains only the staging exposure controls:

```toml
[env.staging]
name = "tirak-backend-staging"
workers_dev = false
preview_urls = false
```

It contains no `[[env.staging.routes]]` entry. After the route-free baseline deployment is read back, the authorized `api-staging.tirak.app` Custom Domain is attached through Cloudflare's account-level Worker Domains API as a separate mutation.

References:

- <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/>

The execution sequence keeps `workers_dev=false`, `preview_urls=false`, and the baseline upload free of routes. It first deploys the reviewed Worker and verifies the new version and bindings through authenticated Cloudflare read-back. It then attaches the authorized Custom Domain as a separate control-plane mutation and performs HTTPS probes only on the final hostname. T-035 begins only after that hostname, version, DNS state, and certificate are read back. No temporary `workers.dev` exposure is authorized or required.

## Required confirmation

The human release owner may unblock the next bounded step by sending this exact statement:

> I authorize T-036 staging-only execution on Cloudflare account `2c0c96c68f0ee73b6d980054557bca5b` using the existing full-scope token: create exactly one KV namespace named `tirak-payment-config-staging`; generate and provision a new staging-only `JWT_SECRET`; deploy `tirak-backend-staging` directly without running D1 migrations while `PAYMENT_MODE=disabled` and `PROMPTPAY_ENABLED=false`; and attach `api-staging.tirak.app` as a Worker Custom Domain, understanding that this creates DNS and certificate state in the `tirak.app` zone. This does not authorize production mutation, live Omise activity, payment enablement, webhook registration, payouts, subscriptions, digital unlocks, or App Store submission.

A newly issued least-privilege token may be supplied instead. If the existing full-scope token is used, the confirmation explicitly accepts that broader credential risk for this bounded operation.

## Post-authorization stop conditions

- account, Worker, D1, KV title/ID, or source SHA differs from this packet;
- any concurrent staging deployment appears after the final preflight capture;
- the real namespace cannot be uniquely read back;
- local tests, staging topology verification, secret-name inventory, or dry-run binding manifest fails;
- Wrangler proposes any D1 migration or a new/destructive Durable Object migration;
- deployed `PAYMENT_MODE` is not `disabled` or `PROMPTPAY_ENABLED` is not `false`;
- expected version, binding set, Custom Domain, health/auth/booking/chat/payment smoke, or Omise test-account identity cannot be proven;
- any production, live-Omise, or payment-enable surface appears.

## Authorized predeployment execution — 2026-08-01

The human release owner supplied the exact itemized authorization statement and explicitly accepted bounded use of the existing full-scope token. The first two authorized mutations then completed with exact read-back:

- create-only KV returned HTTP 200; exactly one namespace titled `tirak-payment-config-staging` now exists with ID `e929e0361e5346af8956bd47cdd2168d`;
- a generated staging-only `JWT_SECRET` was piped to `wrangler secret put JWT_SECRET --env staging` without `--name`, argument exposure, or persisted plaintext;
- the staging secret inventory is now exactly `JWT_SECRET`, `OMISE_SECRET_KEY`, and `OMISE_WEBHOOK_SECRET`;
- the secret-only version transition is `d51b0c58-9718-4125-ba35-c76d5dcd6815` → `bb8a3970-b45c-4a4f-b9cc-c500538ca85b` under deployment `7c07e870-09cd-442a-a82a-0fa4a9f0b6e4`;
- every non-secret binding remained unchanged, with `ENVIRONMENT=staging`, `PAYMENT_MODE=disabled`, and `PROMPTPAY_ENABLED=false`;
- production pre-state remains frozen at deployment `33b764fc-5fac-4732-a4b0-5dfc122d6c5a`, version `2222520b-d5b2-420a-8b41-364c7e8cbb38`, and secret names `[JWT_SECRET]` for the final no-change comparison;
- no D1 command, code deployment, route/domain mutation, Omise mutation, payment enablement, or production mutation ran in this substage.

The sanitized machine record is `t-036-predeployment-mutation-evidence.json`. Application deployment remains gated on the reviewed source diff, resolved-plan evidence, dry-run manifest, immediate deployment-ID recheck, and direct no-D1 command path. Custom Domain attachment remains a separate final stage followed by DNS/certificate and route read-back.
