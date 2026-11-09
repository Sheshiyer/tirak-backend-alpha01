import { sendEmail } from '../utils/communication';
import { computePayloadDigest } from '../utils/supplier-onboarding';
import { isQaPermittedRecipient } from '../middleware/coreQa';
import type { Env } from '../index';

export const SUPPORT_RECIPIENT = 'contact@tirak.app';
type Outbox = { request_id: string; status: string; attempts: number; next_attempt_at: number; lease_until: number | null; first_attempt_at: number | null; config_digest: string | null; provider_request_id: string | null; accepted_at: number | null; last_error_code: string | null };
export function notificationView(row: Outbox | null) {
  return row ? { status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at || null, providerRequestId: row.provider_request_id, acceptedAt: row.accepted_at, lastErrorCode: row.last_error_code, recipient: SUPPORT_RECIPIENT } : { status: 'not_scheduled', attempts: 0, nextAttemptAt: null, providerRequestId: null, acceptedAt: null, lastErrorCode: null, recipient: SUPPORT_RECIPIENT };
}
export async function readSupportNotification(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM core_support_notification_outbox WHERE request_id = ?').bind(id).first<Outbox>();
  const view = { requestId: id, ...notificationView(row) };
  if (row && env.SUPPORT_NOTIFICATIONS_ENABLED !== 'true' && !['provider_accepted', 'needs_review'].includes(row.status)) {
    return { ...view, status: 'unconfigured', nextAttemptAt: null, lastErrorCode: 'DISABLED' };
  }
  return view;
}
/** Stable minimal message. Personal form contents stay behind administrator authentication. */
export async function processSupportNotification(env: Env, id: string, force = false, now = Date.now()) {
  const row = await env.DB.prepare('SELECT * FROM core_support_notification_outbox WHERE request_id = ?').bind(id).first<Outbox>();
  if (!row || ['provider_accepted', 'needs_review'].includes(row.status) || (row.lease_until ?? 0) > now || (!force && row.next_attempt_at > now)) return;
  let disabled: string | undefined;
  if (env.SUPPORT_NOTIFICATIONS_ENABLED !== 'true') disabled = 'DISABLED';
  else if (env.EMAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY?.trim() || !env.EMAIL_FROM?.trim()) disabled = 'NOT_CONFIGURED';
  else if (!isQaPermittedRecipient(env, SUPPORT_RECIPIENT)) disabled = 'QA_RECIPIENT_BLOCKED';
  if (disabled) {
    await env.DB.prepare("UPDATE core_support_notification_outbox SET status='unconfigured',last_error_code=?,next_attempt_at=?,updated_at=? WHERE request_id=? AND status NOT IN ('provider_accepted','needs_review') AND COALESCE(lease_until,0)<=?").bind(disabled, now + 900000, now, id, now).run();
    return;
  }
  const digest = await computePayloadDigest({ provider: 'resend', apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, fromName: env.EMAIL_FROM_NAME || 'Tirak', recipient: SUPPORT_RECIPIENT });
  // Stop well before Resend's 24h idempotency retention; unknown results need human reconciliation after this window.
  if (row.attempts >= 8 || (row.first_attempt_at !== null && now - row.first_attempt_at >= 23 * 3600000) || (row.config_digest !== null && row.config_digest !== digest)) {
    const code = row.config_digest && row.config_digest !== digest ? 'CONFIG_CHANGED' : 'RETRY_REVIEW_REQUIRED';
    await env.DB.prepare("UPDATE core_support_notification_outbox SET status='needs_review',last_error_code=?,updated_at=? WHERE request_id=? AND COALESCE(lease_until,0)<=? AND status NOT IN ('provider_accepted','needs_review')").bind(code, now, id, now).run(); return;
  }
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare("UPDATE core_support_notification_outbox SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),config_digest=COALESCE(config_digest,?),updated_at=? WHERE request_id=? AND attempts=? AND status NOT IN ('provider_accepted','needs_review') AND COALESCE(lease_until,0)<=?").bind(lease, now + 60000, now, digest, now, id, row.attempts, now).run();
  if (!claim.success || Number(claim.meta?.changes) !== 1) return;
  const request = await env.DB.prepare("SELECT kind FROM core_support_requests WHERE id=? AND mode='tirak'").bind(id).first<{ kind: string }>();
  if (!request) throw new Error('Support notification request missing');
  const kind = request.kind === 'privacy_deletion' ? 'privacy request' : 'contact request';
  const outcome = await sendEmail({ provider: 'resend', env, apiKey: env.RESEND_API_KEY, fromEmail: env.EMAIL_FROM, fromName: env.EMAIL_FROM_NAME || 'Tirak', replyTo: SUPPORT_RECIPIENT, idempotencyKey: `tirak-support/${id}` }, SUPPORT_RECIPIENT, `Tirak ${kind}: ${id}`, `A new Tirak ${kind} was recorded.\nReference: ${id}\nReview the private request in https://admin.tirak.app/support-inbox .\nA privacy receipt records intent only; no account deletion has been performed.`);
  const accepted = outcome.status === 'sent' && typeof outcome.providerRequestId === 'string';
  const status = accepted ? 'provider_accepted' : row.attempts + 1 >= 8 ? 'needs_review' : 'retry_due';
  const next = accepted ? 0 : now + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6));
  const saved = await env.DB.prepare('UPDATE core_support_notification_outbox SET status=?,provider_request_id=?,accepted_at=?,last_error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE request_id=? AND lease_token=?').bind(status, accepted ? outcome.providerRequestId! : null, accepted ? now : null, accepted ? null : outcome.errorCode === 'EMAIL_TIMEOUT' ? 'OUTCOME_UNKNOWN' : 'PROVIDER_REJECTED', next, now, id, lease).run();
  if (!saved.success || Number(saved.meta?.changes) !== 1) throw new Error('Support notification result not confirmed');
}
export async function processSupportNotifications(env: Env) {
  const now = Date.now();
  const due = await env.DB.prepare("SELECT request_id FROM core_support_notification_outbox WHERE status IN ('pending','processing','retry_due','unconfigured') AND next_attempt_at<=? AND COALESCE(lease_until,0)<=? ORDER BY updated_at,request_id LIMIT 10").bind(now, now).all<{ request_id: string }>();
  if (!due.success || !Array.isArray(due.results)) throw new Error('Support outbox unavailable');
  let errors = 0;
  for (const row of due.results) { try { await processSupportNotification(env, row.request_id); } catch { errors++; } }
  return { checked: due.results.length, errors };
}
