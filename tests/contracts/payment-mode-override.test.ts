import { describe, expect, it } from 'vitest';
import {
  PAYMENT_MODE_OVERRIDE_KEY,
  paymentRuntimePolicy,
  resolvePaymentRuntimePolicy,
} from '@/contracts/payment';

type Row = Record<string, unknown>;

const testSecrets = { OMISE_SECRET_KEY: 'skey_test_x', OMISE_WEBHOOK_SECRET: 'hook' };
const liveSecrets = { OMISE_SECRET_KEY: 'skey_live_x', OMISE_WEBHOOK_SECRET: 'hook' };

function kvWith(value: unknown, { throws = false } = {}) {
  const calls: string[] = [];
  return {
    calls,
    kv: {
      get: async (key: string) => {
        calls.push(key);
        if (throws) throw new Error('kv unavailable');
        return value;
      },
    },
  };
}

describe('T-033 resolvePaymentRuntimePolicy (KV kill-switch override)', () => {
  it('falls back to the static floor when PAYMENT_CONFIG_KV is unbound', async () => {
    const input = { ENVIRONMENT: 'staging', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'true', ...testSecrets };
    const resolved = await resolvePaymentRuntimePolicy(input);
    expect(resolved).toEqual(paymentRuntimePolicy(input));
    expect(resolved.createEnabled).toBe(true);
  });

  it('falls back to the static floor when the override key is absent or empty', async () => {
    const input = { ENVIRONMENT: 'staging', PAYMENT_MODE: 'test', PROMPTPAY_ENABLED: 'true', ...testSecrets };
    for (const stored of [null, undefined, '']) {
      const { kv, calls } = kvWith(stored);
      const resolved = await resolvePaymentRuntimePolicy({ ...input, PAYMENT_CONFIG_KV: kv });
      expect(resolved).toEqual(paymentRuntimePolicy(input));
      expect(calls).toEqual([PAYMENT_MODE_OVERRIDE_KEY]);
    }
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a bare string', '"test"'],
    ['a bare number', '1'],
    ['an array', '["test"]'],
    ['an invalid mode value', JSON.stringify({ paymentMode: 'sandbox' })],
    ['a non-string mode', JSON.stringify({ paymentMode: 2 })],
    ['a non-boolean promptPayEnabled', JSON.stringify({ promptPayEnabled: 'false' })],
  ])('fails closed with invalid_mode_override for %s', async (_name, stored) => {
    const { kv } = kvWith(stored);
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'true',
      ...testSecrets,
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.reason).toBe('invalid_mode_override');
    expect(resolved.settlementEnabled).toBe(true);
  });

  it('fails closed when a bound namespace cannot be read', async () => {
    const { kv } = kvWith(null, { throws: true });
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'true',
      ...testSecrets,
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.reason).toBe('invalid_mode_override');
  });

  it.each([
    ['staging', 'test', testSecrets, true, null],
    ['staging', 'disabled', testSecrets, false, 'payment_mode_disabled'],
    ['staging', 'live', liveSecrets, false, 'live_mode_forbidden_outside_production'],
    ['production', 'live', liveSecrets, true, null],
    ['production', 'test', testSecrets, false, 'production_requires_live_mode'],
    ['production', 'disabled', liveSecrets, false, 'payment_mode_disabled'],
    ['development', 'test', testSecrets, true, null],
    ['development', 'live', liveSecrets, false, 'live_mode_forbidden_outside_production'],
  ] as Array<[string, string, Row, boolean, string | null]>)(
    'applies the fail-closed ladder to an override mode %s/%s',
    async (environment, mode, secrets, enabled, reason) => {
      const { kv } = kvWith(JSON.stringify({ paymentMode: mode, promptPayEnabled: true }));
      const resolved = await resolvePaymentRuntimePolicy({
        ENVIRONMENT: environment,
        PAYMENT_MODE: 'disabled',
        PROMPTPAY_ENABLED: 'false',
        ...secrets,
        PAYMENT_CONFIG_KV: kv,
      });
      expect(resolved.createEnabled).toBe(enabled);
      expect(resolved.reason).toBe(reason);
    },
  );

  it('enforces key/mode prefix coherence against the override mode, not the floor', async () => {
    const { kv } = kvWith(JSON.stringify({ paymentMode: 'test', promptPayEnabled: true }));
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'disabled',
      PROMPTPAY_ENABLED: 'false',
      OMISE_SECRET_KEY: 'skey_live_x',
      OMISE_WEBHOOK_SECRET: 'hook',
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.reason).toBe('secret_key_mode_mismatch');
  });

  it('keeps settlement enabled when an override disables only creation', async () => {
    const { kv } = kvWith(JSON.stringify({ promptPayEnabled: false }));
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'true',
      ...testSecrets,
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved).toMatchObject({
      createEnabled: false,
      settlementEnabled: true,
      reason: 'creation_disabled',
      mode: 'test',
    });
  });

  it('lets an audited override open creation over a disabled static floor', async () => {
    const { kv } = kvWith(JSON.stringify({
      paymentMode: 'test',
      promptPayEnabled: true,
      operator: 'human release owner',
      reason: 'enable staging test charges',
      approvedAt: '2026-07-24T00:00:00.000Z',
      previousMode: 'disabled',
      previousPromptPayEnabled: false,
    }));
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'disabled',
      PROMPTPAY_ENABLED: 'false',
      ...testSecrets,
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved.createEnabled).toBe(true);
    expect(resolved.reason).toBeNull();
    expect(resolved.mode).toBe('test');
  });

  it('lets a partial override inherit the unspecified dimension from the floor', async () => {
    const { kv } = kvWith(JSON.stringify({ promptPayEnabled: true }));
    const resolved = await resolvePaymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'false',
      ...testSecrets,
      PAYMENT_CONFIG_KV: kv,
    });
    expect(resolved.createEnabled).toBe(true);
    expect(resolved.mode).toBe('test');
  });

  it('keeps the sync static resolver unchanged for static callers', () => {
    const policy = paymentRuntimePolicy({
      ENVIRONMENT: 'staging',
      PAYMENT_MODE: 'test',
      PROMPTPAY_ENABLED: 'true',
      ...testSecrets,
    });
    expect(policy).toMatchObject({ createEnabled: true, settlementEnabled: true, reason: null });
  });
});
