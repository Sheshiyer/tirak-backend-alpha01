# T-030 Rehearse Migrations 010 + 011 Evidence

Status: **PASS — canonical baseline + 008 + 010 + 011 rehearsed on disposable target; contract conformance proven (14 objects); rehearsal deleted; staging fingerprint unchanged**

Executed: 2026-07-24 (capture `20260724T113406Z`)
Task: `Sheshiyer/tirak-mobile-app-v2#30` (issue title says "009" — stale; see renumbering note)
Contract: `tirak-payments-v1`
Branch: `codex/tirak-omise/w2.1/t-030-rehearse-migration-010-011`
Dependencies: T-026 ✅, T-028 ✅, T-029 ✅ (PR #19 merged, merge commit `a095da7` — Stage 0 branched from updated `main`)
Authority boundary: all mutations targeted only the disposable rehearsal DB. Active staging received zero writes. Production, secrets, live Omise, App Store: untouched.

## Renumbering note — 009 → 010/011

Issue #30 is titled "[T-030] Rehearse additive migration 009". `009_booking_scoped_chat.sql` is quarantined (destructive legacy rename; hard-coded in `verify-lineage.mjs` `QUARANTINED_NAMES`). The rehearsed lineage is **`010_booking_chat_expansion.sql`** (additive booking chat) plus **`011_payment_restitutions.sql`**, folded in under the owner-approved 2026-07-24 scope amendment. The quarantined file was never copied, applied, or read; the isolated apply roots made it unreachable.

## Gates executed

| Gate | Decision | Record |
| --- | --- | --- |
| Fingerprint mini-gate (Stage A) | Computed fingerprint `3b57299a2a7cadc048243a18aeae8cc6d568b548eacf3edcfaa5ddbc24eef7cc` matched the human-confirmed successor value exactly — PR #19 added no migration files, so no drift and no re-confirmation round was needed | `docs/execution/phase-2/t-025-staging-resource-ledger.json` |
| GATE 1 (rehearsal creation + apply) | Owner approved 2026-07-24: exactly one disposable D1 `tirak-t030-rehearsal` (APAC), baseline + 008 + 010 + 011 only | this ledger |
| GATE 2 (teardown) | Owner approved Option A (delete) | `evidence/t030/rehearsal-delete.out`, `d1-list-post-delete.txt` |

## Acceptance mapping (issue #30 + 011 amendment)

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Chat + restitution tables on rehearsal target | Baseline (160 commands) + 008 (7) + 010 (7) + 011 (4) applied to `tirak-t030-rehearsal` (`e24d1fa5-12dd-4057-ac6f-d934f6b95335`, APAC) via two isolated migrations roots — quarantined files unreachable | `apply-baseline.out`, `apply-lineage.out` |
| Tables, indexes, constraints, ledger entries match contract | Live-dump surface diff vs `target-schema.sql`: **14/14 objects exact structural match** (columns, FKs, CHECKs, indexes), zero missing, zero extra domain objects; local harness `npx vitest run tests/migrations/` 29/29 PASS | `probe-live-surface-diff.json`, `rehearsal-schema.json` |
| Ledger | Exactly 4 rows in order: `canonical-baseline.sql` → `008_omise_promptpay_payments.sql` → `010_booking_chat_expansion.sql` → `011_payment_restitutions.sql`; `verify-lineage.mjs` exit 0 | `rehearsal-ledger.json`, `verify-lineage.out` |
| No ambiguous legacy history is copied | Legacy `chat_rooms`/`chat_messages` present with DDL byte-identical (whitespace-normalized) to the canonical baseline, incl. all 10 legacy indexes; zero rows before fixtures, zero rows after probe cleanup — nothing copied | `probe-legacy-ddl.json`, `probe-legacy-zero-pre.json`, `probe-legacy-cleanup.json` |
| Eligible bookings create one room | Fixture `t030_bk_1` → exactly one `booking_chat_rooms` row; second INSERT on same `booking_id` rejected: `UNIQUE constraint failed: booking_chat_rooms.booking_id` (SQLITE_CONSTRAINT_UNIQUE, code 7500) | `probe-booking-chat-write.json`, `probe-dup-room-negative.out` |
| Old Worker reads/writes remain safe (dual-Worker window) | Legacy write probe: `chat_rooms`/`chat_messages` INSERT + read-back valid (`status='active'`, content intact). New-Worker probe: `booking_chat_*` writes accepted while legacy counts unchanged (1/1 → 1/1, no cross-touch). Legacy probe rows then deleted; tables back to 0 rows | `probe-legacy-write.json`, `probe-booking-chat-write.json`, `probe-legacy-cleanup.json` |
| Restitution integrity (011 amendment) | Duplicate `payment_attempt_id` rejected: `UNIQUE constraint failed: payment_restitutions.payment_attempt_id`. Duplicate `provider_charge_id` rejected: `UNIQUE constraint failed: payment_restitutions.provider_charge_id`. Lifecycle negatives rejected: `restituted` missing evidence_uri/approver/completed_at → `CHECK constraint failed`; `restitution_pending` with `completed_at` → `CHECK constraint failed` (both SQLITE_CONSTRAINT_CHECK, code 7500). Positive controls accepted for all three states: `restitution_pending`, `restituted` (complete evidence chain), `restitution_failed` (complete failure chain) — fixtures referenced terminal-state `payment_attempts` rows | `probe-restitution-positives.json`, `probe-restitution-dup-attempt.out`, `probe-restitution-dup-charge.out`, `probe-restitution-neg-restituted.out`, `probe-restitution-neg-pending.out` |
| Schema assertions and foreign-key check | `PRAGMA foreign_key_check`: **0 violations** post-apply and re-verified 0 after all fixture writes | `rehearsal-fk-check.json`, `rehearsal-fk-check-final.json` |
| Row-count validation | 40 tables counted; nonzero only: users 3, supplier_services 1, bookings 1, payment_attempts 4 (terminal fixtures), booking_chat_rooms 1, booking_chat_messages 1, payment_restitutions 3, d1_migrations 4. Legacy chat and all other tables 0 | `row-count-manifest.json`, `row-count-manifest.txt` |

## Execution summary

1. **Stage 0:** `main` fast-forwarded to PR #19 merge (`a095da7`); branch created. Baseline regenerated — hash identical `b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f`; `.env.tirak-staging` present mode 0600; tree clean (only pre-existing untracked `.codegraph/`). One local hygiene fix: the checked-out `t-025-staging-resource-ledger.json` was mode 0644; `chmod 600` restored the owner-only mode the discovery script requires (content untouched; git does not track this bit).
2. **Stage A (read-only):** preflight PASS (4 requests, 0 mutations, secrets not captured); discover PASS — fingerprint `3b57299a…eef7cc` exact match; strict verify PASS (30 strict refusals honored). Staging pristine: uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`, `num_tables: 0`, 0 writes/24h. Recovery point: bookmark `0000000a-00000000-000050b2-ab38e099af81f6209d5e69c5194c217f`, export captured.
3. **Stage B:** `d1 list` confirmed `tirak-t030-rehearsal` absent, then created (`e24d1fa5-12dd-4057-ac6f-d934f6b95335`, APAC). Isolated roots: `rehearsal/t030/migrations-baseline/` (baseline copy only, sha256 re-verified) and `rehearsal/t030/migrations/` (008, 010, 011 only); dedicated `wrangler.baseline.toml` / `wrangler.lineage.toml` — repo `wrangler.toml` never used.
4. **Stage C:** baseline applied (160 commands, 1 migration), then lineage root (008: 7, 010: 7, 011: 4 commands, filename order). Ledger: exactly 4 rows, approved order, no quarantined names.
5. **Stage D:** all probes in the acceptance mapping above. Note: D1 rejects compound SELECTs beyond a small term limit (`too many terms in compound SELECT: SQLITE_ERROR`), so the row-count manifest used a single scalar-subquery SELECT via `--command` (file mode returns only summary stats, not rows).
6. **Stage E (teardown + closure):** post-apply export captured; GATE 2 Option A executed — `tirak-t030-rehearsal` deleted; `d1 list` verified absence (0 matches); post-teardown discovery fingerprint unchanged `3b57299a…eef7cc`.

Remote mutations in this task: exactly 2 (create + delete) plus migration applies and probe writes on the disposable DB only. Staging/production/secrets: 0.

## Residuals / wave notes

- Issue #30 title ("009") remains stale — reconcile title, ISA ledger naming, and the branch-worktree manifest (`…-additive-migration-009`) at wave close per the runbook drift register.
- ISA ISC-153–155 ledger was unchecked at T-030 kickoff — verify before wave close.
- Full-scope token rotation remains pending under separate secret-mutation authority.
- Local artifact bundle: `evidence/t030/` (checksums in `checksums.sha256`, presigned export URLs redacted); rehearsal configs + live surface-diff harness under `rehearsal/t030/` retained as apply-path evidence.

**Unblocks: T-031 (validate the complete lineage: baseline + 008 + 010 + 011).**
