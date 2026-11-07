import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { jsonSuccess, jsonError, createPagination, calculateOffset } from '../../utils/response';
import type { Env, Variables } from '../../index';
import { processSupportNotification, readSupportNotification } from '../../background/supportNotifications';

/**
 * Admin inbox for Core (mode = 'tirak') support requests.
 * Auth (authMiddleware/adminOnly) is supplied by the parent admin router.
 * Review status changes are audited. No account or booking mutation.
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
  revision: number;
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
        `SELECT id, mode, kind, status, name, email_normalized, subject, message, created_at, updated_at, revision
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
      updated_at: row.updated_at,
      revision: row.revision
    });
  } catch {
    console.error('Admin support requests: detail query failed');
    return jsonError(c, 'Internal server error', 'Unable to load support request', 500);
  }
});

const reviewSchema = z.object({
  actionId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(1000000),
  status: z.enum(STATUSES),
  note: z.string().trim().min(1).max(1000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
}).strict();

adminSupportRequestRoutes.get('/:id/notification', async c => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID_RE.test(id)) return jsonError(c, 'INVALID_REQUEST', 'Invalid request reference', 400);
  try {
    const row = await c.env.DB.prepare("SELECT id FROM core_support_requests WHERE id=? AND mode='tirak'").bind(id).first();
    if (!row) return jsonError(c, 'NOT_FOUND', 'Request not found', 404);
    return jsonSuccess(c, await readSupportNotification(c.env, id));
  } catch { return jsonError(c, 'NOTIFICATION_UNAVAILABLE', 'Notification state could not be loaded', 500); }
});
adminSupportRequestRoutes.post('/:id/notification/retry', async c => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID_RE.test(id)) return jsonError(c, 'INVALID_REQUEST', 'Invalid request reference', 400);
  try {
    const row = await c.env.DB.prepare("SELECT id FROM core_support_requests WHERE id=? AND mode='tirak'").bind(id).first();
    if (!row) return jsonError(c, 'NOT_FOUND', 'Request not found', 404);
    await processSupportNotification(c.env, id, true);
    return jsonSuccess(c, await readSupportNotification(c.env, id));
  } catch { return jsonError(c, 'NOTIFICATION_UNCERTAIN', 'Notification result could not be confirmed. Recheck its state before retrying.', 500); }
});
type ReviewEvent = { id: string; request_id: string; actor_id: string; from_status: string; to_status: string; from_revision: number; revision: number; note: string; created_at: string };
const transitions: Record<string, readonly string[]> = { received: ['in_review', 'closed'], in_review: ['resolved', 'closed'], resolved: ['in_review', 'closed'], closed: ['in_review'] };

adminSupportRequestRoutes.get('/:id/history', async c => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID_RE.test(id)) return jsonError(c, 'INVALID_REQUEST', 'Invalid request reference', 400);
  try {
    const request = await c.env.DB.prepare("SELECT id FROM core_support_requests WHERE id = ? AND mode = 'tirak'").bind(id).first();
    if (!request) return jsonError(c, 'NOT_FOUND', 'Request not found', 404);
    const result = await c.env.DB.prepare('SELECT id, request_id, actor_id, from_status, to_status, from_revision, revision, note, created_at FROM core_support_review_events WHERE request_id = ? ORDER BY revision DESC LIMIT 50').bind(id).all<ReviewEvent>();
    if (!result.success || !Array.isArray(result.results)) throw new Error('History unavailable');
    return jsonSuccess(c, { items: result.results, limit: 50 });
  } catch { return jsonError(c, 'HISTORY_UNAVAILABLE', 'Unable to load request review history', 500); }
});

adminSupportRequestRoutes.patch('/:id', zValidator('json', reviewSchema), async c => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID_RE.test(id)) return jsonError(c, 'INVALID_REQUEST', 'Invalid request reference', 400);
  const input = c.req.valid('json'); const actor = c.get('userId');
  try {
    const prior = await c.env.DB.prepare('SELECT * FROM core_support_review_events WHERE id = ?').bind(input.actionId).first<ReviewEvent>();
    if (prior) {
      if (prior.request_id !== id || prior.actor_id !== actor || prior.to_status !== input.status || prior.from_revision !== input.expectedRevision || prior.note !== input.note) return jsonError(c, 'ACTION_CONFLICT', 'This action reference was already used for different details', 409);
      return jsonSuccess(c, { actionId: prior.id, requestId: id, status: prior.to_status, revision: prior.revision, replayed: true });
    }
    const row = await c.env.DB.prepare("SELECT status, revision FROM core_support_requests WHERE id = ? AND mode = 'tirak'").bind(id).first<{ status: string; revision: number }>();
    if (!row) return jsonError(c, 'NOT_FOUND', 'Request not found', 404);
    if (row.revision !== input.expectedRevision) return jsonError(c, 'STALE_REVIEW', 'This request changed. Refresh before reviewing it.', 409);
    if (!transitions[row.status]?.includes(input.status)) return jsonError(c, 'INVALID_TRANSITION', 'This status change is not allowed', 400);
    const update = c.env.DB.prepare("UPDATE core_support_requests SET status = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND mode = 'tirak' AND revision = ? AND status = ?").bind(input.status, id, input.expectedRevision, row.status);
    const audit = c.env.DB.prepare('INSERT INTO core_support_review_events(id,request_id,actor_id,from_status,to_status,from_revision,revision,note) SELECT ?,?,?,?,?,?,?,? WHERE changes() = 1').bind(input.actionId, id, actor, row.status, input.status, input.expectedRevision, input.expectedRevision + 1, input.note);
    const result = await c.env.DB.batch([update, audit]);
    if (result.length !== 2 || result.some(value => !value.success)) throw new Error('Review transaction failed');
    if (Number(result[0]!.meta?.changes) !== 1) return jsonError(c, 'STALE_REVIEW', 'This request changed. Refresh before reviewing it.', 409);
    if (Number(result[1]!.meta?.changes) !== 1) throw new Error('Audit not confirmed');
    return jsonSuccess(c, { actionId: input.actionId, requestId: id, status: input.status, revision: input.expectedRevision + 1, replayed: false });
  } catch { return jsonError(c, 'REVIEW_FAILED', 'The review result could not be confirmed. Retry the same action.', 500); }
});
