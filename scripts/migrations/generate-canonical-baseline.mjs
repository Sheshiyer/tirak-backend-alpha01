#!/usr/bin/env node
/**
 * generate-canonical-baseline.mjs — T-028 Lane D
 *
 * Generates the canonical baseline artifact for the tirak-payments-v1
 * migration lineage (docs/contracts/tirak-payments-v1/migration-strategy.md).
 *
 * The baseline is a deterministic concatenation of exactly these files,
 * in exactly this order:
 *
 *   001_initial_schema.sql
 *   002_add_indexes.sql
 *   003_add_analytics_tables.sql
 *   004_background_jobs_tables.sql
 *   005_muse_ai_foundation.sql
 *   006_referrals_tirak_coins.sql
 *   007_registration_profile_persistence.sql
 *
 * It MUST exclude:
 *   - the quarantined legacy 004_mobile_app_features.sql (seven deterministic
 *     failures on a fresh target; quarantined per migration-strategy.md),
 *   - 008_* (payments; applied separately via the Wrangler ledger),
 *   - 009_* (quarantined destructive legacy-chat rename),
 *   - 010_* / 011_* (additive chat / restitutions; applied via the ledger).
 *
 * Outputs:
 *   migrations/baseline/canonical-baseline.sql    (provenance header + body)
 *   migrations/baseline/canonical-baseline.sha256 (shasum-compatible digest)
 *
 * Determinism: output bytes are a pure function of the source file bytes.
 * No timestamps, no host data, no environment-dependent content.
 *
 * Fail-closed (exit 1, nothing written) if:
 *   - any expected source file is missing or unreadable, or
 *   - any quarantined/excluded file is detected inside the include set.
 *
 * Offline only: pure node, no network, no dependencies.
 *
 * Usage:
 *   node scripts/migrations/generate-canonical-baseline.mjs
 *     [--migrations-dir <dir>]   (default: <repo>/migrations)
 *     [--out-dir <dir>]          (default: <repo>/migrations/baseline)
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Ordered canonical include set. Order is load-bearing; never reorder. */
const INCLUDE_FILES = Object.freeze([
  '001_initial_schema.sql',
  '002_add_indexes.sql',
  '003_add_analytics_tables.sql',
  '004_background_jobs_tables.sql',
  '005_muse_ai_foundation.sql',
  '006_referrals_tirak_coins.sql',
  '007_registration_profile_persistence.sql',
]);

/**
 * Files that must never enter the baseline. `004_mobile_app_features.sql` and
 * `009_booking_scoped_chat.sql` are quarantined by the approved strategy;
 * 008/010/011 are ledger-applied after the baseline and are excluded so the
 * baseline stays exactly one ledger row.
 */
const EXCLUDED_FILES = Object.freeze([
  '004_mobile_app_features.sql',
  '008_omise_promptpay_payments.sql',
  '009_booking_scoped_chat.sql',
  '010_booking_chat_expansion.sql',
  '011_payment_restitutions.sql',
]);

const BASELINE_SQL_NAME = 'canonical-baseline.sql';
const BASELINE_SHA_NAME = 'canonical-baseline.sha256';

function sha256hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  console.error(`generate-canonical-baseline: REFUSED — ${message}`);
  console.error('Nothing was written. Resolve the precondition and re-run; do not bypass.');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { migrationsDir: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--migrations-dir') {
      args.migrationsDir = argv[++i];
    } else if (argv[i] === '--out-dir') {
      args.outDir = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node generate-canonical-baseline.mjs [--migrations-dir <dir>] [--out-dir <dir>]');
      process.exit(0);
    } else {
      fail(`unknown argument '${argv[i]}'`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const migrationsDir = resolve(process.cwd(), args.migrationsDir ?? join(REPO_ROOT, 'migrations'));
  const outDir = resolve(process.cwd(), args.outDir ?? join(migrationsDir, 'baseline'));

  if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
    fail(`migrations directory not found: ${migrationsDir}`);
  }

  // --- Guard 1: every expected source file must exist and be a regular file.
  for (const name of INCLUDE_FILES) {
    const path = join(migrationsDir, name);
    if (!existsSync(path)) {
      fail(`expected baseline source file is missing: ${name} (looked in ${migrationsDir})`);
    }
    if (!statSync(path).isFile()) {
      fail(`expected baseline source is not a regular file: ${name}`);
    }
  }

  // --- Guard 2: no quarantined/excluded file may appear in the include set.
  // INCLUDE_FILES is a frozen constant, so this can only trip if the constant
  // is ever edited incorrectly; that edit must fail here, loudly.
  for (const name of INCLUDE_FILES) {
    if (EXCLUDED_FILES.includes(name)) {
      fail(`quarantined/excluded file detected inside the include set: ${name}`);
    }
  }

  // --- Read sources and hash each one individually.
  const sources = INCLUDE_FILES.map((name) => {
    const path = join(migrationsDir, name);
    const content = readFileSync(path);
    return { name, content, sha256: sha256hex(content) };
  });

  // --- Informational: report excluded files observed on disk (never included).
  const onDisk = readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql') && statSync(join(migrationsDir, entry)).isFile())
    .sort();
  const excludedPresent = onDisk.filter((entry) => EXCLUDED_FILES.includes(entry));
  const unknownPresent = onDisk.filter(
    (entry) => !INCLUDE_FILES.includes(entry) && !EXCLUDED_FILES.includes(entry),
  );
  for (const entry of excludedPresent) {
    console.error(`info: excluded from baseline by strategy: ${entry}`);
  }
  for (const entry of unknownPresent) {
    // Unknown files do not alter the deterministic output, but they are
    // surfaced so an unexpected new migration is never silently ignored.
    console.error(`info: not part of the canonical baseline include set, ignored: ${entry}`);
  }

  // --- Build the deterministic artifact.
  const headerLines = [
    '-- ============================================================================',
    '-- canonical-baseline.sql',
    '-- Tirak tirak-payments-v1 canonical baseline (T-028).',
    '--',
    '-- Generated by scripts/migrations/generate-canonical-baseline.mjs.',
    '-- Content is a pure, deterministic concatenation of the source files below,',
    '-- in the order listed. Do not edit by hand; regenerate instead.',
    '--',
    '-- Applied exactly once and recorded as exactly one d1_migrations row',
    '-- (docs/contracts/tirak-payments-v1/migration-strategy.md).',
    '--',
    '-- Excluded by strategy: 004_mobile_app_features.sql (quarantined legacy),',
    '-- 009_booking_scoped_chat.sql (quarantined destructive rename), and',
    '-- 008/010/011 (applied separately through the Wrangler migration ledger).',
    '--',
    '-- Provenance (source file => sha256 of its raw bytes):',
  ];
  for (const source of sources) {
    headerLines.push(`--   ${source.name} => ${source.sha256}`);
  }
  headerLines.push('-- ============================================================================');
  headerLines.push('');

  const bodyParts = [];
  for (const source of sources) {
    bodyParts.push(`-- ---- begin: ${source.name} (sha256: ${source.sha256}) ----`);
    let text = source.content.toString('utf8');
    if (!text.endsWith('\n')) text += '\n';
    bodyParts.push(text);
    bodyParts.push(`-- ---- end: ${source.name} ----`);
    bodyParts.push('');
  }

  const baselineSql = `${headerLines.join('\n')}\n${bodyParts.join('\n')}`;
  const baselineBuffer = Buffer.from(baselineSql, 'utf8');
  const baselineHash = sha256hex(baselineBuffer);
  const shaFileContent = `${baselineHash}  ${BASELINE_SQL_NAME}\n`;

  // --- Write outputs, then re-read and re-hash to prove the write.
  mkdirSync(outDir, { recursive: true });
  const sqlPath = join(outDir, BASELINE_SQL_NAME);
  const shaPath = join(outDir, BASELINE_SHA_NAME);

  writeFileSync(sqlPath, baselineBuffer);
  writeFileSync(shaPath, shaFileContent, 'utf8');

  const verifyHash = sha256hex(readFileSync(sqlPath));
  if (verifyHash !== baselineHash) {
    fail(`post-write verification failed: re-read hash ${verifyHash} != computed ${baselineHash}`);
  }

  console.log(`canonical baseline written: ${sqlPath}`);
  console.log(`sha256 manifest written:    ${shaPath}`);
  console.log(`baseline sha256:            ${baselineHash}`);
  console.log(`source files concatenated:  ${sources.length} (order: ${INCLUDE_FILES.join(', ')})`);
}

main();
