# Project handoff

## Checkpoint

- Status: `draft-held`
- Portfolio: `thoughtseed`
- Repository: `tirak-backend-alpha01`
- Registry WorkObject: `branch:tirak`
- GitHub: `Sheshiyer/tirak-backend-alpha01`

This packet was drafted by the packet-authoring tool from registry and
repository evidence. It has not been reviewed by a human and is not
committed.

## Completed

- Registry WorkObject matched via `sourceInventory`.
- Packet drafted: all six files present.
- No fields were flagged for review.

## Next action

Review this draft packet, resolve any items flagged in the review summary,
commit the six files as a single repository change, and move
`packet_status` to `reviewed-held`. A relocation manifest approval and a
live-apply approval both remain separate, later steps.

## Verification

```bash
npm install
npm run test
git status --short
```

No registry, capsule, relocation, session, Paseo, provider, or deployment
mutation has been performed by drafting this packet.

## Source release candidate — 2026-09-19

Publication follow-up: source commit `0971aba` is pushed on
`codex/release-court-feedback` with draft PR #29; GitHub CI passes. No live
deployment or migration occurred. Production/preview Expo currently target the
default Worker, whose `/health` reports `environment: development`. Cloudflare
sign-in and exact data-target reconciliation are still required.

- Prepared `codex/release-court-feedback` from remote main
  `977ff8c5a0cfadda6b20da3844b0fbdef45a60e0`, preserving existing history.
- Current backend application/config/test changes are integrated, including
  existing payment application source without activating payments.
- Release scope, verification and migration safeguards are recorded in
  `docs/execution/release-court-feedback-20260919.md`.
- Typecheck, all 407 tests across 34 files, and the portable local account-trust
  integration probe pass.
- No commit, push, deployment, remote migration, credential or provider-policy
  change was performed. Select the actual Worker/D1 target before any release;
  do not use blanket migration/deploy wrappers.

## Authorized backend promotion — 2026-09-19

The app's current default `tirak-backend` Worker and `tirak-development` D1
were selected to preserve its existing users. A restricted backup was exported
and restored successfully before applying only `015_account_trust.sql` to that
D1. The schema, migration ledger, unchanged user/booking counts, and zero
foreign-key violations were read back. Source commit `c7d10eb` removed the
checked-in JWT placeholder and added a release-gate check; 407 tests, the local
account-trust probe, and GitHub CI passed.

Worker version `6dcb5ac9-3501-4e9d-816c-e77d43c0ddac` is deployed at 100%
to the app's existing URL. Its JWT binding is `secret_text`; the old signing
key is rejected. The three payment controls are disabled. Health/public smoke
checks and protected-route denial checks passed. The private backup receipt is
held outside Git. No payment/provider activation, production OTA, or device
test occurred. See `docs/execution/release-court-feedback-20260919.md` for
exact boundaries and remaining acceptance gates.

## Tirak Admin access — 2026-09-20

The owner's Tirak application account was provisioned with the existing
`admin` role in `tirak-development` after a restricted D1 backup and restore
check. The app has no distinct `superadmin` role. Account identifiers and the
credential are held outside Git.

The deployed default Worker initially omitted `https://admin.tirak.app` from
`FRONTEND_URLS`, so browser login failed at CORS preflight before reaching
authentication. Wrangler profile `tirak` deployed the origin addition as
Worker version `c1617173-57e7-4313-9295-3491f6bf8d66`. Version readback
confirmed the same D1 binding, `JWT_SECRET` secret binding, and all three
payment controls disabled. The owner account then signed in through the
in-app browser; the dashboard's 29-user count matched D1. Device verification
and any production release decision remain separate.


## Core guide repair candidate — 2026-09-28

Implemented owner experience persistence/archival, recurring settings and dated
availability, shared public visibility for legacy aliases, real owner stats,
canonical booking duration and schedule checks. Migration 017 is prepared but
not applied. Historical service IDs and booking foreign keys are preserved.

Local verification: TypeScript and all 435 tests across 38 files pass;
11 new SQLite route scenarios include security, transactional rollback,
archive/history, schedule precedence, overlap enforcement and truthful stats.
See `docs/execution/core-guide-repairs-20260928.md` for exact mobile contracts,
legacy live-schema drift, selected migration preflight and release limitations.
No remote mutation, release, provider message or device acceptance is claimed.
## Core communication repair candidate — 2026-09-28

Local email/reset/push repair preserves the selected Cloudflare provider, adds
sanitized delivery outcomes, uniform recovery responses, a secure browser reset
page, and atomic single-use reset consumption. Authenticated push registration
now reassigns token ownership atomically; logout removal is owner-scoped.
Migration `019_password_reset_consumptions.sql` is additive and local-only;
apply it explicitly to the retained Core target before any authorized deploy.
TypeScript and all 458 tests pass. See
`docs/execution/core-comms-repair-20260928.md` for contracts and remaining live,
inbox, signed-binary and physical-device gates. No live changes occurred.

Review correction: new supplier invitations now include explicit 24-hour expiry
and use the Core reset page. Historical invite KV records without an expiry are
rejected; a fresh forgot-password request is the supported recovery path.
Verification timeout remains pending/unavailable and supports a received valid
code under unchanged attempt/expiry limits. Definitive failures stay unusable.

## Resend preparation — 2026-09-28

Local shared Resend adapter and Worker secret type are prepared atop the integrated
repair candidate. Tests cover real verification/reset consumers and transport
uncertainty; full suite passes 504 tests. Typecheck and Worker dry-run pass.
See `docs/execution/resend-migration-20260928.md` for activation prerequisites.
Provider selection remains Cloudflare. No DNS, secret, account, deployment or
email send occurred. Resend workspace/domain setup and inbox acceptance remain open.

## Resend live release — supersedes preparation status

User approved the integrated Core release. Migrations 017/019 are applied after
a fresh export and successful restore rehearsal. Corrected source 31e1cbf is
live as version ee8b5743-8907-4fd2-8a2e-67f0aed6344c at 100%, with Resend
selected and payments disabled. All 507 tests, typecheck, static release gate,
workerd acceptance/redirect checks and live HTTP smoke pass. The existing
RESEND_API_KEY secret is rejected by Resend as invalid. Await secure owner
replacement, then test only mrhigh3r@gmail.com. No provider acceptance or inbox
delivery is claimed; do not use missing-account recovery as mail proof.
See docs/execution/resend-migration-20260928.md for provenance and limitations.

## Credential resolution — 2026-09-28

Owner authorized the Tirak-labeled Resend key from the Claude environment. It was
installed securely as RESEND_API_KEY without printing its value. Secret update
activated version ec46c7ab-b96a-4ba2-a907-53849c0f50dc at 100%, retaining the same
source, D1, Resend configuration and disabled payments. The real shared adapter
with the inherited Worker secret sent one QA email to mrhigh3r@gmail.com. Resend
accepted message 01a0e97b-7c8f-7619-a59b-7d4019112a19 and its exact-message GET
returned last_event=delivered with the recipient verified. The preview was stopped.
The invalid-key blocker is resolved. Human inbox confirmation and real invitation/
password-reset completion remain separate from provider-reported delivery.
