import type { Env } from '../index';
import { createEmailConfig, renderBasicEmail, sendEmail } from '../utils/communication';

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface EmailVerificationDelivery {
  deliveryStatus: 'sent' | 'unavailable';
  retryAfterSeconds: number;
}

function generateCode(): string {
  // Rejection sampling avoids modulo bias and uses the platform CSPRNG.
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0]! >= 4_294_000_000);
  return String(values[0]! % 1_000_000).padStart(6, '0');
}

async function hashCode(secret: string, userId: string, email: string, code: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['email-verification', userId, email, code])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function requestEmailVerification(
  env: Env, user: { id: string; email: string }, now = Date.now(),
): Promise<EmailVerificationDelivery> {
  const code = generateCode();
  const codeHash = await hashCode(env.JWT_SECRET, user.id, user.email, code);
  const reserved = await env.DB.prepare(`
    INSERT INTO email_verification_challenges (user_id, email, code_hash, issued_at, expires_at, attempts, delivery_status)
    VALUES (?, ?, ?, ?, ?, 0, 'pending')
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
      issued_at = excluded.issued_at, expires_at = excluded.expires_at, attempts = 0, delivery_status = 'pending'
    WHERE email_verification_challenges.issued_at <= ?
  `).bind(user.id, user.email, codeHash, now, now + CODE_LIFETIME_MS, now - RESEND_INTERVAL_MS).run();

  if (reserved.meta.changes === 0) {
    const previous = await env.DB.prepare('SELECT issued_at, delivery_status FROM email_verification_challenges WHERE user_id = ?')
      .bind(user.id).first<{ issued_at: number; delivery_status: string }>();
    return { deliveryStatus: previous?.delivery_status === 'sent' ? 'sent' : 'unavailable',
      retryAfterSeconds: Math.max(1, Math.ceil(((previous?.issued_at ?? now) + RESEND_INTERVAL_MS - now) / 1000)) };
  }

  let sent = false;
  try {
    const delivery = await sendEmail(createEmailConfig(env), user.email, 'Confirm your Tirak email',
      renderBasicEmail('Confirm your email', `Your Tirak verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`));
    sent = delivery.status === 'sent' || delivery.status === 'delivered';
  } catch {
    // Provider configuration and delivery failures must not masquerade as sent mail.
    sent = false;
  }
  await env.DB.prepare(`UPDATE email_verification_challenges SET delivery_status = ? WHERE user_id = ? AND code_hash = ?`)
    .bind(sent ? 'sent' : 'failed', user.id, codeHash).run();
  return { deliveryStatus: sent ? 'sent' : 'unavailable', retryAfterSeconds: RESEND_INTERVAL_MS / 1000 };
}

export async function verifyEmailCode(
  env: Env, user: { id: string; email: string }, code: string, now = Date.now(),
): Promise<boolean> {
  const codeHash = await hashCode(env.JWT_SECRET, user.id, user.email, code);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET email_verified = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND email = ? AND EXISTS (
        SELECT 1 FROM email_verification_challenges WHERE user_id = ? AND email = ?
          AND code_hash = ? AND delivery_status = 'sent' AND expires_at > ? AND attempts < ?
      )`).bind(user.id, user.email, user.id, user.email, codeHash, now, MAX_ATTEMPTS),
    env.DB.prepare(`UPDATE email_verification_challenges SET delivery_status = 'consumed'
      WHERE user_id = ? AND email = ? AND code_hash = ? AND delivery_status = 'sent'
        AND expires_at > ? AND attempts < ?`).bind(user.id, user.email, codeHash, now, MAX_ATTEMPTS),
    env.DB.prepare(`UPDATE email_verification_challenges SET attempts = MIN(attempts + 1, ?)
      WHERE user_id = ? AND delivery_status = 'sent' AND expires_at > ? AND code_hash != ?`)
      .bind(MAX_ATTEMPTS, user.id, now, codeHash),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
}
