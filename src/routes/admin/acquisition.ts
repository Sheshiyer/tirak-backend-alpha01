import { Hono } from 'hono';
import { jsonSuccess, jsonError, createPagination, calculateOffset } from '../../utils/response';
import type { Env, Variables } from '../../index';
export const adminAcquisitionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
adminAcquisitionRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
adminAcquisitionRoutes.get('/', async c => {
  const url = new URL(c.req.url);
  const page = url.searchParams.get('page') || '1';
  const kind = url.searchParams.get('kind');
  const campaign = url.searchParams.get('campaign');
  if (!/^[1-9]\d{0,4}$/.test(page) || (kind && !['interest', 'guide_application'].includes(kind)) || (campaign !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(campaign)) || [...url.searchParams.keys()].some(key => !['page', 'kind', 'campaign'].includes(key) || url.searchParams.getAll(key).length !== 1)) return jsonError(c, 'INVALID_QUERY', 'Invalid campaign query', 400);
  const clauses: string[] = []; const params: string[] = [];
  if (kind) { clauses.push('resource_kind = ?'); params.push(kind); }
  if (campaign) { clauses.push('utm_campaign = ?'); params.push(campaign); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  try {
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM core_acquisition_conversions ${where}`).bind(...params).first<{ total: number }>();
    const result = await c.env.DB.prepare(`SELECT resource_kind, resource_id, landing_path, utm_source, utm_medium, utm_campaign, utm_content, accepted_at FROM core_acquisition_conversions ${where} ORDER BY accepted_at DESC, resource_kind DESC, resource_id DESC LIMIT 20 OFFSET ?`).bind(...params, calculateOffset(Number(page), 20)).all();
    if (!count || !Number.isSafeInteger(count.total) || !result.success || !Array.isArray(result.results)) throw new Error('Read failed');
    return jsonSuccess(c, { items: result.results, pagination: createPagination(Number(page), 20, count.total) });
  } catch { return jsonError(c, 'ACQUISITION_READ_FAILED', 'Unable to load attributed submissions', 500); }
});
