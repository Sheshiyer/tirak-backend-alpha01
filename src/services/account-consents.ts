export const ACCOUNT_POLICY_VERSION = '2026-09-19';

export interface ConsentPreferences {
  marketingOptIn: boolean;
  analyticsOptIn: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  acceptedAt: string | null;
}

export interface PolicyAcceptance {
  termsVersion: string;
  privacyVersion: string;
}

export async function getAccountConsents(db: D1Database, userId: string): Promise<ConsentPreferences> {
  const row = await db.prepare('SELECT * FROM account_consents WHERE user_id = ?').bind(userId)
    .first<{ marketing_opt_in: number; analytics_opt_in: number; terms_version: string | null; privacy_version: string | null; accepted_at: string | null }>();
  return {
    marketingOptIn: row?.marketing_opt_in === 1,
    analyticsOptIn: row?.analytics_opt_in === 1,
    termsVersion: row?.terms_version ?? null,
    privacyVersion: row?.privacy_version ?? null,
    acceptedAt: row?.accepted_at ?? null,
  };
}

export async function saveAccountConsents(
  db: D1Database,
  userId: string,
  preferences: { marketingOptIn: boolean; analyticsOptIn: boolean },
  policyAcceptance?: PolicyAcceptance,
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [db.prepare(`
    INSERT INTO account_consents (user_id, marketing_opt_in, analytics_opt_in, terms_version, privacy_version, accepted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      marketing_opt_in = excluded.marketing_opt_in,
      analytics_opt_in = excluded.analytics_opt_in,
      terms_version = COALESCE(excluded.terms_version, account_consents.terms_version),
      privacy_version = COALESCE(excluded.privacy_version, account_consents.privacy_version),
      accepted_at = COALESCE(excluded.accepted_at, account_consents.accepted_at),
      updated_at = excluded.updated_at
  `).bind(userId, Number(preferences.marketingOptIn), Number(preferences.analyticsOptIn),
    policyAcceptance?.termsVersion ?? null, policyAcceptance?.privacyVersion ?? null,
    policyAcceptance ? now : null, now)];
  const events: Array<{ type: string; granted: boolean; version: string | null }> = [
    { type: 'marketing', granted: preferences.marketingOptIn, version: ACCOUNT_POLICY_VERSION },
    { type: 'analytics', granted: preferences.analyticsOptIn, version: ACCOUNT_POLICY_VERSION },
  ];
  if (policyAcceptance) {
    events.push({ type: 'terms', granted: true, version: policyAcceptance.termsVersion },
      { type: 'privacy', granted: true, version: policyAcceptance.privacyVersion });
  }
  for (const event of events) {
    statements.push(db.prepare(`INSERT INTO account_consent_events
      (id, user_id, consent_type, granted, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, event.type, Number(event.granted), event.version, now));
  }
  // D1 batch is transactional: a failed event write cannot silently change preferences.
  await db.batch(statements);
}
