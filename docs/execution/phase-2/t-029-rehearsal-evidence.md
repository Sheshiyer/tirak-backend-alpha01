# T-029 Rehearse Migration 008 Evidence

Status: **PASS — baseline + 008 rehearsed on disposable target; contract conformance proven; rehearsal deleted; staging fingerprint unchanged**

Executed: 2026-07-23/24 (capture `20260723T193315Z`)
Task: `Sheshiyer/tirak-mobile-app-v2#29`
Contract: `tirak-payments-v1`
Branch: `codex/tirak-omise/w2.1/t-029-rehearse-migration-008`
Dependencies: T-026 ✅, T-028 ✅ (merged via PR #18)
Authority boundary: all mutations targeted only the disposable rehearsal DB. Active staging received zero writes. Production, secrets, live Omise, App Store: untouched.

## Gates executed

| Gate | Decision | Record |
| --- | --- | --- |
| Fingerprint re-confirmation (pre-flight) | Owner confirmed new fingerprint `3b57299a2a7cadc048243a18aeae8cc6d568b548eacf3edcfaa5ddbc24eef7cc` with the exact T-025 statement (fingerprint binds local migration lineage; T-028's merge legitimately changed it; remote staging independently verified unchanged — same uuid, `num_tables: 0`, 0 writes/24h) | `docs/execution/phase-2/t-025-staging-resource-ledger.json` |
| GATE 1 (rehearsal creation + apply) | Pre-approved by owner "yes go ahead" on the published runbook containing the exact gate statement | this ledger |
| GATE 2 (teardown) | Owner chose Option A (delete) | `evidence/t029/rehearsal-delete.out` |

## Acceptance mapping (issue #29)

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Payment attempt and webhook event tables on rehearsal target | Baseline (160 commands) + 008 (7 commands) applied to `tirak-t029-rehearsal` (`aafab53c-2b83-402e-a9b7-01209ed8f894`, APAC) via two isolated migrations roots — quarantined files unreachable | `apply-baseline.out`, `apply-008.out` |
| Tables, indexes, constraints, ledger entry match contract | Exact DDL match (whitespace-normalized) for `payment_attempts`, `payment_webhook_events`, `idx_payment_attempts_customer`, `idx_payment_attempts_charge`, `idx_payment_webhook_events_charge`, `uq_payment_attempt_active_booking` vs `target-schema.sql`. Ledger exactly 2 rows in order: `canonical-baseline.sql` → `008_omise_promptpay_payments.sql`; `verify-lineage.mjs` exit 0 | `rehearsal-schema.json`, `rehearsal-ledger.json` |
| Schema assertions and foreign-key check | `PRAGMA foreign_key_check`: **0 violations** across 151 objects. Negative probe: duplicate active (`pending`) attempt rejected — `UNIQUE constraint failed: payment_attempts.booking_id`. Positive control: retry accepted after terminal transition | `rehearsal-fk-check.json`, `probe-insert-*.json` |

## Execution summary

1. **Stage 0:** branch from post-merge main; baseline regenerated — hash identical `b6532c80…`; credential checks PASS.
2. **Stage A:** preflight PASS; fingerprint gate escalated and human-confirmed (above); fresh recovery point captured (bookmark `00000008-00000000-000050b1-efb81c05bae12939dbcd04eb6c670355`, 32-byte export — staging still pristine).
3. **Stage B:** rehearsal DB created; isolated apply roots (`rehearsal/t029/migrations-baseline/` and `rehearsal/t029/migrations/` with dedicated configs) so the quarantined `004_mobile_app_features.sql` and `009_booking_scoped_chat.sql` were unreachable by the apply path.
4. **Stage C:** baseline then 008 applied cleanly — exactly one ledger row each, as designed.
5. **Stage D:** all verification above; row-count manifest (probe fixtures documented): users 2, bookings 1, payment_attempts 2, payment_webhook_events 0, d1_migrations 2.
6. **Stage E (teardown):** rehearsal deleted; `d1 list` verified absence; post-teardown discovery fingerprint unchanged `3b57299a…`, 0 remote mutations.

Remote mutations in this task: exactly 2 + migration applies on the disposable DB only. Staging/production/secrets: 0.

## Residuals / wave notes

- `payment_restitutions` (011) was absent from the rehearsal by design — **T-029 covers 008 only**. The wave has no explicit 011 rehearsal task; recommend folding it into T-030's rehearsal target (one-line scope amendment at T-030 kickoff) so T-031 validates the complete lineage.
- Full-scope token rotation remains pending under separate secret-mutation authority.
- Local artifact bundle: `evidence/t029/` (checksums in `checksums.sha256`); rehearsal configs under `rehearsal/t029/` retained as apply-path evidence.

**Unblocks: T-030 (rehearse additive chat 010).**
