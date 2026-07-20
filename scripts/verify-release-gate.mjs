import { accessSync, constants, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const requiredScripts = [
  'scripts/deploy.sh',
  'scripts/backup.sh',
  'scripts/verify-local-recovery.sh',
  'scripts/verify-sql-restore.sh',
  'scripts/validate-target.mjs',
  'scripts/release-negative-matrix.mjs',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  for (const path of requiredScripts) {
    accessSync(path, constants.R_OK);
  }
  for (const path of requiredScripts.filter((path) => path.endsWith('.sh'))) {
    accessSync(path, constants.X_OK);
  }

  const deploy = readFileSync('scripts/deploy.sh', 'utf8');
  const backup = readFileSync('scripts/backup.sh', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const sources = `${deploy}\n${backup}`;

  assert(deploy.includes('set -euo pipefail') && backup.includes('set -euo pipefail'), 'delivery scripts are not strict');
  assert(!sources.includes('tirak-db'), 'stale tirak-db target remains');
  assert(!/for\s+migration\s+in\s+migrations/i.test(sources), 'raw migration directory replay remains');
  assert(!/\|\|\s*true/.test(sources), 'delivery scripts contain fail-open || true');
  assert(!/continuing with deployment|but continuing/i.test(sources), 'warning-only continuation remains');
  assert(deploy.includes('d1 migrations apply "$DATABASE_NAME" --env "$ENVIRONMENT" --remote'), 'target-aware D1 migration ledger command missing');
  assert(backup.includes('d1 export "$DATABASE_NAME"') && backup.includes('verify-sql-restore.sh'), 'restorable D1 export proof missing');
  assert(packageJson.scripts.typecheck === 'tsc --noEmit', 'typecheck script name drift');
  assert(packageJson.scripts['test:run'] === 'vitest run', 'test:run script name drift');
  assert(!packageJson.scripts['db:migrate'], 'ambiguous db:migrate script remains');

  const recovery = JSON.parse(run('bash', ['scripts/verify-local-recovery.sh']));
  const negatives = JSON.parse(run('node', ['scripts/release-negative-matrix.mjs']));

  const stagingProbe = spawnSync('node', ['scripts/validate-target.mjs', 'staging', 'tirak-staging', 'wrangler.toml'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert(stagingProbe.status !== 0 && /placeholder/i.test(stagingProbe.stderr), 'placeholder staging target did not fail closed');
  const production = JSON.parse(run('node', ['scripts/validate-target.mjs', 'production', 'tirak-mobile-production', 'wrangler.toml']));

  console.log(JSON.stringify({
    status: 'PASS',
    gate: 'T-021 backend delivery gate',
    strictScripts: true,
    staleTargets: 0,
    rawMigrationLoops: 0,
    localRecovery: recovery,
    negativeFixtures: negatives.negativeFixtures,
    isolatedPositivePipeline: negatives.isolatedPositivePipeline,
    placeholderStagingRefusal: 'PASS',
    productionTargetStaticValidation: production.status,
    externalCommandsExecuted: 0,
  }, null, 2));
} catch (error) {
  console.error(`T-021 backend release verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
