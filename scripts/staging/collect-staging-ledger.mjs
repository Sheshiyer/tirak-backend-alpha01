import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  assertCredentialGitBoundary,
  createCloudflareReadOnlyClient,
  DEFAULT_STAGING_ENV_FILE,
  extractSafeWorkerBindings,
  extractSafeWorkerRuntime,
  filterConfiguredWorkerBindings,
  loadStagingCredentials,
  PINNED_TIRAK_ACCOUNT_ID,
  requireNonnegativeSafeInteger,
  requireMatchingServingProjection,
  SafeCloudflareError,
} from './cloudflare-read-only-client.mjs';
import {
  CONTRACT_VERSION,
  buildSafeResourceDiagnostics,
  READ_ONLY_AUTHORIZATION,
  REST_METADATA_VARIANCE,
  TASK_ID,
  evaluateStagingEvidence,
  isStagingName,
  parseStagingConfig,
  publicConfiguredSummary,
} from './staging-ledger-lib.mjs';

const args = process.argv.slice(2);
const allowedOptions = new Set(['--environment', '--config', '--output', '--credential-mode']);
for (let index = 0; index < args.length; index += 2) {
  if (!allowedOptions.has(args[index]) || args[index + 1] === undefined) {
    console.error('T-025 staging discovery refused: unsupported or incomplete command option');
    process.exit(1);
  }
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const environment = option('--environment', 'staging');
const credentialMode = option('--credential-mode', 'owner-only-file');
const configPath = resolveWithinProject(option('--config', 'wrangler.toml'), 'configuration');
const outputPath = resolveWithinProject(option('--output', 'docs/execution/phase-2/t-025-staging-resource-ledger.json'), 'ledger output');
const envFilePath = resolve(DEFAULT_STAGING_ENV_FILE);

function fail(message) {
  console.error(`T-025 staging discovery refused: ${message}`);
  process.exit(1);
}

function resolveWithinProject(candidate, label) {
  const path = resolve(candidate);
  const projectRelative = relative(process.cwd(), path);
  if (!projectRelative || projectRelative.startsWith('..') || isAbsolute(projectRelative)) {
    if (!projectRelative && label === 'ledger output') fail(`${label} cannot be the project directory`);
    if (projectRelative.startsWith('..') || isAbsolute(projectRelative)) fail(`${label} must remain inside the project worktree`);
  }
  return path;
}

function isCollectorOwnedSelect(sql) {
  return sql === 'SELECT user_version FROM pragma_user_version'
    || sql === "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    || sql === "SELECT COUNT(*) AS user_table_count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"
    || sql === 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id'
    || /^SELECT COUNT\(\*\) AS row_count FROM "[A-Za-z_][A-Za-z0-9_]*"$/.test(sql);
}

function atomicWritePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const realParent = realpathSync(dirname(path));
  const parentRelative = relative(process.cwd(), realParent);
  if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) {
    throw new SafeCloudflareError('ledger output parent resolves outside the project worktree', 'OUTPUT_PARENT_REFUSED');
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SafeCloudflareError('ledger output must be a regular file, not a symlink', 'OUTPUT_FILE_TYPE');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort only */ }
    throw error;
  }
}

function loadPriorHumanConfirmation(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
      throw new SafeCloudflareError('prior ledger must be a bounded owner-only regular file, not a symlink', 'PRIOR_LEDGER_UNSAFE');
    }
    if ((stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new SafeCloudflareError('prior ledger must remain owner-only', 'PRIOR_LEDGER_UNSAFE');
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.taskId !== TASK_ID || parsed?.contractVersion !== CONTRACT_VERSION || parsed?.environment !== 'staging') {
      throw new SafeCloudflareError('prior ledger contract identity is invalid', 'PRIOR_LEDGER_UNSAFE');
    }
    return parsed.humanConfirmation ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SafeCloudflareError) throw error;
    throw new SafeCloudflareError('prior ledger could not be validated safely', 'PRIOR_LEDGER_UNSAFE');
  }
}

function normalizeName(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.name ?? entry?.title ?? entry?.queue_name ?? entry?.id ?? entry?.script_name ?? null;
}

function normalizeId(entry) {
  return entry?.uuid ?? entry?.id ?? entry?.database_id ?? entry?.queue_id ?? null;
}

function d1Rows(result) {
  if (Array.isArray(result)) {
    return result.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  }
  return Array.isArray(result?.results) ? result.results : [];
}

function localMigrationNames() {
  const migrationsPath = resolve('migrations');
  const names = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+[A-Za-z0-9_.-]*\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const prefixes = new Map();
  for (const name of names) {
    const prefix = name.match(/^(\d+)/)?.[1];
    const matches = prefixes.get(prefix) ?? [];
    matches.push(name);
    prefixes.set(prefix, matches);
  }
  const anomalies = [...prefixes.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([prefix, files]) => ({
      code: 'LOCAL_MIGRATION_PREFIX_DUPLICATE',
      prefix,
      files: [...files].sort(),
    }));
  return {
    names,
    lineage: anomalies.length > 0
      ? {
        status: 'blocked_pending_T028',
        anomalies,
        t028Blocked: true,
        mutationAuthorized: false,
      }
      : {
        status: 'clear',
        anomalies: [],
        t028Blocked: false,
        mutationAuthorized: false,
      },
  };
}

function activeDeploymentSummary(result) {
  const deployments = Array.isArray(result) ? result : Array.isArray(result?.deployments) ? result.deployments : [];
  const latestActive = deployments.length > 0 ? [deployments[0]] : [];
  const summary = latestActive.map((deployment) => ({
    id: typeof deployment?.id === 'string' ? deployment.id : null,
    versionIds: (deployment?.versions ?? []).map((version) => version?.version_id ?? version?.id).filter(Boolean),
  }));
  const versionIds = [...new Set(summary.flatMap((deployment) => deployment.versionIds))];
  if (versionIds.length > 20 || versionIds.some((id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))) {
    throw new SafeCloudflareError('active Worker deployment exposed invalid or excessive version identifiers', 'WORKER_VERSION_INVALID');
  }
  return { deployments: summary, versionIds };
}

if (environment !== 'staging') fail('only the literal staging environment is permitted');
if (!['owner-only-file', 'absent-for-offline-test'].includes(credentialMode)) fail('unsupported credential mode');

try {
  const configStat = lstatSync(configPath);
  if (configStat.isSymbolicLink() || !configStat.isFile()) fail('configuration path must be a regular file inside the project worktree');
  const realConfigPath = realpathSync(configPath);
  const realConfigRelative = relative(process.cwd(), realConfigPath);
  if (realConfigRelative.startsWith('..') || isAbsolute(realConfigRelative)) fail('configuration path resolves outside the project worktree');
} catch (error) {
  if (error?.code === 'ENOENT') fail('configuration file is missing');
  throw error;
}
const configText = readFileSync(configPath, 'utf8');
const configured = parseStagingConfig(configText);
if (configured.accountId !== PINNED_TIRAK_ACCOUNT_ID) fail('wrangler.toml does not contain the pinned Tirak account');
let priorHumanConfirmation;
try {
  priorHumanConfirmation = loadPriorHumanConfirmation(outputPath);
} catch (error) {
  fail(error instanceof SafeCloudflareError ? error.message : 'prior ledger validation failed');
}

let credentials;
try {
  if (credentialMode === 'absent-for-offline-test') {
    credentials = {
      token: '',
      accountId: PINNED_TIRAK_ACCOUNT_ID,
      authorization: process.env.TIRAK_STAGING_READ_ONLY_AUTHORIZATION || '',
      credentialPresent: false,
      source: 'forced-absent-offline-test',
    };
  } else {
    assertCredentialGitBoundary({ envFilePath });
    credentials = loadStagingCredentials({ envFilePath, allowMissing: true });
  }
} catch (error) {
  fail(error instanceof SafeCloudflareError ? error.message : 'staging credential file validation failed');
}
if (credentials.authorization !== READ_ONLY_AUTHORIZATION) {
  fail(`set TIRAK_STAGING_READ_ONLY_AUTHORIZATION=${READ_ONLY_AUTHORIZATION} to acknowledge the read-only T-024 boundary`);
}

let evidence = {
  account: {
    authenticated: false,
    targetAccountPresent: false,
    identitiesRedacted: true,
  },
  credential: {
    present: credentials.credentialPresent,
    source: credentials.source,
    tokenCaptured: false,
    scopeInspected: false,
    pinnedAccountIncluded: false,
    permissionRisk: null,
  },
  acceptanceVariance: REST_METADATA_VARIANCE,
};
let requestLog = [];

if (credentials.credentialPresent) {
  const client = createCloudflareReadOnlyClient({
    token: credentials.token,
    accountId: credentials.accountId,
    workerName: configured.worker,
    selectTemplateValidator: isCollectorOwnedSelect,
  });
  requestLog = client.requestLog;
  try {
    const tokenScope = await client.inspectCurrentTokenScope();
    if (!tokenScope.active || tokenScope.pinnedAccountIncluded !== true) {
      throw new SafeCloudflareError('current-token policies did not include the pinned Tirak account', 'TOKEN_ACCOUNT_SCOPE_MISSING');
    }
    evidence.credential.scopeInspected = true;
    evidence.credential.pinnedAccountIncluded = true;
    evidence.credential.permissionRisk = tokenScope.permissionRisk;

    const accountResponse = await client.request('GET', `/accounts/${credentials.accountId}`);
    if (accountResponse.result?.id !== PINNED_TIRAK_ACCOUNT_ID) {
      throw new SafeCloudflareError('authenticated Cloudflare account does not match the pinned Tirak account', 'ACCOUNT_MISMATCH');
    }
    evidence.account = {
      authenticated: true,
      targetAccountPresent: true,
      verifiedAccountId: PINNED_TIRAK_ACCOUNT_ID,
      identitiesRedacted: true,
    };
    evidence.credential.verificationType = tokenScope.verificationType;

    const workerList = await client.list(`/accounts/${credentials.accountId}/workers/scripts`);
    const matchingWorkers = workerList.filter((entry) => normalizeName(entry) === configured.worker);
    let activeWorker = { deployments: [], versionIds: [] };
    let activeBindings = null;
    let activeRuntime = null;
    if (matchingWorkers.length === 1) {
      const deploymentResponse = await client.request('GET', `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(configured.worker)}/deployments`);
      activeWorker = activeDeploymentSummary(deploymentResponse.result);
      for (const versionId of activeWorker.versionIds) {
        const versionResponse = await client.request('GET', `/accounts/${credentials.accountId}/workers/scripts/${encodeURIComponent(configured.worker)}/versions/${versionId}`);
        const versionBindings = filterConfiguredWorkerBindings(extractSafeWorkerBindings(versionResponse.result), configured);
        activeBindings = requireMatchingServingProjection(activeBindings, versionBindings, 'staging resource bindings');
        const versionRuntime = extractSafeWorkerRuntime(versionResponse.result);
        activeRuntime = requireMatchingServingProjection(activeRuntime, versionRuntime, 'staging safety runtime');
      }
    }
    activeBindings ??= [];
    evidence.workers = matchingWorkers.map(() => ({
      name: configured.worker,
      deploymentCount: activeWorker.deployments.length,
      activeVersionIds: activeWorker.versionIds,
      activeBindingsVerified: activeWorker.versionIds.length > 0 && activeBindings.length > 0,
    }));
    evidence.workerRuntime = activeRuntime;

    const databaseList = await client.list(`/accounts/${credentials.accountId}/d1/database`);
    const matchingDatabases = databaseList.filter((entry) => normalizeName(entry) === configured.database[0]?.name);
    evidence.databases = matchingDatabases.map((entry) => ({ name: normalizeName(entry), uuid: normalizeId(entry) }));

    const kvList = await client.list(`/accounts/${credentials.accountId}/storage/kv/namespaces`);
    evidence.kvNamespaces = configured.kv.flatMap((configuredNamespace) => {
      const binding = activeBindings.filter((entry) => entry.type === 'kv_namespace' && entry.binding === configuredNamespace.binding);
      if (binding.length !== 1) return [];
      return kvList
        .filter((entry) => normalizeId(entry) === binding[0].id)
        .filter((entry) => isStagingName(normalizeName(entry)))
        .map((entry) => ({ binding: configuredNamespace.binding, title: normalizeName(entry), id: normalizeId(entry) }));
    });

    const expectedBuckets = new Set(configured.r2.map((entry) => entry.name));
    const r2List = await client.list(`/accounts/${credentials.accountId}/r2/buckets`);
    evidence.r2Buckets = r2List
      .filter((entry) => expectedBuckets.has(normalizeName(entry)))
      .filter((entry) => activeBindings.some((binding) => binding.type === 'r2_bucket'
        && configured.r2.some((configuredBucket) => configuredBucket.binding === binding.binding && configuredBucket.name === binding.name)
        && binding.name === normalizeName(entry)))
      .map((entry) => ({ name: normalizeName(entry) }));

    const expectedQueues = new Set([
      ...configured.queues.producers.map((entry) => entry.name),
      ...configured.queues.consumers.flatMap((entry) => [entry.name, entry.deadLetterQueue]),
    ]);
    const queueList = await client.list(`/accounts/${credentials.accountId}/queues`);
    evidence.queues = queueList.filter((entry) => expectedQueues.has(normalizeName(entry))).map((entry) => ({ name: normalizeName(entry), id: normalizeId(entry) }));

    const durableObjectList = await client.list(`/accounts/${credentials.accountId}/workers/durable_objects/namespaces`);
    evidence.durableObjects = configured.durableObjects.flatMap((binding) => durableObjectList
      .filter((entry) => (entry.class ?? entry.class_name) === binding.className && (entry.script ?? entry.script_name) === configured.worker)
      .filter((entry) => activeBindings.some((active) => active.type === 'durable_object_namespace'
        && active.binding === binding.binding && active.className === binding.className
        && (!active.namespaceId || active.namespaceId === normalizeId(entry))))
      .map((entry) => ({
        binding: binding.binding,
        className: binding.className,
        namespaceId: normalizeId(entry),
        script: configured.worker,
        useSqlite: entry.use_sqlite === true,
      })));

    try {
      evidence.resourceDiagnostics = buildSafeResourceDiagnostics({
        resources: {
          workers: workerList,
          d1Databases: databaseList,
          kvNamespaces: kvList,
          r2Buckets: r2List,
          queues: queueList,
          durableObjects: durableObjectList,
        },
        unresolvedFrozenMatches: {
          workers: matchingWorkers.length !== 1,
          d1Databases: matchingDatabases.length !== 1,
          kvNamespaces: configured.kv.some((namespace) => evidence.kvNamespaces
            .filter((entry) => entry.binding === namespace.binding).length !== 1),
          r2Buckets: configured.r2.some((bucket) => evidence.r2Buckets
            .filter((entry) => normalizeName(entry) === bucket.name).length !== 1),
          queues: [...expectedQueues].some((queueName) => evidence.queues
            .filter((entry) => normalizeName(entry) === queueName).length !== 1),
          durableObjects: configured.durableObjects.some((binding) => evidence.durableObjects
            .filter((entry) => entry.binding === binding.binding && entry.className === binding.className).length !== 1),
        },
      });
    } catch (error) {
      throw new SafeCloudflareError(error instanceof Error ? error.message : 'resource diagnostics were unsafe', 'RESOURCE_DIAGNOSTIC_INVALID');
    }

    if (matchingDatabases.length === 1) {
      const databaseId = normalizeId(matchingDatabases[0]);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(databaseId ?? '')) {
        throw new SafeCloudflareError('unique staging D1 database did not expose a valid UUID', 'D1_ID_INVALID');
      }
      const activeDatabaseBindings = activeBindings.filter((entry) => entry.type === 'd1' && entry.binding === configured.database[0].binding);
      if (activeDatabaseBindings.length !== 1 || activeDatabaseBindings[0].id !== databaseId) {
        throw new SafeCloudflareError('active Worker DB binding does not match the unique staging D1 database', 'WORKER_D1_BINDING_MISMATCH');
      }
      const detail = await client.request('GET', `/accounts/${credentials.accountId}/d1/database/${databaseId}`);
      if (normalizeId(detail.result) !== databaseId || normalizeName(detail.result) !== configured.database[0].name) {
        throw new SafeCloudflareError('D1 detail did not match the uniquely selected staging database', 'D1_DETAIL_MISMATCH');
      }
      evidence.workerBindings = activeBindings.filter((binding) => {
        if (binding.type === 'd1') return binding.id === databaseId;
        if (binding.type === 'kv_namespace') {
          return evidence.kvNamespaces.some((entry) => entry.binding === binding.binding && entry.id === binding.id);
        }
        if (binding.type === 'r2_bucket') return evidence.r2Buckets.some((entry) => entry.name === binding.name);
        if (binding.type === 'queue') return evidence.queues.some((entry) => entry.name === binding.name);
        if (binding.type === 'durable_object_namespace') {
          return evidence.durableObjects.some((entry) => entry.binding === binding.binding
            && entry.className === binding.className && (!binding.namespaceId || entry.namespaceId === binding.namespaceId));
        }
        return false;
      });
      const queryRequest = (sql, allowHttpFailure = false) => client.request(
        'POST',
        `/accounts/${credentials.accountId}/d1/database/${databaseId}/query`,
        { sql, allowHttpFailure },
      );
      const query = async (sql) => {
        const response = await queryRequest(sql);
        return d1Rows(response.result);
      };
      const versionResponse = await queryRequest('SELECT user_version FROM pragma_user_version', true);
      let userVersion = null;
      let schemaUserVersionEvidence;
      if (versionResponse.ok === true) {
        const versionRows = d1Rows(versionResponse.result);
        userVersion = requireNonnegativeSafeInteger(versionRows[0]?.user_version, 'D1 schema user_version');
        schemaUserVersionEvidence = { source: 'read-only-select', directReadStatus: 'accepted' };
      } else if (versionResponse.status === 400
        && JSON.stringify(versionResponse.errorCodes) === JSON.stringify([7500])) {
        schemaUserVersionEvidence = {
          source: 'fresh-empty-d1-invariant',
          directReadStatus: 'cloudflare-sqlite-auth-refused',
          providerErrorCode: 7500,
        };
      } else {
        throw new SafeCloudflareError('D1 schema user_version could not be captured or bounded safely', 'D1_SCHEMA_VERSION_UNAVAILABLE');
      }
      const platformVersion = detail.result?.version ?? matchingDatabases[0]?.version;
      const tableRows = await query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
      const tableNames = tableRows.map((row) => row?.name);
      if (tableNames.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        || new Set(tableNames).size !== tableNames.length
        || JSON.stringify(tableNames) !== JSON.stringify([...tableNames].sort())) {
        throw new SafeCloudflareError('sqlite_schema table inventory was malformed or inconsistent', 'D1_SCHEMA_EVIDENCE_INVALID');
      }
      const userTableNames = tableNames.filter((name) => name !== 'd1_migrations');
      const userTableCountRows = await query("SELECT COUNT(*) AS user_table_count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'");
      if (userTableCountRows.length !== 1) {
        throw new SafeCloudflareError('sqlite_schema user-table count result was malformed', 'D1_SCHEMA_EVIDENCE_INVALID');
      }
      const userTableCount = requireNonnegativeSafeInteger(userTableCountRows[0]?.user_table_count, 'sqlite_schema user-table count');
      if (userTableCount !== userTableNames.length) {
        throw new SafeCloudflareError('sqlite_schema user-table count disagreed with the explicit table inventory', 'D1_SCHEMA_EVIDENCE_INVALID');
      }
      evidence.schemaInventory = {
        source: 'sqlite_schema',
        excludedInternalTables: ['sqlite_%', '_cf_%', 'd1_migrations'],
        userTableCount,
        userTableNames,
        migrationLedgerTablePresent: tableNames.includes('d1_migrations'),
      };
      evidence.rowCounts = {};
      for (const tableName of tableNames) {
        const countRows = await query(`SELECT COUNT(*) AS row_count FROM "${tableName}"`);
        evidence.rowCounts[tableName] = requireNonnegativeSafeInteger(countRows[0]?.row_count, `row count for ${tableName}`);
      }
      evidence.migrationLedger = tableNames.includes('d1_migrations')
        ? await query('SELECT id, name, applied_at FROM d1_migrations ORDER BY id')
        : [];
      if (userVersion === null) {
        const remoteReportedTableCount = detail.result?.num_tables;
        if (userTableCount !== 0 || tableNames.length !== 0 || evidence.migrationLedger.length !== 0
          || remoteReportedTableCount !== 0) {
          throw new SafeCloudflareError('D1 user_version inference requires a provider-reported pristine empty database', 'D1_SCHEMA_VERSION_UNAVAILABLE');
        }
        userVersion = 0;
        schemaUserVersionEvidence.remoteReportedTableCount = remoteReportedTableCount;
      }
      evidence.databaseInfo = {
        id: databaseId,
        name: configured.database[0].name,
        storageVersion: typeof platformVersion === 'string' ? platformVersion : '',
        schemaUserVersion: userVersion,
        schemaUserVersionEvidence,
        fileSize: Number.isSafeInteger(detail.result?.file_size) ? detail.result.file_size : null,
        reportedTableCount: Number.isSafeInteger(detail.result?.num_tables) ? detail.result.num_tables : null,
      };
      const applied = new Set(evidence.migrationLedger.map((entry) => entry.name).filter((name) => typeof name === 'string'));
      const localMigrations = localMigrationNames();
      evidence.pendingMigrations = localMigrations.names.filter((name) => !applied.has(name));
      evidence.migrationLineage = localMigrations.lineage;
      evidence.proposedConfiguration = {
        database: [{ binding: configured.database[0].binding, name: configured.database[0].name, id: databaseId }],
        kv: configured.kv.map((entry) => ({
          binding: entry.binding,
          id: evidence.kvNamespaces.find((candidate) => candidate.binding === entry.binding)?.id ?? null,
        })),
      };
    }
  } catch (error) {
    evidence.discoveryError = error instanceof SafeCloudflareError
      ? { code: error.code, message: error.message }
      : { code: 'UNEXPECTED_DISCOVERY_FAILURE', message: 'unexpected read-only discovery failure' };
  }
} else {
  evidence.discoveryError = {
    code: 'TOKEN_MISSING',
    message: `Cloudflare API token is absent; create owner-only ${DEFAULT_STAGING_ENV_FILE} locally and rerun`,
  };
}

const evaluation = evaluateStagingEvidence(configured, evidence, priorHumanConfirmation);
const manifest = {
  schemaVersion: 2,
  taskId: TASK_ID,
  contractVersion: CONTRACT_VERSION,
  generatedAt: new Date().toISOString(),
  environment: 'staging',
  authority: 'T-024 approved authenticated read-only staging evidence only',
  discoveryTransport: 'Cloudflare REST API token through fixed read-only client',
  discoveryState: evaluation.status === 'HUMAN_CONFIRMED_STAGING_IDENTITIES'
    ? 'READ_ONLY_EVIDENCE_HUMAN_CONFIRMED'
    : evaluation.status === 'HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION'
      ? 'READ_ONLY_EVIDENCE_HUMAN_CONFIRMED_WITH_CONFIG_BLOCKER'
      : evaluation.resourcesVerified
        ? 'READ_ONLY_EVIDENCE_COMPLETE'
    : evidence.account?.targetAccountPresent === true && Array.isArray(evidence.migrationLedger) && evidence.rowCounts
      ? 'READ_ONLY_EVIDENCE_CAPTURED_WITH_ACCEPTANCE_BLOCKERS'
      : 'HALTED_FAIL_CLOSED',
  ...evaluation,
  configured: publicConfiguredSummary(configured),
  evidence,
  requestLog,
  secretsCaptured: false,
  productionCommandsExecuted: 0,
  remoteMutationsExecuted: 0,
  t026Blocked: evaluation.status !== 'HUMAN_CONFIRMED_STAGING_IDENTITIES',
  requiredNextAction: evaluation.status === 'HUMAN_CONFIRMED_STAGING_IDENTITIES'
    ? 'T-025 accepted; T-026 remains separately evidence-gated and mutation remains unauthorized.'
    : evaluation.status === 'HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION'
      ? 'Replace only the staging D1/KV placeholder identities with exact proposedConfiguration values, then rerun discovery to revalidate this same approval fingerprint.'
      : evaluation.resourcesVerified
        ? 'Human release owner must confirm targetFingerprint before any local configuration correction or T-026 work.'
    : credentials.credentialPresent
      ? 'Resolve each read-only evidence blocker, then rerun. Do not guess resource identities.'
      : `Copy .env.example to ${DEFAULT_STAGING_ENV_FILE}, set the token locally, chmod 0600, and rerun. Never commit or paste the token.`,
};

try {
  atomicWritePrivateJson(outputPath, manifest);
} catch (error) {
  fail(error instanceof SafeCloudflareError ? error.message : 'owner-only ledger write failed');
}
console.log(JSON.stringify({
  status: manifest.status,
  discoveryState: manifest.discoveryState,
  blockerCodes: [...new Set(manifest.blockers.map((entry) => entry.code))],
  targetFingerprint: manifest.targetFingerprint,
  requestsExecuted: requestLog.length,
  productionCommandsExecuted: 0,
  remoteMutationsExecuted: 0,
  secretsCaptured: false,
  output: outputPath,
}, null, 2));

if (!evaluation.resourcesVerified) process.exitCode = 2;
