import { Hono } from 'hono';
import { jsonSuccess, jsonError, createPagination, calculateOffset } from '../../utils/response';
import type { Env, Variables } from '../../index';

/**
 * Admin inbox for Core (mode = 'tirak') support requests.
 * Auth (authMiddleware/adminOnly) is supplied by the parent admin router.
 * Read-only list/detail; no account, booking, review or notification mutation.
 */
export const adminSupportRequestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const KINDS = ['contact', 'privacy_deletion'] as const;
const STATUSES = ['received', 'in_review', 'resolved', 'closed'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^[0-9]{1,9}$/;

interface SummaryRow {
  id: string;
  kind: string;
  status: string;
  name: string;
  subject: string;
  created_at: string;
}

interface DetailRow extends SummaryRow {
  mode: string;
  email_normalized: string;
  message: string;
  updated_at: string;
}

function parseStrictInt(
  values: string[] | undefined,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (!values || values.length === 0) return fallback;
  if (values.length !== 1) return null;
  const raw = values[0];
  if (raw === undefined || !INT_RE.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

function parseEnum<T extends string>(
  values: string[] | undefined,
  allowed: readonly T[]
): { ok: true; value: T | null } | { ok: false } {
  if (!values || values.length === 0) return { ok: true, value: null };
  if (values.length !== 1) return { ok: false };
  const v = values[0];
  if (v === undefined) return { ok: false };
  return (allowed as readonly string[]).includes(v) ? { ok: true, value: v as T } : { ok: false };
}

// Every response from this router, including errors, must never be cached.
adminSupportRequestRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  try {
    await next();
  } catch {
    console.error('Admin support requests: unexpected failure');
    c.res = jsonError(c, 'Internal server error', 'Unable to process support request query', 500);
  }
  c.res.headers.set('Cache-Control', 'no-store');
});

adminSupportRequestRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const query = (name: string) => {
    const vals = url.searchParams.getAll(name);
    return vals.length ? vals : undefined;
  };

  const page = parseStrictInt(query('page'), 1, 1, 100000);
  const limit = parseStrictInt(query('limit'), 20, 1, 100);
  const kind = parseEnum(query('kind'), KINDS);
  const status = parseEnum(query('status'), STATUSES);

  if (page === null || limit === null || !kind.ok || !status.ok || [...url.searchParams.keys()].some(key => !['page', 'limit', 'kind', 'status'].includes(key))) {
    return jsonError(c, 'Invalid query parameters', 'Invalid page, limit, kind, or status', 400);
  }

  const conditions = ["mode = 'tirak'"];
  const params: Array<string | number> = [];
  if (kind.value) {
    conditions.push('kind = ?');
    params.push(kind.value);
  }
  if (status.value) {
    conditions.push('status = ?');
    params.push(status.value);
  }
  const where = conditions.join(' AND ');

  try {
    const countResult = await c.env.DB
      .prepare(`SELECT COUNT(*) AS total FROM core_support_requests WHERE ${where}`)
      .bind(...params)
      .first<{ total: number }>();

    if (!countResult || typeof countResult.total !== 'number') {
      console.error('Admin support requests: count failed');
      return jsonError(c, 'Internal server error', 'Unable to load support requests', 500);
    }

    const listResult = await c.env.DB
      .prepare(
        `SELECT id, kind, status, name, subject, created_at
         FROM core_support_requests
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, calculateOffset(page, limit))
      .all<SummaryRow>();

    if (!listResult || (listResult.success as boolean) === false || !Array.isArray(listResult.results)) {
      console.error('Admin support requests: list failed');
      return jsonError(c, 'Internal server error', 'Unable to load support requests', 500);
    }

    const items = listResult.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      name: r.name,
      subject: r.subject,
      created_at: r.created_at
    }));

    return jsonSuccess(c, {
      items,
      pagination: createPagination(page, limit, countResult.total)
    });
  } catch {
    console.error('Admin support requests: list query failed');
    return jsonError(c, 'Internal server error', 'Unable to load support requests', 500);
  }
});

adminSupportRequestRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return jsonError(c, 'Invalid request id', 'Support request id must be a UUID', 400);
  }

  try {
    const row = await c.env.DB
      .prepare(
        `SELECT id, mode, kind, status, name, email_normalized, subject, message, created_at, updated_at
         FROM core_support_requests
         WHERE id = ? AND mode = 'tirak'`
      )
      .bind(id.toLowerCase())
      .first<DetailRow>();

    if (!row) {
      return jsonError(c, 'Not found', 'Support request not found', 404);
    }

    return jsonSuccess(c, {
      id: row.id,
      mode: row.mode,
      kind: row.kind,
      status: row.status,
      name: row.name,
      email: row.email_normalized,
      subject: row.subject,
      message: row.message,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch {
    console.error('Admin support requests: detail query failed');
    return jsonError(c, 'Internal server error', 'Unable to load support request', 500);
  }
});

