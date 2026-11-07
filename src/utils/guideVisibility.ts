import { publicCompanionIdentityFilter } from './publicCompanionIdentity';

export const publicIdentity = publicCompanionIdentityFilter();

/**
 * Core trial-expiry predicate shared by public visibility and new booking eligibility.
 *
 * Rules:
 * - subscription_expires_at IS NULL → legacy guide, allowed (no expiry means perpetual active trial).
 * - subscription_expires_at is a valid datetime in the future → allowed.
 * - subscription_expires_at is expired or malformed → denied.
 *
 * Uses SQLite julianday() against CURRENT_TIMESTAMP (always UTC in SQLite)
 * so the comparison is timezone-safe and deterministic. No server/device
 * timezone is ever inferred.
 */
export const trialExpirySql = `
  (
    sp.subscription_expires_at IS NULL
    OR (
      sp.subscription_expires_at IS NOT NULL
      AND julianday(sp.subscription_expires_at) IS NOT NULL
      AND julianday(sp.subscription_expires_at) > julianday(CURRENT_TIMESTAMP)
    )
  )
`;

/** Shared by every public guide alias and new booking eligibility. */
export const publicCompanionVisibility = `
  COALESCE(sp.subscription_status, 'active') = 'active'
  AND sp.verification_status = 'verified'
  AND u.status = 'active'
  AND TRIM(COALESCE(sp.display_name, '')) != ''
  AND ${trialExpirySql}
  AND EXISTS (SELECT 1 FROM supplier_services visible_service
    WHERE visible_service.supplier_id = sp.user_id AND visible_service.is_active = TRUE AND visible_service.archived_at IS NULL)
  AND ${publicIdentity.sql}
`;

export async function isPublicGuide(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT sp.user_id FROM supplier_profiles sp
    JOIN users u ON u.id = sp.user_id WHERE sp.user_id = ? AND ${publicCompanionVisibility}`)
    .bind(id, ...publicIdentity.parameters).first());
}

export async function hasGuideProfile(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT user_id FROM supplier_profiles WHERE user_id = ?').bind(id).first());
}
