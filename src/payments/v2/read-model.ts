import {
  assertPaymentIntentV2Amount,
  normalizePaymentIntentV2Currency,
  type PaymentIntentV2,
  type PaymentIntentV2Status,
  type PaymentProviderKey,
  type PaymentProviderReference,
} from './domain';

/**
 * Read-only payment vocabulary.  This is deliberately not a persistence
 * shape: action details are intent-only and never contain a URL, QR payload,
 * token, or provider secret.
 */
export type PaymentReadStatus =
  | 'cash_due'
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded';

export type PaymentMethodV2 = 'cash' | 'digital';

export type PaymentActionV2 =
  | { kind: 'cash_due'; paymentMethod: 'cash' }
  | { kind: 'requires_action'; paymentMethod: 'digital' }
  | null;

/** The customer projection intentionally has no provider identity fields. */
export interface CustomerPaymentReadModel {
  contractVersion: 'tirak-payment-intents-v2';
  id: string;
  bookingId: string;
  amountMinor: number;
  currency: string;
  status: PaymentReadStatus;
  paymentMethod: PaymentMethodV2;
  action: PaymentActionV2;
  createdAt: string;
  updatedAt: string;
}

/**
 * Operator-only projection.  Provider identity is useful for reconciliation,
 * but this projection still excludes provider URLs, QR payloads, and secrets.
 */
export interface OperatorPaymentReadModel extends CustomerPaymentReadModel {
  customerId: string;
  provider: PaymentProviderKey | null;
  providerReference: PaymentProviderReference | null;
}

export type PaymentAttemptV2Status =
  | 'creating'
  | 'indeterminate'
  | 'pending'
  | 'successful'
  | 'failed'
  | 'expired'
  | PaymentIntentV2Status;

/**
 * Boundary input for adapting the frozen V1 attempt row or a future V2
 * attempt.  The mapper reads only these fields and ignores all other input,
 * including qr_code_url and provider credentials.
 */
export interface PaymentAttemptV2ReadInput {
  id: string;
  bookingId?: string;
  booking_id?: string;
  customerId?: string;
  customer_id?: string;
  paymentIntentId?: string | null;
  provider?: PaymentProviderKey | null;
  providerReference?: PaymentProviderReference | null;
  providerIntentReference?: PaymentProviderReference | null;
  provider_charge_id?: PaymentProviderReference | null;
  amountMinor?: number;
  amount_satang?: number;
  currency: string;
  status: PaymentAttemptV2Status;
  paymentMethod?: string | null;
  payment_method?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

export type PaymentIntentV2ReadInput = PaymentIntentV2 & {
  paymentMethod?: string | null;
  payment_method?: string | null;
};

export type PaymentReadInput = PaymentIntentV2ReadInput | PaymentAttemptV2ReadInput;

const READ_CONTRACT_VERSION = 'tirak-payment-intents-v2' as const;

function isAttemptInput(input: PaymentReadInput): input is PaymentAttemptV2ReadInput {
  return 'amount_satang' in input
    || 'payment_method' in input
    || input.status === 'creating'
    || input.status === 'indeterminate'
    || input.status === 'pending'
    || input.status === 'successful';
}

function paymentMethodOf(input: PaymentReadInput): PaymentMethodV2 {
  const raw = ('paymentMethod' in input ? input.paymentMethod : undefined)
    ?? ('payment_method' in input ? input.payment_method : undefined);
  return typeof raw === 'string' && ['cash', 'cash_on_arrival', 'cash-on-arrival'].includes(raw.trim().toLowerCase())
    ? 'cash'
    : 'digital';
}

function readAmountMinor(input: PaymentReadInput): number {
  const amount = 'amountMinor' in input && input.amountMinor !== undefined
    ? input.amountMinor
    : 'amount_satang' in input ? input.amount_satang : undefined;
  if (amount === undefined) throw new Error('Payment V2 read model requires amountMinor');
  assertPaymentIntentV2Amount(amount);
  return amount;
}

function readBookingId(input: PaymentReadInput): string {
  const bookingId = ('bookingId' in input ? input.bookingId : undefined)
    ?? ('booking_id' in input ? input.booking_id : undefined);
  if (!bookingId) throw new Error('Payment V2 read model requires bookingId');
  return bookingId;
}

function readTimestamp(input: PaymentReadInput, field: 'created' | 'updated'): string {
  const value = field === 'created'
    ? (('createdAt' in input ? input.createdAt : undefined) ?? ('created_at' in input ? input.created_at : undefined))
    : (('updatedAt' in input ? input.updatedAt : undefined) ?? ('updated_at' in input ? input.updated_at : undefined));
  if (!value) throw new Error(`Payment V2 read model requires ${field}At`);
  return value;
}

function readStatus(input: PaymentReadInput, method: PaymentMethodV2): PaymentReadStatus {
  const status = input.status;
  switch (status) {
    case 'draft':
    case 'requires_payment_method':
      return method === 'cash' ? 'cash_due' : 'requires_payment_method';
    case 'creating':
    case 'indeterminate':
    case 'processing':
      return 'processing';
    case 'pending':
      return method === 'cash' ? 'cash_due' : 'requires_action';
    case 'requires_action':
      return 'requires_action';
    case 'successful':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
    default:
      return assertNever(status);
  }
}

export function paymentActionV2For(
  status: PaymentReadStatus,
  paymentMethod: PaymentMethodV2,
): PaymentActionV2 {
  if (status === 'cash_due') return { kind: 'cash_due', paymentMethod: 'cash' };
  if (status === 'requires_action') return { kind: 'requires_action', paymentMethod: 'digital' };
  // Digital processing/terminal states intentionally expose no action data.
  void paymentMethod;
  return null;
}

function baseReadModel(input: PaymentReadInput): CustomerPaymentReadModel {
  const paymentMethod = paymentMethodOf(input);
  const status = readStatus(input, paymentMethod);
  return {
    contractVersion: READ_CONTRACT_VERSION,
    id: input.id,
    bookingId: readBookingId(input),
    amountMinor: readAmountMinor(input),
    currency: normalizePaymentIntentV2Currency(input.currency),
    status,
    paymentMethod,
    action: paymentActionV2For(status, paymentMethod),
    createdAt: readTimestamp(input, 'created'),
    updatedAt: readTimestamp(input, 'updated'),
  };
}

function providerReferenceOf(input: PaymentReadInput): PaymentProviderReference | null {
  if (!isAttemptInput(input)) return input.providerIntentReference;
  return input.providerReference ?? input.providerIntentReference ?? input.provider_charge_id ?? null;
}

function customerIdOf(input: PaymentReadInput): string {
  const customerId = ('customerId' in input ? input.customerId : undefined)
    ?? ('customer_id' in input ? input.customer_id : undefined);
  if (!customerId) throw new Error('Payment V2 operator read model requires customerId');
  return customerId;
}

export function toCustomerPaymentReadModel(input: PaymentReadInput): CustomerPaymentReadModel {
  return baseReadModel(input);
}

export function toOperatorPaymentReadModel(input: PaymentReadInput): OperatorPaymentReadModel {
  const base = baseReadModel(input);
  return {
    ...base,
    customerId: customerIdOf(input),
    provider: input.provider ?? null,
    providerReference: providerReferenceOf(input),
  };
}

/** Explicit aliases make the projection boundary easy to discover at call sites. */
export const customerPaymentReadModel = toCustomerPaymentReadModel;
export const operatorPaymentReadModel = toOperatorPaymentReadModel;

function assertNever(value: never): never {
  throw new Error(`Unsupported payment V2 status: ${String(value)}`);
}
