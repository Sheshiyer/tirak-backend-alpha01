import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cancellationBlockReason,
  paymentRuntimePolicy,
  publicBookingPaymentStatus,
  publicPaymentStatus,
} from '@/contracts/payment';

const root = resolve(import.meta.dirname, '../..');
const contractRoot = join(root, 'contracts/tirak-payments-v1');
const apiContract = JSON.parse(readFileSync(join(contractRoot, 'payment-api.json'), 'utf8'));
const stateMatrix = JSON.parse(readFileSync(join(contractRoot, 'state-matrix.json'), 'utf8'));
const environmentMatrix = JSON.parse(readFileSync(join(contractRoot, 'environment-matrix.json'), 'utf8'));

describe('tirak-payments-v1 contract', () => {
  it('mounts only the four frozen payment routes and exposes no legacy contact or history route', () => {
    const routeSource = readFileSync(join(root, 'src/routes/payments.ts'), 'utf8');
    const mounted = [...routeSource.matchAll(/payments\.(?:get|post|put|patch|delete)\('([^']+)'/g)]
      .map((match) => match[1]);

    expect(mounted).toEqual([
      '/webhooks/omise',
      '/charges',
      '/charges/recover',
      '/charges/:chargeId',
    ]);
    for (const blocked of apiContract.blockedRoutes) {
      expect(routeSource).not.toContain(blocked.replace('/api/payments', ''));
    }
    expect(apiContract.forbiddenRequestFields).toContain('amount');
    expect(apiContract.routes).toHaveLength(4);
  });

  it.each(stateMatrix.rules)(
    'maps $attempt plus $restitution to $publicPayment without inventing a refund',
    (rule: any) => {
      expect(publicPaymentStatus(rule.attempt, rule.restitution)).toBe(rule.publicPayment);
      const block = cancellationBlockReason(rule.attempt);
      if (['blocked', 'allowed_by_manual_case_only'].includes(rule.ordinaryCancellation)) {
        expect(block).not.toBeNull();
      } else {
        expect(block).toBeNull();
      }
    },
  );

  it('rejects impossible restitution and downgrades legacy refunded serialization to unresolved restitution', () => {
    expect(() => publicPaymentStatus('failed', 'restituted')).toThrow('successful provider charge');
    expect(publicBookingPaymentStatus('refunded')).toBe('restitution_pending');
    expect(publicBookingPaymentStatus('completed')).toBe('paid');
    expect(publicBookingPaymentStatus('failed')).toBe('failed');
  });

  it.each([
    ['missing mode', { ENVIRONMENT: 'staging', PROMPTPAY_ENABLED: 'true' }, false, 'invalid_payment_mode'],
    ['disabled', { ENVIRONMENT: 'staging', PAYMENT_MODE: 'disabled', PROMPTPAY_ENABLED: 'true' }, false, 'payment_mode_disabled'],
    ['kill switch', { ENVIRONMENT: 'staging', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'false' }, false, 'creation_disabled'],
    ['live outside production', { ENVIRONMENT: 'staging', PAYMENT_MODE: 'live', PROMPTPAY_ENABLED: 'true', OMISE_SECRET_KEY: 'skey_live_x', OMISE_WEBHOOK_SECRET: 'hook' }, false, 'live_mode_forbidden_outside_production'],
    ['test in production', { ENVIRONMENT: 'production', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'true', OMISE_SECRET_KEY: 'skey_test_x', OMISE_WEBHOOK_SECRET: 'hook' }, false, 'production_requires_live_mode'],
    ['secret mismatch', { ENVIRONMENT: 'staging', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'true', OMISE_SECRET_KEY: 'skey_live_x', OMISE_WEBHOOK_SECRET: 'hook' }, false, 'secret_key_mode_mismatch'],
    ['valid test', { ENVIRONMENT: 'staging', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'true', OMISE_SECRET_KEY: 'skey_test_x', OMISE_WEBHOOK_SECRET: 'hook' }, true, null],
    ['valid live', { ENVIRONMENT: 'production', PAYMENT_MODE: 'live', PROMPTPAY_ENABLED: 'true', OMISE_SECRET_KEY: 'skey_live_x', OMISE_WEBHOOK_SECRET: 'hook' }, true, null],
  ])('fails closed for %s', (_name, input, enabled, reason) => {
    const policy = paymentRuntimePolicy(input);
    expect(policy.createEnabled).toBe(enabled);
    expect(policy.reason).toBe(reason);
  });

  it('keeps settlement paths available when only new creation is disabled', () => {
    expect(paymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'false',
      OMISE_SECRET_KEY: 'skey_test_x',
      OMISE_WEBHOOK_SECRET: 'hook',
    })).toMatchObject({ createEnabled: false, settlementEnabled: true });
  });

  it('keeps every unresolved external environment non-deployable', () => {
    const external = environmentMatrix.environments.filter((environment: any) => environment.name !== 'test');
    expect(external.every((environment: any) => environment.deployable === false)).toBe(true);
    expect(external.some((environment: any) => JSON.stringify(environment).includes('REQUIRES_T025_CONFIRMATION'))).toBe(true);
  });

  it('keeps seed ingestion travel-only and forbids a locally manufactured paid fixture', () => {
    const seed = readFileSync(join(root, 'scripts/seed-data.sql'), 'utf8');
    expect(seed).not.toMatch(/Companion Services|Dining Companion|บริการเพื่อน|เพื่อนทานอาหาร/iu);
    expect(seed).not.toMatch(/payment_status\s*[,=].*['"](?:paid|completed|successful)/iu);
    expect(seed).not.toMatch(/chrg_(?:test|live)_/u);
  });

  it('quarantines raw legacy 004 replay and destructive 009 migration', () => {
    const strategy = readFileSync(join(root, 'docs/contracts/tirak-payments-v1/migration-strategy.md'), 'utf8');
    expect(strategy).toContain('004_mobile_app_features.sql');
    expect(strategy).toContain('009_booking_scoped_chat.sql');
    expect(strategy).toContain('It is forbidden');
    expect(strategy).toContain('booking_chat_rooms');
    expect(strategy).toContain('unknown target');
  });

  it('applies and introspects the target schema on a disposable SQLite fixture', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tirak-payments-contract-'));
    const database = join(directory, 'contract.sqlite');
    try {
      const fixture = `
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE bookings (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES users(id),
          supplier_id TEXT NOT NULL REFERENCES users(id)
        );
      `;
      const schema = readFileSync(join(contractRoot, 'target-schema.sql'), 'utf8');
      execFileSync('sqlite3', [database], { input: `${fixture}\n${schema}`, stdio: ['pipe', 'pipe', 'pipe'] });
      const tables = execFileSync('sqlite3', [database, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"], { encoding: 'utf8' });
      expect(tables.trim().split('\n')).toEqual(expect.arrayContaining([
        'booking_chat_messages',
        'booking_chat_rooms',
        'payment_attempts',
        'payment_restitutions',
        'payment_webhook_events',
      ]));

      const restitutionColumns = execFileSync('sqlite3', [database, "SELECT name FROM pragma_table_info('payment_restitutions') ORDER BY cid;"], { encoding: 'utf8' });
      expect(restitutionColumns.trim().split('\n')).toEqual(expect.arrayContaining([
        'amount_satang',
        'approver_user_id',
        'evidence_uri',
        'provider_charge_id',
        'recipient_reference',
        'status',
      ]));

      const foreignKeys = execFileSync('sqlite3', [database, 'PRAGMA foreign_key_check;'], { encoding: 'utf8' });
      expect(foreignKeys).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
