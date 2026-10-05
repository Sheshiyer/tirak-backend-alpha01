import { describe, expect, it } from 'vitest';
import {
  computeBookingPayloadDigest,
  computeDeterministicPayloadDigest,
  evaluateRunOutcome,
} from '../../scripts/core-qa/run-local-runtime.mjs';

describe('core QA local runtime helpers', () => {
  it('produces stable onboarding payload digests regardless of object key order', () => {
    const a = {
      businessName: 'QA Synthetic Guide Co',
      contactName: 'Synthetic Guide',
      email: 'qa-guide@core.local',
      phone: '+66957890123',
      location: 'Bangkok',
      bio: 'Synthetic private-only guide',
      brochureUrls: [],
      categories: [{ name: 'City Walk', memberCount: 1 }],
      applicationData: {
        lastName: 'Guide',
        firstName: 'Synthetic',
        schedule: { timeZone: 'Asia/Bangkok', days: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true }] },
      },
    };

    const b = {
      categories: [{ memberCount: 1, name: 'City Walk' }],
      bio: 'Synthetic private-only guide',
      email: 'qa-guide@core.local',
      phone: '+66957890123',
      location: 'Bangkok',
      applicationData: {
        schedule: { days: [{ endTime: '17:00', isAvailable: true, startTime: '09:00', dayOfWeek: 1 }], timeZone: 'Asia/Bangkok' },
        firstName: 'Synthetic',
        lastName: 'Guide',
      },
      businessName: 'QA Synthetic Guide Co',
      brochureUrls: [],
      contactName: 'Synthetic Guide',
    };

    expect(computeDeterministicPayloadDigest(a)).toBe(computeDeterministicPayloadDigest(b));
  });

  it('changes booking payload digests when the semantic payload changes', () => {
    const base = {
      companionId: 'guide-1',
      serviceId: 'service-1',
      date: '2026-11-02',
      startTime: '09:00',
      duration: 120,
      preferredLanguages: ['en', 'th'],
      dietaryRestrictions: ['vegetarian'],
      location: 'Bangkok Old Town',
      specialRequests: 'Synthetic QA only',
    };

    const changed = {
      ...base,
      preferredLanguages: ['th', 'en'],
    };

    expect(computeBookingPayloadDigest(base)).not.toBe(computeBookingPayloadDigest(changed));
  });

  it('marks EPERM loopback failures as unverified instead of verified', () => {
    const next = evaluateRunOutcome({ ok: false, limitations: [] }, {
      name: 'Error',
      message: 'listen EPERM: operation not permitted 127.0.0.1',
      code: 'EPERM',
      syscall: 'listen',
      address: '127.0.0.1',
    });

    expect(next.ok).toBe(false);
    expect(next.verificationState).toBe('unverified');
    expect(next.limitations).toEqual([
      'Local seat blocked loopback bind for Miniflare/workerd before any route execution.',
      'The failure occurred during runtime boot, not inside a specific application route.',
    ]);
  });

  it('preserves verified success and marks ordinary failures as failed', () => {
    const verified = evaluateRunOutcome({ ok: true, limitations: [] }, null);
    expect(verified.verificationState).toBe('verified');

    const failed = evaluateRunOutcome({ ok: false, limitations: [] }, {
      name: 'Error',
      message: 'worker assertion failed',
      code: 'ASSERT',
      syscall: null,
      address: null,
    });
    expect(failed.verificationState).toBe('failed');
    expect(failed.error.code).toBe('ASSERT');
  });
});
