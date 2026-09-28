import { publicCompanionIdentityFilter } from './publicCompanionIdentity';

export const publicIdentity = publicCompanionIdentityFilter();
/** Shared by every public guide alias and new booking eligibility. */
export const publicCompanionVisibility = `
  COALESCE(sp.subscription_status, 'active') = 'active'
  AND sp.verification_status = 'verified'
  AND u.status = 'active'
  AND TRIM(COALESCE(sp.display_name, '')) != ''
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
