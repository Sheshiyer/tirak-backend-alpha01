import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminSupplierOnboardingRoutes } from '@/routes/admin/supplierOnboarding';
import { createTestEnv } from '@tests/setup';

const pendingApplication = {
  id: 'app-1',
  business_name: 'Siam Wellness Co.',
  contact_name: 'Chanida Wongsa',
  email: 'chanida@example.com',
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
  rejection_reason: null,
  reviewed_user_id: null,
  reviewed_at: null,
  created_at: '2026-07-25 00:00:00',
};

describe('Admin Supplier Onboarding Review Routes', () => {
  let app: Hono;
  let testEnv: any;
  let executed: { query: string; params: unknown[] }[];
  let firstResults: Record<string, unknown> | null;
  let kvPuts: { key: string; value: string }[];

  beforeEach(() => {
    executed = [];
    kvPuts = [];
    firstResults = null;
    testEnv = createTestEnv();
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => firstResults,
        all: async () => ({ results: [] }),
      }),
    });
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

  it('GET /:id returns 404 when missing', async () => {
    firstResults = null;
    const res = await app.request('/admin/supplier-onboarding/nope', undefined, testEnv);
    expect(res.status).toBe(404);
  });

  it('approve creates supplier user, 30-day basic trial, invite token, and returns tempPassword', async () => {
    const responses: (Record<string, unknown> | null)[] = [pendingApplication, null];
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          executed.push({ query, params });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => responses.shift() ?? null,
        all: async () => ({ results: [] }),
      }),
    });

    const res = await post('/app-1/approve');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.userId).toBeDefined();
    expect(body.data.email).toBe('chanida@example.com');
    expect(typeof body.data.tempPassword).toBe('string');
    expect(body.data.tempPassword.length).toBe(12);
    expect(typeof body.data.emailSent).toBe('boolean');

    const userInsert = executed.find((e) => e.query.includes('INSERT INTO users'));
    expect(userInsert).toBeDefined();
    expect(userInsert!.query).toContain("'supplier'");
    expect(userInsert!.query).toContain("'pending'");
    expect(userInsert!.params[1]).toBe('chanida@example.com');

    const profileInsert = executed.find((e) => e.query.includes('INSERT INTO supplier_profiles'));
    expect(profileInsert).toBeDefined();
    expect(profileInsert!.query).toContain("'basic'");
    expect(profileInsert!.query).toContain("'+30 days'");
    expect(profileInsert!.params[1]).toBe('Siam Wellness Co.');
    expect(profileInsert!.params[4]).toBe(
      JSON.stringify(['Traditional Thai Massage', 'Aromatherapy'])
    );

    expect(kvPuts.some((p) => p.key.startsWith('reset:'))).toBe(true);
    const invitePayload = JSON.parse(kvPuts.find((p) => p.key.startsWith('reset:'))!.value);
    expect(invitePayload.userId).toBe(body.data.userId);

    const appUpdate = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'approved'")
    );
    expect(appUpdate).toBeDefined();
    expect(appUpdate!.params[0]).toBe('admin-1');
    expect(appUpdate!.params[1]).toBe(body.data.userId);

    const notifInsert = executed.find((e) => e.query.includes('INSERT INTO notifications'));
    expect(notifInsert).toBeDefined();
    expect(notifInsert!.params).toContain('supplier_application_approved');
  });

  it('approve returns 409 ALREADY_REVIEWED for non-pending application', async () => {
    firstResults = { ...pendingApplication, status: 'approved' };
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error || body.message).toContain('ALREADY_REVIEWED');
  });

  it('approve returns 409 EMAIL_EXISTS when email already registered', async () => {
    const responses: (Record<string, unknown> | null)[] = [
      pendingApplication,
      { id: 'existing-user' },
    ];
    testEnv.DB.prepare = (query: string) => ({
      bind: () => ({
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => responses.shift() ?? null,
        all: async () => ({ results: [] }),
      }),
    });
    const res = await post('/app-1/approve');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error || body.message).toContain('EMAIL_EXISTS');
  });

  it('reject persists reason and reviewer', async () => {
    firstResults = { id: 'app-1', status: 'pending' };
    const res = await post('/app-1/reject', { reason: 'Incomplete documentation' });
    expect(res.status).toBe(200);
    const update = executed.find(
      (e) => e.query.includes('UPDATE supplier_onboarding_applications') && e.query.includes("'rejected'")
    );
    expect(update).toBeDefined();
    expect(update!.params[0]).toBe('Incomplete documentation');
    expect(update!.params[1]).toBe('admin-1');
  });

  it('reject without reason stores NULL', async () => {
    firstResults = { id: 'app-1', status: 'pending' };
    const res = await post('/app-1/reject', {});
    expect(res.status).toBe(200);
    const update = executed.find((e) => e.query.includes("'rejected'"));
    expect(update!.params[0]).toBeNull();
  });

  it('reject returns 409 ALREADY_REVIEWED for non-pending application', async () => {
    firstResults = { id: 'app-1', status: 'rejected' };
    const res = await post('/app-1/reject', { reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('reject returns 404 when application missing', async () => {
    firstResults = null;
    const res = await post('/nope/reject', {});
    expect(res.status).toBe(404);
  });
});
