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

const disabledOverride = JSON.stringify({
  paymentMode: 'disabled',
  promptPayEnabled: false,
  operator: 'human release owner',
  reason: 'maintenance window: close creation',
  approvedAt: '2026-07-24T00:00:00.000Z',
  previousMode: 'test',
  previousPromptPayEnabled: true,
});

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

describe('T-033 payment kill-switch routes', () => {
  let app: Hono;
  let env: any;
  let authHeader: string;
  let booking: Row | null;
  let attempt: Row | null;
  let retryCount: number;
  let kvStore: string | null;
  let kvThrows: boolean;
  let statements: Array<{ query: string; params: unknown[] }>;

  beforeEach(async () => {
    app = new Hono();
    env = createTestEnv();
    env.OMISE_SECRET_KEY = 'skey_test_server_only';
    env.OMISE_WEBHOOK_SECRET = btoa('webhook_test_secret');
    kvStore = null;
    kvThrows = false;
    env.PAYMENT_CONFIG_KV = {
      get: async (_key: string) => {
        if (kvThrows) throw new Error('namespace unavailable');
        return kvStore;
      },
      put: async (_key: string, _value: string) => undefined,
      delete: async (_key: string) => undefined,
    };
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
          if (query.includes('FROM payment_attempts')) return attempt;
          if (query.includes('FROM payment_webhook_events')) return null;
          return null;
        },
        all: async () => {
          statements.push({ query, params });
          return { results: [] };
        },
        run: async () => {
          statements.push({ query, params });
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

  const postPromptPay = () => app.request(createMockRequest(
    'http://localhost/payments/charges',
    {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, method: 'promptpay' }),
    },
  ), undefined, env);

  it('refuses creation with 503 PAYMENT_CREATION_DISABLED when the static mode is disabled', async () => {
    env.PAYMENT_MODE = 'disabled';
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay();
    const payload = await response.json() as any;

    expect(response.status).toBe(503);
    expect(payload.error).toBe('PAYMENT_CREATION_DISABLED');
    expect(payload.message).toContain('payment_mode_disabled');
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('refuses creation when PROMPTPAY_ENABLED is false while settlement secrets remain', async () => {
    env.PROMPTPAY_ENABLED = 'false';
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay();
    const payload = await response.json() as any;

    expect(response.status).toBe(503);
    expect(payload.error).toBe('PAYMENT_CREATION_DISABLED');
    expect(payload.message).toContain('creation_disabled');
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['an invalid mode value', JSON.stringify({ paymentMode: 'sandbox' })],
    ['a non-boolean promptPayEnabled', JSON.stringify({ promptPayEnabled: 'yes' })],
  ])('fails closed with invalid_mode_override for %s', async (_name, stored) => {
    kvStore = stored;
    const omiseFetch = vi.fn();
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay();
    const payload = await response.json() as any;

    expect(response.status).toBe(503);
    expect(payload.error).toBe('PAYMENT_CREATION_DISABLED');
    expect(payload.message).toContain('invalid_mode_override');
    expect(omiseFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the bound override namespace cannot be read', async () => {
    kvThrows = true;
    const response = await postPromptPay();
    const payload = await response.json() as any;

    expect(response.status).toBe(503);
    expect(payload.message).toContain('invalid_mode_override');
  });

  it('closes creation under a disabled override but keeps webhook settlement available', async () => {
    kvStore = disabledOverride;

    const createResponse = await postPromptPay();
    expect(createResponse.status).toBe(503);
    expect(((await createResponse.json()) as any).error).toBe('PAYMENT_CREATION_DISABLED');

    attempt = {
      id: 'attempt-inflight',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: null,
    };
    const body = JSON.stringify({
      id: 'evnt_kill_switch',
      key: 'charge.complete',
      data: { id: 'chrg_promptpay_1', status: 'successful', paid: true },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signWebhook(body, timestamp, env.OMISE_WEBHOOK_SECRET);
    const omiseFetch = vi.fn().mockResolvedValue(jsonResponse({ ...pendingCharge, status: 'successful', paid: true }));
    vi.stubGlobal('fetch', omiseFetch);

    const webhook = await app.request(new Request('http://localhost/payments/webhooks/omise', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'Omise-Signature': signature,
        'Omise-Signature-Timestamp': timestamp,
      },
    }), undefined, env);

    expect(webhook.status).toBe(200);
    expect(omiseFetch).toHaveBeenCalledTimes(1);
    expect(statements.some(entry => (
      entry.query.includes('UPDATE payment_attempts') && entry.params.includes('successful')
    ))).toBe(true);
  });

  it('keeps the status route reconciling in-flight attempts while creation is disabled', async () => {
    kvStore = disabledOverride;
    attempt = {
      id: 'attempt-inflight',
      booking_id: bookingId,
      customer_id: userId,
      provider_charge_id: 'chrg_promptpay_1',
      amount_satang: 100000,
      currency: 'THB',
      status: 'pending',
      qr_code_url: null,
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
  });

  it('keeps the recover route binding indeterminate attempts while creation is disabled', async () => {
    kvStore = disabledOverride;
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

    expect(response.status).toBe(200);
    expect(((await response.json()) as any).data.chargeId).toBe('chrg_recovered_1');
  });

  it('lets an audited override reopen creation over a disabled static floor', async () => {
    env.PAYMENT_MODE = 'disabled';
    env.PROMPTPAY_ENABLED = 'false';
    kvStore = JSON.stringify({
      paymentMode: 'test',
      promptPayEnabled: true,
      operator: 'human release owner',
      reason: 'enable staging test charges',
      approvedAt: '2026-07-24T00:00:00.000Z',
      previousMode: 'disabled',
      previousPromptPayEnabled: false,
    });
    const omiseFetch = vi.fn().mockResolvedValueOnce(jsonResponse(pendingCharge));
    vi.stubGlobal('fetch', omiseFetch);

    const response = await postPromptPay();

    expect(response.status).toBe(201);
    expect(omiseFetch).toHaveBeenCalledTimes(1);
  });

  it('settles exactly one decision when a create races a toggle to disabled', async () => {
    // Request A passes the policy gate while creation is open; the operator
    // toggles the kill switch while A's provider call is still in flight.
    let resolveOmise: (value: Response) => void = () => undefined;
    const omiseFetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveOmise = resolve;
    }));
    vi.stubGlobal('fetch', omiseFetch);

    const inflight = postPromptPay();
    await vi.waitFor(() => expect(omiseFetch).toHaveBeenCalledTimes(1));

    kvStore = disabledOverride;
    const afterDisable = await postPromptPay();
    const afterDisablePayload = await afterDisable.json() as any;

    // No charge is created after the disable: exactly one provider call total.
    expect(afterDisable.status).toBe(503);
    expect(afterDisablePayload.error).toBe('PAYMENT_CREATION_DISABLED');
    expect(omiseFetch).toHaveBeenCalledTimes(1);

    // The attempt that was authorized before the disable keeps its ownership
    // and settles normally instead of being stranded.
    resolveOmise(jsonResponse(pendingCharge));
    const inflightResponse = await inflight;
    const inflightPayload = await inflightResponse.json() as any;

    expect(inflightResponse.status).toBe(201);
    expect(inflightPayload.data.chargeId).toBe('chrg_promptpay_1');
    expect(omiseFetch).toHaveBeenCalledTimes(1);
  });
});
