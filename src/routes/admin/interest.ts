import { Hono } from 'hono';
import { jsonSuccess, jsonError, createPagination, calculateOffset } from '../../utils/response';
import type { Env, Variables } from '../../index';

/** Core interest only. Parent router enforces active admin authentication. No exports or mutations. */
export const adminInterestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
adminInterestRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
adminInterestRoutes.get('/', async c => {
  const url = new URL(c.req.url);
  const number = (name: string, fallback: number, max: number) => {
    const values = url.searchParams.getAll(name);
    if (!values.length) return fallback;
    if (values.length !== 1 || !/^[1-9]\d{0,5}$/.test(values[0]!)) return null;
    const value = Number(values[0]); return value <= max ? value : null;
  };
  const page = number('page', 1, 100000), limit = number('limit', 20, 100);
  const sources = url.searchParams.getAll('source');
  const source = sources[0];
  if (page === null || limit === null || sources.length > 1 || (source !== undefined && (!source.trim() || source.length > 100 || /[\x00-\x1f\x7f]/.test(source))) || [...url.searchParams.keys()].some(k => !['page', 'limit', 'source'].includes(k))) {
    return jsonError(c, 'INVALID_QUERY', 'Invalid page, limit or source', 400);
  }
  const where = source ? 'WHERE source = ?' : '';
  const params = source ? [source] : [];
  try {
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM interest_entries ${where}`).bind(...params).first<{ total: number }>();
    const rows = await c.env.DB.prepare(`SELECT id, email_normalized, name, source, created_at FROM interest_entries ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...params, limit, calculateOffset(page, limit)).all<{ id: string; email_normalized: string; name: string | null; source: string | null; created_at: string }>();
    if (!count || !Number.isSafeInteger(count.total) || count.total < 0 || !rows.success || !Array.isArray(rows.results)) throw new Error('Invalid read result');
    return jsonSuccess(c, { items: rows.results.map(row => ({ id: row.id, email: row.email_normalized, name: row.name, source: row.source, createdAt: row.created_at })), pagination: createPagination(page, limit, count.total) });
  } catch {
    return jsonError(c, 'INTEREST_READ_FAILED', 'Unable to load recorded interest', 500);
  }
});
