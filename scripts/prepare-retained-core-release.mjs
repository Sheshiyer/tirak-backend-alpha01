import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { experimental_readRawConfig: readRawConfig } = require('wrangler');
const HELD_VARS = {
  ENVIRONMENT: 'production', SUPPORT_NOTIFICATIONS_ENABLED: 'false',
  PAYMENT_MODE: 'disabled', PROMPTPAY_ENABLED: 'false',
  PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: 'false',
};

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : (JSON.stringify(canonical(value)) ?? 'undefined')).digest('hex');
}

export function defaultConfiguration(raw) {
  const { env: _namedEnvironments, ...defaults } = raw;
  return defaults;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedBindings(bindings) {
  return [...bindings].sort((a, b) => a.name.localeCompare(b.name));
}

function configuredBindings(config) {
  return sortedBindings([
    ...Object.entries(config.vars || {}).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...(config.d1_databases || []).map(b => ({ name: b.binding, type: 'd1', database_id: b.database_id })),
    ...(config.r2_buckets || []).map(b => ({ name: b.binding, type: 'r2_bucket', bucket_name: b.bucket_name })),
    ...(config.kv_namespaces || []).map(b => ({ name: b.binding, type: 'kv_namespace', namespace_id: b.id })),
    ...(config.queues?.producers || []).map(b => ({ name: b.binding, type: 'queue', queue_name: b.queue })),
    ...(config.durable_objects?.bindings || []).map(b => ({ name: b.name, type: 'durable_object_namespace', class_name: b.class_name })),
    ...(config.send_email || []).map(b => ({ ...b, type: 'send_email' })),
    { name: 'JWT_SECRET', type: 'secret_text' },
    { name: 'RESEND_API_KEY', type: 'secret_text' },
  ]);
}

export function validateRetainedCore(config, contract) {
  assert(config.name === 'tirak-backend', 'retained Core Worker mismatch');
  assert(config.main === 'src/index.ts', 'retained Core entry point mismatch');
  const db = config.d1_databases;
  assert(db?.length === 1 && db[0].binding === 'DB' && db[0].database_name === 'tirak-development', 'retained Core database mismatch');
  assert(contract.schema === 'tirak.retained-core-preparation.v1', 'private preparation contract schema mismatch');
  assert(contract.expectedDefaultConfiguration, 'complete expected default configuration required');
  assert(digest(config) === digest(contract.expectedDefaultConfiguration), 'complete default configuration differs from pinned contract');
  assert(/^[a-f0-9]{32}$/.test(config.account_id || ''), 'pinned account identity required');
  assert(/^[a-f0-9-]{36}$/.test(db[0].database_id || ''), 'pinned database identity required');
  for (const [key, value] of Object.entries(HELD_VARS)) {
    assert(config.vars?.[key] === value, `held runtime control mismatch: ${key}`);
  }
  assert(!('JWT_SECRET' in config.vars) && !('RESEND_API_KEY' in config.vars), 'secret values must not be configured as vars');
  assert((config.triggers?.crons || []).length === 0, 'candidate must not add support scheduling');

  const live = contract.live;
  assert(live?.worker === config.name && live.versionId && Number.isFinite(Date.parse(live.observedAt)), 'timestamped retained Worker readback required');
  assert(Array.isArray(live.bindings), 'complete live bindings required');
  assert(digest(sortedBindings(live.bindings)) === contract.expectedLiveBindingsSha256, 'live binding identities differ from pinned contract');
  const expected = configuredBindings(config);
  const actual = sortedBindings(live.bindings);
  assert(actual.length === expected.length && new Set(actual.map(b => b.name)).size === actual.length, 'complete binding set mismatch');
  for (const [index, binding] of expected.entries()) {
    const observed = actual[index];
    assert(observed.name === binding.name && Object.entries(binding).every(([key, value]) => digest(observed[key]) === digest(value)), `binding mismatch: ${binding.name}`);
    assert(binding.type !== 'secret_text' || Object.keys(observed).every(key => ['name', 'type'].includes(key)), 'secret readback must contain names/types only');
    if (binding.type === 'durable_object_namespace') assert(observed.namespace_id, 'Durable Object namespace identity missing');
  }
  assert(/^[a-f0-9]{64}$/.test(live.moduleSha256 || ''), 'rollback module fingerprint required');
  assert(live.runtime?.compatibility_date === config.compatibility_date
    && digest(live.runtime?.compatibility_flags) === digest(config.compatibility_flags)
    && live.runtime?.usage_model === (config.usage_model || 'standard')
    && live.runtime?.migration_tag === config.migrations?.at(-1)?.tag, 'retained runtime or Durable Object migration changed');
  assert(Array.isArray(live.crons) && live.crons.length === 1 && live.crons[0] === '*/5 * * * *', 'retained schedule observation changed; owner review required');
  assert(contract.triggerDisposition === 'preserve-existing-disabled-held', 'explicit held trigger disposition required');
  const schema = contract.schemaPrerequisites;
  assert(schema?.bookingRoomBookingIdNotNullUnique === true && schema?.duplicateBookingIds === 0
    && ['027', '028', '029', '030'].every(id => schema.appliedMigrations?.includes(id)), 'read-only schema prerequisite evidence required; do not apply migrations');

  return {
    status: 'PREPARED_HELD', target: 'retained-core-default', bindingCount: actual.length,
    configurationSha256: digest(config), bindingsSha256: contract.expectedLiveBindingsSha256,
    rollbackModuleSha256: live.moduleSha256, observedAt: live.observedAt,
    triggerDisposition: contract.triggerDisposition, candidateCrons: [], observedCronCount: live.crons.length,
    releaseReady: false, externalMutations: 0,
    heldGates: ['owner promotion approval', 'fresh target/schema/recovery readback', 'replacement local CI receipt', 'trigger-preserving promotion procedure and owner disposition', 'installed-client and live-role acceptance'],
  };
}

export function prepareRetainedCore({ configPath, contractPath, outputDir, build = false, run = spawnSync, cwd = process.cwd() }) {
  const config = defaultConfiguration(readRawConfig({ config: resolve(configPath) }).rawConfig);
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  // All target, binding, schema and scheduling guards run before any subprocess or output write.
  const result = validateRetainedCore(config, contract);
  if (!build) return result;
  assert(outputDir, 'private output directory required for a local bundle');
  const output = resolve(outputDir);
  assert(!existsSync(output), 'choose a new output directory to preserve existing recovery evidence');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const command = run(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--config', resolve(configPath), '--outdir', output], {
    cwd, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  writeFileSync(resolve(output, 'wrangler-dry-run.log'), `${command.stdout || ''}\n${command.stderr || ''}`, { mode: 0o600 });
  assert(command.status === 0, 'local Wrangler dry-run failed; inspect the private log');
  const module = readFileSync(resolve(output, 'index.js'));
  const source = run('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  assert(source.status === 0, 'source identity unavailable');
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' });
  assert(dirty.status === 0 && !dirty.stdout.trim(), 'commit the reviewed tracked source before binding the artifact');
  const receipt = { ...result, sourceCommit: source.stdout.trim(), privateContractSha256: digest(contract), artifactSha256: digest(module), artifactBytes: module.byteLength, preparedAt: new Date().toISOString(), build: 'Wrangler deploy --dry-run with default retained configuration; no --env override' };
  writeFileSync(resolve(output, 'preparation-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { configPath: 'wrangler.toml' };
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift();
      if (flag === '--bundle') options.build = true;
      else if (['--config', '--contract', '--out'].includes(flag) && args[0] && !args[0].startsWith('--')) {
        options[{ '--config': 'configPath', '--contract': 'contractPath', '--out': 'outputDir' }[flag]] = args.shift();
      } else throw new Error('usage: prepare-retained-core-release.mjs --contract PRIVATE_JSON [--config wrangler.toml] [--bundle --out NEW_PRIVATE_DIRECTORY]');
    }
    assert(options.contractPath, 'private preparation contract required');
    console.log(JSON.stringify(prepareRetainedCore(options), null, 2));
  } catch (error) {
    console.error(`Retained Core preparation refused: ${error.message}`);
    process.exitCode = 1;
  }
}
