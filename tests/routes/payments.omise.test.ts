import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { paymentRoutes } from '@/routes/payments';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestEnv, createTestUser } from '@tests/setup';

type Row = Record<string, unknown>;

const bookingId = '123e4567-e89b-12d3-a456-426614174000';
const userId = 'test-customer-id';

const promptPaySource = {
  id: 'src_promptpay_1',
  type: 'promptpay',
  amount: 100000,
  currency: 'thb',
  scannable_code: {
    image: { download_uri: 'https://example.test/promptpay-qr.png' },
  },
};

const pendingCharge = {
  id: 'chrg_promptpay_1',
  amount: 100000,
  currency: 'thb',
  status: 'pending',
  paid: false,
  source: promptPaySource,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function signWebhook(body: string, timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const decodedSecret = Uint8Array.from(atob(secret), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    decodedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signWebhookWithUndecodedSecret(body: string, timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('Omise PromptPay booking payments', () => {
  let app: Hono;
  let env: any;
  let authHeader: string;
  let booking: Row | null;
  let attempt: Row | null;
  let retryCount: number;
  let attemptInsertChanges: number;
  let attemptReadSequence: Array<Row | null>;
  let webhookInsertChanges: number;
  let webhookExisting: Row | null;
  let webhookClaimChanges: number;
  let statements: Array<{ query: string; params: unknown[] }>;

  beforeEach(async () => {
    app = new Hono();
    env = createTestEnv();
    env.OMISE_SECRET_KEY = 'skey_test_server_only';
    env.OMISE_WEBHOOK_SECRET = btoa('webhook_test_secret');
    authHeader = `Bearer ${await generateJWT(
      { sub: userId, email: 'customer@example.com', userType: 'customer' },
      env.JWT_SECRET,
    )}`;
    booking = {
      id: bookingId,
      customer_id: userId,
      status: 'confirmed',
      total_amount: 1000,
      currency: 'THB',
      payment_status: 'pending',
    };
    attempt = null;
    retryCount = 0;
    attemptInsertChanges = 1;
    attemptReadSequence = [];
    webhookInsertChanges = 1;
    webhookExisting = null;
    webhookClaimChanges = 1;
    statements = [];

    env.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          statements.push({ query, params });
          if (query.includes('FROM users WHERE id')) {
            return createTestUser({ id: userId, email: 'customer@example.com' });
          }
          if (query.includes('FROM bookings') && query.includes('customer_id = ?')) return booking;
          if (query.includes('COUNT(*)') || query.includes('MAX(attempt_number)')) {
            return { retry_count: retryCount };
          }
          if (query.includes('FROM payment_attempts') && query.includes('provider_charge_id = ?')) return attempt;
          if (query.includes('FROM payment_attempts') && query.includes('booking_id = ?')) {
            return attemptReadSequence.length > 0 ? attemptReadSequence.shift() : attempt;
          }
          if (query.includes('FROM payment_webhook_events')) return webhookExisting;
          return null;
        },
        all: async () => {
          statements.push({ query, params });
          return { results: [] };
        },
        run: async () => {
          statements.push({ query, params });
          if (query.includes('INSERT OR IGNORE INTO payment_webhook_events')) {
            return { success: true, meta: { changes: webhookInsertChanges } };
          }
          if (query.includes("UPDATE payment_webhook_events") && query.includes("status = 'received'")) {
            return { success: true, meta: { changes: webhookClaimChanges } };
          }
          if (query.includes('INSERT OR IGNORE INTO payment_attempts')) {
            return { success: true, meta: { changes: attemptInsertChanges } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      }),
    });

    app.route('/payments', paymentRoutes);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const postPromptPay = (body: Record<string, unknown>) => app.request(createMockRequest(
    'http://localhost/payments/charges',
    {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ), undefined, env);

  it('requires authentication to create a PromptPay charge', async () => {
    const response = await app.request(createMockRequest('http://localhost/payments/charges', {
      method: 'POST',
      body: JSON.stringify({ bookingId, method: 'promptpay' }),
    }), undefined, env);

    expect(response.status).toBe(401);
  });

  it('creates PromptPay using the owned confirmed booking amount converted once to satang', async () => {
    const omiseFetch = vi.fn().mockResolvedValueOnce(jsonResponse(pendingCharge));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });
    const payload = await response.json() as any;

    expect(response.status).toBe(201);
    expect(payload.data).toEqual({
      contractVersion: 'tirak-payments-v1',
      chargeId: 'chrg_promptpay_1',
      qrCodeUrl: 'https://example.test/promptpay-qr.png',
      amountSatang: 100000,
      displayTotalThb: 1000,
      currency: 'THB',
      paymentStatus: 'pending',
      attemptStatus: 'pending',
    });
    expect(JSON.stringify(payload)).not.toContain('src_promptpay_1');

    expect(omiseFetch).toHaveBeenCalledTimes(1);
    const chargeBody = String((omiseFetch.mock.calls[0]?.[1] as RequestInit).body);
    expect(chargeBody).toContain('source%5Btype%5D=promptpay');
    expect(chargeBody).toContain('amount=100000');
    expect(chargeBody).not.toContain('10000000');
    expect((omiseFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'Idempotency-Key': expect.stringContaining(bookingId),
    });
  });

  it('rejects client-controlled amounts, currencies, card data, and non-booking purposes', async () => {
    const bodies = [
      { bookingId, amount: 1 },
      { bookingId, currency: 'USD' },
      { bookingId, cardNumber: '4111111111111111' },
      { bookingId, cvv: '123' },
      { bookingId, expiryMonth: 12, expiryYear: 2030 },
      { bookingId, purpose: 'subscription' },
      { bookingId, purpose: 'digital_unlock' },
      { bookingId, method: 'card' },
    ];

    for (const body of bodies) {
      const response = await postPromptPay({ method: 'promptpay', ...body });
      expect(response.status).toBe(400);
    }
  });

  it('does not mount legacy payment-method creation', async () => {
    const response = await app.request(createMockRequest('http://localhost/payments/payment-methods', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'card',
        details: { cardNumber: '4111111111111111', cvv: '123', expiryMonth: 12, expiryYear: 2030 },
      }),
    }), undefined, env);

    expect(response.status).toBe(404);
  });

  it('only creates charges for an owned booking whose persisted status is exactly confirmed', async () => {
    booking = { ...booking!, status: 'pending' };
    expect((await postPromptPay({ bookingId, method: 'promptpay' })).status).toBe(409);

    booking = { ...booking!, status: 'confirmed', currency: 'USD' };
    expect((await postPromptPay({ bookingId, method: 'promptpay' })).status).toBe(409);

    booking = null;
    expect((await postPromptPay({ bookingId, method: 'promptpay' })).status).toBe(404);
  });

  it('rejects an already-paid confirmed booking even when its legacy attempt row is absent', async () => {
    booking = { ...booking!, status: 'confirmed', payment_status: 'completed' };
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });

    expect(response.status).toBe(409);
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the server-side Omise secret is absent', async () => {
    delete env.OMISE_SECRET_KEY;
    const response = await postPromptPay({ bookingId, method: 'promptpay' });
    expect(response.status).toBe(503);
  });

  it('returns 503 for status and webhook routes when their required secrets are absent', async () => {
    delete env.OMISE_SECRET_KEY;
    const statusResponse = await app.request(createMockRequest(
      'http://localhost/payments/charges/chrg_promptpay_1',
      { headers: { Authorization: authHeader } },
    ), undefined, env);
    expect(statusResponse.status).toBe(503);

    env.OMISE_SECRET_KEY = 'skey_test_server_only';
    delete env.OMISE_WEBHOOK_SECRET;
    const webhookResponse = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body: '{}',
    }), undefined, env);
    expect(webhookResponse.status).toBe(503);
  });

  it('returns a persisted pending attempt on repeated create without another Omise charge', async () => {
    attempt = {
      id: 'attempt-1',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_existing',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: 'https://example.test/existing.png',
    };
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data.chargeId).toBe('chrg_existing');
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('does not repeat the provider POST while a claimed attempt is still creating', async () => {
    attempt = {
      id: 'attempt-creating',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: null,
      amount_satang: 100000,
      currency: 'THB',
      status: 'creating',
      qr_code_url: null,
    };
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });

    expect(response.status).toBe(409);
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('lets the D1 uniqueness claim stop racing requests from creating a second charge', async () => {
    const racedAttempt = {
      id: 'attempt-race-winner',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_race_winner',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: 'https://example.test/race-winner.png',
    };
    attemptReadSequence = [null, racedAttempt];
    attemptInsertChanges = 0;
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data.chargeId).toBe('chrg_race_winner');
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it.each(['failed', 'expired'] as const)('allows a new stable booking-bound attempt after %s', async (finalStatus) => {
    attempt = {
      id: `attempt-${finalStatus}`,
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: `chrg_${finalStatus}`,
      amount_satang: 100000,
      currency: 'THB',
      status: finalStatus,
      qr_code_url: null,
    };
    retryCount = 1;
    const omiseFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ ...pendingCharge, id: 'chrg_retry' }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay({ bookingId, method: 'promptpay' });

    expect(response.status).toBe(201);
    expect((omiseFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'Idempotency-Key': expect.stringContaining(`${bookingId}:2`),
    });
  });

  it('independently retrieves and reconciles Omise status for the booking owner', async () => {
    attempt = {
      id: 'attempt-1',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: 'https://example.test/promptpay-qr.png',
    };
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({ ...pendingCharge, status: 'successful', paid: true }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/chrg_promptpay_1',
      { headers: { Authorization: authHeader } },
    ), undefined, env);
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data.attemptStatus).toBe('successful');
    expect(payload.data.paymentStatus).toBe('paid');
    expect(omiseFetch).toHaveBeenCalledWith(
      expect.stringContaining('/charges/chrg_promptpay_1'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(statements.some(entry => entry.query.includes("payment_status = 'completed'"))).toBe(true);
  });

  it('does not expose status to a user who does not own the booking', async () => {
    attempt = null;
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/chrg_promptpay_1',
      { headers: { Authorization: authHeader } },
    ), undefined, env);

    expect(response.status).toBe(404);
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('validates the public raw-body webhook signature and ignores webhook-reported status', async () => {
    attempt = {
      id: 'attempt-1',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: null,
    };
    const body = JSON.stringify({
      id: 'evnt_1',
      key: 'charge.complete',
      data: { id: 'chrg_promptpay_1', status: 'successful', paid: true },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signWebhook(body, timestamp, env.OMISE_WEBHOOK_SECRET);
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({ ...pendingCharge, status: 'failed', paid: false }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Omise-Signature': `deadbeef, ${signature}`,
        'Omise-Signature-Timestamp': timestamp,
      },
    }), undefined, env);

    expect(response.status).toBe(200);
    expect(omiseFetch).toHaveBeenCalledTimes(1);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts') && entry.params.includes('failed')
    ))).toBe(true);
    expect(statements.some(entry => entry.query.includes("payment_status = 'completed'"))).toBe(false);
  });

  it('rejects stale/invalid signatures and safely acknowledges replay without retrieving a charge', async () => {
    const body = JSON.stringify({ id: 'evnt_2', data: { id: 'chrg_promptpay_1' } });
    const staleTimestamp = Math.floor((Date.now() - (6 * 60 * 1000)) / 1000).toString();
    const staleSignature = await signWebhook(body, staleTimestamp, env.OMISE_WEBHOOK_SECRET);
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const stale = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST', body,
      headers: { 'Omise-Signature': staleSignature, 'Omise-Signature-Timestamp': staleTimestamp },
    }), undefined, env);
    expect(stale.status).toBe(401);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const invalid = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST', body,
      headers: { 'Omise-Signature': '00, 11', 'Omise-Signature-Timestamp': timestamp },
    }), undefined, env);
    expect(invalid.status).toBe(401);

    webhookInsertChanges = 0;
    const validSignature = await signWebhook(body, timestamp, env.OMISE_WEBHOOK_SECRET);
    const replay = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST', body,
      headers: { 'Omise-Signature': validSignature, 'Omise-Signature-Timestamp': timestamp },
    }), undefined, env);
    expect(replay.status).toBe(200);
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('retries a previously failed authentic webhook instead of permanently acknowledging it', async () => {
    const body = JSON.stringify({ id: 'evnt_retry_failed', data: { id: 'chrg_promptpay_1' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signWebhook(body, timestamp, env.OMISE_WEBHOOK_SECRET);
    webhookInsertChanges = 0;
    webhookExisting = { replay_key: 'stored-replay-key', status: 'failed' };
    attempt = {
      id: 'attempt-webhook-retry',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: null,
    };
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse(pendingCharge));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Omise-Signature': signature,
        'Omise-Signature-Timestamp': timestamp,
      },
    }), undefined, env);

    expect(response.status).toBe(200);
    expect(omiseFetch).toHaveBeenCalledTimes(1);
    expect(statements.some(entry => (
      entry.query.includes("status = 'received'")
      && entry.params.includes('stored-replay-key')
    ))).toBe(true);
  });

  it('rejects signatures generated from the undecoded Base64 secret', async () => {
    const body = JSON.stringify({ id: 'evnt_raw_secret', data: { id: 'chrg_promptpay_1' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawSecretSignature = await signWebhookWithUndecodedSecret(
      body,
      timestamp,
      env.OMISE_WEBHOOK_SECRET,
    );

    const response = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Omise-Signature': rawSecretSignature,
        'Omise-Signature-Timestamp': timestamp,
      },
    }), undefined, env);

    expect(response.status).toBe(401);
  });

  it('rejects future, empty, and unequal-length signature candidates without throwing', async () => {
    const body = JSON.stringify({ id: 'evnt_malformed', data: { id: 'chrg_promptpay_1' } });
    const futureTimestamp = Math.floor((Date.now() + (6 * 60 * 1000)) / 1000).toString();
    const futureSignature = await signWebhook(body, futureTimestamp, env.OMISE_WEBHOOK_SECRET);

    const future = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Omise-Signature': futureSignature,
        'Omise-Signature-Timestamp': futureTimestamp,
      },
    }), undefined, env);
    expect(future.status).toBe(401);

    const now = Math.floor(Date.now() / 1000).toString();
    const malformed = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Omise-Signature': ' , 00, sha256=11',
        'Omise-Signature-Timestamp': now,
      },
    }), undefined, env);
    expect(malformed.status).toBe(401);

    const empty = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Omise-Signature': '',
        'Omise-Signature-Timestamp': now,
      },
    }), undefined, env);
    expect(empty.status).toBe(401);
  });

  it('keeps successful attempts final and failed attempts unpaid', async () => {
    attempt = {
      id: 'attempt-final',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'successful',
      qr_code_url: null,
    };
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({ ...pendingCharge, status: 'failed', paid: false }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/chrg_promptpay_1',
      { headers: { Authorization: authHeader } },
    ), undefined, env);
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data.attemptStatus).toBe('successful');
    expect(payload.data.paymentStatus).toBe('paid');
    expect(omiseFetch).toHaveBeenCalledTimes(1);
    expect(statements.some(entry => entry.query.includes('UPDATE payment_attempts'))).toBe(false);
  });

  it('fails closed when a locally successful attempt retrieves a mismatched amount', async () => {
    attempt = {
      id: 'attempt-final-mismatch',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'successful',
      qr_code_url: null,
    };
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({
      ...pendingCharge,
      amount: 99999,
      status: 'successful',
      paid: true,
    }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/chrg_promptpay_1',
      { headers: { Authorization: authHeader } },
    ), undefined, env);

    expect(response.status).toBe(502);
    expect(statements.some(entry => entry.query.includes('UPDATE payment_attempts'))).toBe(false);
  });

  it('persists ambiguous provider failures as indeterminate and blocks blind retry', async () => {
    const omiseFetch = vi.fn().mockRejectedValue(new TypeError('network connection reset'));
    vi.stubGlobal('fetch', omiseFetch);

    const firstResponse = await postPromptPay({ bookingId, method: 'promptpay' });

    expect(firstResponse.status).toBe(502);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts')
      && entry.query.includes('indeterminate_at')
      && entry.params.includes('indeterminate')
    ))).toBe(true);

    attempt = {
      id: 'attempt-indeterminate',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: null,
      amount_satang: 100000,
      currency: 'THB',
      status: 'indeterminate',
      qr_code_url: null,
    };
    omiseFetch.mockClear();

    const retryResponse = await postPromptPay({ bookingId, method: 'promptpay' });

    expect(retryResponse.status).toBe(409);
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('treats provider 5xx as indeterminate but a definite 4xx as retryable failure', async () => {
    const serverErrorFetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'upstream unavailable' }, 500));
    vi.stubGlobal('fetch', serverErrorFetch);

    expect((await postPromptPay({ bookingId, method: 'promptpay' })).status).toBe(502);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts') && entry.params.includes('indeterminate')
    ))).toBe(true);

    statements = [];
    attempt = null;
    const clientErrorFetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'request rejected' }, 400));
    vi.stubGlobal('fetch', clientErrorFetch);

    expect((await postPromptPay({ bookingId, method: 'promptpay' })).status).toBe(502);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts') && entry.params.includes('failed')
    ))).toBe(true);
    expect(statements.some(entry => entry.params.includes('indeterminate'))).toBe(false);
  });

  it('recovers an indeterminate attempt only from a booking-bound Omise charge', async () => {
    attempt = {
      id: 'attempt-indeterminate',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: null,
      amount_satang: 100000,
      currency: 'THB',
      status: 'indeterminate',
      qr_code_url: null,
    };
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({
      ...pendingCharge,
      id: 'chrg_recovered_1',
      metadata: { booking_id: bookingId },
    }));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/recover',
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, chargeId: 'chrg_recovered_1' }),
      },
    ), undefined, env);
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      contractVersion: 'tirak-payments-v1',
      chargeId: 'chrg_recovered_1',
      amountSatang: 100000,
      displayTotalThb: 1000,
      currency: 'THB',
      paymentStatus: 'pending',
      attemptStatus: 'pending',
    });
    expect(omiseFetch).toHaveBeenCalledTimes(1);
    expect(omiseFetch).toHaveBeenCalledWith(
      expect.stringContaining('/charges/chrg_recovered_1'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts')
      && entry.query.includes('provider_charge_id')
      && entry.params.includes('chrg_recovered_1')
    ))).toBe(true);
  });

  it('refuses to bind an indeterminate attempt to a charge with different booking metadata', async () => {
    attempt = {
      id: 'attempt-indeterminate',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: null,
      amount_satang: 100000,
      currency: 'THB',
      status: 'indeterminate',
      qr_code_url: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...pendingCharge,
      id: 'chrg_unrelated_1',
      metadata: { booking_id: 'another-booking' },
    })));

    const response = await app.request(createMockRequest(
      'http://localhost/payments/charges/recover',
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, chargeId: 'chrg_unrelated_1' }),
      },
    ), undefined, env);

    expect(response.status).toBe(409);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts') && entry.query.includes('provider_charge_id')
    ))).toBe(false);
  });
});
