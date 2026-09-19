/** Explicit review fixtures shared with the mobile demo gate. Accounts remain
 * usable for review/login/admin; they are never public marketplace inventory.
 * Do not infer fixture status from display names, email domains or prefixes.
 */
export const REVIEW_ACCOUNT_IDS = [
  'demo_customer_001',
  'demo_companion_001',
  '30c6d267-22d1-4cd0-8bdc-46993c14c143',
  '4f34d4e0-84f3-4e3c-b443-909ea3905f58',
  'companion_001',
  'companion_002',
] as const;

export const REVIEW_ACCOUNT_EMAILS = [
  'demo.customer@tirak.com',
  'demo.companion@tirak.com',
  'test.customer.tirak@gmail.com',
  'test.companion.tirak@gmail.com',
] as const;

/** All callers join the users table as `u`; values are always bound. */
export function publicCompanionIdentityFilter(): { sql: string; parameters: string[] } {
  return {
    sql: `u.id NOT IN (${REVIEW_ACCOUNT_IDS.map(() => '?').join(', ')})
      AND LOWER(TRIM(COALESCE(u.email, ''))) NOT IN (${REVIEW_ACCOUNT_EMAILS.map(() => '?').join(', ')})`,
    parameters: [...REVIEW_ACCOUNT_IDS, ...REVIEW_ACCOUNT_EMAILS],
  };
}
