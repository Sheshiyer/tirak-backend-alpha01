# Court feedback source-release integration

Date: 2026-09-19. Status: default backend deployed; device and full product release held.

Published source: commit `0971aba9face6e38dd407a059bc405bc515ca56d`,
[draft PR #29](https://github.com/Sheshiyer/tirak-backend-alpha01/pull/29).
GitHub's `backend-release` check passed. The release checkout is preserved at
the sibling `tirak-backend-release-20260919` directory, not the unborn original.

## Lineage and included scope

The release branch `codex/release-court-feedback` starts at remote `main`
commit `977ff8c5a0cfadda6b20da3844b0fbdef45a60e0` in
`Sheshiyer/tirak-backend-alpha01`. Existing remote history and unrelated files
are preserved; the original local checkout is not the release lineage.

The candidate includes the current backend application code, automated tests,
Wrangler configuration, account-trust migration and the staging configuration
validators. This includes existing payment/provider-policy application source
at the owner's explicit direction. Including source does not authorize payment
activation, payment database changes or provider calls.

No new environment files, credentials, raw evidence/rehearsal artifacts,
machine-local orchestration or generated bundles are included. Existing files
already in remote history are not rewritten by this integration. Dependencies
were installed locally with Bun. The existing dependency resolutions were
imported into authoritative `bun.lock`; the old npm lockfile is recoverable in
Git history. The non-deploying CI workflow and release-check command now use Bun.

## Portable schema test fixtures

- `tests/fixtures/014_payment_intents_v2.sql` is an inert, local-only payment
  schema fixture used by the existing automated tests. It is deliberately not
  in `migrations/`; do not apply it remotely during this release.
- `tests/fixtures/016_customer_registration_fields.sql` preserves the two
  compatibility statements needed by the frozen-baseline registration probe.
  This is not a blanket migration: inspect the selected target's
  `PRAGMA table_info(customer_profiles)` and apply each statement only when its
  column is absent, after approval and backup. Do not execute the whole fixture
  on a target that already has either column.
- `migrations/015_account_trust.sql` contains the additive consent, verification
  and socket-ticket tables required by the new application code.

## Release safeguards

1. Confirm the intended Worker, Cloudflare account and D1 database from the
   client's current API URL. The default Worker and named production Worker
   have different database bindings; do not assume they are interchangeable.
2. Capture an approved backup and target schema/migration ledger. Confirm the
   approved booking-chat tables from migration 010 already exist.
3. Select only migration 015 and, where introspection proves necessary,
   individual missing-column statements from fixture 016. Do not run blanket
   migration commands, the historical deploy wrapper or the quarantined
   historical mobile migrations. Payment migration 014 remains excluded.
4. Keep `PAYMENT_MODE=disabled`, `PROMPTPAY_ENABLED=false` and
   `PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED=false`. Do not change provider
   policy KV values, keys or provider configuration. The new staging KV binding
   is source configuration, not evidence that any remote policy is enabled.
5. Verify approved mail configuration and sender identity, then conduct an
   explicitly approved real-inbox test. Adapter readiness alone does not prove
   inbox delivery. Legal approval, real vendor inventory and mailbox ownership
   remain business dependencies.
6. Source publication is owner-authorized. Deploy only after resolving the
   exact target, authentication and schema prerequisites. Verify the
   deployed version, target API and Android build/device journeys before
   describing the client-facing issues as resolved in production.

## Verification in the isolated release checkout

- `bun run typecheck`: pass.
- `bun run release:verify`: pass, including disposable recovery proof and eight
  negative fixtures, with `externalCommandsExecuted: 0`.
- `bunx wrangler deploy --dry-run --env production`: bundles successfully and
  exits without deployment. Production JWT secret presence must be verified
  after authentication; a dry run cannot prove remote secret readiness.
- `bun run test:run`: 407 tests in 34 files pass, including mocked provider
  regressions and local SQLite migration tests; no external mail or payment
  calls are made by these tests.
- `bun run tests/local/verify-account-trust.ts`: pass for real local Hono/SQLite
  registration, verification, consent rollback, persisted chat, socket-ticket
  binding/replay/expiry, authorization, admin contacts and aggregate reporting.
- Browser/Android release and live-provider checks are not established by these
  backend tests; see the separate non-payment implementation checkpoint.

### Separate operational validator limitations

The standalone staging-ledger scripts are not part of the 407 passing
application tests. Their release evidence must not be fabricated or copied
from private local state to obtain a passing result:

- `bun scripts/staging/verify-staging-ledger.mjs` fails its existing internal
  acceptance fixture with `current ledger evidence does not recompute as
  verified`. The same failure reproduces in the original working copy; this
  integration has not established that operational gate.
- `bun scripts/staging/verify-staging-ledger-negative.mjs` passes 38 fixtures in
  the original working copy but refuses the cloned historical ledger because
  Git does not preserve its required owner-only file permissions. Its final
  fixture receives `prior ledger must remain owner-only` before reaching the
  expected missing-authorization check. No permissions, evidence or credential
  files were changed to bypass that guard.

Reconcile these operational validator inputs/fixtures in a separately scoped
release-preflight task before relying on them for staging readiness.

The initial source publication performed no deployment, remote database
migration or payment/provider activation. The subsequent authorized backend
promotion is recorded below.

## Live default-Worker promotion — 2026-09-19

The mobile preview and production environment records target
`https://tirak-backend.tirak-court.workers.dev`. To retain the existing users,
the selected target was the **default** `tirak-backend` Worker and its existing
`tirak-development` D1 (`60443346-c480-4975-962e-bd4daf4a37a8`). The
separate named production Worker/D1 was not switched or modified. This is a
backend deployment to the app's current endpoint, not a claim that the wider
product release or physical-device verification is complete.

- Scoped `tirak` Wrangler authentication succeeded. A restricted local D1 SQL
  export was made before mutation and restored into disposable SQLite: 28 users,
  five bookings, and no foreign-key violations. Its hash and location are held
  in a private, owner-only release receipt outside Git.
- The current D1 already had booking-chat migration 010 tables and both
  customer-profile compatibility columns. An isolated Wrangler migration
  configuration listed only `015_account_trust.sql`; applying it added and
  recorded the four account/consent/socket-ticket tables. No historical,
  payment, or compatibility migration was replayed. The 28 users and five
  bookings remained after migration.
- The default Worker's checked-in JWT placeholder was removed in source commit
  `c7d10eb`; the release gate now rejects a plaintext `JWT_SECRET` in
  `wrangler.toml`. `bun run release:verify` passed all 407 tests and the local
  account-trust Hono/SQLite probe passed. GitHub `backend-release` CI passed.
- Source commit `c7d10eb` was deployed with a fresh `JWT_SECRET` in the same
  Wrangler upload. Active Worker version
  `6dcb5ac9-3501-4e9d-816c-e77d43c0ddac` is at 100% traffic. Live
  bindings read back as the selected D1, `JWT_SECRET: secret_text`, and
  `PAYMENT_MODE=disabled`, `PROMPTPAY_ENABLED=false`, and
  `PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED=false`. The prior `RESEND_API_KEY`
  secret remained bound. The temporary secret upload file was removed.
- `/health`, public stats, and public categories returned HTTP 200. Missing
  authentication on account-verification, consent, and chat routes returned
  HTTP 401; malformed registration returned HTTP 400. A token signed with the
  former placeholder was rejected as invalid, while a token signed with the
  new secret advanced to the expected nonexistent-user denial. No customer
  account or payment mutation was used for smoke tests.

**Remaining:** The default Worker still reports `ENVIRONMENT=development` and
uses development-named storage and queues; this preserves the app's current
data target but does not normalize production topology. Existing sessions may
need to sign in again after JWT rotation. Older Worker versions contain the
exposed key and are unsafe rollback targets. A controlled authenticated
account/consent/chat journey, real-inbox mail delivery, approved legal copy,
vendor inventory, admin publication, Android device verification, and
production OTA/store rollout remain separate gates. Do not present the new
client-facing flows as fully verified until those checks pass.
