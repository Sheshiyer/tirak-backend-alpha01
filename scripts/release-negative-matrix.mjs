import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'tirak-backend-gate-'));
const validConfig = resolve(fixtureRoot, 'wrangler-valid.toml');
const invalidConfig = resolve(fixtureRoot, 'wrangler-invalid.toml');

writeFileSync(validConfig, `
account_id = "2c0c96c68f0ee73b6d980054557bca5b"
[env.staging]
name = "tirak-backend-staging"
[[env.staging.d1_databases]]
binding = "DB"
database_name = "tirak-staging"
database_id = "11111111-1111-4111-8111-111111111111"
[env.staging.vars]
ENVIRONMENT = "staging"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"
`);
writeFileSync(invalidConfig, readConfig(validConfig).replace('tirak-staging', 'wrong-target'));

function readConfig(path) {
  return Buffer.from(requireRead(path)).toString('utf8');
}

function requireRead(path) {
  return process.getBuiltinModule('fs').readFileSync(path);
}

function run({ name, failStep, config = validConfig, recoveryFailure = false }) {
  const result = spawnSync('bash', ['scripts/deploy.sh', 'staging'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TIRAK_RELEASE_TEST_MODE: '1',
      TIRAK_RELEASE_AUTHORIZATION: 'TEST_ONLY',
      TIRAK_WRANGLER_CONFIG: config,
      TIRAK_RELEASE_FAIL_STEP: failStep || '',
      TIRAK_RECOVERY_INJECT_FAILURE: recoveryFailure ? '1' : '0',
    },
  });
  if (result.status === 0) throw new Error(`${name} did not fail closed`);
  return { fixture: name, status: 'EXPECTED_FAILURE', exit: result.status };
}

const results = [
  run({ name: 'target', config: invalidConfig }),
  run({ name: 'typecheck', failStep: 'typecheck' }),
  run({ name: 'test', failStep: 'test' }),
  run({ name: 'backup', failStep: 'backup' }),
  run({ name: 'migration', failStep: 'migration' }),
  run({ name: 'deploy', failStep: 'deploy' }),
  run({ name: 'health', failStep: 'health' }),
  run({ name: 'restore', recoveryFailure: true }),
];

const success = spawnSync('bash', ['scripts/deploy.sh', 'staging'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    TIRAK_RELEASE_TEST_MODE: '1',
    TIRAK_RELEASE_AUTHORIZATION: 'TEST_ONLY',
    TIRAK_WRANGLER_CONFIG: validConfig,
  },
});
if (success.status !== 0) throw new Error(`positive isolated pipeline failed: ${success.stderr || success.stdout}`);

console.log(JSON.stringify({ status: 'PASS', negativeFixtures: results, isolatedPositivePipeline: 'PASS' }, null, 2));
