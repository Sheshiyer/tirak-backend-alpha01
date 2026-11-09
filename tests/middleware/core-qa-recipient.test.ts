import { describe, expect, it } from 'vitest';
import { isQaPermittedRecipient } from '@/middleware/coreQa';
import type { Env } from '@/index';

describe('QA recipient boundary', () => {
  it('blocks delivery when no private owner-selected recipient is configured', () => {
    expect(isQaPermittedRecipient({ ENVIRONMENT: 'core-qa' } as Env, 'guide@example.invalid')).toBe(false);
  });

  it('permits the exact configured address and denies a different recipient', () => {
    const env = { ENVIRONMENT: 'core-qa', CORE_QA_EMAIL_RECIPIENT: ' Owner@Example.Invalid ' } as Env;
    expect(isQaPermittedRecipient(env, 'owner@example.invalid')).toBe(true);
    expect(isQaPermittedRecipient(env, 'other@example.invalid')).toBe(false);
  });

  it.each(['', 'owner@example.invalid\r\nbcc:other@example.invalid', 'not-an-address'])('blocks malformed private configuration', value => {
    const env = { ENVIRONMENT: 'core-qa', CORE_QA_EMAIL_RECIPIENT: value } as Env;
    expect(isQaPermittedRecipient(env, value)).toBe(false);
  });

  it('preserves the normal non-QA provider recipient contract', () => {
    expect(isQaPermittedRecipient({ ENVIRONMENT: 'production' } as Env, 'guide@example.invalid')).toBe(true);
  });
});
