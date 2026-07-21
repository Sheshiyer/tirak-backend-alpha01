const OMISE_API_BASE_URL = 'https://api.omise.co';

export type PaymentAttemptStatus = 'creating' | 'indeterminate' | 'pending' | 'successful' | 'failed' | 'expired';

export interface OmiseCharge {
  id: string;
  amount: number;
  currency: string;
  status?: string;
  paid?: boolean;
  expires_at?: string | null;
  metadata?: Record<string, unknown> | null;
  source?: {
    id?: string;
    type?: string;
    scannable_code?: {
      image?: { download_uri?: string };
    };
  };
}

export class OmiseRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly indeterminate = false,
    public readonly code = 'omise_request_error',
  ) {
    super(message);
    this.name = 'OmiseRequestError';
  }
}

function authorizationHeader(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`;
}

async function parseOmiseResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OmiseRequestError(
      'Omise returned an invalid response',
      502,
      response.ok || response.status >= 500,
      'invalid_provider_response',
    );
  }

  if (!response.ok) {
    throw new OmiseRequestError(
      'Omise rejected the payment request',
      502,
      response.status >= 500,
      `provider_http_${response.status}`,
    );
  }

  return payload as T;
}

async function omiseFetch<T>(
  secretKey: string,
  path: string,
  init: RequestInit,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authorizationHeader(secretKey),
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${OMISE_API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new OmiseRequestError(
      'Omise is temporarily unavailable',
      502,
      true,
      'provider_network_error',
    );
  }

  return parseOmiseResponse<T>(response);
}

function qrCodeFrom(source: OmiseCharge['source'] | undefined): string | null {
  const qrCode = source?.scannable_code?.image?.download_uri;
  return typeof qrCode === 'string' && qrCode.length > 0 ? qrCode : null;
}

export async function createPromptPayCharge(input: {
  secretKey: string;
  bookingId: string;
  amount: number;
  currency: 'THB';
  attemptNumber: number;
}): Promise<{ charge: OmiseCharge; qrCode: string | null; idempotencyKey: string }> {
  const idempotencyKey = `tirak:promptpay:booking:${input.bookingId}:${input.attemptNumber}`;
  const currency = input.currency.toLowerCase();
  const chargeBody = new URLSearchParams({
    amount: input.amount.toString(),
    currency,
    'source[type]': 'promptpay',
    description: `Tirak booking ${input.bookingId}`,
    'metadata[booking_id]': input.bookingId,
  });
  const charge = await omiseFetch<OmiseCharge>(
    input.secretKey,
    '/charges',
    { method: 'POST', body: chargeBody },
    idempotencyKey,
  );

  if (
    !charge.id
    || charge.amount !== input.amount
    || charge.currency?.toUpperCase() !== input.currency
  ) {
    throw new OmiseRequestError(
      'Omise charge did not match the booking payment',
      502,
      true,
      'created_charge_mismatch',
    );
  }

  return {
    charge,
    qrCode: qrCodeFrom(charge.source),
    idempotencyKey,
  };
}

export async function retrieveOmiseCharge(secretKey: string, chargeId: string): Promise<OmiseCharge> {
  const charge = await omiseFetch<OmiseCharge>(
    secretKey,
    `/charges/${encodeURIComponent(chargeId)}`,
    { method: 'GET' },
  );

  if (!charge.id || charge.id !== chargeId) {
    throw new OmiseRequestError('Omise returned the wrong charge', 502);
  }

  return charge;
}

export function paymentStatusFromCharge(charge: OmiseCharge): PaymentAttemptStatus {
  if (charge.paid === true || charge.status === 'successful') return 'successful';
  if (charge.status === 'failed') return 'failed';
  if (charge.status === 'expired') return 'expired';
  return 'pending';
}

export function qrCodeFromCharge(charge: OmiseCharge): string | null {
  return qrCodeFrom(charge.source);
}

function hexToBytes(value: string): Uint8Array | null {
  const normalized = value.startsWith('sha256=') ? value.slice(7) : value;
  if (!/^[a-f\d]+$/i.test(normalized) || normalized.length % 2 !== 0) return null;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, (index * 2) + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function decodeWebhookSecret(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    if (decoded.length === 0) return null;
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyOmiseWebhookSignature(input: {
  rawBody: string;
  timestamp: string;
  signature: string;
  webhookSecret: string;
  now?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  if (!/^\d+$/.test(input.timestamp)) return false;
  const timestampMs = Number(input.timestamp) * 1000;
  const now = input.now ?? Date.now();
  const tolerance = input.toleranceMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > tolerance) return false;

  const encoder = new TextEncoder();
  const decodedSecret = decodeWebhookSecret(input.webhookSecret);
  if (!decodedSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    decodedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expectedBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${input.timestamp}.${input.rawBody}`),
  );
  const expected = new Uint8Array(expectedBuffer);
  return input.signature
    .split(',')
    .map(signature => hexToBytes(signature.trim()))
    .some(supplied => supplied !== null && timingSafeEqual(expected, supplied));
}

export async function webhookReplayKey(timestamp: string, rawBody: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
