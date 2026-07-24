-- Payment restitutions: external customer-resolution ledger for Omise PromptPay charges.
--
-- Authored under T-028 (issue Sheshiyer/tirak-mobile-app-v2#28) per the T-027
-- staging schema inspection divergence routing: divergence #3 — no repo
-- migration created `payment_restitutions` at all
-- (evidence/t027/lane-a-t011-contract-checklist.md §E, rows E1–E17; all
-- classified FAIL — repo artifact non-conformant — T-028 must correct).
--
-- Sources (frozen contract, authoritative over filenames):
--   contracts/tirak-payments-v1/target-schema.sql          lines 48–78
--   contracts/tirak-payments-v1/state-matrix.json          restitution states
--   docs/contracts/tirak-payments-v1/permission-matrix.md  enforcement contract
--   docs/contracts/tirak-payments-v1/migration-strategy.md forbidden patterns
--
-- Design invariants enforced here at schema level:
--   * Duplicate prevention (permission matrix): a restitution is UNIQUE per
--     originating payment attempt AND per provider charge.
--   * Provider truth is immutable: this ledger records customer resolution
--     only; it never rewrites an Omise successful charge to refunded/voided.
--   * Three-state lifecycle (state matrix): restitution_pending, restituted,
--     restitution_failed. Terminal states REQUIRE approver, evidence, and
--     their timestamps; `restituted` additionally requires recipient
--     reference + completion timestamp; `restitution_failed` requires
--     failure reason + failed timestamp. Pending forbids terminal timestamps.
--   * Amounts are stored in the gateway's integer minor unit (satang), THB
--     only, matching the payments contract.
--
-- Idempotent: every statement uses IF NOT EXISTS. Apply only through the
-- Wrangler migration ledger after the canonical baseline and the corrected
-- payments migration; never via raw directory replay.

CREATE TABLE IF NOT EXISTS payment_restitutions (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
    provider_charge_id TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL REFERENCES users(id),
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    currency TEXT NOT NULL CHECK (currency = 'THB'),
    reason TEXT NOT NULL,
    recipient_reference TEXT,
    evidence_uri TEXT,
    approver_user_id TEXT REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('restitution_pending', 'restituted', 'restitution_failed')),
    requested_at TEXT NOT NULL,
    approved_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (status = 'restitution_pending' AND completed_at IS NULL AND failed_at IS NULL)
      OR
      (status = 'restituted' AND recipient_reference IS NOT NULL AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND completed_at IS NOT NULL AND failed_at IS NULL)
      OR
      (status = 'restitution_failed' AND evidence_uri IS NOT NULL AND approver_user_id IS NOT NULL AND approved_at IS NOT NULL AND failed_at IS NOT NULL AND failure_reason IS NOT NULL AND completed_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_restitutions_booking
    ON payment_restitutions(booking_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_restitutions_customer
    ON payment_restitutions(customer_id, requested_at DESC);
