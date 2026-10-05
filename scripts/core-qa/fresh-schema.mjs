import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CORE_QA_SCHEMA_INPUTS = Object.freeze([
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

export const CANONICAL_BASELINE_SHA256 =
  'b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function generateFreshSchema({
  repoRoot,
  outputPath = path.join(repoRoot, 'scripts/core-qa/generated/core-qa-fresh-schema.sql'),
} = {}) {
  if (!repoRoot) {
    throw new Error('repoRoot is required');
  }

  const baselineHashFile = path.join(repoRoot, 'migrations/baseline/canonical-baseline.sha256');
  const baselineHashLine = (await readFile(baselineHashFile, 'utf8')).trim();
  const [baselineHash] = baselineHashLine.split(/\s+/);
  const baselineSqlPath = path.join(repoRoot, 'migrations/baseline/canonical-baseline.sql');
  const baselineSql = await readFile(baselineSqlPath, 'utf8');
  const baselineSqlHash = sha256(baselineSql);

  if (baselineHash !== CANONICAL_BASELINE_SHA256) {
    throw new Error(
      `Pinned canonical baseline hash mismatch: expected ${CANONICAL_BASELINE_SHA256}, received ${baselineHash || 'missing'}`,
    );
  }

  if (baselineSqlHash !== CANONICAL_BASELINE_SHA256) {
    throw new Error(
      `Canonical baseline bytes hash mismatch: expected ${CANONICAL_BASELINE_SHA256}, received ${baselineSqlHash}`,
    );
  }

  const parts = [];
  const manifest = [];

  for (const relativePath of CORE_QA_SCHEMA_INPUTS) {
    const absolutePath = path.join(repoRoot, relativePath);
    const sql = await readFile(absolutePath, 'utf8');
    const hash = sha256(sql);
    manifest.push({ path: relativePath, sha256: hash });
    parts.push(`-- BEGIN ${relativePath} sha256=${hash}\n${sql.trim()}\n-- END ${relativePath}`);
  }

  const manifestText = manifest
    .map((entry) => `-- ${entry.path} ${entry.sha256}`)
    .join('\n');

  const combinedSql = [
    '-- GENERATED FILE: disposable Core QA fresh schema only',
    '-- Local-only guard: no remote or retained database usage is permitted',
    manifestText,
    parts.join('\n\n'),
    '',
  ].join('\n');

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, combinedSql, 'utf8');

  return {
    outputPath,
    combinedSha256: sha256(combinedSql),
    manifest,
    sql: combinedSql,
  };
}
