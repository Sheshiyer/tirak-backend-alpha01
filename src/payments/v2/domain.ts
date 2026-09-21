/**
 * Provider-neutral payment-intent vocabulary.
 *
 * This is intentionally separate from the frozen Omise/PromptPay V1 ledger.
 * It contains no provider SDK calls, credentials, transport types, or database
 * access. A future adapter may map a provider event into this vocabulary only
 * after its additive storage migration and activation review are approved.
 */
export const TIRAK_PAYMENT_INTENTS_V2_CONTRACT_VERSION = 'tirak-payment-intents-v2' as const;

export type PaymentIntentV2Status =
  | 'draft'
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'refunded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type PaymentProviderEventKind =
  | 'intent.created'
  | 'payment_method.required'
  | 'customer_action.required'
  | 'provider.processing'
  | 'provider.succeeded'
  | 'provider.refunded'
  | 'provider.failed'
  | 'provider.cancelled'
  | 'provider.expired'
  | 'provider.reconciled';

/**
 * Provider keys and provider references are deliberately opaque. The V2 core
 * does not encode an Omise-, Stripe-, or wallet-specific identifier format.
 */
export type PaymentProviderKey = string;
export type PaymentProviderReference = string;

export interface PaymentIntentV2 {
  id: string;
  bookingId: string;
  customerId: string;
  provider: PaymentProviderKey;
  providerIntentReference: PaymentProviderReference | null;
  amountMinor: number;
  currency: string;
  status: PaymentIntentV2Status;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentProviderEventV2 {
  id: string;
  paymentIntentId: string;
  provider: PaymentProviderKey;
  providerEventReference: PaymentProviderReference;
  kind: PaymentProviderEventKind;
  occurredAt: string;
  receivedAt: string;
}

const TERMINAL_STATUSES = new Set<PaymentIntentV2Status>([
  'succeeded',
  'refunded',
  'failed',
  'cancelled',
  'expired',
]);

const ALLOWED_TRANSITIONS: Record<PaymentIntentV2Status, ReadonlySet<PaymentIntentV2Status>> = {
  draft: new Set(['requires_payment_method', 'processing', 'cancelled', 'expired']),
  requires_payment_method: new Set(['processing', 'cancelled', 'expired']),
  requires_action: new Set(['processing', 'succeeded', 'failed', 'cancelled', 'expired']),
  processing: new Set(['requires_action', 'succeeded', 'failed', 'cancelled', 'expired']),
  succeeded: new Set(['refunded']),
  refunded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

const EVENT_STATUS: Readonly<Record<PaymentProviderEventKind, PaymentIntentV2Status | null>> = {
  'intent.created': 'draft',
  'payment_method.required': 'requires_payment_method',
  'customer_action.required': 'requires_action',
  'provider.processing': 'processing',
  'provider.succeeded': 'succeeded',
  'provider.refunded': 'refunded',
  'provider.failed': 'failed',
  'provider.cancelled': 'cancelled',
  'provider.expired': 'expired',
  // Reconciliation may refresh metadata without implying a state change.
  'provider.reconciled': null,
};

export function isTerminalPaymentIntentV2Status(status: PaymentIntentV2Status): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Identical-state transitions are permitted so a replayed provider event can
 * be safely de-duplicated by a future persistence adapter.
 */
export function canTransitionPaymentIntentV2(
  from: PaymentIntentV2Status,
  to: PaymentIntentV2Status,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

export function assertPaymentIntentV2Transition(
  from: PaymentIntentV2Status,
  to: PaymentIntentV2Status,
): void {
  if (!canTransitionPaymentIntentV2(from, to)) {
    throw new Error(`Invalid payment-intent V2 transition: ${from} -> ${to}`);
  }
}

export function paymentIntentV2StatusForEvent(
  event: PaymentProviderEventKind,
): PaymentIntentV2Status | null {
  return EVENT_STATUS[event];
}

/**
 * Applies only the state implication of an event. Persistence, provider
 * signature verification, and event de-duplication remain future adapter work.
 */
export function applyPaymentIntentV2Event(
  current: PaymentIntentV2Status,
  event: PaymentProviderEventKind,
): PaymentIntentV2Status {
  const next = paymentIntentV2StatusForEvent(event);
  if (next === null) return current;
  assertPaymentIntentV2Transition(current, next);
  return next;
}

export function assertPaymentIntentV2Amount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Payment-intent V2 amountMinor must be a positive safe integer');
  }
}

export function normalizePaymentIntentV2Currency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error('Payment-intent V2 currency must be a three-letter ISO code');
  }
  return normalized;
}

/** A provider event cannot be attached to an intent owned by another adapter. */
export function assertPaymentIntentV2EventProvider(
  intent: Pick<PaymentIntentV2, 'provider'>,
  event: Pick<PaymentProviderEventV2, 'provider'>,
): void {
  if (!intent.provider || !event.provider || intent.provider !== event.provider) {
    throw new Error('Payment-intent V2 provider event does not match the intent provider');
  }
}
