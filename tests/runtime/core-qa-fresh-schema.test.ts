import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CORE_QA_SCHEMA_INPUTS, CANONICAL_BASELINE_SHA256, generateFreshSchema } from '../../scripts/core-qa/fresh-schema.mjs';

describe('core QA fresh schema generator', () => {
  it('pins the accepted migration list in order', () => {
    expect(CORE_QA_SCHEMA_INPUTS).toEqual([
      'migrations/baseline/canonical-baseline.sql',
      'migrations/010_booking_chat_expansion.sql',
      'migrations/012_supplier_onboarding.sql',
      'migrations/013_supplier_onboarding_review.sql',
      'migrations/015_account_trust.sql',
      'migrations/017_core_guide_management.sql',
      'migrations/019_password_reset_consumptions.sql',
      'migrations/020_core_onboarding_lifecycle.sql',
      'migrations/021_evidence_interest_cohort.sql',
      'migrations/022_core_booking_idempotency.sql',
      'migrations/023_core_customer_registration_fields.sql',
      'migrations/024_core_api_repairs.sql',
      'migrations/025_core_booking_mobile_fields.sql',
      'migrations/026_core_notification_prerequisites.sql',
    ]);
  });

  it('matches the pinned canonical baseline hash', async () => {
    const hashFile = await readFile(path.join(process.cwd(), 'migrations/baseline/canonical-baseline.sha256'), 'utf8');
    expect(hashFile.trim().startsWith(CANONICAL_BASELINE_SHA256)).toBe(true);

    const baselineSql = await readFile(path.join(process.cwd(), 'migrations/baseline/canonical-baseline.sql'), 'utf8');
    const bytesHash = createHash('sha256').update(baselineSql).digest('hex');
    expect(bytesHash).toBe(CANONICAL_BASELINE_SHA256);
  });

  it('generates a reproducible combined schema artifact with manifest comments', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'core-qa-schema-test-'));
    const outputPath = path.join(outputDir, 'core-qa.sql');
    const result = await generateFreshSchema({ repoRoot: process.cwd(), outputPath });
    const second = await generateFreshSchema({ repoRoot: process.cwd(), outputPath: path.join(outputDir, 'core-qa-2.sql') });
    const contents = await readFile(outputPath, 'utf8');

    expect(result.manifest).toHaveLength(CORE_QA_SCHEMA_INPUTS.length);
    expect(contents).toContain('-- GENERATED FILE: disposable Core QA fresh schema only');
    expect(contents).toContain(`-- ${CORE_QA_SCHEMA_INPUTS[0]} ${CANONICAL_BASELINE_SHA256}`);
    expect(contents).toContain('-- BEGIN migrations/021_evidence_interest_cohort.sql sha256=');
    expect(result.combinedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.combinedSha256).toBe(second.combinedSha256);
    expect(result.sql).toBe(second.sql);
    expect(contents.includes('Generated at')).toBe(false);
  });
});
