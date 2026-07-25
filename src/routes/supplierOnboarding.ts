import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const supplierOnboardingRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const onboardingSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(8).max(32),
  location: z.string().trim().min(2).max(200),
  bio: z.string().trim().max(500).optional(),
  brochureUrls: z.array(z.string().trim().url()).max(5).default([]),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        memberCount: z.number().int().min(1).max(100000),
      })
    )
    .min(1)
    .max(50),
  mode: z.enum(['tirak', 'tirakplus']).default('tirak'),
});

supplierOnboardingRoutes.use('*', createRateLimit('general'));

supplierOnboardingRoutes.post('/', zValidator('json', onboardingSchema), async (c) => {
  const payload = c.req.valid('json');

  try {
    const applicationId = crypto.randomUUID();

    const result = await c.env.DB.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, bio,
        brochure_urls, categories, mode, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `)
      .bind(
        applicationId,
        payload.businessName,
        payload.contactName,
        payload.email,
        payload.phone,
        payload.location,
        payload.bio ?? null,
        JSON.stringify(payload.brochureUrls),
        JSON.stringify(payload.categories),
        payload.mode
      )
      .run();

    if (!result.success) {
      return jsonError(c, 'ONBOARDING_INSERT_FAILED', 'Could not save the application.', 500);
    }

    return jsonSuccess(c, { applicationId }, 'Application received.', 201);
  } catch (error) {
    console.error('Supplier onboarding submission failed:', error);
    return jsonError(c, 'ONBOARDING_SUBMISSION_FAILED', 'Submission failed.', 500);
  }
});

export { supplierOnboardingRoutes };
