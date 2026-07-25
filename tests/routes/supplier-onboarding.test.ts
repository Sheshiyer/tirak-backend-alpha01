import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { supplierOnboardingRoutes } from '@/routes/supplierOnboarding';
import { createTestEnv } from '@tests/setup';

describe('Supplier Onboarding Routes', () => {
  let app: Hono;
  let testEnv: any;
  let lastInsert: { query: string; params: unknown[] } | null;

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
      { name: 'Aromatherapy', memberCount: 2 },
    ],
    mode: 'tirak',
  };

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    lastInsert = null;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          lastInsert = { query, params };
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    });
    app.route('/supplier-onboarding', supplierOnboardingRoutes);
  });

  function post(body: unknown) {
    return app.request(
      '/supplier-onboarding',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      testEnv
    );
  }

  it('accepts a valid application and returns an applicationId', async () => {
    const res = await post(validPayload);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.applicationId).toBe('string');
    expect(body.data.applicationId.length).toBeGreaterThan(0);
  });

  it('persists brochureUrls and categories as JSON with snake_case columns', async () => {
    await post(validPayload);
    expect(lastInsert).not.toBeNull();
    expect(lastInsert!.query).toContain('supplier_onboarding_applications');
    expect(lastInsert!.params).toContain(JSON.stringify(validPayload.brochureUrls));
    expect(lastInsert!.params).toContain(JSON.stringify(validPayload.categories));
  });

  it('rejects missing required fields with 400', async () => {
    const res = await post({ ...validPayload, businessName: '' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid brochure URL with 400', async () => {
    const res = await post({ ...validPayload, brochureUrls: ['not-a-url'] });
    expect(res.status).toBe(400);
  });

  it('rejects an empty categories array with 400', async () => {
    const res = await post({ ...validPayload, categories: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid mode with 400', async () => {
    const res = await post({ ...validPayload, mode: 'enterprise' });
    expect(res.status).toBe(400);
  });
});
