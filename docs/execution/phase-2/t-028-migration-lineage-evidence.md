# T-028 Migration Lineage and Additive Chat Expansion Evidence

Status: **PASS — contract-conformant lineage implemented; 216 + 29 tests green; rehearsal on staging deferred to T-029/T-030**

Executed: 2026-07-24 (five parallel implementation lanes + coordinator reconciliation)
Task: `Sheshiyer/tirak-mobile-app-v2#28`
Contract: `tirak-payments-v1`
Branch: `codex/tirak-omise/w2.1/t-028-migration-lineage-and-chat-expansion`
Dependencies: T-012 (strategy) ✅, T-027 (schema inspection) ✅
Authority boundary: no live database was touched. All validation is offline (in-memory/temp SQLite). Staging application is T-029's gated rehearsal.

## Deliverables

| Artifact | What it is |
| --- | --- |
| `migrations/008_omise_promptpay_payments.sql` (corrected in place) | Contract-conformant payments migration: `amount_satang`, `uq_payment_attempt_active_booking` partial unique index, non-contract index removed; exact DDL match to `target-schema.sql` verified programmatically. Safe in place: never applied to any database (T-027 pristine-empty proof) |
| `migrations/010_booking_chat_expansion.sql` (new) | Approved additive chat: `booking_chat_rooms`/`booking_chat_messages` alongside untouched legacy tables; one room per unique booking; `reply_to_id` self-FK; TEXT timestamps; zero data copy. Replaces the quarantined destructive `009_booking_scoped_chat.sql` |
| `migrations/011_payment_restitutions.sql` (new) | The previously missing restitutions table: UNIQUE per attempt + per provider charge, three-state lifecycle CHECKs (approver/evidence/recipient/timestamps per terminal state), verbatim contract conformance |
| `scripts/migrations/generate-canonical-baseline.mjs` + `migrations/baseline/canonical-baseline.sql` | Deterministic canonical baseline from exactly 001–003, `004_background_jobs_tables`, 005–007 (quarantined `004_mobile_app_features.sql` hard-excluded); sha256 `b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f`; refuses on missing sources or quarantined inclusion |
| `scripts/migrations/verify-lineage.mjs` | Offline fail-closed lineage checker: ledger-before-filename enforcement, baseline exactly one row, ordering rules, 10 refusal scenarios; verified against the real T-027 staging dumps (classifies staging pristine-empty, exit 0) |
| `tests/migrations/` (29 tests) | Schema-surface exact-match vs contract, idempotency, integrity negatives, legacy-chat dual-Worker compatibility, quarantine guard |

## Acceptance mapping (issue #28)

| Acceptance | Result | Evidence |
| --- | --- | --- |
| `004` lineage deterministic and rehearsal-reversible | Generator is a pure function of source bytes (identical hash across runs); replay-safety test proves benign no-op-or-refuse on second apply with zero schema change | `idempotency.test.ts`, generator self-verification |
| Existing data remains intact | Additive-only design; legacy `chat_rooms`/`chat_messages` untouched; no renames/drops/copies anywhere in the chain | `legacy-chat.test.ts`, `quarantine-guard.test.ts` |
| Old and new Workers remain compatible | Legacy pair tables present and writable after 010 (old-Worker probe); booking chat writable alongside (new-Worker probe) | `legacy-chat.test.ts` |
| Restitution uniqueness and permissions enforce the frozen contract | Duplicate attempt/charge rejected; terminal states without approver/evidence/recipient rejected by CHECK; positive controls accepted | `integrity-negative.test.ts` |
| Fresh/existing schema, restored-backup replay, idempotency, permission, dual-Worker compatibility tests | Fresh-schema ✅, idempotency ✅, permission ✅, dual-Worker ✅ (29 tests). Restored-backup replay and existing-target repair are rehearsal-scope: **T-029/T-030** on the T-026 recovery chain | `npx vitest run tests/migrations/` |

## Coordinator reconciliation (cross-lane findings)

1. **`src/routes/payments.ts` conformance fix** — application code referenced the pre-contract column `amount`; renamed all 8 `payment_attempts` column references to `amount_satang` (interface, 3 SELECT lists, INSERT list, 2 reconciliation comparisons, response mapping). Local variables, `bookings.total_amount`, and Omise `charge.amount` untouched. Route-test fixture rows updated (12 attempt fixtures; Omise charge mocks correctly kept `amount`).
2. **Staging-ledger fixture correction** — `scripts/staging/verify-staging-ledger.mjs` pending-migration expectation pointed at phantom `008_payment_attempts.sql`; corrected to the real file name.
3. **Baseline idempotency semantics** — strict idempotency for 008/010/011; baseline is single-apply-by-ledger (benign "already exists" refusal with provably zero schema change on replay), per the strategy's single-ledger-row design.
4. **Apply mechanics decision (for T-029)** — baseline applies from `migrations/baseline/` as its own migrations root (ledger name exactly `canonical-baseline.sql`), then 008/010/011 from a directory excluding the quarantined files. Never raw replay from `migrations/`.

## Validation totals

- `tests/migrations/`: **29/29 PASS**
- Full backend suite: **216/216 PASS** (16 files), `tsc --noEmit` clean
- Staging provisioner offline verification: **39/39 checks PASS**; release gate: **PASS**
- Zero network calls, zero live database mutations, zero secrets captured

## Residuals

- T-027 evidence lives on its own branch (`codex/tirak-omise/w2.1/t-027-staging-schema-inspection`, PR #17); it merges independently.
- Quarantined files remain in `migrations/` untouched by design; lineage tooling (`verify-lineage.mjs`) refuses them.
- Full-scope token rotation remains pending under separate secret-mutation authority (carried from T-025/T-026).

**Unblocks: T-029 (rehearse migration 008 on rehearsal target via the T-026 recovery chain).**
