import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { supplierOnboardingRoutes } from '@/routes/supplierOnboarding';
import { adminSupplierOnboardingRoutes } from '@/routes/admin/supplierOnboarding';
import { createTestEnv } from '@tests/setup';
import { normalizeEmail, computeIdempotencyKeyHash, computePayloadDigest, deriveStatusToken, generateStatusToken, hashStatusToken, validateApplicationData, ApplicationDataValidationError } from '@/utils/supplier-onboarding';

const FULL_WEEK_SCHEDULE = {
  timeZone: 'Asia/Bangkok' as const,
  days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
    isAvailable: dayOfWeek > 0 && dayOfWeek < 6,
  })),
};

// ---------------------------------------------------------------------------
// Unit tests for helper utilities
// ---------------------------------------------------------------------------
describe('supplier-onboarding helpers', () => {
  it('normalizeEmail lowercases and trims', () => {
    expect(normalizeEmail('  Test@Example.COM  ')).toBe('test@example.com');
    expect(normalizeEmail('user@domain.org')).toBe('user@domain.org');
  });

  it('computeIdempotencyKeyHash is deterministic for same key', async () => {
    const h1 = await computeIdempotencyKeyHash('key-1');
    const h2 = await computeIdempotencyKeyHash('key-1');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeIdempotencyKeyHash differs for different keys', async () => {
    const h1 = await computeIdempotencyKeyHash('key-1');
    const h2 = await computeIdempotencyKeyHash('key-2');
    expect(h1).not.toBe(h2);
  });

  it('computePayloadDigest is deterministic for same payload regardless of key order', async () => {
    const d1 = await computePayloadDigest({ a: 1, b: { z: 3, y: 2 } });
    const d2 = await computePayloadDigest({ b: { y: 2, z: 3 }, a: 1 });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computePayloadDigest differs for different payloads', async () => {
    const d1 = await computePayloadDigest({ a: 1 });
    const d2 = await computePayloadDigest({ a: 2 });
    expect(d1).not.toBe(d2);
  });

  it('deriveStatusToken is deterministic for same inputs', async () => {
    const t1 = await deriveStatusToken('secret', 'app-1', 'key-1');
    const t2 = await deriveStatusToken('secret', 'app-1', 'key-1');
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deriveStatusToken differs for different inputs', async () => {
    const t1 = await deriveStatusToken('secret', 'app-1', 'key-1');
    const t2 = await deriveStatusToken('secret', 'app-1', 'key-2');
    expect(t1).not.toBe(t2);
  });

  it('generateStatusToken returns 96-char hex string', () => {
    const token = generateStatusToken();
    expect(token).toMatch(/^[0-9a-f]{96}$/);
  });

  it('hashStatusToken returns deterministic 64-char hex', async () => {
    const hash1 = await hashStatusToken('test-token');
    const hash2 = await hashStatusToken('test-token');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashStatusToken differs for different tokens', async () => {
    const hash1 = await hashStatusToken('token-a');
    const hash2 = await hashStatusToken('token-b');
    expect(hash1).not.toBe(hash2);
  });
});

describe('validateApplicationData', () => {
  it('returns null for null/undefined input', () => {
    expect(validateApplicationData(null)).toBeNull();
    expect(validateApplicationData(undefined)).toBeNull();
  });

  it('accepts valid minimal application data', () => {
    const result = validateApplicationData({ firstName: 'John' });
    expect(result).toEqual({ firstName: 'John' });
  });

  it('accepts full application data with all fields', () => {
    const input = {
      firstName: 'John',
      lastName: 'Doe',
      bio: 'Experienced guide',
      location: 'Bangkok',
      languages: ['en', 'th'],
      interests: ['food', 'culture'],
      serviceDrafts: [{ title: 'City Walk', description: 'A walk', price: 500, currency: 'THB', durationMinutes: 90 }],
      schedule: FULL_WEEK_SCHEDULE,
    };
    const result = validateApplicationData(input);
    expect(result).toMatchObject(input);
  });

  it('accepts durationMinutes at the booking-aligned boundaries 30 and 1439', () => {
    const result = validateApplicationData({
      serviceDrafts: [
        { title: 'Short Walk', price: 500, currency: 'THB', durationMinutes: 30 },
        { title: 'Long Day Tour', price: 2500, currency: 'THB', durationMinutes: 1439 },
      ],
    });
    expect(result?.serviceDrafts?.[0].durationMinutes).toBe(30);
    expect(result?.serviceDrafts?.[1].durationMinutes).toBe(1439);
  });

  it('rejects non-object applicationData', () => {
    expect(() => validateApplicationData('string')).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData([1, 2])).toThrow(ApplicationDataValidationError);
  });

  it('rejects empty string fields', () => {
    expect(() => validateApplicationData({ firstName: '' })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({ firstName: '   ' })).toThrow(ApplicationDataValidationError);
  });

  it('rejects local file URIs in string fields', () => {
    expect(() => validateApplicationData({ bio: 'file:///etc/passwd' })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({ location: 'data:text/html,<script>' })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({ firstName: 'javascript:alert(1)' })).toThrow(ApplicationDataValidationError);
  });

  it('rejects file URIs in array fields', () => {
    expect(() => validateApplicationData({ interests: ['file:///local'] })).toThrow(ApplicationDataValidationError);
  });

  it('rejects unsupported language codes', () => {
    expect(() => validateApplicationData({ languages: ['xx'] })).toThrow(ApplicationDataValidationError);
  });

  it('rejects service drafts exceeding maximum', () => {
    const drafts = Array.from({ length: 11 }, (_, i) => ({ title: `Draft ${i}`, price: 100, currency: 'THB', durationMinutes: 60 }));
    expect(() => validateApplicationData({ serviceDrafts: drafts })).toThrow(ApplicationDataValidationError);
  });

  it('rejects schedule.days exceeding 7', () => {
    const days = Array.from({ length: 8 }, (_, i) => ({
      dayOfWeek: i % 7, startTime: '09:00', endTime: '17:00', isAvailable: true,
    }));
    expect(() => validateApplicationData({ schedule: { timeZone: 'Asia/Bangkok', days } })).toThrow(ApplicationDataValidationError);
  });

  it('rejects schedule.days shorter than seven explicit entries', () => {
    const days = FULL_WEEK_SCHEDULE.days.slice(0, 6);
    expect(() => validateApplicationData({ schedule: { timeZone: 'Asia/Bangkok', days } })).toThrow(
      /exactly 7 entries covering days 0-6/,
    );
  });

  it('rejects schedule.days missing a weekday even when length is seven', () => {
    const days = [
      ...FULL_WEEK_SCHEDULE.days.filter((day) => day.dayOfWeek !== 6),
      { dayOfWeek: 7, startTime: '09:00', endTime: '17:00', isAvailable: false },
    ];
    expect(() => validateApplicationData({ schedule: { timeZone: 'Asia/Bangkok', days } })).toThrow(ApplicationDataValidationError);
  });

  it('rejects unknown top-level keys in applicationData', () => {
    expect(() => validateApplicationData({ firstName: 'X', hackerField: 'bad' })).toThrow(ApplicationDataValidationError);
  });

  it('rejects non-THB currency in serviceDrafts', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: 100, currency: 'USD', durationMinutes: 60 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects missing currency in serviceDrafts', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: 100, durationMinutes: 60 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects non-Asia/Bangkok timezone', () => {
    expect(() => validateApplicationData({
      schedule: { timeZone: 'UTC', days: FULL_WEEK_SCHEDULE.days },
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects duplicate dayOfWeek', () => {
    expect(() => validateApplicationData({
      schedule: {
        timeZone: 'Asia/Bangkok',
        days: [
          { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', isAvailable: false },
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 1, startTime: '18:00', endTime: '20:00', isAvailable: true },
          { dayOfWeek: 3, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 4, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 5, startTime: '09:00', endTime: '17:00', isAvailable: true },
          { dayOfWeek: 6, startTime: '09:00', endTime: '17:00', isAvailable: false },
        ],
      },
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects non-finite price', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: Infinity, currency: 'THB', durationMinutes: 60 }],
    })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: NaN, currency: 'THB', durationMinutes: 60 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects non-integer durationMinutes', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: 100, currency: 'THB', durationMinutes: 60.5 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects invalid dayOfWeek', () => {
    expect(() => validateApplicationData({
      schedule: {
        timeZone: 'Asia/Bangkok',
        days: [
          ...FULL_WEEK_SCHEDULE.days.slice(0, 6),
          { dayOfWeek: 7, startTime: '09:00', endTime: '17:00', isAvailable: true },
        ],
      },
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects negative price or too-short duration', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: -1, currency: 'THB', durationMinutes: 60 }],
    })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: 100, currency: 'THB', durationMinutes: 29 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects overnight durationMinutes boundary at 1440', () => {
    expect(() => validateApplicationData({
      serviceDrafts: [{ title: 'X', price: 100, currency: 'THB', durationMinutes: 1440 }],
    })).toThrow(ApplicationDataValidationError);
  });

  it('rejects array fields that are not arrays', () => {
    expect(() => validateApplicationData({ languages: 'en' })).toThrow(ApplicationDataValidationError);
    expect(() => validateApplicationData({ interests: 'food' })).toThrow(ApplicationDataValidationError);
  });
});

// ---------------------------------------------------------------------------
// Route tests — supplier intake
// ---------------------------------------------------------------------------
describe('Core supplier onboarding intake', () => {
  let app: Hono;
  let testEnv: ReturnType<typeof createTestEnv>;
  let lastInsert: { query: string; params: unknown[] } | null;
  let selectResults: unknown[];

  const validPayload = {
    businessName: 'Siam Wellness Co.',
    contactName: 'Chanida Wongsa',
    email: 'chanida@example.com',
    phone: '+66957890123',
    location: 'Bangkok',
    bio: 'Spa and massage studio',
    brochureUrls: ['https://example.com/brochure.pdf'],
    categories: [
      { name: 'Traditional Thai Massage', memberCount: 4 },
    ],
    mode: 'tirak',
  };

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    lastInsert = null;
    selectResults = [];

    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          lastInsert = { query, params };
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => selectResults.shift() ?? null,
        all: async () => ({ results: [] }),
      }),
    });
    app.route('/supplier-onboarding', supplierOnboardingRoutes);
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return app.request(
      '/supplier-onboarding',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      testEnv,
    );
  }

  it('accepts a valid application and returns applicationId + statusToken', async () => {
    const res = await post(validPayload);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.applicationId).toBe('string');
    expect(typeof body.data.statusToken).toBe('string');
    expect(body.data.statusToken).toMatch(/^[0-9a-f]{96}$/);
  });

  it('normalizes email to lowercase', async () => {
    await post({ ...validPayload, email: '  Chanida@EXAMPLE.COM  ' });
    expect(lastInsert).not.toBeNull();
    expect(lastInsert!.params).toContain('chanida@example.com');
  });

  it('persists status_token_hash but not the raw token', async () => {
    await post(validPayload);
    expect(lastInsert).not.toBeNull();
    expect(lastInsert!.query).toContain('status_token_hash');
    expect(lastInsert!.query).toContain('idempotency_key_hash');
  });

  it('forces mode to tirak regardless of input', async () => {
    await post({ ...validPayload, mode: 'tirakplus' });
    expect(lastInsert).not.toBeNull();
    expect(lastInsert!.query).toContain('tirak');
  });

  it('stores applicationData JSON when provided', async () => {
    const appData = { firstName: 'Chanida', lastName: 'Wongsa', languages: ['en', 'th'] };
    await post({ ...validPayload, applicationData: appData });
    expect(lastInsert).not.toBeNull();
    const appDataParam = lastInsert!.params.find((p) => typeof p === 'string' && (p as string).includes('"firstName"'));
    expect(appDataParam).toBeDefined();
    expect(JSON.parse(appDataParam as string)).toMatchObject(appData);
  });

  it('rejects invalid applicationData with 400', async () => {
    const res = await post({ ...validPayload, applicationData: { bio: 'file:///etc/passwd' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_APPLICATION_DATA');
  });

  it('rejects missing required fields with 400', async () => {
    const res = await post({ ...validPayload, businessName: '' });
    expect(res.status).toBe(400);
  });

  describe('Idempotency-Key', () => {
    it('rejects non-UUID Idempotency-Key with 400', async () => {
      const res = await post(validPayload, { 'Idempotency-Key': 'not-a-uuid' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('accepts valid UUID Idempotency-Key', async () => {
      const res = await post(validPayload, { 'Idempotency-Key': crypto.randomUUID() });
      expect(res.status).toBe(201);
    });

    it('returns same applicationId on replay with same Idempotency-Key + same payload', async () => {
      const key = crypto.randomUUID();
      const res1 = await post(validPayload, { 'Idempotency-Key': key });
      expect(res1.status).toBe(201);
      const body1 = await res1.json();
      const appId1 = body1.data.applicationId;

      // Second call: DB returns existing application with matching payload_digest
      // The idempotency check query uses idempotency_key_hash
      selectResults = [{ id: appId1, status_token_hash: null, payload_digest: null }];
      testEnv.DB.prepare = (query: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => selectResults.shift() ?? null,
          all: async () => ({ results: [] }),
        }),
      });

      const res2 = await post(validPayload, { 'Idempotency-Key': key });
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.data.applicationId).toBe(appId1);
      // status is 'pending' on replay; message contains "replay"
      expect(body2.data.status).toBe('pending');
    });

    it('works without Idempotency-Key for legacy clients', async () => {
      const res = await post(validPayload);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(typeof body.data.applicationId).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// GET /:id/status tests
// ---------------------------------------------------------------------------
describe('Core supplier onboarding status', () => {
  let app: Hono;
  let testEnv: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    app.route('/supplier-onboarding', supplierOnboardingRoutes);
  });

  it('returns 404 when no Authorization header', async () => {
    const res = await app.request('/supplier-onboarding/some-id/status', {}, testEnv);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns 404 when Authorization is not Bearer', async () => {
    const res = await app.request('/supplier-onboarding/some-id/status', {
      headers: { Authorization: 'Basic abc' },
    }, testEnv);
    expect(res.status).toBe(404);
  });

  it('returns 404 when token does not match stored hash', async () => {
    testEnv.DB.prepare = () => ({
      bind: () => ({ first: async () => null }),
    });
    const res = await app.request('/supplier-onboarding/some-id/status', {
      headers: { Authorization: 'Bearer wrong-token-here' },
    }, testEnv);
    expect(res.status).toBe(404);
  });

  it('returns application status when token matches', async () => {
    const token = generateStatusToken();
    const tokenHash = await hashStatusToken(token);
    testEnv.DB.prepare = () => ({
      bind: () => ({
        first: async () => ({
          id: 'app-1', status: 'pending', status_token_hash: tokenHash,
          created_at: new Date().toISOString(), reviewed_at: null, rejection_reason: null,
        }),
      }),
    });
    const res = await app.request('/supplier-onboarding/app-1/status', {
      headers: { Authorization: `Bearer ${token}` },
    }, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.applicationId).toBe('app-1');
    expect(body.data.status).toBe('pending');
    expect(body.data.blockers).toBeDefined();
    expect(body.data.blockers.account).toBe('application_pending');
  });

  it('returns uniform 404 for wrong token hash', async () => {
    const token = generateStatusToken();
    testEnv.DB.prepare = () => ({
      bind: () => ({
        first: async () => ({
          id: 'app-1', status: 'pending', status_token_hash: 'different-hash',
          created_at: new Date().toISOString(), reviewed_at: null, rejection_reason: null,
        }),
      }),
    });
    const res = await app.request('/supplier-onboarding/app-1/status', {
      headers: { Authorization: `Bearer ${token}` },
    }, testEnv);
    expect(res.status).toBe(404);
  });

  it('does not expose credentials in status response', async () => {
    const token = generateStatusToken();
    const tokenHash = await hashStatusToken(token);
    testEnv.DB.prepare = () => ({
      bind: () => ({
        first: async () => ({
          id: 'app-1', status: 'approved', status_token_hash: tokenHash,
          created_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), rejection_reason: null,
        }),
      }),
    });
    const res = await app.request('/supplier-onboarding/app-1/status', {
      headers: { Authorization: `Bearer ${token}` },
    }, testEnv);
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('password');
    expect(bodyStr).not.toContain('token');
    expect(bodyStr).not.toContain('email');
  });

  it('returns not_provisioned publication contract when approved application has no provisioned user', async () => {
    const token = generateStatusToken();
    const tokenHash = await hashStatusToken(token);
    testEnv.DB.prepare = (query: string) => ({
      bind: () => ({
        first: async () => {
          if (query.includes('FROM supplier_onboarding_applications') && query.includes('application_data')) {
            return {
              id: 'app-1',
              status: 'approved',
              status_token_hash: tokenHash,
              approved_user_id: 'supplier-1',
              created_at: new Date().toISOString(),
              reviewed_at: new Date().toISOString(),
              rejection_reason: null,
              application_data: '{}',
            };
          }
          if (query.includes('SELECT status FROM users')) {
            return null;
          }
          if (query.includes('SELECT verification_status, subscription_expires_at FROM supplier_profiles')) {
            return null;
          }
          if (query.includes('SELECT invitation_delivery_status')) {
            return { invitation_delivery_status: 'pending' };
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    });

    const res = await app.request('/supplier-onboarding/app-1/status', {
      headers: { Authorization: `Bearer ${token}` },
    }, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.accountStatus).toBe('not_provisioned');
    expect(body.data.profileStatus).toBe('none');
    expect(body.data.publicationStatus).toBe('blocked');
    expect(body.data.blockers.account).toBe('account_not_provisioned');
    expect(body.data.blockers.profile).toBe('profile_not_provisioned');
    expect(body.data.paymentStatus).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Admin approval tests
// ---------------------------------------------------------------------------
describe('Core admin approval', () => {
  let app: Hono;
  let testEnv: ReturnType<typeof createTestEnv>;
  let executed: Array<{ query: string; params: unknown[] }>;
  let kvPuts: Array<{ key: string; value: string }>;

  const pendingApplication = {
    id: 'app-1',
    email: 'guide@example.com',
    email_normalized: 'guide@example.com',
    business_name: 'Test Guide Co.',
    contact_name: 'Test Guide',
    phone: '+66957890123',
    mode: 'tirak',
    status: 'pending',
    approved_user_id: null,
    application_data: '{}',
  };

  afterEach(() => vi.unstubAllGlobals());

  /** Default mock: email collision check returns null (no existing user). */
  function defaultMock() {
    executed = [];
    kvPuts = [];
    testEnv = createTestEnv();
    let firstCallForApp = true;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { executed.push({ query, params }); return { success: true, meta: { changes: 1 } }; },
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return null;
          if (query.includes('LOWER(TRIM(email))')) return null;
          if (query.includes('WHERE id = ?') && !query.includes('core_qa') && !query.includes('invitation_delivery')) {
            if (firstCallForApp) { firstCallForApp = false; return { ...pendingApplication }; }
            return null;
          }
          return null;
        },
        all: async () => {
          // Return evidence kinds for the evidence prereq check
          if (query.includes('supplier_onboarding_evidence')) {
            return { results: [{ kind: 'id_front' }, { kind: 'id_back' }, { kind: 'selfie' }] };
          }
          return { results: [] };
        },
      }),
    });
    // Support batch
    testEnv.DB.batch = async (statements: any[]) => {
      const results: any[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    };
    testEnv.CACHE = {
      get: async () => null,
      put: async (key: string, value: string) => { kvPuts.push({ key, value }); },
      delete: async () => undefined,
    };
    testEnv.EMAIL_PROVIDER = 'resend';
    testEnv.RESEND_API_KEY = 'test-resend-key';
    testEnv.EMAIL_FROM = 'noreply@example.test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }),
    ));

    app = new Hono();
    app.use('*', async (c, next) => { c.set('userId', 'admin-1'); await next(); });
    app.route('/supplier-onboarding', adminSupplierOnboardingRoutes);
  }

  beforeEach(() => defaultMock());

  function post(path: string, body?: Record<string, unknown>) {
    return app.request(
      `/supplier-onboarding${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      testEnv,
    );
  }

  it('approves and provisions supplier', async () => {
    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.applicationId).toBe('app-1');
    expect(typeof body.data.userId).toBe('string');
    expect(body.data.email).toBe('guide@example.com');
    expect(body.data.invitationDelivery).toBeDefined();
  });

  it('never exposes plaintext tempPassword in response', async () => {
    const res = await post('/app-1/approve');
    const body = await res.json();
    expect(body.data.tempPassword).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/tempPassword/);
  });

  it('sets approved_user_id to created supplier and reviewed_user_id to admin', async () => {
    await post('/app-1/approve');
    // The CAS UPDATE in the batch sets approved_user_id and reviewed_user_id
    const update = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'approved'"),
    );
    expect(update).toBeDefined();
    // params: [userId, adminUserId, now, applicationId]
    expect(typeof update!.params[0]).toBe('string'); // approved_user_id = userId
    expect(update!.params[1]).toBe('admin-1');        // reviewed_user_id = admin
  });

  it('returns 409 when email already belongs to an existing supplier', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { executed.push({ query, params }); return { success: true }; },
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return { id: 'existing-user', user_type: 'supplier' };
          if (query.includes('LOWER(TRIM(email))')) return { id: 'existing-user' };
          if (query.includes('WHERE id = ?') && !query.includes('core_qa') && !query.includes('invitation_delivery')) return { ...pendingApplication };
          return null;
        },
        all: async () => {
          if (query.includes('supplier_onboarding_evidence')) {
            return { results: [{ kind: 'id_front' }, { kind: 'id_back' }, { kind: 'selfie' }] };
          }
          return { results: [] };
        },
      }),
    });
    testEnv.DB.batch = async (statements: any[]) => {
      const results: any[] = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('IDENTITY_CONFLICT');
  });

  it('does not mutate existing supplier account on email collision', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { executed.push({ query, params }); return { success: true }; },
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return { id: 'existing-user', user_type: 'supplier' };
          if (query.includes('LOWER(TRIM(email))')) return { id: 'existing-user' };
          return { ...pendingApplication };
        },
        all: async () => {
          if (query.includes('supplier_onboarding_evidence')) {
            return { results: [{ kind: 'id_front' }, { kind: 'id_back' }, { kind: 'selfie' }] };
          }
          return { results: [] };
        },
      }),
    });
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    expect(executed.find((e) => e.query.includes('INSERT INTO users'))).toBeUndefined();
  });

  it('returns 409 ALREADY_REVIEWED for non-pending application', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: () => ({ first: async () => ({ ...pendingApplication, status: 'approved' }) }),
    });
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
  });

  it('returns 404 when application missing', async () => {
    testEnv.DB.prepare = () => ({ bind: () => ({ first: async () => null }) });
    const res = await post('/nope/approve');
    expect(res.status).toBe(404);
  });

  it('returns 409 ALREADY_REVIEWED on idempotent retry (already approved)', async () => {
    testEnv.DB.prepare = () => ({
      bind: () => ({ first: async () => ({ ...pendingApplication, status: 'approved', approved_user_id: 'supplier-guid-123' }) }),
    });
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
  });

  it('stores KV reset token with 24-hour expiry', async () => {
    await post('/app-1/approve');
    expect(kvPuts.some((p) => p.key.startsWith('reset:'))).toBe(true);
    const invitePayload = JSON.parse(kvPuts.find((p) => p.key.startsWith('reset:'))!.value);
    expect(invitePayload.purpose).toBe('supplier-onboarding');
    expect(Date.parse(invitePayload.expiresAt)).toBeGreaterThan(Date.now() + 86300_000);
  });

  it('does not fail approval when KV storage fails', async () => {
    testEnv.CACHE = { get: async () => null, put: async () => { throw new Error('KV unavailable'); }, delete: async () => undefined };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    expect((await res.json()).data.invitationDelivery.status).toBe('failed');
  });

  it('does not fail approval when email send fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    expect((await res.json()).data.emailSent).toBe(false);
  });

  it('creates supplier profile with pending verification and active trial', async () => {
    await post('/app-1/approve');
    const profileInsert = executed.find((e) => e.query.includes('INSERT INTO supplier_profiles'));
    expect(profileInsert).toBeDefined();
    // Profile is created via INSERT ... SELECT with 'pending', 'active', 'basic'
    expect(profileInsert!.query).toContain("'pending'");
    expect(profileInsert!.query).toContain("'active'");
    expect(profileInsert!.query).toContain("'basic'");
  });

  it('creates user with pending supplier status', async () => {
    await post('/app-1/approve');
    const userInsert = executed.find((e) => e.query.includes('INSERT INTO users'));
    expect(userInsert).toBeDefined();
    // User is created via INSERT ... SELECT with 'supplier' and 'pending'
    expect(userInsert!.query).toContain("'supplier'");
    expect(userInsert!.query).toContain("'pending'");
  });

  it('reject preserves reviewed_user_id but never writes admin into guide link', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { executed.push({ query, params }); return { success: true, meta: { changes: 1 } }; },
        first: async () => (query.includes('SELECT id, status') ? { id: 'app-1', status: 'pending', mode: 'tirak' } : null),
        all: async () => ({ results: [] }),
      }),
    });
    const res = await post('/app-1/reject', { reason: 'Incomplete documentation' });
    expect(res.status).toBe(200);
    const update = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'rejected'"),
    );
    expect(update).toBeDefined();
    expect(update!.params[2]).toBe('admin-1'); // reviewed_user_id = admin
    expect(update!.params[1]).toBe('Incomplete documentation');
    expect(update!.query).toContain("status = 'pending'");
    expect(update!.query).toContain('approved_user_id IS NULL');
    // approved_user_id is only part of the CAS guard, never assigned in SET
    expect(update!.query).not.toMatch(/SET[\s\S]*approved_user_id\s*=/i);
  });

  it('reject returns 409 ALREADY_REVIEWED for non-pending', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          return { success: true, meta: { changes: 0 } };
        },
        first: async () => {
          if (query.includes('SELECT id, status, approved_user_id')) {
            return {
              id: 'app-1',
              status: 'rejected',
              approved_user_id: null,
              reviewed_user_id: 'admin-1',
              invitation_delivery_status: null,
            };
          }
          if (query.includes('SELECT id, status, mode')) {
            return { id: 'app-1', status: 'rejected', mode: 'tirak' };
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    });
    const res = await post('/app-1/reject', { reason: 'Already done' });
    expect(res.status).toBe(409);
  });

  it('reject returns approval winner details when the CAS loses to a concurrent approval', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          return { success: true, meta: { changes: 0 } };
        },
        first: async () => {
          if (query.includes('SELECT id, status, approved_user_id')) {
            return {
              id: 'app-1',
              status: 'approved',
              approved_user_id: 'supplier-guid-123',
              reviewed_user_id: 'admin-2',
              invitation_delivery_status: 'pending',
            };
          }
          if (query.includes('SELECT id, status, mode')) {
            return { id: 'app-1', status: 'pending', mode: 'tirak' };
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    });

    const res = await post('/app-1/reject', { reason: 'Already approved elsewhere' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ALREADY_REVIEWED');
    expect(body.data.approvedUserId).toBe('supplier-guid-123');
    expect(body.data.reviewedUserId).toBe('admin-2');
    expect(body.data.status).toBe('approved');
  });

  it('handles concurrent approval gracefully (CAS loser returns winning state)', async () => {
    // Simulate: batch fails with UNIQUE constraint on user insert
    testEnv.DB.batch = async (_statements: any[]) => {
      throw new Error('UNIQUE constraint failed: users.email');
    };
    // After batch failure, reads actual winning state
    let readAfterRace = false;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => {
          if (query.includes('LOWER(TRIM(email))')) return null;
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return null;
          if (query.includes('WHERE id = ?') && !query.includes('core_qa')) {
            if (!readAfterRace) { readAfterRace = true; return { ...pendingApplication }; }
            return { approved_user_id: 'supplier-guid-123', reviewed_user_id: 'admin-2', status: 'approved' };
          }
          return null;
        },
        all: async () => {
          // Return evidence kinds for the evidence prereq check
          if (query.includes('supplier_onboarding_evidence')) {
            return { results: [{ kind: 'id_front' }, { kind: 'id_back' }, { kind: 'selfie' }] };
          }
          return { results: [] };
        },
      }),
    });

    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.userId).toBe('supplier-guid-123');
    expect(body.data.raceRecovery).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin list with reviewed_user_id
// ---------------------------------------------------------------------------
describe('Admin list/detail includes reviewed_user_id', () => {
  it('returns reviewedUserId in list', async () => {
    const adminApp = new Hono();
    const env = createTestEnv();
    env.DB.prepare = () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => ({ total: 1 }),
        all: async () => ({
          results: [{
            id: 'app-1', business_name: 'Test', contact_name: 'Contact',
            email: 'test@example.com', phone: '1234567890', location: 'Bangkok',
            bio: null, brochure_urls: '[]', categories: '[]', mode: 'tirak',
            status: 'pending', created_at: '2026-10-01',
            reviewed_at: null, rejection_reason: null,
            approved_user_id: null, reviewed_user_id: 'admin-2',
          }],
        }),
      }),
    });
    adminApp.route('/supplier-onboarding', adminSupplierOnboardingRoutes);
    const res = await adminApp.request('/supplier-onboarding?page=1&limit=20', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items[0]).toHaveProperty('reviewedUserId');
    expect(body.data.items[0].reviewedUserId).toBe('admin-2');
  });
});
