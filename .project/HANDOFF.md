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

## Local checkpoint — modular payment-provider policy

- Added the non-secret `PAYMENT_PROVIDER_POLICY_V1` contract and known-provider
  registry. Omise currently maps only the allowlisted `promptpay` method to the
  existing `omise-promptpay` adapter seam.
- Added admin-readable `GET` and payment-admin-only `PATCH
  /api/admin/payments/provider-policy`. PATCH requires the acting admin ID in
  the `PAYMENT_ADMIN_USER_IDS` environment allowlist. The PATCH body is strict
  and accepts provider, environment, mode, enabled state, method allowlist, and
  optional expected revision only; provider credentials remain environment
  bindings and are represented solely by readiness booleans.
- Current policy and before/after actor/timestamp audit are saved in one KV
  value. Validation, revision conflicts, unreadable stored state, and failed KV
  writes leave the previous policy unchanged.
- Resolver states fail closed for absent, invalid, disabled, unknown-provider,
  unsupported-method, environment/mode mismatch, and missing/mismatched binding
  conditions. No provider request is made by this configuration surface.
- The existing `POST /api/payments/charges` creation gate now requires both the
  legacy runtime kill-switch and this modular policy to allow Omise PromptPay.
  Absent/disabled/invalid/unready provider policy closes before booking,
  payment-attempt, or provider work; webhook, status, and recovery settlement
  paths remain available.
- The admin read model reports the combined runtime kill-switch and provider
  policy result, so it cannot display an effective enabled state while charge
  creation remains closed. Enabled production/live writes additionally require
  `PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED=true`; checked-in environments keep
  that release-owner gate false.
- KV revision checks are best-effort conflict detection, not a compare-and-set
  transaction. A D1 transaction or Durable Object serialization remains a
  production-hardening gate before concurrent multi-operator use.

Remote-rooted verification on branch `codex/tirak-backend-release-readiness`:

- `bun run typecheck` passes.
- The focused payment surface passes 5 files and 93 tests.
- The full suite passes 26 files and 341 tests. Its remaining four failures are
  all in `tests/routes/admin-supplier-onboarding.test.ts` and reproduce unchanged
  on the untouched `origin/main` commit `977ff8c`; they are outside this payment
  reconciliation.

This checkpoint does not provision KV, change credentials, call Omise, deploy,
or mutate external state. Those are separate owner-gated integration steps.
