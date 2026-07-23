# T-027 Staging Booking, Payment, and Chat Schema Inspection

Status: **COMPLETE — all 100 preconditions classified (21 PASS / 71 FAIL / 8 NOT_APPLICABLE); every FAIL is the expected, strategy-compliant state; no corruption or drift detected on staging**

Executed: 2026-07-24 (local, APAC) — synthesis of Lanes A/B/C evidence captured 2026-07-23/24
Task: `Sheshiyer/tirak-mobile-app-v2#27`
Contract: `tirak-payments-v1` (T-011 frozen target schema; T-012 migration strategy)
Authority: read-only throughout. Lane C executed SELECT-only probes against staging D1 `tirak-staging` (uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`); every successful query reported `changes: 0`, `rows_written: 0`. No git mutations, no database writes, no file modifications outside the lane evidence files and this synthesis.

## Acceptance mapping (issue #27)

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Every precondition for 008 and 009 is classified pass/fail | **DONE** — 100/100 precondition rows classified: 80 Lane A contract rows (sections A–H) + 20 Lane B lineage rows (B-P1–B-P11, B-C1–B-C9), each with PASS / FAIL (baseline required) / FAIL (repo artifact non-conformant) / NOT_APPLICABLE and a basis | Classified checklists below; `t-027-schema-inspection-ledger.json` |
| Read-only SQL output checked against T-011 | **DONE** — Lane C live probes (`sqlite_schema` dump, `table_list`, per-table `table_info`/`index_list`/`foreign_key_list`, `d1_migrations` ledger read, `PRAGMA user_version`) compared row-by-row against the frozen T-011 `target-schema.sql`, state matrix, permission matrix, and migration strategy | `evidence/t027/staging-*.json`; Lane A checklist expectations; classification basis column below |
| Read-only; no mutations | **HONORED** — zero writes to staging, zero git operations, zero credential exposure | Lane C auth note; `rows_written: 0` on all probes |

## Staging actuals summary (Lane C, 2026-07-24)

| Probe | Result |
| --- | --- |
| `d1 info tirak-staging` | uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`, APAC, `num_tables: 0`, created `2026-07-21T08:31:52.401Z` |
| Full `sqlite_schema` dump | 1 row only: Cloudflare-internal `_cf_KV`. Zero user tables/indexes/triggers/views |
| `PRAGMA table_list` | `_cf_KV`, `sqlite_schema`, `sqlite_temp_schema` only — no user tables |
| `d1_migrations` ledger | **Absent** — no wrangler-managed migration has ever been applied |
| `PRAGMA user_version` | **REFUSED** — `not authorized: SQLITE_AUTH [code: 7500]` (same refusal class as T-025 via REST) |
| Bookmark surface | Not exposed via `d1 info --json` or per-query `meta.bookmark`; T-026 Time Travel bookmark + export remain the recovery point |

Staging matches the T-026 fingerprint `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10` (pristine-empty). No drift.

## Classification decision rule

1. Expected state is absence / quarantine / non-application, and staging confirms it → **PASS**.
2. Identity or classification metadata confirmed by probes → **PASS**.
3. Contract↔state-matrix or FK design cross-check performable from the frozen contract and lane documents → **PASS** (basis noted).
4. Row names a specific repo-artifact divergence from the frozen contract → **FAIL (repo artifact non-conformant — T-028 must correct)**.
5. Row requires schema objects (tables/columns/indexes/constraints/ledger rows) that pristine staging intentionally does not have, with no repo divergence named → **FAIL (baseline required)** — the expected, strategy-compliant state per migration-strategy.md (empty target → canonical-baseline path), **not** corruption.
6. Forward-looking process/plan/tooling gate not observable from staging state → **NOT_APPLICABLE** (deferred to T-028/T-029/release plan).

## Classified checklist — Lane A: T-011 contract preconditions (80 rows)

### A. Target identity, ledger, and execution path (10 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| A1 | Exact target identity captured (name + database_id) | **PASS** | Lane C `staging-d1-info.json`: name `tirak-staging`, uuid recorded |
| A2 | `d1_migrations` ledger read and compared to repo filenames | **PASS** | `staging-migration-ledger.json`: table absent → per-file mapping is trivially "nothing applied"; absence documented as evidence |
| A3 | Target classified into exactly one path | **PASS** | Zero user tables + absent ledger → empty/fresh → canonical-baseline path (not raw replay) |
| A4 | Unknown-target refuse/escalate rule honored | **NOT_APPLICABLE** | Target was recognized; refuse path never engaged. Fail-closed enforcement is a T-028 tooling property |
| A5 | Recoverable Time Travel bookmark/export captured before mutation | **PASS** | T-026 (2026-07-23): bookmark `00000004-00000000-000050b1-8a569dc1ed6892b99a7f807910fd90a9` + export `tirak-staging-20260723T181204Z.sql`; post-task fingerprint unchanged |
| A6 | Legacy `004_mobile_app_features.sql` quarantined | **PASS** | Ledger absent → never applied to this target; excluded from T-028 plan |
| A7 | Legacy renaming `009_booking_scoped_chat.sql` forbidden | **PASS** | Ledger absent → never applied; remains quarantined |
| A8 | No raw `for file in migrations/*.sql` replay | **PASS** | Zero user tables + absent ledger prove no raw replay ever ran on this target |
| A9 | Payment/chat/restitution migrations only via Wrangler ledger after rehearsal; `target-schema.sql` never applied to D1 | **PASS** | Zero contract tables present → contract target SQL never applied through any path; ledger-first gate carries to T-028 |
| A10 | Legacy chat tables never renamed/dropped; legacy conversations never copied | **PASS** | No legacy tables exist on staging; nothing renamed, dropped, or copied |

### B. Parent-table preconditions (4 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| B1 | `users(id)` exists as FK parent | **FAIL (baseline required)** | `users` absent (`staging-table-list.json`) — expected on pristine staging; supplied by canonical baseline (001) |
| B2 | `bookings(id)` exists as FK parent | **FAIL (baseline required)** | `bookings` absent — supplied by canonical baseline (001) |
| B3 | No partial/orphan payment/chat objects pre-exist | **PASS** | All five contract tables (`payment_attempts`, `payment_webhook_events`, `payment_restitutions`, `booking_chat_rooms`, `booking_chat_messages`) absent — exactly the required pre-baseline state |
| B4 | Legacy pair-scoped `chat_rooms`/`chat_messages` state recorded if present | **PASS** | Absent, as expected on empty staging; additive path has nothing to preserve |

### C. `payment_attempts` preconditions (17 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| C1 | Table exists, `id TEXT PRIMARY KEY` | **FAIL (baseline required)** | Table absent; repo 008 conforms on this point — passes after baseline + corrected payments migration |
| C2 | `booking_id TEXT NOT NULL REFERENCES bookings(id)` | **FAIL (baseline required)** | Table and parent absent; repo 008 conforms |
| C3 | `customer_id TEXT NOT NULL REFERENCES users(id)` | **FAIL (baseline required)** | Table and parent absent; repo 008 conforms |
| C4 | `provider` CHECK = 'omise' | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C5 | `payment_method` CHECK = 'promptpay' | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C6 | `idempotency_key TEXT NOT NULL UNIQUE` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C7 | `attempt_number` CHECK > 0 | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C8 | `provider_charge_id TEXT UNIQUE` (nullable) | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C9 | Amount column named `amount_satang` | **FAIL (repo artifact non-conformant — T-028 must correct)** | Repo 008 uses `amount`; contract requires `amount_satang` (Lane A divergence 1) |
| C10 | `currency` CHECK = 'THB' | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C11 | Status enum: six state-matrix values exactly | **FAIL (baseline required)** | Table absent; repo 008 enum matches contract/state matrix |
| C12 | Nullable lifecycle/error columns (7 × TEXT) | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C13 | `created_at`/`updated_at` defaults | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C14 | `UNIQUE (booking_id, attempt_number)` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C15 | Partial unique index `uq_payment_attempt_active_booking … WHERE status IN ('creating','indeterminate','pending')` | **FAIL (repo artifact non-conformant — T-028 must correct)** | Repo 008 lacks it; has non-unique `idx_payment_attempts_booking` instead (Lane A divergence 2) |
| C16 | Index `idx_payment_attempts_customer` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| C17 | Index `idx_payment_attempts_charge` | **FAIL (baseline required)** | Table absent; repo 008 conforms |

### D. `payment_webhook_events` preconditions (7 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| D1 | Table exists, `replay_key TEXT PRIMARY KEY` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D2 | `provider_event_id TEXT UNIQUE` (nullable) | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D3 | `provider_charge_id TEXT NOT NULL` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D4 | `signature_timestamp INTEGER NOT NULL` | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D5 | Status enum: received/processed/ignored/failed | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D6 | `received_at` default; `processed_at` nullable | **FAIL (baseline required)** | Table absent; repo 008 conforms |
| D7 | Index `idx_payment_webhook_events_charge` | **FAIL (baseline required)** | Table absent; repo 008 conforms |

### E. `payment_restitutions` preconditions (17 rows — contract-only, no repo migration exists)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| E1–E17 | Table shape, FKs, uniques (E3/E4), lifecycle CHECKs (E13–E15), indexes (E16/E17) | **FAIL (repo artifact non-conformant — T-028 must correct)** | No repo migration creates `payment_restitutions` at all (Lane A divergence 3); T-028 must author the restitutions migration before any of these can be verified on staging |

(E1 table+PK; E2 booking FK; E3 `payment_attempt_id` UNIQUE FK; E4 `provider_charge_id` UNIQUE; E5 customer FK; E6 `amount_satang`/currency; E7 `reason`; E8 `recipient_reference`; E9 `evidence_uri`; E10 `approver_user_id` FK; E11 status enum; E12 lifecycle timestamps; E13–E15 lifecycle CHECKs; E16 booking index; E17 customer index — all share the same classification and basis.)

### F. Booking chat preconditions (15 rows — additive expansion replacing forbidden legacy 009)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| F1 | New tables named `booking_chat_rooms`/`booking_chat_messages` alongside legacy | **FAIL (repo artifact non-conformant — T-028 must correct)** | Repo 009 is the forbidden renaming variant (renames legacy tables, reuses `chat_rooms`/`chat_messages` names; also `DATETIME` vs contract `TEXT`) — Lane A divergence 4 |
| F2 | `booking_chat_rooms.id TEXT PRIMARY KEY` | **FAIL (baseline required)** | Table absent; no conformant migration exists yet (T-028 additive replacement) |
| F3 | `booking_id UNIQUE REFERENCES bookings(id) ON DELETE CASCADE` | **FAIL (baseline required)** | Table and parent absent |
| F4 | `customer_id`/`supplier_id` FKs to `users(id)` | **FAIL (baseline required)** | Table and parent absent |
| F5 | Room status enum + default 'active' | **FAIL (baseline required)** | Table absent |
| F6 | `last_message_at` nullable; timestamp defaults | **FAIL (baseline required)** | Table absent |
| F7 | Messages table PK + `room_id`/`sender_id` FKs | **FAIL (baseline required)** | Table absent |
| F8 | `message_type` enum | **FAIL (baseline required)** | Table absent |
| F9 | Payload columns + delivery/read timestamps | **FAIL (baseline required)** | Table absent |
| F10 | `reply_to_id` self-referencing FK | **FAIL (repo artifact non-conformant — T-028 must correct)** | Legacy 009's `reply_to_id` has no REFERENCES clause (Lane A divergence 4) |
| F11 | Index `idx_booking_chat_rooms_customer` | **FAIL (baseline required)** | Table absent |
| F12 | Index `idx_booking_chat_rooms_supplier` | **FAIL (baseline required)** | Table absent |
| F13 | Index `idx_booking_chat_messages_room_time` | **FAIL (baseline required)** | Table absent |
| F14 | New/old Worker compatibility proven before traffic change | **NOT_APPLICABLE** | Release-plan step, not a schema property; on empty staging there is no legacy traffic to protect. Deferred to T-028/release plan |
| F15 | No legacy table retirement/renaming in this release | **PASS** | No migration applied; no rename/drop of legacy chat tables has occurred on staging |

### G. Permission-matrix expectations enforceable at schema level (6 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| G1 | Clients cannot write payment tables; ownership columns present | **FAIL (baseline required)** | Ownership columns (C3, E5) not materialized; tables absent |
| G2 | Restitution unique per attempt and provider charge | **FAIL (repo artifact non-conformant — T-028 must correct)** | Depends on E3/E4 in the missing restitutions migration |
| G3 | Terminal restitution requires approver + evidence (E13–E15 verbatim) | **FAIL (repo artifact non-conformant — T-028 must correct)** | Depends on the missing restitutions migration |
| G4 | Provider truth immutable; resolution only via restitutions ledger | **FAIL (repo artifact non-conformant — T-028 must correct)** | C11 enum itself is closed/conformant, but the required separate restitutions ledger has no repo migration |
| G5 | Cancellation gate schema-enforceable | **FAIL (repo artifact non-conformant — T-028 must correct)** | Depends on the missing partial unique index C15 |
| G6 | Chat participants derived from one unique booking | **FAIL (baseline required)** | `booking_chat_rooms` absent (F3–F4) |

### H. State-matrix ↔ schema cross-checks (4 rows)

| # | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| H1 | Attempt enum = state-matrix values exactly | **PASS** | Set comparison: contract C11 and repo 008 both enumerate exactly creating/indeterminate/pending/successful/failed/expired |
| H2 | Restitution enum = state-matrix values exactly | **PASS** | Set comparison: contract E11 enumerates exactly restitution_pending/restituted/restitution_failed (+ "none" = no row). Materialization tracked at E11 (FAIL above) |
| H3 | `bookingRules.pending`/`.confirmed` implementable | **FAIL (repo artifact non-conformant — T-028 must correct)** | "Definitely failed" retry semantics require C15's partial unique index, missing in repo 008 |
| H4 | Cancelled booking never changes provider truth; no cascade to payment tables | **PASS** | FK inspection: contract schema uses `ON DELETE CASCADE` only on chat rooms/messages; no cascade from `bookings` to any payment table (repo 008 likewise) |

## Classified checklist — Lane B: migration lineage preconditions (20 rows)

### Payments lineage (B-P1–B-P11)

| ID | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| B-P1 | Staging identity reconfirmed before any apply | **PASS** | `staging-d1-info.json`: uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888` reconfirmed live |
| B-P2 | Staging still pristine-empty | **PASS** | Zero user tables; consistent with fingerprint `52431d70…7f10` |
| B-P3 | `d1_migrations` absent or zero rows | **PASS** | `staging-migration-ledger.json`: table absent — no partial/foreign ledger state |
| B-P4 | Time Travel bookmark/export captured before any write | **PASS** | T-026 bookmark + export captured 2026-07-23; staging unwritten since |
| B-P5 | Canonical baseline generated (001–003, 004_background_jobs, 005–007; legacy 004 excluded) | **FAIL (baseline required)** | Baseline artifact not yet generated — T-028 deliverable |
| B-P6 | Baseline applied once, exactly one ledger row | **FAIL (baseline required)** | No baseline applied; ledger absent |
| B-P7 | Post-baseline schema contains `users`/`bookings`/pair chat FK targets | **FAIL (baseline required)** | None present on staging |
| B-P8 | Payments applied via Wrangler ledger only (no raw replay, no deploy.sh loop) | **NOT_APPLICABLE** | Method gate; no apply attempted. Engaged at T-028 apply time |
| B-P9 | Payments migration content matches reviewed design (hash/diff) | **NOT_APPLICABLE** | Apply-time integrity gate; 008 will be corrected under T-028 (C9/C15), then re-hashed against the corrected reviewed copy |
| B-P10 | Disposable rehearsal completed before staging apply | **NOT_APPLICABLE** | Future gate owned by T-029 (rehearse migration 008); not yet engaged |
| B-P11 | Post-apply verification: tables, 4 indexes, ledger = baseline + payments rows | **FAIL (baseline required)** | Verified end-state absent; requires baseline + payments apply |

### Chat lineage (B-C1–B-C9)

| ID | Precondition (abridged) | Classification | Basis |
|---|---|---|---|
| B-C1 | Repo 009 not applied in any form; remains quarantined | **PASS** | Ledger absent, zero tables — 009 never applied; quarantine holds |
| B-C2 | Replacement additive migration creates `booking_chat_*`, no RENAME/DROP/copy | **FAIL (repo artifact non-conformant — T-028 must correct)** | Only chat migration in repo is the forbidden renaming 009; T-028 must author the additive replacement |
| B-C3 | New tables' FKs match approved design | **FAIL (repo artifact non-conformant — T-028 must correct)** | No conformant artifact exists to verify; requirement carries to the T-028 replacement (incl. `reply_to_id` self-FK, F10) |
| B-C4 | New index names do not collide with 002's `idx_chat_*` | **PASS** | Name diff: the `idx_booking_chat_*` prefix is collision-free against 002's plain-`CREATE INDEX` names; must be preserved (with defensive `IF NOT EXISTS`) in the T-028 replacement |
| B-C5 | Legacy pair chat tables present and unmodified after apply | **FAIL (baseline required)** | Legacy tables come from baseline (001); none exist on pristine staging to diff |
| B-C6 | Ledger ordering: baseline + payments rows present before chat apply | **FAIL (baseline required)** | Ledger absent; ordering cannot yet be satisfied |
| B-C7 | Controlled release window; old/new Worker compatibility proof | **NOT_APPLICABLE** | Release-plan gate, not a schema fact; deferred to release plan |
| B-C8 | `PRAGMA foreign_key_check` zero violations after apply | **NOT_APPLICABLE** | Post-apply audit; not runnable meaningfully before baseline + chat apply |
| B-C9 | Chat migration via Wrangler ledger after disposable rehearsal | **NOT_APPLICABLE** | Method gate; engaged at T-028/T-029 time |

## Counts

| Lane | Total | PASS | FAIL (baseline required) | FAIL (repo artifact non-conformant) | FAIL (total) | NOT_APPLICABLE |
|---|---|---|---|---|---|---|
| Lane A (contract checklist) | 80 | 15 | 37 | 26 | 63 | 2 |
| Lane B (lineage preconditions) | 20 | 6 | 6 | 2 | 8 | 6 |
| **Overall** | **100** | **21** | **43** | **28** | **71** | **8** |

Note: row counts are computed from the actual lane files — Lane A contains 80 precondition rows across sections A–H (A:10, B:4, C:17, D:7, E:17, F:15, G:6, H:4); Lane B contains 20 (B-P:11, B-C:9).

## Key findings

1. **Staging is confirmed pristine-empty with zero drift.** Live probes on 2026-07-24 reproduce the T-026 state exactly: zero user tables, no `d1_migrations` ledger, only Cloudflare-internal `_cf_KV`. Fingerprint reference `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10` stands.
2. **Every FAIL is expected and strategy-compliant.** 43 FAILs are `FAIL (baseline required)` — pristine staging intentionally lacks the parent tables and ledger rows that only the canonical baseline + ordered lineage may create. None indicate corruption. 28 FAILs are `FAIL (repo artifact non-conformant)` — concrete divergences of repo migrations 008/009 (and the absent restitutions migration) from the frozen T-011 contract, all routed to T-028.
3. **Five repo-artifact divergences confirmed** (Lane A §Divergences, Lane B §7): (1) `amount` vs contract `amount_satang`; (2) missing partial unique index `uq_payment_attempt_active_booking`; (3) no `payment_restitutions` migration exists; (4) repo 009 is the forbidden renaming variant (also: `reply_to_id` lacks its self-FK, `DATETIME` vs contract `TEXT`, table-name collision with legacy chat tables); (5) the baseline gap itself — the canonical baseline must be generated excluding quarantined `004_mobile_app_features.sql`.
4. **Lineage verification must be `d1_migrations`-table-based.** `PRAGMA user_version` is refused on D1 (`SQLITE_AUTH [code: 7500]`) via both wrangler remote execute (Lane C) and REST (T-025). It cannot be used as a ledger. The first `wrangler d1 migrations apply` will create `d1_migrations` fresh on this database — a clean, unambiguous lineage start.
5. **No bookmark-based consistency checks available from query metadata.** Neither `d1 info --json` nor per-query `meta.bookmark` surfaced a bookmark; cross-task fingerprinting (T-025/T-026 style schema-dump hash) remains the drift-detection mechanism, with the T-026 Time Travel bookmark + export as the recovery point.
6. **`_cf_KV` is out of contract scope.** It is Cloudflare-internal, must be excluded from the T-011 contract surface, and must never be migrated or dropped.
7. **Repo 008 is the only near-release-ready file**, and even it needs the C9/C15 corrections before it can be considered contract-conformant; application remains gated on baseline + rehearsal + Wrangler ledger (B-P5…B-P11).

## T-028 implications (migration lineage implementation)

1. **Generate the canonical baseline** from 001–003, `004_background_jobs_tables`, 005–007 — explicitly excluding quarantined `004_mobile_app_features.sql` — and record it as exactly one `d1_migrations` row (never one row per repo file, never a `004_mobile_app_features` entry).
2. **Correct 008 before apply:** rename `amount` → `amount_satang`; replace non-unique `idx_payment_attempts_booking` with the partial unique index `uq_payment_attempt_active_booking ON payment_attempts(booking_id) WHERE status IN ('creating','indeterminate','pending')`.
3. **Author the missing restitutions migration** creating `payment_restitutions` with the E1–E17 shape, including lifecycle CHECKs E13–E15 verbatim and uniques E3/E4.
4. **Rewrite 009 as additive expand:** new tables `booking_chat_rooms`/`booking_chat_messages` (no RENAME, no DROP, no data copy), `TEXT` timestamps, `reply_to_id` self-FK, collision-free `idx_booking_chat_*` index names with defensive `IF NOT EXISTS`. Keep legacy pair chat untouched; retirement is out of scope for this release.
5. **Enforce fail-closed lineage tooling:** applicability decided from target schema + `d1_migrations` only; refuse and escalate on any unrecognized ledger/schema state; no raw replay; no `deploy.sh` migration loop (T-021 blocker). All applies through the Wrangler ledger after disposable rehearsal (T-029 chain).
6. **Do not rely on `PRAGMA user_version`** anywhere in tooling (SQLITE_AUTH 7500 on D1); use the `d1_migrations` table as the sole ledger.

## Constraints honored

- Read-only: no git operations; no database writes; no network commands beyond Lane C's already-captured SELECT-only probes; no credentials touched, printed, or persisted.
- Lane evidence files unmodified; this synthesis and the JSON ledger are the only new files.
- Machine-readable companion: `docs/execution/phase-2/t-027-schema-inspection-ledger.json`.
