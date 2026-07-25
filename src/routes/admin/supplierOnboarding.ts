import { Hono } from 'hono';
import { validatePagination } from '../../middleware/validation';
import { jsonPaginated, jsonError, createPagination } from '../../utils/response';
import type { Env, Variables } from '../../index';

const adminSupplierOnboarding = new Hono<{ Bindings: Env; Variables: Variables }>();

adminSupplierOnboarding.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  const allowedStatuses = ['pending', 'approved', 'rejected'];

  if (status && !allowedStatuses.includes(status)) {
    return jsonError(c, 'INVALID_STATUS', 'Status must be pending, approved, or rejected.', 400);
  }

  try {
    const where = status ? 'WHERE status = ?' : '';
    const bindValues = status ? [status] : [];

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM supplier_onboarding_applications ${where}`
    )
      .bind(...bindValues)
      .first();
    const total = Number((countRow as Record<string, unknown> | null)?.total ?? 0);

    const offset = (page - 1) * limit;
    const rows = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, created_at
      FROM supplier_onboarding_applications
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
      .bind(...bindValues, limit, offset)
      .all();

    const items = ((rows.results ?? []) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      businessName: row.business_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      location: row.location,
      bio: row.bio,
      brochureUrls: JSON.parse((row.brochure_urls as string) || '[]'),
      categories: JSON.parse((row.categories as string) || '[]'),
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
    }));

    return jsonPaginated(c, items, createPagination(page, limit, total), 'Supplier onboarding applications.');
  } catch (error) {
    console.error('Failed to list supplier onboarding applications:', error);
    return jsonError(c, 'ONBOARDING_LIST_FAILED', 'Could not load applications.', 500);
  }
});

export { adminSupplierOnboarding as adminSupplierOnboardingRoutes };
