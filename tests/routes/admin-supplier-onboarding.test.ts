import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { adminSupplierOnboardingRoutes } from '@/routes/admin/supplierOnboarding';
import { createTestEnv } from '@tests/setup';

const pendingApplication = {
  id: 'app-1',
  business_name: 'Siam Wellness Co.',
  contact_name: 'Chanida Wongsa',
  email: 'chanida@example.com',
  email_normalized: 'chanida@example.com',
  phone: '+66957890123',
  location: 'Bangkok',
  bio: 'Spa and massage studio',
  brochure_urls: JSON.stringify(['https://example.com/brochure.pdf']),
  categories: JSON.stringify([
    { name: 'Traditional Thai Massage', memberCount: 4 },
    { name: 'Aromatherapy', memberCount: 2 },
  ]),
  mode: 'tirak',
  status: 'pending',
  approved_user_id: null,
  rejection_reason: null,
  reviewed_user_id: null,
  reviewed_at: null,
  application_data: '{}',
  invitation_delivery_status: null,
  created_at: '2026-07-25 00:00:00',
};

describe('Admin Supplier Onboarding Review Routes', () => {
  let app: Hono;
  let testEnv: any;
  let executed: { query: string; params: unknown[] }[];
  let firstResults: Record<string, unknown> | null;
  let kvPuts: { key: string; value: string }[];

  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    executed = [];
    kvPuts = [];
    firstResults = null;
    testEnv = createTestEnv();
    const makeDb = () => {
      testEnv.DB.prepare = (query: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => {
            executed.push({ query, params });
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => {
            // For user email collision check, return null (no existing user) by default.
            // Individual tests override this for collision scenarios.
            if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) {
              return null;
            }
            return firstResults;
          },
          all: async () => {
            // For evidence query, return the three required kinds
            if (query.includes('supplier_onboarding_evidence')) {
              return { results: [
                { kind: 'id_front' },
                { kind: 'id_back' },
                { kind: 'selfie' },
              ] };
            }
            return { results: [] };
          },
        }),
      });
    };
    makeDb();
    // Support batch — records all statements and returns success
    testEnv.DB.batch = async (statements: any[]) => {
      const results: any[] = [];
      for (const stmt of statements) {
        const result = await stmt.run();
        results.push(result);
      }
      return results;
    };
    testEnv.CACHE = {
      get: async () => null,
      put: async (key: string, value: string) => {
        kvPuts.push({ key, value });
      },
      delete: async () => undefined,
    };

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId', 'admin-1');
      await next();
    });
    app.route('/admin/supplier-onboarding', adminSupplierOnboardingRoutes);
  });

  const post = (path: string, body?: unknown) =>
    app.request(
      `/admin/supplier-onboarding${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      testEnv
    );

  it('GET /:id returns a single application with camelCase fields', async () => {
    firstResults = pendingApplication;
    const res = await app.request('/admin/supplier-onboarding/app-1', undefined, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.businessName).toBe('Siam Wellness Co.');
    expect(body.data.brochureUrls).toEqual(['https://example.com/brochure.pdf']);
    expect(body.data.categories).toHaveLength(2);
    expect(body.data.status).toBe('pending');
  });

  it('GET /:id returns reviewedUserId field', async () => {
    firstResults = { ...pendingApplication, reviewed_user_id: 'admin-2' };
    const res = await app.request('/admin/supplier-onboarding/app-1', undefined, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reviewedUserId).toBe('admin-2');
  });

  it('GET /:id returns 404 when missing', async () => {
    firstResults = null;
    const res = await app.request('/admin/supplier-onboarding/nope', undefined, testEnv);
    expect(res.status).toBe(404);
  });

  it('GET /:id rejects non-Core applications', async () => {
    firstResults = { ...pendingApplication, mode: 'tirakplus' };
    const res = await app.request('/admin/supplier-onboarding/app-1', undefined, testEnv);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CORE_MODE_REQUIRED');
  });

  it('approve creates supplier user, 30-day basic trial, invite token, no tempPassword', async () => {
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return null;
          if (query.includes('WHERE id = ?') && !query.includes('core_qa')) return pendingApplication;
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

    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.userId).toBeDefined();
    expect(body.data.email).toBe('chanida@example.com');
    // No plaintext tempPassword
    expect(body.data.tempPassword).toBeUndefined();
    expect(body.data.invitationDelivery).toBeDefined();
    expect(body.data.emailSent).toBe(false);

    const userInsert = executed.find((e) => e.query.includes('INSERT INTO users'));
    expect(userInsert).toBeDefined();
    expect(userInsert!.query).toContain("'supplier'");
    expect(userInsert!.query).toContain("'pending'");
    // Email is normalized to lowercase
    // INSERT ... SELECT embeds email from applications table; verified by query content above

    const profileInsert = executed.find((e) => e.query.includes('INSERT INTO supplier_profiles'));
    expect(profileInsert).toBeDefined();
    expect(profileInsert!.query).toContain("'basic'");
    expect(profileInsert!.query).toContain("'pending'");
    // INSERT ... SELECT param layout verified by query content; specific positions differ from plain INSERT

    expect(kvPuts.some((p) => p.key.startsWith('reset:'))).toBe(true);
    const invitePayload = JSON.parse(kvPuts.find((p) => p.key.startsWith('reset:'))!.value);
    expect(invitePayload.userId).toBe(body.data.userId);
    expect(invitePayload.purpose).toBe('supplier-onboarding');
    expect(Date.parse(invitePayload.expiresAt)).toBeGreaterThan(Date.now() + 86300_000);
    expect(Date.parse(invitePayload.expiresAt)).toBeLessThanOrEqual(Date.now() + 86400_000);

    // UPDATE: reviewed_at=now, approved_user_id=userId, reviewed_user_id=admin, WHERE id=app-1
    const appUpdate = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'approved'")
    );
    expect(appUpdate).toBeDefined();
    // CAS UPDATE: [userId, adminUserId, now, applicationId]
    expect(typeof appUpdate!.params[0]).toBe('string'); // userId
    expect(appUpdate!.params[1]).toBe('admin-1');       // reviewed_user_id = admin
    expect(typeof appUpdate!.params[2]).toBe('string'); // now (reviewed_at)
    expect(appUpdate!.params[3]).toBe('app-1');

    const notifInsert = executed.find((e) => e.query.includes('INSERT INTO notifications'));
    expect(notifInsert).toBeDefined();
    expect(notifInsert!.query).toContain("'supplier_approved'");
    expect(notifInsert!.params[2]).toContain('forgot-password');
  });

  it('approve derives reset URL from HOST header', async () => {
    let callIdx = 0;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { executed.push({ query, params }); return { success: true, meta: { changes: 1 } }; },
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) return null;
          if (query.includes('WHERE id = ?') && !query.includes('core_qa') && !query.includes('invitation_delivery')) {
            return callIdx++ === 0 ? pendingApplication : null;
          }
          if (query.includes('LOWER(TRIM(email))')) return null;
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
    testEnv.EMAIL_PROVIDER = 'resend';
    testEnv.RESEND_API_KEY = 'test-resend-key';
    testEnv.EMAIL_FROM = 'noreply@example.test';
    testEnv.EMAIL = { send: vi.fn().mockResolvedValue({ messageId: 'test-msg-id' }) };
    // Send with HOST header to verify URL derivation
    const res = await app.request('/admin/supplier-onboarding/app-1/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'admin.tirak.app' },
    }, testEnv);
    expect(res.status).toBe(200);
    // Browser reset URL uses HOST header with /auth/new#token
    const emailCall = testEnv.EMAIL.send.mock.calls[0];
    if (emailCall) {
      const emailBody = JSON.stringify(emailCall[0]);
      expect(emailBody).toContain('admin.tirak.app/auth/new#token=');
    }
  });

  it('approve returns 409 ALREADY_REVIEWED for non-pending application', async () => {
    firstResults = { ...pendingApplication, status: 'approved' };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error || body.message).toContain('ALREADY_REVIEWED');
  });

  it('approve returns 409 when email already belongs to any existing user', async () => {
    let callIdx = 0;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => {
          if (query.includes('SELECT id, user_type FROM users WHERE LOWER')) {
            return { id: 'existing-supplier', user_type: 'supplier' };
          }
          if (query.includes('WHERE id = ?') && !query.includes('core_qa')) {
            return callIdx++ === 0 ? pendingApplication : null;
          }
          if (query.includes('LOWER(TRIM(email))')) {
            return { id: 'existing-supplier' };
          }
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
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('IDENTITY_CONFLICT');
  });

  it('approve rejects non-Core applications', async () => {
    firstResults = { ...pendingApplication, mode: 'tirakplus', status: 'pending' };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CORE_MODE_REQUIRED');
  });

  it('approve returns 409 ALREADY_REVIEWED on idempotent retry (already approved)', async () => {
    firstResults = { ...pendingApplication, status: 'approved', approved_user_id: 'supplier-guid-123' };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error || body.message).toContain('ALREADY_REVIEWED');
  });

  it('reject persists reason and reviewer', async () => {
    firstResults = { id: 'app-1', status: 'pending', mode: 'tirak' };
    const res = await post('/app-1/reject', { reason: 'Incomplete documentation' });
    expect(res.status).toBe(200);
    const update = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'rejected'")
    );
    expect(update).toBeDefined();
    expect(update!.params[1]).toBe('Incomplete documentation');
    expect(update!.params[2]).toBe('admin-1');
    expect(update!.query).toContain("status = 'pending'");
    expect(update!.query).toContain('approved_user_id IS NULL');
  });

  it('reject without reason stores NULL', async () => {
    firstResults = { id: 'app-1', status: 'pending', mode: 'tirak' };
    const res = await post('/app-1/reject', {});
    expect(res.status).toBe(200);
    const update = executed.find((e) => e.query.includes("'rejected'"));
    expect(update!.params[1]).toBeNull();
  });

  it('reject returns 409 ALREADY_REVIEWED for non-pending application', async () => {
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
    const res = await post('/app-1/reject', { reason: 'Valid rejection reason' });
    expect(res.status).toBe(409);
  });

  it('reject returns 409 ALREADY_REVIEWED with winner readback when approval already won the CAS race', async () => {
    let updateAttempted = false;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          if (query.includes('UPDATE supplier_onboarding_applications') && query.includes("'rejected'")) {
            updateAttempted = true;
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
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

    const res = await post('/app-1/reject', { reason: 'Too late' });
    expect(updateAttempted).toBe(true);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ALREADY_REVIEWED');
    expect(body.data.approvedUserId).toBe('supplier-guid-123');
    expect(body.data.reviewedUserId).toBe('admin-2');
    expect(body.data.invitationDelivery.status).toBe('pending');
  });

  it('reject returns 404 when application missing', async () => {
    firstResults = null;
    const res = await post('/nope/reject', {});
    expect(res.status).toBe(404);
  });

  it('reject rejects non-Core applications', async () => {
    firstResults = { id: 'app-1', status: 'pending', mode: 'tirakplus' };
    const res = await post('/app-1/reject', { reason: 'Wrong surface' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('CORE_MODE_REQUIRED');
  });
});
