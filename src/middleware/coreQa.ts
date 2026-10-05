import type { Context, Next } from 'hono';
import { verifyJWT } from '../utils/auth';
import { getUserById } from '../utils/database';
import { jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

function setQaHeaders(c: Context<{ Bindings: Env; Variables: Variables }>) {
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  c.header('X-Tirak-QA-Environment', String(c.env.ENVIRONMENT || 'unknown'));
  c.header('X-Tirak-QA-Mode', String(c.env.CORE_QA_MODE || 'unset'));
}

function applyQaHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('X-Tirak-QA-Environment', String(env.ENVIRONMENT || 'unknown'));
  headers.set('X-Tirak-QA-Mode', String(env.CORE_QA_MODE || 'unset'));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    // An upgraded Worker response owns the live socket; retain it when enforcing QA headers.
    webSocket: response.webSocket,
  });
}

function finalizeQaResponse(c: Context<{ Bindings: Env; Variables: Variables }>): Response {
  setQaHeaders(c);
  c.res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.res.headers.set('Pragma', 'no-cache');
  c.res.headers.set('Expires', '0');
  c.res.headers.set('X-Tirak-QA-Environment', String(c.env.ENVIRONMENT || 'unknown'));
  c.res.headers.set('X-Tirak-QA-Mode', String(c.env.CORE_QA_MODE || 'unset'));
  c.res = applyQaHeaders(c.res, c.env);
  return c.res;
}

function isQaWebsocketRoute(c: Context<{ Bindings: Env; Variables: Variables }>): boolean {
  return c.req.method === 'GET'
    && /^\/api\/chat\/rooms\/[0-9a-fA-F-]{36}\/ws$/.test(c.req.path)
    && c.req.header('Upgrade')?.toLowerCase() === 'websocket';
}

async function socketTicketHash(ticket: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function roleMatchesUserType(cohortRole: string, userType: string): boolean {
  const normalizedUserType = String(userType || '').trim().toLowerCase();
  switch (cohortRole) {
    case 'traveler':
      return normalizedUserType === 'customer';
    case 'guide':
      return normalizedUserType === 'supplier';
    case 'admin':
      return normalizedUserType === 'admin';
    default:
      return false;
  }
}

export async function findCoreQaCohortRoom(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<{ id: string } | null> {
  return db.prepare(
    `SELECT cr.id
     FROM booking_chat_rooms cr
     JOIN bookings b
       ON b.id = cr.booking_id
      AND b.customer_id = cr.customer_id
      AND b.supplier_id = cr.supplier_id
      AND b.status IN ('confirmed', 'in_progress')
     WHERE cr.id = ?
       AND (
         (b.customer_id = ? AND b.supplier_id IN (
           SELECT approved_user_id
           FROM supplier_onboarding_applications
           WHERE mode = 'tirak'
             AND status = 'approved'
             AND approved_user_id = b.supplier_id
             AND reviewed_user_id IS NOT NULL
         ))
         OR (b.supplier_id = ?)
       )`
  ).bind(roomId, userId, userId).first<{ id: string }>();
}

async function requireQaWebsocketTicket(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response | null> {
  const ticket = c.req.query('ticket');
  const roomId = c.req.path.split('/').at(-2);
  if (!ticket || !roomId || ticket.length > 100) {
    return jsonError(c, 'AUTHENTICATION_REQUIRED', 'Request a new chat connection ticket.', 401);
  }

  try {
    const ticketRow = await c.env.DB.prepare(
      `SELECT user_id, room_id, expires_at
       FROM chat_socket_tickets
       WHERE ticket_hash = ? AND room_id = ? AND expires_at > ?`
    ).bind(await socketTicketHash(ticket), roomId, Date.now()).first<{
      user_id: string;
      room_id: string;
      expires_at: number;
    }>();

    if (!ticketRow || ticketRow.room_id !== roomId) {
      return jsonError(c, 'AUTHENTICATION_REQUIRED', 'Request a new chat connection ticket.', 401);
    }

    const user = await getUserById(ticketRow.user_id, c.env.DB);
    if (!user) {
      return jsonError(c, 'USER_NOT_FOUND', 'User not found.', 401);
    }
    if (user.status !== 'active') {
      return jsonError(c, 'ACCOUNT_INACTIVE', 'Account is not active.', 403);
    }

    const qaMember = await c.env.DB.prepare(
      `SELECT role, source_application_id, enrolled_by
       FROM core_qa_accounts
       WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(user.id).first<{ role: string; source_application_id: string | null; enrolled_by: string | null }>();

    if (!qaMember) {
      return jsonError(c, 'QA_ACCESS_DENIED', 'Not a member of the QA cohort.', 403);
    }

    if (!roleMatchesUserType(qaMember.role, user.userType)) {
      return jsonError(c, 'QA_ROLE_MISMATCH', 'QA cohort role does not match user type.', 403);
    }

    const cohortRoom = await findCoreQaCohortRoom(c.env.DB, roomId, user.id);

    if (!cohortRoom) {
      return jsonError(c, 'Chat room not found', 'Access denied or room does not exist', 404);
    }

    if (qaMember.role === 'guide') {
      if (!qaMember.source_application_id || !qaMember.enrolled_by) {
        return jsonError(c, 'QA_MEMBERSHIP_INVALID', 'Guide cohort enrollment is missing its approval provenance.', 403);
      }

      const provenance = await c.env.DB.prepare(
        `SELECT application.id
         FROM supplier_onboarding_applications application
         JOIN users reviewer_user
           ON reviewer_user.id = application.reviewed_user_id
          AND reviewer_user.status = 'active'
          AND reviewer_user.user_type = 'admin'
         JOIN core_qa_accounts reviewer
           ON reviewer.user_id = reviewer_user.id
          AND reviewer.role = 'admin'
          AND reviewer.revoked_at IS NULL
         WHERE application.id = ?
           AND application.mode = 'tirak'
           AND application.status = 'approved'
           AND application.approved_user_id = ?
           AND application.reviewed_user_id = ?`
      ).bind(qaMember.source_application_id, user.id, qaMember.enrolled_by).first<{ id: string }>();

      if (!provenance) {
        return jsonError(c, 'QA_MEMBERSHIP_INVALID', 'Guide cohort enrollment is not linked to an approved Core application reviewed by an active QA admin.', 403);
      }
    }

    c.set('userId', user.id);
    c.set('userType', user.userType);
    c.set('user', user);
    return null;
  } catch (dbErr) {
    const err = dbErr as Error;
    if (err.message?.includes('no such table')) {
      return jsonError(c, 'QA_UNAVAILABLE', 'QA cohort system is not available.', 503);
    }
    console.error('QA websocket ticket check failed');
    return jsonError(c, 'QA_CHECK_FAILED', 'Could not verify QA membership.', 500);
  }
}

/**
 * Bootstrap exception allowlist — these routes are accessible without QA cohort
 * membership. They use their own capability-based auth (statusToken, etc.)
 * or are intentionally public for the application flow.
 */
const BOOTSTRAP_EXCEPTIONS: Array<{ method: string; pattern: RegExp }> = [
  // Auth routes
  { method: 'POST', pattern: /^\/api\/auth\/login$/ },
  { method: 'POST', pattern: /^\/api\/auth\/forgot-password$/ },
  { method: 'POST', pattern: /^\/api\/auth\/reset-password$/ },
  { method: 'POST', pattern: /^\/api\/auth\/register$/ },
  // Token activation (HTML page)
  { method: 'GET', pattern: /^\/auth\/activate\/?$/ },
  // Supplier onboarding intake (public capability)
  { method: 'POST', pattern: /^\/api\/supplier-onboarding\/?$/ },
  // Application status (bearer statusToken)
  { method: 'GET', pattern: /^\/api\/supplier-onboarding\/[^/]+\/status$/ },
  // Evidence upload (bearer statusToken)
  { method: 'POST', pattern: /^\/api\/supplier-onboarding\/[^/]+\/evidence$/ },
  // Interest (public)
  { method: 'POST', pattern: /^\/api\/interest\/?$/ },
  // Health
  { method: 'GET', pattern: /^\/health$/ },
];

/**
 * Core QA boundary middleware.
 *
 * In ENVIRONMENT=core-qa with CORE_QA_MODE=cohort, every API route
 * (except bootstrap exceptions) requires:
 * 1. Valid JWT
 * 2. Active DB user
 * 3. Active (non-revoked) membership in core_qa_accounts
 *
 * If ENVIRONMENT is not core-qa or CORE_QA_MODE is not cohort,
 * this middleware is a no-op (live behavior unchanged).
 *
 * Missing table → 503. Revoked account → 403. No JWT → 401.
 * No-cache headers on all QA responses.
 */
export async function coreQaBoundary(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  // Only activate in core-qa environment with cohort mode
  const env = c.env.ENVIRONMENT;
  const qaMode = c.env.CORE_QA_MODE;

  if (env !== 'core-qa' || qaMode !== 'cohort') {
    // Fail closed: QA env without cohort config must reject, not pass through.
    if (env === 'core-qa' && qaMode !== 'cohort') {
      setQaHeaders(c);
      return jsonError(c, 'QA_CONFIG_MISSING', 'QA environment requires CORE_QA_MODE=cohort.', 403);
    }
    // Not a QA environment — pass through unchanged
    return next();
  }

  // QA responses must always be uncached and visibly marked, including pass-throughs.
  setQaHeaders(c);

  // Check bootstrap exception
  const method = c.req.method;
  const path = c.req.path;

  for (const exception of BOOTSTRAP_EXCEPTIONS) {
    if (method === exception.method && exception.pattern.test(path)) {
      await next();
      return finalizeQaResponse(c);
    }
  }

  // All other routes require JWT + active user + QA cohort membership

  if (isQaWebsocketRoute(c) && c.req.query('ticket') && !c.req.header('Authorization')) {
    const failure = await requireQaWebsocketTicket(c);
    if (failure) return failure;
    await next();
    return finalizeQaResponse(c);
  }

  // Extract JWT
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return jsonError(c, 'AUTHENTICATION_REQUIRED', 'No authentication token provided.', 401);
  }

  // Verify JWT
  let payload: { sub: string };
  try {
    payload = await verifyJWT(token, c.env.JWT_SECRET) as { sub: string };
  } catch {
    return jsonError(c, 'INVALID_TOKEN', 'Invalid authentication token.', 401);
  }

  try {
    // Verify active DB user
    const user = await getUserById(payload.sub, c.env.DB);
    if (!user) {
      return jsonError(c, 'USER_NOT_FOUND', 'User not found.', 401);
    }
    if (user.status !== 'active') {
      return jsonError(c, 'ACCOUNT_INACTIVE', 'Account is not active.', 403);
    }

    // Verify QA cohort membership
    const qaMember = await c.env.DB.prepare(
      `SELECT role, revoked_at, source_application_id, enrolled_by
       FROM core_qa_accounts WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(user.id).first<{ role: string; revoked_at: string | null; source_application_id: string | null; enrolled_by: string | null }>();

    if (!qaMember) {
      return jsonError(c, 'QA_ACCESS_DENIED', 'Not a member of the QA cohort.', 403);
    }

    if (!roleMatchesUserType(qaMember.role, user.userType)) {
      return jsonError(c, 'QA_ROLE_MISMATCH', 'QA cohort role does not match user type.', 403);
    }

    if (qaMember.role === 'guide') {
      if (!qaMember.source_application_id || !qaMember.enrolled_by) {
        return jsonError(c, 'QA_MEMBERSHIP_INVALID', 'Guide cohort enrollment is missing its approval provenance.', 403);
      }

      const provenance = await c.env.DB.prepare(
        `SELECT application.id
         FROM supplier_onboarding_applications application
         JOIN users reviewer_user
           ON reviewer_user.id = application.reviewed_user_id
          AND reviewer_user.status = 'active'
          AND reviewer_user.user_type = 'admin'
         JOIN core_qa_accounts reviewer
           ON reviewer.user_id = reviewer_user.id
          AND reviewer.role = 'admin'
          AND reviewer.revoked_at IS NULL
         WHERE application.id = ?
           AND application.mode = 'tirak'
           AND application.status = 'approved'
           AND application.approved_user_id = ?
           AND application.reviewed_user_id = ?`
      ).bind(qaMember.source_application_id, user.id, qaMember.enrolled_by).first<{ id: string }>();

      if (!provenance) {
        return jsonError(c, 'QA_MEMBERSHIP_INVALID', 'Guide cohort enrollment is not linked to an approved Core application reviewed by an active QA admin.', 403);
      }
    }

    // Set QA context for downstream routes
    c.set('userId', user.id);
    c.set('userType', user.userType);
    c.set('user', user);
  } catch (dbErr) {
    // Table may not exist — fail closed
    const err = dbErr as Error;
    if (err.message?.includes('no such table')) {
      return jsonError(c, 'QA_UNAVAILABLE', 'QA cohort system is not available.', 503);
    }
    console.error('QA cohort check failed');
    return jsonError(c, 'QA_CHECK_FAILED', 'Could not verify QA membership.', 500);
  }

  await next();
  return finalizeQaResponse(c);
}

/**
 * Email recipient guard for core-qa environment.
 *
 * In core-qa, only mrhigh3r@gmail.com is permitted as email recipient.
 * All other recipients are fail-closed (email not sent).
 * This should be called from the central sendEmail utility.
 *
 * @returns true if the recipient is permitted, false if blocked.
 */
export function isQaPermittedRecipient(env: Env, recipient: string): boolean {
  if (env.ENVIRONMENT !== 'core-qa') {
    // Not QA environment — no restriction
    return true;
  }
  // Core-qa: only this recipient is permitted
  return recipient.toLowerCase().trim() === 'mrhigh3r@gmail.com';
}
