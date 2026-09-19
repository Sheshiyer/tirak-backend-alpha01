import { describe, expect, it } from 'vitest';
import {
  PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION,
  createStoredPaymentProviderPolicy,
  parseStoredPaymentProviderPolicy,
  resolvePaymentProviderPolicy,
  type PaymentProviderPolicy,
} from '@/payments/provider-policy';

const now = '2026-09-17T05:00:00.000Z';
const policy: PaymentProviderPolicy = {
  provider: 'omise',
  environment: 'staging',
  mode: 'test',
  enabled: true,
  supportedMethods: ['promptpay'],
  revision: 1,
  updatedAt: now,
};
const readyEnv = {
  ENVIRONMENT: 'staging',
  OMISE_SECRET_KEY: 'skey_test_fixture',
  OMISE_WEBHOOK_SECRET: 'webhook-fixture',
};

describe('payment provider policy registry and resolver', () => {
  it.each([
    ['absent policy', null, 'promptpay', readyEnv, 'provider_policy_absent'],
    ['disabled policy', { ...policy, enabled: false }, 'promptpay', readyEnv, 'provider_policy_disabled'],
    ['unknown provider', { ...policy, provider: 'other' }, 'promptpay', readyEnv, 'unknown_provider'],
    ['unsupported method', policy, 'card', readyEnv, 'unsupported_payment_method'],
    ['method outside allowlist', { ...policy, supportedMethods: [] }, 'promptpay', readyEnv, 'unsupported_payment_method'],
    ['missing credentials', policy, 'promptpay', { ...readyEnv, OMISE_SECRET_KEY: undefined }, 'missing_provider_credentials'],
    ['missing webhook binding', policy, 'promptpay', { ...readyEnv, OMISE_WEBHOOK_SECRET: undefined }, 'missing_webhook_secret'],
    ['environment mismatch', policy, 'promptpay', { ...readyEnv, ENVIRONMENT: 'production' }, 'provider_environment_mismatch'],
    ['mode/environment mismatch', { ...policy, mode: 'live' }, 'promptpay', { ...readyEnv, OMISE_SECRET_KEY: 'skey_live_fixture' }, 'provider_mode_environment_mismatch'],
    ['secret/mode mismatch', policy, 'promptpay', { ...readyEnv, OMISE_SECRET_KEY: 'skey_live_fixture' }, 'provider_secret_mode_mismatch'],
  ])('fails closed for %s', (_name, candidate, method, env, reason) => {
    expect(resolvePaymentProviderPolicy(candidate, method, env)).toMatchObject({
      enabled: false,
      reason,
      adapter: null,
    });
  });

  it('maps an eligible Omise PromptPay policy to its adapter without returning credentials', () => {
    const resolved = resolvePaymentProviderPolicy(policy, 'promptpay', readyEnv);
    expect(resolved).toEqual({
      enabled: true,
      reason: null,
      adapter: 'omise-promptpay',
      readiness: { credentialsBound: true, webhookSecretBound: true },
    });
    expect(JSON.stringify(resolved)).not.toContain(readyEnv.OMISE_SECRET_KEY);
    expect(JSON.stringify(resolved)).not.toContain(readyEnv.OMISE_WEBHOOK_SECRET);
  });

  it('creates one parseable document containing current policy and before/after audit', () => {
    const first = createStoredPaymentProviderPolicy({
      before: null,
      policy: {
        provider: 'omise',
        environment: 'staging',
        mode: 'disabled',
        enabled: false,
        supportedMethods: ['promptpay'],
      },
      actorId: 'admin-1',
      occurredAt: now,
    });
    const second = createStoredPaymentProviderPolicy({
      before: first,
      policy: {
        provider: 'omise',
        environment: 'staging',
        mode: 'test',
        enabled: true,
        supportedMethods: ['promptpay'],
      },
      actorId: 'admin-2',
      occurredAt: '2026-09-17T05:01:00.000Z',
    });

    expect(second.schemaVersion).toBe(PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION);
    expect(second.policy.revision).toBe(2);
    expect(second.auditTrail.at(-1)).toMatchObject({
      actorId: 'admin-2',
      before: { enabled: false, revision: 1 },
      after: { enabled: true, revision: 2 },
    });
    expect(parseStoredPaymentProviderPolicy(JSON.stringify(second))).toEqual(second);
  });

  it('rejects stored documents containing extra fields such as credentials', () => {
    const unsafe = {
      schemaVersion: PAYMENT_PROVIDER_POLICY_SCHEMA_VERSION,
      policy: { ...policy, secretKey: 'must-not-be-stored' },
      auditTrail: [],
    };
    expect(parseStoredPaymentProviderPolicy(JSON.stringify(unsafe))).toBeNull();
  });
});
