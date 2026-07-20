import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONTRACT_VERSION,
  READ_ONLY_AUTHORIZATION,
  TASK_ID,
  evaluateStagingEvidence,
  parseStagingConfig,
  publicConfiguredSummary,
  sha256,
} from './staging-ledger-lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const environment = option('--environment', 'staging');
const configPath = resolve(option('--config', 'wrangler.toml'));
const outputPath = resolve(option('--output', 'docs/execution/phase-2/t-025-staging-resource-ledger.json'));

function fail(message) {
  console.error(`T-025 staging discovery refused: ${message}`);
  process.exit(1);
}

if (environment !== 'staging') fail('only the literal staging environment is permitted');
if (process.env.TIRAK_STAGING_READ_ONLY_AUTHORIZATION !== READ_ONLY_AUTHORIZATION) {
  fail(`set TIRAK_STAGING_READ_ONLY_AUTHORIZATION=${READ_ONLY_AUTHORIZATION} to acknowledge the read-only T-024 boundary`);
}

const configText = readFileSync(configPath, 'utf8');
const configured = parseStagingConfig(configText);
const commandLog = [];

function wrangler(label, commandArgs, { json = false, allowFailure = false } = {}) {
  const joined = commandArgs.join(' ');
  if (/(^|\s)(production|prod|live)(\s|$)/i.test(joined)) fail(`production-like command refused: ${label}`);
  if (commandArgs[0] === 'd1' && commandArgs[1] === 'execute') {
    const sql = commandArgs[commandArgs.indexOf('--command') + 1] ?? '';
    if (!/^SELECT\b/i.test(sql.trim()) || /;\s*\S/.test(sql) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/i.test(sql)) {
      fail(`non-read-only SQL refused: ${label}`);
    }
  }
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...commandArgs, '--config', configPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  commandLog.push({ label, command: ['wrangler', ...commandArgs.map((entry, index) => commandArgs[index - 1] === '--command' ? '<read-only-select>' : entry)], exitCode: result.status });
  if (result.status !== 0 && !allowFailure) throw new Error(`${label} failed without exposing command output`);
  if (result.status !== 0) return null;
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function rows(result) {
  if (Array.isArray(result)) {
    if (result.length === 1 && Array.isArray(result[0]?.results)) return result[0].results;
    return result;
  }
  return Array.isArray(result?.results) ? result.results : [];
}

function normalizedAccountEvidence(whoami) {
  const memberships = whoami.accounts ?? whoami.memberships ?? [];
  const ids = memberships.map((entry) => entry.id ?? entry.account_id ?? entry.accountId).filter(Boolean);
  return {
    authenticated: true,
    targetAccountPresent: ids.includes(configured.accountId),
    observedMembershipCount: ids.length,
    observedAccountIdsDigest: sha256(ids.sort()),
    identitiesRedacted: true,
  };
}

function exactNamesPresent(text, expectedNames) {
  const output = String(text ?? '');
  return [...new Set(expectedNames)].filter((name) => output.includes(name)).map((name) => ({ name }));
}

function arrayFrom(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function extractBindings(valueToSearch) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const binding = value.binding ?? value.name;
    const className = value.class_name ?? value.className;
    if (typeof binding === 'string' && typeof className === 'string') found.push({ binding, className });
    Object.values(value).forEach(visit);
  };
  visit(valueToSearch);
  return [...new Map(found.map((entry) => [`${entry.binding}:${entry.className}`, entry])).values()];
}

let evidence;
try {
  const whoami = wrangler('authenticated account membership', ['whoami', '--json'], { json: true });
  const account = normalizedAccountEvidence(whoami);
  evidence = { account };

  if (account.targetAccountPresent) {
    const databases = arrayFrom(wrangler('D1 database list', ['d1', 'list', '--json'], { json: true }), ['databases', 'd1_databases', 'items']);
    const d1Candidate = databases.filter((entry) => (entry.name ?? entry.database_name) === configured.database[0]?.name);
    const kvRaw = wrangler('KV namespace list', ['kv', 'namespace', 'list']);
    const r2Raw = wrangler('R2 bucket list', ['r2', 'bucket', 'list']);
    const queueRaw = wrangler('queue and DLQ list', ['queues', 'list']);
    const deployments = arrayFrom(wrangler('staging Worker deployments', ['deployments', 'list', '--name', configured.worker, '--json'], { json: true, allowFailure: true }), ['deployments', 'items']);
    const versions = arrayFrom(wrangler('staging Worker versions', ['versions', 'list', '--name', configured.worker, '--json'], { json: true, allowFailure: true }), ['versions', 'items']);
    const latestVersionId = versions[0]?.id ?? versions[0]?.version_id ?? versions.items?.[0]?.id ?? null;
    const version = latestVersionId
      ? wrangler('staging Worker version bindings', ['versions', 'view', latestVersionId, '--name', configured.worker, '--json'], { json: true })
      : null;

    evidence.workers = deployments.length || versions.length ? [{ name: configured.worker, deployments, versions }] : [];
    evidence.databases = databases;
    evidence.kvNamespaces = (() => {
      let namespaces;
      try { namespaces = arrayFrom(JSON.parse(kvRaw), ['namespaces', 'items']); } catch { namespaces = []; }
      return namespaces.map((entry) => {
        const title = entry.title ?? entry.name ?? '';
        const binding = /cache/i.test(title) ? 'CACHE' : /session/i.test(title) ? 'SESSIONS' : null;
        return { ...entry, binding };
      }).filter((entry) => entry.binding && /staging/i.test(entry.title ?? entry.name ?? ''));
    })();
    evidence.r2Buckets = exactNamesPresent(r2Raw, configured.r2.map((entry) => entry.name));
    evidence.queues = exactNamesPresent(queueRaw, [
      ...configured.queues.producers.map((entry) => entry.name),
      ...configured.queues.consumers.map((entry) => entry.deadLetterQueue),
    ]);
    evidence.durableObjects = extractBindings(version);

    if (d1Candidate.length === 1) {
      const databaseName = configured.database[0].name;
      const info = wrangler('D1 database info', ['d1', 'info', databaseName, '--json'], { json: true });
      evidence.databaseInfo = {
        id: info.uuid ?? info.id ?? info.database_id ?? d1Candidate[0].uuid,
        name: info.name ?? databaseName,
        storageVersion: String(info.version ?? info.storage_version ?? info.storageVersion ?? ''),
        fileSize: info.file_size ?? info.fileSize ?? null,
      };
      const tableResult = wrangler('D1 table-name inventory', ['d1', 'execute', databaseName, '--env', 'staging', '--remote', '--json', '--command',
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"], { json: true });
      const tableNames = rows(tableResult).map((row) => row.name).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      evidence.rowCounts = {};
      for (const tableName of tableNames) {
        const countResult = wrangler(`row count ${tableName}`, ['d1', 'execute', databaseName, '--env', 'staging', '--remote', '--json', '--command',
          `SELECT COUNT(*) AS row_count FROM "${tableName}"`], { json: true });
        evidence.rowCounts[tableName] = Number(rows(countResult)[0]?.row_count);
      }
      if (tableNames.includes('d1_migrations')) {
        const ledgerResult = wrangler('D1 migration ledger SELECT', ['d1', 'execute', databaseName, '--env', 'staging', '--remote', '--json', '--command',
          'SELECT id, name, applied_at FROM d1_migrations ORDER BY id'], { json: true });
        evidence.migrationLedger = rows(ledgerResult);
      } else {
        evidence.migrationLedger = [];
      }
      const migrationsText = wrangler('Wrangler unapplied migration list', ['d1', 'migrations', 'list', databaseName, '--env', 'staging', '--remote']);
      evidence.pendingMigrations = [...new Set(String(migrationsText).match(/\b\d+[_-][A-Za-z0-9_.-]+\.sql\b/g) ?? [])];
    }
  }
} catch (error) {
  evidence ??= { account: { authenticated: false, targetAccountPresent: false, identitiesRedacted: true } };
  evidence.discoveryError = error.message;
}

const evaluation = evaluateStagingEvidence(configured, evidence);
const manifest = {
  schemaVersion: 1,
  taskId: TASK_ID,
  contractVersion: CONTRACT_VERSION,
  generatedAt: new Date().toISOString(),
  environment: 'staging',
  authority: 'T-024 approved authenticated read-only staging evidence only',
  discoveryState: evaluation.resourcesVerified ? 'READ_ONLY_EVIDENCE_COMPLETE' : 'HALTED_FAIL_CLOSED',
  ...evaluation,
  configured: publicConfiguredSummary(configured),
  evidence,
  commandLog,
  secretsCaptured: false,
  productionCommandsExecuted: 0,
  remoteMutationsExecuted: 0,
  requiredNextAction: evaluation.resourcesVerified
    ? 'Human release owner must confirm targetFingerprint before any local configuration correction or later remote mutation.'
    : 'Authenticate Wrangler into the pinned Tirak account or resolve each blocker, then rerun read-only discovery. Do not guess identities.',
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  status: manifest.status,
  discoveryState: manifest.discoveryState,
  blockerCodes: [...new Set(manifest.blockers.map((entry) => entry.code))],
  targetFingerprint: manifest.targetFingerprint,
  commandsExecuted: commandLog.length,
  productionCommandsExecuted: 0,
  remoteMutationsExecuted: 0,
  output: outputPath,
}, null, 2));

if (!evaluation.resourcesVerified) process.exitCode = 2;
