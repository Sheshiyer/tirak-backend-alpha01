# T-027 Lane B — Local Migration Lineage Analysis and 008/009 Preconditions

Status: local, read-only analysis complete. No git mutations, no file modifications, no database writes.
Scope: every file in `migrations/`, the recorded T-005 failure evidence, and the frozen
`tirak-payments-v1` contract (`docs/contracts/tirak-payments-v1/migration-strategy.md`).
Target context: staging D1 `tirak-staging` (`database_id 5132c8cc-8f23-4dd2-94d1-9d53edb92888`),
proven pristine-empty on 2026-07-21 (T-025) and re-verified 2026-07-23 (T-026, fingerprint
`52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10`).

## 1. Migration inventory (all files, in lexicographic = replay order)

| # | File | Role | Replay safety |
| --- | --- | --- | --- |
| 1 | `001_initial_schema.sql` | Core schema: `users`, `supplier_profiles`, `customer_profiles`, `supplier_services`, `supplier_availability`, pair-scoped `chat_rooms`/`chat_messages`, `bookings`, `reviews`, `categories`, `regions`, `user_sessions` | Plain `CREATE TABLE`; fails on second run |
| 2 | `002_add_indexes.sql` | Indexes for 001 tables | Plain `CREATE INDEX`; fails on second run |
| 3 | `003_add_analytics_tables.sql` | `analytics_events`, `moderation_queue`, etc. | Mostly `IF NOT EXISTS` |
| 4a | `004_background_jobs_tables.sql` | `moderation_results`, `flagged_content`, etc. | `IF NOT EXISTS`; sorts **before** 4b |
| 4b | `004_mobile_app_features.sql` | Companion-era mobile schema (duplicate prefix) | **Deterministically fails after 001** (see §2) |
| 5 | `005_muse_ai_foundation.sql` | Muse AI consent/session/privacy tables | `IF NOT EXISTS` |
| 6 | `006_referrals_tirak_coins.sql` | `referral_accounts`, `referral_events`, `coin_transactions` | `IF NOT EXISTS` |
| 7 | `007_registration_profile_persistence.sql` | `ALTER TABLE supplier_profiles/customer_profiles ADD COLUMN …` | Plain `ALTER … ADD COLUMN`; fails on second run; overlaps 4b intent |
| 8 | `008_omise_promptpay_payments.sql` | `payment_attempts`, `payment_webhook_events` + 4 indexes | `IF NOT EXISTS` throughout |
| 9 | `009_booking_scoped_chat.sql` | **Destructive rename** of active chat tables + recreate booking-scoped chat | **Quarantined / forbidden** (see §3) |

## 2. The duplicate-`004` problem (recorded strategy)

Sources: `docs/execution/phase-1/t-005-backend-baseline-evidence.md` and
`docs/contracts/tirak-payments-v1/migration-strategy.md`.

- Two files share the `004` numeric prefix. Any filename-ordered replay (raw `for file in migrations/*.sql` loop, or naive tooling) applies `004_background_jobs_tables.sql` first, then `004_mobile_app_features.sql`.
- `004_mobile_app_features.sql` assumes a **companion-era** schema that `001_initial_schema.sql` never created, and re-adds columns 001 already created. T-005 reproduced **seven deterministic failures** on a fresh database:
  1. `bookings.companion_id` missing (001 has `supplier_id`);
  2. `bookings.date` missing (001 has `scheduled_at`);
  3. `reviews.companion_id` missing (001 has `reviewee_id`);
  4. `reviews.customer_id` missing (001 has `reviewer_id`);
  5. duplicate `supplier_profiles.rating_average` (already in 001);
  6. duplicate `supplier_profiles.rating_count` (already in 001);
  7. `supplier_services.category_id` missing (001 has no such column; 4b's `CREATE TABLE IF NOT EXISTS supplier_services` does not run because 001 created the table, so the later index/FK references to `category_id` fail).
- Contract ruling (migration-strategy.md): legacy `004_mobile_app_features.sql` is **quarantined from release tooling**. "Raw directory replay is therefore neither a fresh-install baseline nor an existing-target repair strategy." Forbidden patterns include raw `for file in migrations/*.sql` replay and applying legacy `004` to any release target.
- Consequence for the ledger: migration applicability is selected from **target schema + `d1_migrations` ledger**, never by replaying repository SQL files. The canonical baseline (generated for an empty target) must incorporate the current non-legacy schema (001–003, 004a, 005–007 content) and be recorded **once** — the two 004 files must not both become ledger entries.

## 3. What 008 and 009 create (as present in repo)

### `008_omise_promptpay_payments.sql` (additive, `IF NOT EXISTS` throughout)

Tables:

- `payment_attempts`
  - `id TEXT PRIMARY KEY`
  - `booking_id TEXT NOT NULL REFERENCES bookings(id)`
  - `customer_id TEXT NOT NULL REFERENCES users(id)`
  - `provider TEXT NOT NULL CHECK (provider = 'omise')`
  - `payment_method TEXT NOT NULL CHECK (payment_method = 'promptpay')`
  - `idempotency_key TEXT NOT NULL UNIQUE`
  - `attempt_number INTEGER NOT NULL CHECK (attempt_number > 0)`
  - `provider_charge_id TEXT UNIQUE`
  - `amount INTEGER NOT NULL CHECK (amount > 0)` (minor unit, satang)
  - `currency TEXT NOT NULL CHECK (currency = 'THB')`
  - `status TEXT NOT NULL CHECK (status IN ('creating','indeterminate','pending','successful','failed','expired'))`
  - `qr_code_url`, `expires_at`, `last_checked_at`, `indeterminate_at`, `last_error_at`, `last_error_code`, `recovered_at` (nullable TEXT)
  - `created_at`, `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
  - Table constraint `UNIQUE (booking_id, attempt_number)`
- `payment_webhook_events`
  - `replay_key TEXT PRIMARY KEY`
  - `provider_event_id TEXT UNIQUE`
  - `provider_charge_id TEXT NOT NULL`
  - `signature_timestamp INTEGER NOT NULL`
  - `status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed'))`
  - `received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`, `processed_at TEXT`

Indexes: `idx_payment_attempts_booking (booking_id, attempt_number DESC)`,
`idx_payment_attempts_customer (customer_id, created_at DESC)`,
`idx_payment_attempts_charge (provider_charge_id)`,
`idx_payment_webhook_events_charge (provider_charge_id, received_at DESC)`.

Foreign keys (2): `payment_attempts.booking_id → bookings(id)`, `payment_attempts.customer_id → users(id)`.

Dependency: requires `bookings(id)` and `users(id)` to already exist — i.e. it must be applied **after** the canonical baseline, per the contract dependency graph (baseline → payment attempts + webhook ledger → additive chat / restitution).

### `009_booking_scoped_chat.sql` (destructive — FORBIDDEN as written)

What it does today:

1. `ALTER TABLE chat_messages RENAME TO legacy_pair_chat_messages;`
2. `ALTER TABLE chat_rooms RENAME TO legacy_pair_chat_rooms;`
3. Creates new booking-scoped `chat_rooms` (`booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE`, `customer_id`/`supplier_id → users(id)`, status CHECK, `last_message_at`, timestamps) and `chat_messages` (`room_id → chat_rooms(id) ON DELETE CASCADE`, `sender_id → users(id)`, message_type CHECK, delivery/read/reply columns).
4. Creates 5 `chat_rooms` indexes and 8 `chat_messages` indexes named `idx_booking_chat_*`.
5. Ends with `PRAGMA foreign_key_check;`.

Contract ruling (migration-strategy.md, "Chat expand/contract design"):

- This file "renames active legacy tables and would break the old Worker immediately. **It is forbidden.**"
- The approved replacement is **additive expand**: create `booking_chat_rooms` and `booking_chat_messages` **alongside** the legacy pair-scoped `chat_rooms`/`chat_messages`; no legacy conversation is copied; the new Worker reads/writes only booking chat during the compatibility window; legacy retirement is a separate contract migration outside this release.
- Additional mechanics the additive replacement must respect: on a baseline-applied database, 002 already created `idx_chat_rooms_*` / `idx_chat_messages_*` index names, so the new file's index names must not collide (the current file's `idx_booking_chat_*` names are collision-free for the new table names, but the current file's **table** names `chat_rooms`/`chat_messages` do collide with the legacy tables it renames — the additive version must use the `booking_chat_*` table names instead).
- Note the current file is also **self-inconsistent for a pristine target**: on an empty database the `ALTER TABLE … RENAME` statements fail immediately because `chat_messages`/`chat_rooms` do not exist. It is only runnable on a database that already has the 001 chat tables — exactly the database where running it is forbidden.

## 4. Expected `d1_migrations` ledger contents at each stage

Wrangler's ledger table (`d1_migrations`, auto-created by `wrangler d1 migrations apply`, columns
`id INTEGER PRIMARY KEY AUTOINCREMENT`, `name TEXT`, `applied_at TIMESTAMP … NOT NULL`):

| Stage | Ledger state |
| --- | --- |
| Pristine staging (T-025/T-026 verified) | Table absent, or present with **zero rows** (zero user tables confirmed; any non-empty ledger on an "empty" DB is an unrecognized-target escalation) |
| After canonical baseline applied (empty-target path) | Exactly **one** row, naming the single generated baseline migration — never one row per repo file, and never a `004_mobile_app_features` entry |
| After 008 (payments) applied via Wrangler | Baseline row + one row for the payments migration |
| After additive booking-chat migration applied via Wrangler | Above + one row for the additive chat migration |
| After restitution ledger contract migration (later task) | Above + one row for restitution |

Invariants from the contract: never trust a filename without checking `d1_migrations` **and** schema; an unrecognized target (unexpected rows, unexpected tables, partial failure) means **refuse and escalate — no best-effort path**.

## 5. Preconditions checklist — applying payments (008-lineage) to staging

PASS/FAIL left blank for the live-inspection lanes (A/C) to fill against staging.

| ID | Precondition | Evidence source | PASS/FAIL |
| --- | --- | --- | --- |
| B-P1 | Staging D1 `tirak-staging` identity reconfirmed (`database_id 5132c8cc-8f23-4dd2-94d1-9d53edb92888`) before any apply | T-025/T-026; live re-check |  |
| B-P2 | Staging schema still pristine-empty (fingerprint `52431d70…7f10` or equivalent zero-user-table proof) | T-026 fingerprint; live re-check |  |
| B-P3 | `d1_migrations` ledger absent or zero rows (no partial/foreign ledger state) | Live ledger read |  |
| B-P4 | Recoverable Time Travel bookmark / export captured **before** any write | migration-strategy.md §Target selection step 1 |  |
| B-P5 | Canonical baseline generated from current non-legacy schema (001–003, `004_background_jobs_tables`, 005–007); legacy `004_mobile_app_features` content excluded | migration-strategy.md §Decision |  |
| B-P6 | Baseline applied once and recorded as exactly one `d1_migrations` row | Ledger read after baseline |  |
| B-P7 | Post-baseline schema contains `users(id)`, `bookings(id)`, pair-scoped `chat_rooms`, `chat_messages` — the FK targets 008/009-lineage need | `PRAGMA table_info` / `foreign_key_list` |  |
| B-P8 | Payments migration applied via Wrangler migration ledger only — no raw SQL replay, no `deploy.sh` loop | Forbidden patterns list |  |
| B-P9 | Payments migration content matches the reviewed 008 design (2 tables, 4 indexes, 2 FKs, all CHECK/UNIQUE constraints per §3) | File hash/diff vs reviewed copy |  |
| B-P10 | Disposable rehearsal completed on a throwaway D1 before staging apply | migration-strategy.md step 4 |  |
| B-P11 | Post-apply verification: `payment_attempts`, `payment_webhook_events` present with expected columns; 4 `idx_payment_*` indexes present; ledger = baseline + payments rows only | `table_info` / `index_list` / ledger read |  |

## 6. Preconditions checklist — applying additive booking chat (009-lineage) to staging

| ID | Precondition | Evidence source | PASS/FAIL |
| --- | --- | --- | --- |
| B-C1 | Repo `009_booking_scoped_chat.sql` is **not** applied in any form; it remains quarantined until replaced | migration-strategy.md; T-005 |  |
| B-C2 | Replacement additive migration (T-028 deliverable) creates `booking_chat_rooms` and `booking_chat_messages` — new table names, no `RENAME`, no `DROP`, no data copy from legacy rooms | migration-strategy.md §Chat expand/contract |  |
| B-C3 | New tables' FKs match the approved design: `booking_id UNIQUE REFERENCES bookings(id) ON DELETE CASCADE`; `customer_id`/`supplier_id`/`sender_id REFERENCES users(id)`; `room_id REFERENCES booking_chat_rooms(id) ON DELETE CASCADE` | 009 design + contract |  |
| B-C4 | New index names do not collide with existing `idx_chat_rooms_*` / `idx_chat_messages_*` from 002 (002 used plain `CREATE INDEX` — a name collision is a hard failure, not a skip) | 002 vs new file name diff |  |
| B-C5 | Legacy pair-scoped `chat_rooms` and `chat_messages` (from baseline) remain present and unmodified after apply | `table_info` before/after diff |  |
| B-C6 | Ledger ordering: baseline row and payments row already present before chat apply; chat apply adds exactly one row | Ledger read |  |
| B-C7 | Controlled release window: old Worker cannot write pair rooms after archive decision; new Worker reads/writes only booking chat (compatibility proof precedes traffic change) | migration-strategy.md dependency graph |  |
| B-C8 | `PRAGMA foreign_key_check` (or equivalent read-only FK audit) returns zero violations after apply | 009 tail; FK audit |  |
| B-C9 | Chat migration applied via Wrangler ledger after disposable rehearsal, same gates as B-P8/B-P10 | Forbidden patterns list |  |

## 7. Findings that shape T-028 (migration lineage implementation)

1. **009 must be rewritten, not patched.** The additive replacement needs new table names (`booking_chat_rooms`/`booking_chat_messages`); reusing `chat_rooms`/`chat_messages` names is impossible without the forbidden rename.
2. **Index-name collision risk is real.** 002 created plain (non-`IF NOT EXISTS`) `idx_chat_*` indexes; the new chat file must use distinct names (the current `idx_booking_chat_*` prefix is safe) and should use `IF NOT EXISTS` defensively.
3. **The baseline is a generated artifact, not a repo file.** T-028 must define how the canonical baseline is produced, hashed, and recorded as a single ledger row — and must exclude `004_mobile_app_features.sql` explicitly, since raw replay of the directory deterministically fails at it (7 errors, T-005).
4. **008 is the only release-ready file as-is** (fully `IF NOT EXISTS`, additive, FK targets exist post-baseline), but it still must flow through the Wrangler ledger after rehearsal — never raw replay, and the deploy script's raw migration loop (T-021 blocker) must not be used.
5. **Ledger-before-filename rule must be enforced in tooling.** Strategy forbids trusting filenames without checking `d1_migrations` + schema; T-028 tooling should fail closed on any unrecognized ledger/schema state.

## 8. Constraints honored

- Read-only: no git mutations, no writes outside this new file, no database or production access.
- No secrets printed; `account_id`/database IDs quoted are non-secret identifiers from `wrangler.toml`.
