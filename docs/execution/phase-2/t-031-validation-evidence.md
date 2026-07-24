# T-031 — Validate Migration Integrity and Recovery · Independent Validation Evidence

Status: **EXECUTED — ALL STAGES PASS**
Executed: 2026-07-24
Task: GitHub issue `Sheshiyer/tirak-mobile-app-v2#31` — "[T-031] Validate migration integrity and recovery"
Branch: `codex/tirak-omise/w2.1/t-031-validate-migration-integrity-recovery` (from `main @ d3fbd4d` = PR #20 T-030 merge commit)
Deliverable (verbatim): *"Independent migration and restore report"* — this document + `t-031-validation-ledger.json`
Acceptance (verbatim): *"Foreign keys, indexes, row counts, ledger, and restore procedure pass"* — **all five PASS**
Abort triggers: **none fired**

## What makes this independent

T-031 treats T-030's rehearsal report as a *claim*, not a result. Every claim was re-derived:

1. **Verified before use.** `sha256sum -c evidence/t030/checksums.sha256` → **34/34 OK, exit 0** — before any T-030 artifact was read or restored.
2. **Primary export only.** Restored solely from `evidence/t030/tirak-t030-rehearsal-post-20260724T113406Z.sql`. No rehearsal DB was located, resurrected, or consulted (all were deleted under T-030 GATE 2).
3. **Fresh probes.** Schema surface, FK check, ledger verification, negative/positive probes, and row-count manifest were all re-executed by the validator against `tirak-t031-validation`. Fixture IDs were re-read from the restored DB, not from T-030's fixture file.
4. **Continuity re-verified.** The T-030 evidence bundle records the pre-staging fingerprint `3b57299a…eef7cc` (== T-029 post-teardown fingerprint), and a fresh `staging:discover` on 2026-07-24 produced the same value.

## Stage-by-stage results

### Stage 0 — Preconditions: PASS

- `git checkout main && git pull --ff-only origin main` → head `d3fbd4d1224459763da2039a0e385128183ad21d` ("Merge pull request #20 … t-030-rehearse-migration-010-011"). PR #20 was MERGED; no branch-from-`8f33c51` fallback was needed.
- Baseline regeneration: `node scripts/migrations/generate-canonical-baseline.mjs` → sha256 **`b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f`** — exact match, no drift.
- Contract manifest hash (sha256 of `contracts/tirak-payments-v1/target-schema.sql`): **`08acab5d…b9c9`** — match.
- `.env.tirak-staging` present, mode 0600. Tracked tree clean (untracked: `.codegraph/` tooling only).
- **Independence Rule 1**: `sha256sum -c evidence/t030/checksums.sha256` → 34/34 `OK`.

### Stage A — Fresh staging capture (read-only): PASS

- `staging:preflight` exit 0 (pinned account `2c0c96c68f0ee73b6d980054557bca5b`, 0 remote mutations); `staging:discover` exit 0 → fingerprint **`3b57299a2a7cadc048243a18aeae8cc6d568b548eacf3edcfaa5ddbc24eef7cc`** — fingerprint mini-gate MATCH, no drift (PR #20 added no migration files). `staging:verify` (strict) exit 0, 30 acceptance refusals intact.
- `d1 info tirak-staging`: uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`, **`num_tables: 0`, `write_queries_24h: 0`** — staging pristine.
- Time-travel bookmark: `0000000d-00000000-000050b2-fe1302644a55f9d74a6a73f10eefbb4c`.
- Export `tirak-staging-pre-20260724T140134Z.sql`: **32 bytes** (pristine-empty class, same as T-026/T-030). Signed export URL redacted from the saved transcript.
- **Zero staging writes.** (Operational note: discovery initially refused because the git checkout had reset `t-025-staging-resource-ledger.json` to mode 0644; restored to 0600 per the script's owner-only invariant — a local permission fix, not a repo mutation.)

### Stage B — Validation target + restore (GATE 1, owner-approved 2026-07-24): PASS

- Pre-create check: `d1 list` → `tirak-t031-validation` absent.
- `npx wrangler d1 create tirak-t031-validation` → created in **APAC**, database_id `14e82ef4-0f31-4262-b0d5-705d88a97350`; pre-restore state `num_tables: 0`.
- Restore: `npx wrangler d1 execute tirak-t031-validation --remote --file evidence/t030/tirak-t030-rehearsal-post-20260724T113406Z.sql` → **exit 0**, `rows_written: 365`, `num_tables: 40`, **0 errors / 0 failed / 0 skipped statements**. Single-shot `--file` accepted the 179-statement-line dump; the documented chunking fallback was not needed.
- Post-restore `d1 info`: `num_tables: 40`, `database_size: 933888`.

### Stage C — Structural verification (fresh, on restored DB): PASS

- **Schema surface / indexes:** `rehearsal/t031/live-surface-diff.mjs` (T-030's harness replaying *this validator's* fresh 160-object `sqlite_schema` dump) → **14/14 contract objects exact structural match; 0 missing; 0 extra; verdict `MATCH`; exit 0**. `npx vitest run tests/migrations/` → **29/29 PASS** (5 files).
- **Foreign keys:** fresh `PRAGMA foreign_key_check` → **0 rows**.
- **Ledger:** `verify-lineage.mjs restored-schema.json restored-ledger.json` → **exit 0** ("recognized, consistent lineage state"). Exactly **4 rows, canonical order, no quarantined names**, restored verbatim:

  | id | name | applied_at |
  | --- | --- | --- |
  | 1 | canonical-baseline.sql | 2026-07-24 11:36:39 |
  | 2 | 008_omise_promptpay_payments.sql | 2026-07-24 11:36:56 |
  | 3 | 010_booking_chat_expansion.sql | 2026-07-24 11:36:57 |
  | 4 | 011_payment_restitutions.sql | 2026-07-24 11:36:57 |

  The preserved `applied_at` timestamps (T-030's apply, not re-generated) evidence that the restore carried the ledger intact.

### Stage D — Behavioral verification + cleanup + manifest (fresh): PASS

- Fixtures re-discovered from the restored DB: booking `t030_bk_1`, room `t030_br_1`, users `t030_u_customer` / `t030_u_supplier` / `t030_u_approver`.
- **Negative probe 1 — duplicate active room** on `t030_bk_1` → rejected, exact error:
  `UNIQUE constraint failed: booking_chat_rooms.booking_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE) [code: 7500]`
- **Negative probe 2 — `restituted` row missing evidence/approver/completed_at** → rejected, exact error (lifecycle CHECK):
  `CHECK constraint failed: (status = 'restitution_pending' AND completed_at IS NULL AND failed_at IS NULL) OR (status = 'restituted' AND recipient_reference IS NOT NULL AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL) OR …`
- **Positive controls:** well-formed `restituted` restitution (all lifecycle fields) accepted (`changes: 1`); text `booking_chat_messages` insert on `t030_br_1` accepted (`changes: 1`).
- **Cleanup:** both probe rows deleted (`changes: 1 + 1`) before final capture; final `PRAGMA foreign_key_check` → **0 rows**.
- **Row-count manifest:** fresh 40-table manifest == `evidence/t030/row-count-manifest.json` — **EXACT MATCH, zero diffs**. Nonzero only: `users 3, supplier_services 1, bookings 1, payment_attempts 4, booking_chat_rooms 1, booking_chat_messages 1, payment_restitutions 3, d1_migrations 4`; all other 32 tables 0.

### Teardown — GATE 2 Option A (owner-approved 2026-07-24): PASS

- `npx wrangler d1 delete tirak-t031-validation --skip-confirmation` → exit 0, "Deleted 'tirak-t031-validation' successfully."
- Absence verified: post-delete `d1 list` → 0 matches.
- Post-teardown `staging:discover` fingerprint: **`3b57299a…eef7cc` — unchanged**.
- **Write-target discipline:** every write of this task landed on `tirak-t031-validation` only; staging and production were never written. Restore-by-overwrite of staging/production remains contract-forbidden (migration-strategy.md line 65) and was not attempted.

## Evidence bundle

`evidence/t031/` (27 artifacts + `checksums.sha256`, all verifying): staging pre-captures (info, bookmark, 32-byte export, sanitized transcript), validation DB create/pre-restore/post-restore info, restore transcript, fresh schema/ledger/FK dumps, surface-diff verdict, vitest output, fixture discovery, both negative-probe transcripts, positive controls, cleanup, final row-count manifest, final FK check, pre-create/post-delete `d1 list`, delete transcript.

## Residuals (carried, not introduced by T-031)

- Stale "009" naming in issue #30 title / ISA ISC-153 / branch-worktree manifest — reconcile at wave close.
- ISA ISC-149–155 ledger verification still open — verify before wave close.
- Full-scope token rotation pending separate authority (no secret mutation under this runbook).
- `t-025-staging-resource-ledger.json` `generatedAt` refreshed by the two T-031 discovery runs (same pattern T-030 committed in PR #20).
