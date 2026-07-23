# T-027 Lane A — T-011 Contract Preconditions Checklist (`tirak-payments-v1`)

**Contract status:** frozen for local integration validation; no deployment authority.
**Sources (all local, read-only, this lane):**
- `contracts/tirak-payments-v1/target-schema.sql` (T-011 frozen target; contract-only, exercised against a disposable SQLite fixture — MUST NOT be applied to D1 directly)
- `contracts/tirak-payments-v1/state-matrix.json` (T-010)
- `docs/contracts/tirak-payments-v1/README.md`, `migration-strategy.md` (T-012), `permission-matrix.md` (T-011)
- Repo migrations `008_omise_promptpay_payments.sql` and `009_booking_scoped_chat.sql` (read for divergence analysis only; both are **not** the contract target)

**How to use:** each row is one checkable precondition for migrations `008`/`009` (or their T-028 replacements) on staging D1 `tirak-staging`. Lane B (live inspection) and Lane C (comparison/classification) fill the `PASS/FAIL` column. Staging was proven pristine-empty on 2026-07-21 (T-025) and re-verified 2026-07-23 (T-026, fingerprint `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10`), so rows whose expected state is "absent" should PASS on emptiness evidence, and rows requiring parent tables will FAIL until a baseline exists — that FAIL is the expected, strategy-compliant outcome (see §G/T-028 notes).

---

## A. Target identity, ledger, and execution-path preconditions (migration-strategy.md)

| # | Precondition | Expected per contract | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| A1 | Exact target identity captured before any decision | D1 name `tirak-staging` + database_id recorded | Wrangler/d1 metadata output | |
| A2 | `d1_migrations` ledger readable and compared against repo migration filenames (never trust filename alone) | Ledger dump present; per-file applied/not-applied mapping | `SELECT * FROM d1_migrations` | |
| A3 | Target classified into exactly one path: empty/fresh, recognized-existing, or unknown | Staging = empty/fresh → canonical-baseline path (not raw replay) | Zero user tables + empty ledger | |
| A4 | Unknown-target refuse/escalate rule honored | No best-effort path exists in tooling | Strategy compliance note | |
| A5 | Recoverable Time Travel bookmark/export captured before mutation | Bookmark/export reference recorded | Lane B artifact or deferred to T-028 gate | |
| A6 | Legacy `004_mobile_app_features.sql` quarantined | Never applied to release target (7 deterministic failures on fresh probe: assumes companion-era booking/review columns absent from `001`, re-adds existing supplier rating + service category columns) | Absent from `d1_migrations`; not in T-028 plan | |
| A7 | Legacy `009_booking_scoped_chat.sql` (renaming variant) forbidden | Never applied: renames `chat_messages`→`legacy_pair_chat_messages`, `chat_rooms`→`legacy_pair_chat_rooms`, breaks old Worker immediately | Absent from `d1_migrations`; not in T-028 plan | |
| A8 | No raw `for file in migrations/*.sql` replay | Applicability decided from target schema + ledger only | Strategy compliance note | |
| A9 | Payment/chat/restitution migrations applied only through Wrangler's migration ledger after disposable rehearsal | `target-schema.sql` itself never applied to D1 | T-028 plan conformance | |
| A10 | Legacy chat tables never renamed/dropped during this release; legacy conversations never copied into booking chat (cannot be attributed to one booking safely) | Additive-only expansion | Schema inspection + T-028 plan | |

## B. Parent-table preconditions (FK targets required by 008/009 and contract schema)

| # | Precondition | Expected per contract | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| B1 | `users(id)` exists as FK parent | Referenced by `payment_attempts.customer_id`, `payment_restitutions.customer_id`/`approver_user_id`, `booking_chat_rooms.customer_id`/`supplier_id`, `booking_chat_messages.sender_id` | `table_info`/sqlite_master for `users` | |
| B2 | `bookings(id)` exists as FK parent | Referenced by `payment_attempts.booking_id`, `payment_restitutions.booking_id`, `booking_chat_rooms.booking_id` | `table_info`/sqlite_master for `bookings` | |
| B3 | No partial/orphan payment/chat objects pre-exist on target | `payment_attempts`, `payment_webhook_events`, `payment_restitutions`, `booking_chat_rooms`, `booking_chat_messages` absent before baseline+payments migrations | sqlite_master table list | |
| B4 | Legacy pair-scoped `chat_rooms`/`chat_messages` state recorded if present | On staging (empty): expected absent → additive path has nothing to preserve; on recognized-existing targets they must remain untouched | sqlite_master table list | |

## C. `payment_attempts` preconditions (migration 008 → contract target)

| # | Precondition | Expected per contract (`target-schema.sql` lines 5–33) | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| C1 | Table `payment_attempts` exists with `id TEXT PRIMARY KEY` | Exact match | `table_info(payment_attempts)` | |
| C2 | `booking_id TEXT NOT NULL REFERENCES bookings(id)` | Exact match | table_info + FK list | |
| C3 | `customer_id TEXT NOT NULL REFERENCES users(id)` | Exact match | table_info + FK list | |
| C4 | `provider TEXT NOT NULL CHECK (provider = 'omise')` | Exact match | table_info | |
| C5 | `payment_method TEXT NOT NULL CHECK (payment_method = 'promptpay')` | Exact match | table_info | |
| C6 | `idempotency_key TEXT NOT NULL UNIQUE` (client retry duplicate prevention) | Exact match | table_info + index list | |
| C7 | `attempt_number INTEGER NOT NULL CHECK (attempt_number > 0)` | Exact match | table_info | |
| C8 | `provider_charge_id TEXT UNIQUE` (nullable; one attempt per provider charge) | Exact match | table_info + index list | |
| C9 | Amount column named **`amount_satang`** `INTEGER NOT NULL CHECK (amount_satang > 0)` — integer minor unit per Omise PromptPay primary source | Contract name `amount_satang` (**repo 008 diverges: uses `amount`**) | table_info | |
| C10 | `currency TEXT NOT NULL CHECK (currency = 'THB')` | Exact match | table_info | |
| C11 | `status TEXT NOT NULL CHECK (status IN ('creating','indeterminate','pending','successful','failed','expired'))` — matches state-matrix attempt values exactly | Exact match, six values | table_info; cross-check `state-matrix.json` | |
| C12 | Nullable lifecycle/error columns present: `qr_code_url`, `expires_at`, `last_checked_at`, `indeterminate_at`, `last_error_at`, `last_error_code`, `recovered_at` (all TEXT) | Exact match | table_info | |
| C13 | `created_at`/`updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` | Exact match | table_info | |
| C14 | `UNIQUE (booking_id, attempt_number)` table constraint (ordered retry chain per booking) | Exact match | table_info / index list | |
| C15 | **Partial unique index** `uq_payment_attempt_active_booking ON payment_attempts(booking_id) WHERE status IN ('creating','indeterminate','pending')` — at most one active/unresolved attempt per booking; this is the schema-level enforcement of "cancel unpaid booking only with no active/unresolved/successful attempt" (permission matrix) and the `bookingRules.confirmed` "can pay when unpaid or definitely failed" rule | Present with exact WHERE clause (**repo 008 diverges: missing; has non-unique `idx_payment_attempts_booking` instead**) | `sqlite_master` index SQL | |
| C16 | Index `idx_payment_attempts_customer ON payment_attempts(customer_id, created_at DESC)` | Exact match | index list | |
| C17 | Index `idx_payment_attempts_charge ON payment_attempts(provider_charge_id)` | Exact match | index list | |

## D. `payment_webhook_events` preconditions (migration 008 → contract target)

| # | Precondition | Expected per contract (`target-schema.sql` lines 35–46) | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| D1 | Table `payment_webhook_events` with `replay_key TEXT PRIMARY KEY` (replay control per webhook contract) | Exact match | table_info | |
| D2 | `provider_event_id TEXT UNIQUE` (provider-level dedup; nullable) | Exact match | table_info + index list | |
| D3 | `provider_charge_id TEXT NOT NULL` (webhooks correlate to charge, not to attempt row) | Exact match | table_info | |
| D4 | `signature_timestamp INTEGER NOT NULL` (HMAC over `<timestamp>.<raw body>` per Omise primary source) | Exact match | table_info | |
| D5 | `status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed'))` | Exact match, four values | table_info | |
| D6 | `received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`; `processed_at TEXT` nullable | Exact match | table_info | |
| D7 | Index `idx_payment_webhook_events_charge ON payment_webhook_events(provider_charge_id, received_at DESC)` | Exact match | index list | |

## E. `payment_restitutions` preconditions (contract-only — no repo migration exists yet)

Rationale: PromptPay charges cannot be voided/refunded through Omise (primary source), so external customer resolution is recorded without rewriting provider truth. No migration file in the repo creates this table — T-028 must author it.

| # | Precondition | Expected per contract (`target-schema.sql` lines 48–78) | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| E1 | Table `payment_restitutions` with `id TEXT PRIMARY KEY` | Exact match | table_info | |
| E2 | `booking_id TEXT NOT NULL REFERENCES bookings(id)` | Exact match | table_info + FK list | |
| E3 | `payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id)` — **restitution unique per originating attempt** (permission-matrix duplicate prevention) | Exact match | table_info + FK list | |
| E4 | `provider_charge_id TEXT NOT NULL UNIQUE` — unique per provider charge | Exact match | table_info + index list | |
| E5 | `customer_id TEXT NOT NULL REFERENCES users(id)` | Exact match | table_info + FK list | |
| E6 | `amount_satang INTEGER NOT NULL CHECK (amount_satang > 0)`; `currency TEXT NOT NULL CHECK (currency = 'THB')` | Exact match | table_info | |
| E7 | `reason TEXT NOT NULL` (support operator creates pending case with reason) | Exact match | table_info | |
| E8 | `recipient_reference TEXT` nullable at creation, required for `restituted` (see E13) | Exact match | table_info | |
| E9 | `evidence_uri TEXT` nullable at creation, required for both terminal states | Exact match | table_info | |
| E10 | `approver_user_id TEXT REFERENCES users(id)` nullable at creation, required for both terminal states (financial approver) | Exact match | table_info + FK list | |
| E11 | `status TEXT NOT NULL CHECK (status IN ('restitution_pending','restituted','restitution_failed'))` — matches state-matrix restitution values exactly | Exact match, three values | table_info; cross-check `state-matrix.json` | |
| E12 | Lifecycle timestamps: `requested_at TEXT NOT NULL`; `approved_at`, `completed_at`, `failed_at` nullable; `failure_reason TEXT` nullable; `created_at`/`updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` | Exact match | table_info | |
| E13 | Lifecycle CHECK constraint — `restitution_pending` ⇒ `completed_at IS NULL AND failed_at IS NULL` | Exact match | table_info (CHECK text) | |
| E14 | Lifecycle CHECK constraint — `restituted` ⇒ `recipient_reference`, `evidence_uri`, `approver_user_id`, `approved_at`, `completed_at` all NOT NULL and `failed_at IS NULL` | Exact match | table_info (CHECK text) | |
| E15 | Lifecycle CHECK constraint — `restitution_failed` ⇒ `evidence_uri`, `approver_user_id`, `approved_at`, `failed_at`, `failure_reason` all NOT NULL and `completed_at IS NULL` | Exact match | table_info (CHECK text) | |
| E16 | Index `idx_payment_restitutions_booking ON payment_restitutions(booking_id, requested_at DESC)` | Exact match | index list | |
| E17 | Index `idx_payment_restitutions_customer ON payment_restitutions(customer_id, requested_at DESC)` | Exact match | index list | |

## F. Booking chat preconditions (additive expansion — replaces forbidden legacy 009)

| # | Precondition | Expected per contract (`target-schema.sql` lines 80–107 + migration-strategy chat design) | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| F1 | New tables named **`booking_chat_rooms`** / **`booking_chat_messages`** created alongside (not replacing) legacy pair-scoped tables | Exact names (**legacy 009 diverges: reuses `chat_rooms`/`chat_messages` after renaming legacy ones — forbidden**) | sqlite_master table list | |
| F2 | `booking_chat_rooms.id TEXT PRIMARY KEY` | Exact match | table_info | |
| F3 | `booking_chat_rooms.booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE` — one room per booking; both participants derived from the unique booking | Exact match | table_info + FK list | |
| F4 | `booking_chat_rooms.customer_id` / `supplier_id TEXT NOT NULL REFERENCES users(id)` | Exact match | table_info + FK list | |
| F5 | `booking_chat_rooms.status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','archived'))` | Exact match | table_info | |
| F6 | `booking_chat_rooms.last_message_at TEXT` nullable; `created_at`/`updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` | Exact match | table_info | |
| F7 | `booking_chat_messages.id TEXT PRIMARY KEY`; `room_id TEXT NOT NULL REFERENCES booking_chat_rooms(id) ON DELETE CASCADE`; `sender_id TEXT NOT NULL REFERENCES users(id)` | Exact match | table_info + FK list | |
| F8 | `message_type TEXT NOT NULL CHECK (message_type IN ('text','image','system'))` | Exact match | table_info | |
| F9 | Payload columns `content`, `image_url`, `metadata` (TEXT, nullable); `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`; `delivered_at`, `read_at` TEXT nullable | Exact match | table_info | |
| F10 | `reply_to_id TEXT REFERENCES booking_chat_messages(id)` — self-referencing FK present (**legacy 009 diverges: `reply_to_id` has no REFERENCES clause**) | Exact match | table_info + FK list | |
| F11 | Index `idx_booking_chat_rooms_customer ON booking_chat_rooms(customer_id)` | Exact match | index list | |
| F12 | Index `idx_booking_chat_rooms_supplier ON booking_chat_rooms(supplier_id)` | Exact match | index list | |
| F13 | Index `idx_booking_chat_messages_room_time ON booking_chat_messages(room_id, created_at)` | Exact match | index list | |
| F14 | New Worker reads/writes only booking chat; old Worker may continue on legacy tables during compatibility window; old/new behavior proven before traffic changes | Verification step exists in release plan (not a schema property; on empty staging there is no legacy traffic to protect) | T-028/release-plan conformance | |
| F15 | Legacy table retirement/renaming out of scope for this release (separate contract migration after old Worker unavailable) | No rename/drop of legacy chat tables in any applied migration | Ledger + schema inspection | |

## G. Permission-matrix expectations enforceable at schema level (permission-matrix.md)

| # | Precondition | Expected per contract | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| G1 | Mobile clients cannot write payment/webhook/restitution tables | No client-writable path; schema carries ownership columns (`customer_id`) so APIs derive ownership from authenticated user + booking row | Column presence (C3, E5) + API contract (T-009) | |
| G2 | Restitution unique per originating successful attempt and provider charge | `UNIQUE` on `payment_attempt_id` (E3) and `provider_charge_id` (E4) | Index/constraint list | |
| G3 | Terminal restitution requires approver + evidence; `restituted` additionally requires recipient reference + completion timestamp; `restitution_failed` requires failure reason + timestamp | Lifecycle CHECKs E13–E15 present verbatim | table_info (CHECK text) | |
| G4 | Provider truth immutable — no schema path marks an Omise successful charge as refunded; resolution lives only in `payment_restitutions` | `payment_attempts` has no refund/void status value (C11 enum closed); restitution is a separate ledger | Enum check (C11, E11) | |
| G5 | Cancellation gate "no active/unresolved/successful attempt" is schema-enforceable | Partial unique index C15 + status enum C11 make the active-attempt query well-defined | Index SQL (C15) | |
| G6 | Booking chat participants limited to the booking's customer and supplier (no third-party/private-access rooms) | Rooms derive both participants from one unique booking (F3–F4); no free-form participant table | Schema shape | |

## H. State-matrix ↔ schema cross-checks (`state-matrix.json`, T-010)

| # | Precondition | Expected per contract | Verification (Lane B/C) | PASS/FAIL |
|---|---|---|---|---|
| H1 | Attempt status enum covers exactly the state-matrix `attempt` values: creating, indeterminate, pending, successful, failed, expired | C11 matches | Set comparison | |
| H2 | Restitution status enum covers exactly: restitution_pending, restituted, restitution_failed (+ "none" = no row) | E11 matches | Set comparison | |
| H3 | `bookingRules.pending` ("cannot pay or chat") and `.confirmed` ("can pay when unpaid or definitely failed") are implementable: schema links attempts/rooms to bookings, active-attempt uniqueness (C15) supports "definitely failed" retry | Schema supports app-layer enforcement | Design check | |
| H4 | Cancelled booking never changes provider truth and never implies refund | No cascade from bookings to payment tables in contract schema (only chat rooms/messages use `ON DELETE CASCADE`) | FK action inspection | |

---

## Divergences found (repo migrations vs frozen contract) — input to T-028

1. **Column name:** repo `008` uses `amount`; contract requires `amount_satang` (C9).
2. **Missing constraint:** repo `008` lacks the partial unique index `uq_payment_attempt_active_booking`; it has a plain non-unique `idx_payment_attempts_booking(booking_id, attempt_number DESC)` instead (C15).
3. **Missing table:** no repo migration creates `payment_restitutions` at all (§E).
4. **Forbidden 009:** repo `009_booking_scoped_chat.sql` is the renaming variant explicitly forbidden by migration-strategy.md (A7); the contract requires new additively-named tables `booking_chat_rooms`/`booking_chat_messages` (F1) with `TEXT` timestamps (legacy 009 uses `DATETIME`) and a self-FK on `reply_to_id` (F10).
5. **Baseline gap:** staging is empty, so `users`/`bookings` parents (B1–B2) do not exist; per migration-strategy.md the empty-target path is a **canonical baseline** (001–003, `004_background_jobs_tables`, 005–007; excluding quarantined `004_mobile_app_features`), after which corrected payment/chat/restitution migrations run through the Wrangler ledger.
