import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { buildMigrationDb, seedStubRow } from './helpers/sqlite';

/**
 * T-028 requirement (3): negative / permission-mirror tests. These assert the
 * database-level guards that back the permission matrix and state matrix:
 *
 *  - one active payment attempt per booking (partial unique index);
 *  - one restitution per originating attempt and per provider charge;
 *  - terminal restitution states rejected without approver / evidence.
 *
 * FK enforcement is left off so seeding does not depend on unrelated baseline
 * table shapes; FK definitions themselves are verified structurally in
 * schema-surface.test.ts.
 */

const ATTEMPT_COLS = [
  'id',
  'booking_id',
  'customer_id',
  'provider',
  'payment_method',
  'idempotency_key',
  'attempt_number',
  'provider_charge_id',
  'amount_satang',
  'currency',
  'status',
] as const;

interface AttemptOverrides {
  id: string;
  booking_id?: string;
  customer_id?: string;
  attempt_number?: number;
  provider_charge_id?: string | null;
  amount_satang?: number;
  status?: string;
}

function insertAttempt(db: DatabaseSync, overrides: AttemptOverrides): void {
  const row: Record<string, unknown> = {
    booking_id: 'b1',
    customer_id: 'u_customer',
    provider: 'omise',
    payment_method: 'promptpay',
    idempotency_key: `idem_${overrides.id}`,
    attempt_number: 1,
    provider_charge_id: null,
    amount_satang: 25_000,
    currency: 'THB',
    status: 'pending',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO payment_attempts (${ATTEMPT_COLS.join(', ')}) VALUES (${ATTEMPT_COLS.map(
      () => '?',
    ).join(', ')})`,
  ).run(...(ATTEMPT_COLS.map((c) => row[c]) as never[]));
}

const RESTITUTION_COLS = [
  'id',
  'booking_id',
  'payment_attempt_id',
  'provider_charge_id',
  'customer_id',
  'amount_satang',
  'currency',
  'reason',
  'recipient_reference',
  'evidence_uri',
  'approver_user_id',
  'status',
  'requested_at',
  'approved_at',
  'completed_at',
  'failed_at',
  'failure_reason',
] as const;

interface RestitutionOverrides {
  id: string;
  booking_id?: string;
  payment_attempt_id?: string;
  provider_charge_id?: string;
  customer_id?: string;
  status?: string;
  recipient_reference?: string | null;
  evidence_uri?: string | null;
  approver_user_id?: string | null;
  approved_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  failure_reason?: string | null;
}

function insertRestitution(db: DatabaseSync, overrides: RestitutionOverrides): void {
  const row: Record<string, unknown> = {
    booking_id: 'b1',
    payment_attempt_id: 'a_ok',
    provider_charge_id: 'chrg_ok',
    customer_id: 'u_customer',
    amount_satang: 25_000,
    currency: 'THB',
    reason: 'duplicate_charge',
    recipient_reference: null,
    evidence_uri: null,
    approver_user_id: null,
    status: 'restitution_pending',
    requested_at: '2026-01-01T00:00:00Z',
    approved_at: null,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO payment_restitutions (${RESTITUTION_COLS.join(', ')}) VALUES (${RESTITUTION_COLS.map(
      () => '?',
    ).join(', ')})`,
  ).run(...(RESTITUTION_COLS.map((c) => row[c]) as never[]));
}

describe('T-028 payments/restitutions integrity guards', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = buildMigrationDb();
    db.exec('PRAGMA foreign_keys = OFF;');
    seedStubRow(db, 'users', { id: 'u_customer' });
    seedStubRow(db, 'users', { id: 'u_supplier' });
    seedStubRow(db, 'users', { id: 'u_approver' });
    seedStubRow(db, 'bookings', {
      id: 'b1',
      customer_id: 'u_customer',
      supplier_id: 'u_supplier',
    });
  });

  it('rejects a second active attempt for the same booking (partial unique index)', () => {
    insertAttempt(db, { id: 'a1', status: 'pending', attempt_number: 1 });
    expect(() => insertAttempt(db, { id: 'a2', status: 'creating', attempt_number: 2 })).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => insertAttempt(db, { id: 'a3', status: 'indeterminate', attempt_number: 2 })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('allows a new attempt once the previous one is terminal', () => {
    insertAttempt(db, { id: 'a1', status: 'pending', attempt_number: 1 });
    db.prepare(`UPDATE payment_attempts SET status = 'failed' WHERE id = 'a1'`).run();
    expect(() =>
      insertAttempt(db, { id: 'a2', status: 'creating', attempt_number: 2 }),
    ).not.toThrow();
  });

  it('rejects duplicate (booking_id, attempt_number) regardless of status', () => {
    insertAttempt(db, { id: 'a1', status: 'failed', attempt_number: 1 });
    expect(() => insertAttempt(db, { id: 'a2', status: 'expired', attempt_number: 1 })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('rejects duplicate idempotency keys and duplicate provider charge ids', () => {
    insertAttempt(db, {
      id: 'a1',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_1',
    });
    // Same idempotency key, different everything else.
    expect(() =>
      insertAttempt(db, {
        id: 'a2',
        status: 'failed',
        attempt_number: 2,
        provider_charge_id: null,
      }),
    ).not.toThrow(); // control: different key derived from id
    // Force the same key explicitly.
    expect(() =>
      db
        .prepare(
          `INSERT INTO payment_attempts (${ATTEMPT_COLS.join(', ')}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'a3',
          'b1',
          'u_customer',
          'omise',
          'promptpay',
          'idem_a1',
          3,
          null,
          25_000,
          'THB',
          'failed',
        ),
    ).toThrow(/UNIQUE constraint failed/);
    // Same provider_charge_id on a different attempt.
    expect(() =>
      insertAttempt(db, {
        id: 'a4',
        status: 'successful',
        attempt_number: 4,
        provider_charge_id: 'chrg_1',
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects a duplicate restitution per originating attempt', () => {
    insertAttempt(db, {
      id: 'a_ok',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_ok',
    });
    insertAttempt(db, {
      id: 'a_ok_2',
      status: 'successful',
      attempt_number: 2,
      provider_charge_id: 'chrg_ok_2',
    });
    insertRestitution(db, { id: 'r1' });
    expect(() =>
      insertRestitution(db, { id: 'r2', provider_charge_id: 'chrg_other' }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects a duplicate restitution per provider charge', () => {
    insertAttempt(db, {
      id: 'a_ok',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_ok',
    });
    insertAttempt(db, {
      id: 'a_ok_2',
      status: 'successful',
      attempt_number: 2,
      provider_charge_id: 'chrg_ok_2',
    });
    insertRestitution(db, { id: 'r1' });
    expect(() =>
      insertRestitution(db, { id: 'r2', payment_attempt_id: 'a_ok_2' }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects restituted rows missing approver, evidence, recipient, or timestamps', () => {
    insertAttempt(db, {
      id: 'a_ok',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_ok',
    });
    const terminal: RestitutionOverrides = {
      id: 'r_ok',
      status: 'restituted',
      recipient_reference: 'promptpay_msisdn_0812345678',
      evidence_uri: 's3://tirak-restitutions/r_ok.pdf',
      approver_user_id: 'u_approver',
      approved_at: '2026-01-02T00:00:00Z',
      completed_at: '2026-01-03T00:00:00Z',
    };
    // Positive control: a fully evidenced terminal restitution is accepted.
    expect(() => insertRestitution(db, terminal)).not.toThrow();

    const missingCases: Array<[string, Partial<RestitutionOverrides>]> = [
      ['no evidence', { evidence_uri: null }],
      ['no approver', { approver_user_id: null }],
      ['no recipient reference', { recipient_reference: null }],
      ['no approval timestamp', { approved_at: null }],
      ['no completion timestamp', { completed_at: null }],
    ];
    missingCases.forEach(([label, patch], index) => {
      const attemptId = `a_restituted_${index}`;
      insertAttempt(db, {
        id: attemptId,
        status: 'successful',
        attempt_number: 10 + index,
        provider_charge_id: `chrg_${attemptId}`,
      });
      expect(
        () =>
          insertRestitution(db, {
            ...terminal,
            ...patch,
            id: `r_${attemptId}`,
            payment_attempt_id: attemptId,
            provider_charge_id: `chrg_${attemptId}`,
          }),
        `restituted row ${label} must be rejected by the CHECK constraint`,
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it('rejects restitution_failed rows missing evidence, approver, reason, or failure timestamp', () => {
    insertAttempt(db, {
      id: 'a_ok',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_ok',
    });
    const terminal: RestitutionOverrides = {
      id: 'r_ok',
      status: 'restitution_failed',
      evidence_uri: 's3://tirak-restitutions/r_ok_failure.pdf',
      approver_user_id: 'u_approver',
      approved_at: '2026-01-02T00:00:00Z',
      failed_at: '2026-01-03T00:00:00Z',
      failure_reason: 'provider_rejected_recipient',
    };
    // Positive control.
    expect(() => insertRestitution(db, terminal)).not.toThrow();

    const missingCases: Array<[string, Partial<RestitutionOverrides>]> = [
      ['no evidence', { evidence_uri: null }],
      ['no approver', { approver_user_id: null }],
      ['no failure reason', { failure_reason: null }],
      ['no failure timestamp', { failed_at: null }],
    ];
    missingCases.forEach(([label, patch], index) => {
      const attemptId = `a_fail_${index}`;
      insertAttempt(db, {
        id: attemptId,
        status: 'successful',
        attempt_number: 10 + index,
        provider_charge_id: `chrg_${attemptId}`,
      });
      expect(
        () =>
          insertRestitution(db, {
            ...terminal,
            ...patch,
            id: `r_${attemptId}`,
            payment_attempt_id: attemptId,
            provider_charge_id: `chrg_${attemptId}`,
          }),
        `restitution_failed row ${label} must be rejected by the CHECK constraint`,
      ).toThrow(/CHECK constraint failed/);
    });
  });

  it('rejects a pending restitution that already carries terminal timestamps', () => {
    insertAttempt(db, {
      id: 'a_ok',
      status: 'successful',
      attempt_number: 1,
      provider_charge_id: 'chrg_ok',
    });
    expect(() =>
      insertRestitution(db, { id: 'r1', completed_at: '2026-01-02T00:00:00Z' }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertRestitution(db, { id: 'r1', failed_at: '2026-01-02T00:00:00Z' }),
    ).toThrow(/CHECK constraint failed/);
  });
});
