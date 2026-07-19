export const TIRAK_PAYMENTS_CONTRACT_VERSION = 'tirak-payments-v1' as const;

export type PaymentAttemptStatus =
  | 'creating'
  | 'indeterminate'
  | 'pending'
  | 'successful'
  | 'failed'
  | 'expired';

export type PublicPaymentStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'restitution_pending'
  | 'restituted'
  | 'restitution_failed';

export type RestitutionStatus =
  | 'none'
  | 'restitution_pending'
  | 'restituted'
  | 'restitution_failed';

export type PaymentMode = 'disabled' | 'test' | 'live';

export interface PaymentRuntimeInput {
  ENVIRONMENT?: string;
  PAYMENT_MODE?: string;
  PROMPTPAY_ENABLED?: string;
  OMISE_SECRET_KEY?: string;
  OMISE_WEBHOOK_SECRET?: string;
}

export interface PaymentRuntimePolicy {
  environment: 'test' | 'development' | 'staging' | 'production';
  mode: PaymentMode;
  createEnabled: boolean;
  settlementEnabled: boolean;
  reason: string | null;
}

const ACTIVE_OR_UNRESOLVED = new Set<PaymentAttemptStatus>([
  'creating',
  'indeterminate',
  'pending',
]);

export function publicPaymentStatus(
  attemptStatus: PaymentAttemptStatus,
  restitutionStatus: RestitutionStatus = 'none',
): PublicPaymentStatus {
  if (attemptStatus === 'successful') {
    if (restitutionStatus !== 'none') return restitutionStatus;
    return 'paid';
  }

  if (restitutionStatus !== 'none') {
    throw new Error('Restitution cannot exist without a successful provider charge');
  }

  if (attemptStatus === 'creating' || attemptStatus === 'indeterminate') return 'processing';
  if (attemptStatus === 'pending') return 'pending';
  return 'failed';
}

/**
 * Booking serialization never infers a refund from cancellation. A legacy
 * `refunded` value is downgraded to pending restitution until a ledger record
 * proves the external transfer.
 */
export function publicBookingPaymentStatus(value: unknown): PublicPaymentStatus {
  const status = String(value || '').trim().toLowerCase();
  if (['completed', 'paid', 'successful', 'succeeded'].includes(status)) return 'paid';
  if (status === 'restituted') return 'restituted';
  if (status === 'restitution_failed') return 'restitution_failed';
  if (status === 'restitution_pending' || status === 'refunded') return 'restitution_pending';
  if (['processing', 'creating', 'indeterminate'].includes(status)) return 'processing';
  if (['failed', 'expired'].includes(status)) return 'failed';
  return 'pending';
}

export function cancellationBlockReason(attemptStatus: PaymentAttemptStatus | null): string | null {
  if (!attemptStatus) return null;
  if (ACTIVE_OR_UNRESOLVED.has(attemptStatus)) {
    return 'Resolve the active PromptPay attempt before cancelling this booking';
  }
  if (attemptStatus === 'successful') {
    return 'Paid bookings require an approved restitution case before cancellation';
  }
  return null;
}

function keyMode(key: string | undefined): 'test' | 'live' | 'unknown' {
  if (!key) return 'unknown';
  if (key.startsWith('skey_test_')) return 'test';
  if (key.startsWith('skey_live_')) return 'live';
  return 'unknown';
}

export function paymentRuntimePolicy(input: PaymentRuntimeInput): PaymentRuntimePolicy {
  const environment = input.ENVIRONMENT;
  const mode = input.PAYMENT_MODE;
  const requested = input.PROMPTPAY_ENABLED === 'true';
  const validEnvironment = ['test', 'development', 'staging', 'production'].includes(String(environment));
  const validMode = ['disabled', 'test', 'live'].includes(String(mode));
  const normalizedEnvironment = validEnvironment
    ? environment as PaymentRuntimePolicy['environment']
    : 'development';
  const normalizedMode = validMode ? mode as PaymentMode : 'disabled';

  let reason: string | null = null;
  if (!validEnvironment) reason = 'invalid_environment';
  else if (!validMode) reason = 'invalid_payment_mode';
  else if (!requested) reason = 'creation_disabled';
  else if (normalizedMode === 'disabled') reason = 'payment_mode_disabled';
  else if (normalizedEnvironment === 'production' && normalizedMode !== 'live') reason = 'production_requires_live_mode';
  else if (normalizedEnvironment !== 'production' && normalizedMode === 'live') reason = 'live_mode_forbidden_outside_production';
  else if (keyMode(input.OMISE_SECRET_KEY) !== normalizedMode) reason = 'secret_key_mode_mismatch';
  else if (!input.OMISE_WEBHOOK_SECRET) reason = 'missing_webhook_secret';

  return {
    environment: normalizedEnvironment,
    mode: normalizedMode,
    createEnabled: reason === null,
    settlementEnabled: Boolean(input.OMISE_SECRET_KEY && input.OMISE_WEBHOOK_SECRET),
    reason,
  };
}
