import { describe, expect, it } from 'vitest';
import {
  applyPaymentIntentV2Event,
  assertPaymentIntentV2Amount,
  assertPaymentIntentV2EventProvider,
  assertPaymentIntentV2Transition,
  canTransitionPaymentIntentV2,
  isTerminalPaymentIntentV2Status,
  normalizePaymentIntentV2Currency,
  paymentIntentV2StatusForEvent,
} from '@/payments/v2';

describe('payment-intent V2 domain', () => {
  it('permits only forward lifecycle transitions, with identical state safe for replay', () => {
    expect(canTransitionPaymentIntentV2('draft', 'requires_payment_method')).toBe(true);
    expect(canTransitionPaymentIntentV2('processing', 'succeeded')).toBe(true);
    expect(canTransitionPaymentIntentV2('processing', 'processing')).toBe(true);
    expect(canTransitionPaymentIntentV2('succeeded', 'refunded')).toBe(true);
    expect(canTransitionPaymentIntentV2('succeeded', 'processing')).toBe(false);
    expect(canTransitionPaymentIntentV2('failed', 'succeeded')).toBe(false);
    expect(() => assertPaymentIntentV2Transition('expired', 'processing')).toThrow('expired -> processing');
  });

  it('maps generic provider observations without coupling to a payment provider', () => {
    expect(paymentIntentV2StatusForEvent('provider.reconciled')).toBeNull();
    expect(applyPaymentIntentV2Event('draft', 'provider.processing')).toBe('processing');
    expect(applyPaymentIntentV2Event('processing', 'provider.succeeded')).toBe('succeeded');
    expect(applyPaymentIntentV2Event('succeeded', 'provider.refunded')).toBe('refunded');
    expect(applyPaymentIntentV2Event('succeeded', 'provider.reconciled')).toBe('succeeded');
    expect(() => applyPaymentIntentV2Event('succeeded', 'provider.processing')).toThrow('succeeded -> processing');
  });

  it('preserves amount, currency, and provider-ownership invariants', () => {
    expect(() => assertPaymentIntentV2Amount(0)).toThrow('positive safe integer');
    expect(() => assertPaymentIntentV2Amount(1.5)).toThrow('positive safe integer');
    expect(() => assertPaymentIntentV2Amount(Number.MAX_SAFE_INTEGER + 1)).toThrow('positive safe integer');
    expect(() => assertPaymentIntentV2Amount(100)).not.toThrow();
    expect(normalizePaymentIntentV2Currency(' thb ')).toBe('THB');
    expect(() => normalizePaymentIntentV2Currency('TH')).toThrow('three-letter ISO');
    expect(() => assertPaymentIntentV2EventProvider(
      { provider: 'provider-a' },
      { provider: 'provider-b' },
    )).toThrow('does not match');
    expect(() => assertPaymentIntentV2EventProvider(
      { provider: 'provider-a' },
      { provider: 'provider-a' },
    )).not.toThrow();
  });

  it('marks only final outcomes as terminal', () => {
    expect(isTerminalPaymentIntentV2Status('succeeded')).toBe(true);
    expect(isTerminalPaymentIntentV2Status('refunded')).toBe(true);
    expect(isTerminalPaymentIntentV2Status('failed')).toBe(true);
    expect(isTerminalPaymentIntentV2Status('processing')).toBe(false);
  });
});
