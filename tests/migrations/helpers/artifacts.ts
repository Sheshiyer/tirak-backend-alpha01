import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Locates the T-028 migration artifacts fixed by the coordinator lineage
 * decisions and loads them in the exact application order:
 *
 *   1. migrations/baseline/canonical-baseline.sql  (generated, single ledger row)
 *   2. migrations/008_omise_promptpay_payments.sql (corrected in place)
 *   3. migrations/010_booking_chat_expansion.sql   (new, additive)
 *   4. migrations/011_payment_restitutions.sql     (new)
 */

export const repoRoot = resolve(import.meta.dirname, '../../..');
export const contractRoot = join(repoRoot, 'contracts/tirak-payments-v1');
export const targetSchemaPath = join(contractRoot, 'target-schema.sql');

export interface MigrationArtifact {
  key: string;
  name: string;
  path: string;
  sql: string;
}

const artifactSpec: Array<{ key: string; name: string; path: string }> = [
  {
    key: 'baseline',
    name: 'migrations/baseline/canonical-baseline.sql',
    path: join(repoRoot, 'migrations/baseline/canonical-baseline.sql'),
  },
  {
    key: 'payments',
    name: 'migrations/008_omise_promptpay_payments.sql',
    path: join(repoRoot, 'migrations/008_omise_promptpay_payments.sql'),
  },
  {
    key: 'chat',
    name: 'migrations/010_booking_chat_expansion.sql',
    path: join(repoRoot, 'migrations/010_booking_chat_expansion.sql'),
  },
  {
    key: 'restitutions',
    name: 'migrations/011_payment_restitutions.sql',
    path: join(repoRoot, 'migrations/011_payment_restitutions.sql'),
  },
];

/** Files quarantined by the migration strategy: never applied, never referenced. */
export const quarantinedMigrations = [
  '004_mobile_app_features.sql',
  '009_booking_scoped_chat.sql',
] as const;

export function readSql(path: string): string {
  return readFileSync(path, 'utf8');
}

export function missingArtifacts(): string[] {
  return artifactSpec.filter((a) => !existsSync(a.path)).map((a) => a.name);
}

/**
 * Loads the full migration chain in application order. Throws a descriptive
 * error when any lane's artifact has not landed yet, so a premature run fails
 * loudly instead of testing a partial lineage.
 */
export function loadMigrationChain(): MigrationArtifact[] {
  const missing = missingArtifacts();
  if (missing.length > 0) {
    throw new Error(
      'T-028 migration artifacts are missing; the validation suite cannot run ' +
        'until every lane lands its deliverable:\n - ' +
        missing.join('\n - '),
    );
  }
  return artifactSpec.map((a) => ({ ...a, sql: readSql(a.path) }));
}

export function loadArtifact(key: string): MigrationArtifact {
  const spec = artifactSpec.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown artifact key: ${key}`);
  if (!existsSync(spec.path)) {
    throw new Error(`T-028 migration artifact is missing: ${spec.name}`);
  }
  return { ...spec, sql: readSql(spec.path) };
}
