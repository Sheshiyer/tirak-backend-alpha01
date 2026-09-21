import { describe, expect, it } from 'vitest';
import {
  toCustomerPaymentReadModel,
  toOperatorPaymentReadModel,
  type PaymentAttemptV2ReadInput,
  type PaymentIntentV2ReadInput,
} from '@/payments/v2';

const intent = (overrides: Partial<PaymentIntentV2ReadInput> = {}): PaymentIntentV2ReadInput => ({
  id: 'pi_123',
  bookingId: 'booking_123',
  customerId: 'customer_123',
  provider: 'provider-a',
  providerIntentReference: 'provider-intent-secret-ref',
  amountMinor: 12500,
  currency: 'thb',
  status: 'processing',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:01:00.000Z',
  ...overrides,
});

const attempt = (overrides: Partial<PaymentAttemptV2ReadInput> = {}): PaymentAttemptV2ReadInput => ({
  id: 'attempt_123',
  booking_id: 'booking_123',
  customer_id: 'customer_123',
  provider: 'provider-a',
  provider_charge_id: 'provider-charge-secret-ref',
  amount_satang: 12500,
  currency: 'THB',
  payment_method: 'promptpay',
  status: 'pending',
  created_at: '2026-09-10T10:00:00.000Z',
  updated_at: '2026-09-10T10:01:00.000Z',
  ...overrides,
});

describe('payment V2 read models', () => {
  it.each([
    ['cash due', attempt({ payment_method: 'cash', status: 'pending' }), 'cash_due'],
    ['requires action', intent({ status: 'requires_action' }), 'requires_action'],
    ['processing', intent({ status: 'processing' }), 'processing'],
    ['succeeded', intent({ status: 'succeeded' }), 'succeeded'],
    ['failed', attempt({ status: 'failed' }), 'failed'],
    ['cancelled', intent({ status: 'cancelled' }), 'cancelled'],
    ['refunded', intent({ status: 'refunded' }), 'refunded'],
  ] as const)('maps %s to a stable customer status', (_name, input, status) => {
    expect(toCustomerPaymentReadModel(input)).toMatchObject({ status });
  });

  it('models cash and digital actions without secret-bearing fields', () => {
    expect(toCustomerPaymentReadModel(attempt({ payment_method: 'cash', status: 'pending' }))).toMatchObject({
      paymentMethod: 'cash',
      action: { kind: 'cash_due', paymentMethod: 'cash' },
    });
    expect(toCustomerPaymentReadModel(intent({ status: 'requires_action' }))).toMatchObject({
      paymentMethod: 'digital',
      action: { kind: 'requires_action', paymentMethod: 'digital' },
    });
    expect(toCustomerPaymentReadModel(intent({ status: 'processing' })).action).toBeNull();
  });

  it('redacts provider identity from the customer projection', () => {
    const model = toCustomerPaymentReadModel({
      ...attempt({
        status: 'succeeded',
        qr_code_url: 'https://provider.invalid/secret-qr',
        providerSecret: 'do-not-copy',
      }),
    } as PaymentAttemptV2ReadInput & { qr_code_url: string; providerSecret: string });
    expect(model).not.toHaveProperty('provider');
    expect(model).not.toHaveProperty('providerReference');
    expect(JSON.stringify(model)).not.toContain('provider-charge-secret-ref');
    expect(JSON.stringify(model)).not.toContain('secret-qr');
    expect(JSON.stringify(model)).not.toContain('do-not-copy');
  });

  it('keeps provider identity only in the operator projection', () => {
    const model = toOperatorPaymentReadModel(attempt({ status: 'succeeded' }));
    expect(model).toMatchObject({
      provider: 'provider-a',
      providerReference: 'provider-charge-secret-ref',
      customerId: 'customer_123',
    });
    expect(model).not.toHaveProperty('qrCodeUrl');
    expect(model).not.toHaveProperty('qr_code_url');
  });
});
