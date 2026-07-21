import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 'tirak-payments-v1';
export const TASK_ID = 'T-025';
export const READ_ONLY_AUTHORIZATION = 'T-024_APPROVED_READ_ONLY';
export const CONFIRMATION_STATEMENT =
  'I confirm the T-025 staging resource ledger fingerprint and authorize the listed staging identities for later evidence-gated staging work. This does not authorize production access, deployment, migration application, secret mutation, live Omise charging, or App Store submission.';
export const REST_METADATA_VARIANCE_ID = 'CLOUDFLARE_OFFICIAL_REST_READ_ONLY_METADATA';
export const REST_METADATA_VARIANCE = Object.freeze({
  id: REST_METADATA_VARIANCE_ID,
  status: 'PROPOSED_OWNER_CONFIRMATION_REQUIRED',
  requestedContractTransport: 'Wrangler authenticated metadata',
  proposedTransport: 'Cloudflare official REST API with a deny-by-default read-only client',
  reason: 'Wrangler OAuth did not provide the authenticated staging metadata path required by T-025.',
  confirmationMechanism: 'The human release owner confirms the exact targetFingerprint, which includes this variance proposal.',
});
export const RESOURCE_DIAGNOSTIC_LIMITS = Object.freeze({
  maxObservedPerResourceType: 10_000,
  maxObservedTotal: 60_000,
  maxCandidatesPerResourceType: 20,
  maxCandidatesTotal: 100,
});
export const D1_SCHEMA_INTERNAL_EXCLUSIONS = Object.freeze(['sqlite_%', '_cf_%', 'd1_migrations']);

const DIAGNOSTIC_RESOURCE_TYPES = Object.freeze([
  'workers', 'd1Databases', 'kvNamespaces', 'r2Buckets', 'queues', 'durableObjects',
]);
const SAFE_RESOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const STRICT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STRICT_HEX_ID = /^[a-f0-9]{32}$/i;
const SAFE_CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function value(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
}

function sectionBodies(config, header) {
  const lines = config.split('\n');
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== header) continue;
    const body = [];
    for (index += 1; index < lines.length && !lines[index].trim().startsWith('['); index += 1) {
      body.push(lines[index]);
    }
    bodies.push(body.join('\n'));
    index -= 1;
  }
  return bodies;
}

function scalarSection(config, section) {
  return sectionBodies(config, `[${section}]`)[0] ?? '';
}

function arraySections(config, section) {
  return sectionBodies(config, `[[${section}]]`);
}

export function parseStagingConfig(config) {
  const accountId = value(config, 'account_id');
  const environment = scalarSection(config, 'env.staging');
  const variables = scalarSection(config, 'env.staging.vars');
  const database = arraySections(config, 'env.staging.d1_databases').map((block) => ({
    binding: value(block, 'binding'),
    name: value(block, 'database_name'),
    id: value(block, 'database_id'),
  }));
  const kv = arraySections(config, 'env.staging.kv_namespaces').map((block) => ({
    binding: value(block, 'binding'),
    id: value(block, 'id'),
  }));
  const r2 = arraySections(config, 'env.staging.r2_buckets').map((block) => ({
    binding: value(block, 'binding'),
    name: value(block, 'bucket_name'),
  }));
  const queueProducers = arraySections(config, 'env.staging.queues.producers').map((block) => ({
    binding: value(block, 'binding'),
    name: value(block, 'queue'),
  }));
  const queueConsumers = arraySections(config, 'env.staging.queues.consumers').map((block) => ({
    name: value(block, 'queue'),
    deadLetterQueue: value(block, 'dead_letter_queue'),
  }));
  const durableObjects = arraySections(config, 'env.staging.durable_objects.bindings').map((block) => ({
    binding: value(block, 'name'),
    className: value(block, 'class_name'),
  }));
  const durableObjectMigrations = arraySections(config, 'env.staging.migrations').map((block) => ({
    tag: value(block, 'tag'),
    newSqliteClasses: block.match(/new_sqlite_classes\s*=\s*\[([^\]]*)\]/)?.[1]
      ?.split(',').map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean) ?? [],
  }));

  return {
    accountId,
    worker: value(environment, 'name'),
    database,
    kv,
    r2,
    queues: { producers: queueProducers, consumers: queueConsumers },
    durableObjects,
    durableObjectMigrations,
    variables: {
      environment: value(variables, 'ENVIRONMENT'),
      paymentMode: value(variables, 'PAYMENT_MODE'),
      promptPayEnabled: value(variables, 'PROMPTPAY_ENABLED'),
    },
  };
}

export function containsPlaceholder(valueToCheck) {
  return typeof valueToCheck === 'string' && /placeholder|change[-_]?me|your[-_]/i.test(valueToCheck);
}

export function containsConfiguredPlaceholder(configured) {
  const visit = (candidate) => {
    if (typeof candidate === 'string') return containsPlaceholder(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate && typeof candidate === 'object') return Object.values(candidate).some(visit);
    return false;
  };
  return visit(configured);
}

export function isStagingName(valueToCheck) {
  return typeof valueToCheck === 'string'
    && /(?:^|[-_])staging(?:$|[-_])/.test(valueToCheck)
    && !/(?:^|[-_])production(?:$|[-_])|(?:^|[-_])prod(?:$|[-_])|(?:^|[-_])live(?:$|[-_])/i.test(valueToCheck);
}

function diagnosticName(entry, keys) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const key of keys) if (typeof entry[key] === 'string') return entry[key];
  return null;
}

function diagnosticId(entry, keys) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const key of keys) if (typeof entry[key] === 'string') return entry[key];
  return null;
}

function requireSafeDiagnosticName(name, label) {
  if (!isStagingName(name) || !SAFE_RESOURCE_NAME.test(name)
    || /(?:^|[-_])(?:production|prod|live)(?:$|[-_])/i.test(name)) {
    throw new Error(`${label} diagnostic candidate name was unsafe`);
  }
  return name;
}

function projectDiagnosticCandidate(type, entry) {
  // Returning null is the expected, acceptance-neutral result for an observed
  // resource whose minimized name does not satisfy the frozen staging boundary.
  if (type === 'workers') {
    const name = diagnosticName(entry, ['name', 'script_name']);
    if (!isStagingName(name)) return null;
    return { name: requireSafeDiagnosticName(name, 'Worker') };
  }
  if (type === 'd1Databases') {
    const name = diagnosticName(entry, ['name', 'database_name']);
    if (!isStagingName(name)) return null;
    const id = diagnosticId(entry, ['uuid', 'id', 'database_id']);
    if (!STRICT_UUID.test(id ?? '')) throw new Error('D1 diagnostic candidate identifier was malformed');
    return { name: requireSafeDiagnosticName(name, 'D1'), id };
  }
  if (type === 'kvNamespaces') {
    const name = diagnosticName(entry, ['title', 'name']);
    if (!isStagingName(name)) return null;
    const id = diagnosticId(entry, ['id', 'namespace_id']);
    if (!STRICT_HEX_ID.test(id ?? '')) throw new Error('KV diagnostic candidate identifier was malformed');
    return { name: requireSafeDiagnosticName(name, 'KV'), id };
  }
  if (type === 'r2Buckets') {
    const name = diagnosticName(entry, ['name', 'bucket_name']);
    if (!isStagingName(name)) return null;
    return { name: requireSafeDiagnosticName(name, 'R2') };
  }
  if (type === 'queues') {
    const name = diagnosticName(entry, ['name', 'queue_name']);
    if (!isStagingName(name)) return null;
    return { name: requireSafeDiagnosticName(name, 'Queue') };
  }
  if (type === 'durableObjects') {
    const name = diagnosticName(entry, ['script', 'script_name']);
    if (!isStagingName(name)) return null;
    const className = diagnosticName(entry, ['class', 'class_name']);
    if (!SAFE_CLASS_NAME.test(className ?? '') || /prod(?:uction)?|live/i.test(className)) {
      throw new Error('Durable Object diagnostic class name was malformed or production-like');
    }
    return {
      name: requireSafeDiagnosticName(name, 'Durable Object'),
      className,
      useSqlite: entry?.use_sqlite === true,
    };
  }
  throw new Error('unknown resource diagnostic type');
}

export function buildSafeResourceDiagnostics({ resources, unresolvedFrozenMatches }) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)
    || !unresolvedFrozenMatches || typeof unresolvedFrozenMatches !== 'object' || Array.isArray(unresolvedFrozenMatches)) {
    throw new Error('resource diagnostic inputs were malformed');
  }
  const observedCounts = {};
  const stagingCandidates = {};
  const unresolved = [];
  let observedTotal = 0;
  let candidateTotal = 0;
  for (const type of DIAGNOSTIC_RESOURCE_TYPES) {
    const entries = resources[type];
    if (!Array.isArray(entries)) throw new Error(`${type} diagnostic source was malformed`);
    if (entries.length > RESOURCE_DIAGNOSTIC_LIMITS.maxObservedPerResourceType) {
      throw new Error(`${type} observed count exceeded the diagnostic limit`);
    }
    observedCounts[type] = entries.length;
    observedTotal += entries.length;
    const includeCandidates = unresolvedFrozenMatches[type] === true;
    if (includeCandidates) unresolved.push(type);
    const candidates = includeCandidates
      ? entries.map((entry) => projectDiagnosticCandidate(type, entry)).filter(Boolean)
      : [];
    if (candidates.length > RESOURCE_DIAGNOSTIC_LIMITS.maxCandidatesPerResourceType) {
      throw new Error(`${type} candidate count exceeded the diagnostic limit`);
    }
    candidateTotal += candidates.length;
    stagingCandidates[type] = candidates;
  }
  if (observedTotal > RESOURCE_DIAGNOSTIC_LIMITS.maxObservedTotal) {
    throw new Error('total observed resource count exceeded the diagnostic limit');
  }
  if (candidateTotal > RESOURCE_DIAGNOSTIC_LIMITS.maxCandidatesTotal) {
    throw new Error('total staging candidate count exceeded the diagnostic limit');
  }
  return {
    informationalOnly: true,
    acceptanceEffect: 'NONE',
    mutationAllowed: false,
    fingerprintPolicy: {
      included: false,
      reason: 'Aggregate counts and unresolved staging candidates are troubleshooting context, not human-reviewed identity selections.',
    },
    limits: RESOURCE_DIAGNOSTIC_LIMITS,
    observedCounts: { ...observedCounts, total: observedTotal },
    unresolvedFrozenMatches: unresolved,
    stagingCandidates,
  };
}

export function validateSafeResourceDiagnostics(diagnostics) {
  try {
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) throw new Error('diagnostics missing');
    const expectedTopKeys = [
      'acceptanceEffect', 'fingerprintPolicy', 'informationalOnly', 'limits', 'mutationAllowed',
      'observedCounts', 'stagingCandidates', 'unresolvedFrozenMatches',
    ].sort();
    if (JSON.stringify(Object.keys(diagnostics).sort()) !== JSON.stringify(expectedTopKeys)) throw new Error('diagnostic fields invalid');
    if (diagnostics.informationalOnly !== true || diagnostics.acceptanceEffect !== 'NONE'
      || diagnostics.mutationAllowed !== false
      || JSON.stringify(Object.keys(diagnostics.fingerprintPolicy ?? {}).sort()) !== JSON.stringify(['included', 'reason'])
      || diagnostics.fingerprintPolicy?.included !== false
      || diagnostics.fingerprintPolicy?.reason !== 'Aggregate counts and unresolved staging candidates are troubleshooting context, not human-reviewed identity selections.') {
      throw new Error('diagnostic boundary invalid');
    }
    if (canonicalJson(diagnostics.limits) !== canonicalJson(RESOURCE_DIAGNOSTIC_LIMITS)) throw new Error('diagnostic limits invalid');
    if (JSON.stringify(Object.keys(diagnostics.observedCounts ?? {}).sort())
      !== JSON.stringify([...DIAGNOSTIC_RESOURCE_TYPES, 'total'].sort())
      || JSON.stringify(Object.keys(diagnostics.stagingCandidates ?? {}).sort())
      !== JSON.stringify([...DIAGNOSTIC_RESOURCE_TYPES].sort())) {
      throw new Error('diagnostic resource fields invalid');
    }
    if (!Array.isArray(diagnostics.unresolvedFrozenMatches)
      || diagnostics.unresolvedFrozenMatches.some((type) => !DIAGNOSTIC_RESOURCE_TYPES.includes(type))
      || new Set(diagnostics.unresolvedFrozenMatches).size !== diagnostics.unresolvedFrozenMatches.length) {
      throw new Error('unresolved diagnostic types invalid');
    }
    let observedTotal = 0;
    let candidateTotal = 0;
    for (const type of DIAGNOSTIC_RESOURCE_TYPES) {
      const count = diagnostics.observedCounts?.[type];
      if (!Number.isSafeInteger(count) || count < 0 || count > RESOURCE_DIAGNOSTIC_LIMITS.maxObservedPerResourceType) {
        throw new Error('observed diagnostic count invalid');
      }
      observedTotal += count;
      const candidates = diagnostics.stagingCandidates?.[type];
      if (!Array.isArray(candidates) || candidates.length > RESOURCE_DIAGNOSTIC_LIMITS.maxCandidatesPerResourceType) {
        throw new Error('diagnostic candidate list invalid');
      }
      if (!diagnostics.unresolvedFrozenMatches.includes(type) && candidates.length !== 0) {
        throw new Error('resolved resource type retained diagnostic candidates');
      }
      for (const candidate of candidates) {
        const rebuilt = projectDiagnosticCandidate(type, type === 'durableObjects'
          ? { script: candidate?.name, class: candidate?.className, use_sqlite: candidate?.useSqlite }
          : type === 'd1Databases'
            ? { name: candidate?.name, uuid: candidate?.id }
            : type === 'kvNamespaces'
              ? { title: candidate?.name, id: candidate?.id }
              : { name: candidate?.name });
        if (canonicalJson(candidate) !== canonicalJson(rebuilt)) throw new Error('diagnostic candidate fields invalid');
      }
      candidateTotal += candidates.length;
    }
    if (!Number.isSafeInteger(diagnostics.observedCounts?.total)
      || diagnostics.observedCounts.total !== observedTotal
      || observedTotal > RESOURCE_DIAGNOSTIC_LIMITS.maxObservedTotal
      || candidateTotal > RESOURCE_DIAGNOSTIC_LIMITS.maxCandidatesTotal) {
      throw new Error('diagnostic aggregate count invalid');
    }
    return true;
  } catch {
    return false;
  }
}

export function validateConfiguredBoundary(configured) {
  const errors = [];
  const exactList = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (!/^[a-f0-9]{32}$/i.test(configured.accountId ?? '')) errors.push('configured account_id is missing or malformed');
  if (configured.worker !== 'tirak-backend-staging' || !isStagingName(configured.worker)) errors.push('configured Worker is not the frozen staging Worker');
  if (!exactList(configured.database.map((entry) => `${entry.binding}:${entry.name}`), ['DB:tirak-staging'])) {
    errors.push('configured D1 topology is not exactly DB/tirak-staging');
  }
  if (!exactList(configured.kv.map((entry) => entry.binding), ['CACHE', 'SESSIONS'])) {
    errors.push('configured KV topology is not exactly CACHE and SESSIONS');
  }
  if (!exactList(configured.r2.map((entry) => `${entry.binding}:${entry.name}`), ['STORAGE:tirak-storage-staging'])) {
    errors.push('configured R2 topology is not exactly STORAGE/tirak-storage-staging');
  }
  if (!exactList(configured.queues.producers.map((entry) => `${entry.binding}:${entry.name}`), [
    'MODERATION_QUEUE:tirak-moderation-staging',
    'ANALYTICS_QUEUE:tirak-analytics-staging',
    'NOTIFICATION_QUEUE:tirak-notification-staging',
  ])) errors.push('configured Queue producer topology does not match the frozen staging boundary');
  if (!exactList(configured.queues.consumers.map((entry) => `${entry.name}:${entry.deadLetterQueue}`), [
    'tirak-moderation-staging:tirak-moderation-dlq-staging',
    'tirak-analytics-staging:tirak-analytics-dlq-staging',
    'tirak-notification-staging:tirak-notification-dlq-staging',
  ])) errors.push('configured Queue consumer/DLQ topology does not match the frozen staging boundary');
  if (!exactList(configured.durableObjects.map((entry) => `${entry.binding}:${entry.className}`), [
    'CHAT_ROOM:ChatRoom',
    'NOTIFICATION_SERVICE:NotificationService',
  ])) errors.push('configured Durable Object topology does not match the frozen staging boundary');
  const migration = configured.durableObjectMigrations;
  if (migration.length !== 1 || migration[0]?.tag !== 'v1'
    || !exactList(migration[0]?.newSqliteClasses ?? [], ['ChatRoom', 'NotificationService'])) {
    errors.push('configured Durable Object migration must be exactly v1 with both SQLite classes');
  }
  if (configured.variables.environment !== 'staging') errors.push('runtime ENVIRONMENT is not staging');
  if (configured.variables.paymentMode !== 'disabled') errors.push('PAYMENT_MODE must remain disabled');
  if (configured.variables.promptPayEnabled !== 'false') errors.push('PROMPTPAY_ENABLED must remain false');
  for (const resource of [
    ...configured.database.map((entry) => entry.name),
    ...configured.r2.map((entry) => entry.name),
    ...configured.queues.producers.map((entry) => entry.name),
    ...configured.queues.consumers.flatMap((entry) => [entry.name, entry.deadLetterQueue]),
  ]) {
    if (!isStagingName(resource)) errors.push(`non-staging resource name refused: ${resource ?? '<missing>'}`);
  }
  return errors;
}

function exactOne(items, predicate) {
  const matches = items.filter(predicate);
  return { matches, exact: matches.length === 1 };
}

function normalizeId(entry) {
  return entry?.id ?? entry?.uuid ?? entry?.database_id ?? entry?.databaseId ?? null;
}

function normalizeName(entry) {
  return entry?.name ?? entry?.title ?? entry?.database_name ?? entry?.bucket_name ?? entry?.queue_name ?? null;
}

export function validateD1SchemaEvidence(evidence) {
  try {
    const schema = evidence?.schemaInventory;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)
      || canonicalJson(Object.keys(schema).sort()) !== canonicalJson([
        'excludedInternalTables', 'migrationLedgerTablePresent', 'source', 'userTableCount', 'userTableNames',
      ])) return false;
    if (schema.source !== 'sqlite_schema'
      || canonicalJson(schema.excludedInternalTables) !== canonicalJson(D1_SCHEMA_INTERNAL_EXCLUSIONS)
      || !Number.isSafeInteger(schema.userTableCount) || schema.userTableCount < 0
      || !Array.isArray(schema.userTableNames)
      || schema.userTableNames.length !== schema.userTableCount
      || schema.userTableNames.some((name) => typeof name !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'd1_migrations')
      || new Set(schema.userTableNames).size !== schema.userTableNames.length
      || canonicalJson(schema.userTableNames) !== canonicalJson([...schema.userTableNames].sort())
      || typeof schema.migrationLedgerTablePresent !== 'boolean') return false;
    if (!evidence.rowCounts || typeof evidence.rowCounts !== 'object' || Array.isArray(evidence.rowCounts)) return false;
    const expectedCountNames = [
      ...schema.userTableNames,
      ...(schema.migrationLedgerTablePresent ? ['d1_migrations'] : []),
    ].sort();
    if (canonicalJson(Object.keys(evidence.rowCounts).sort()) !== canonicalJson(expectedCountNames)
      || Object.values(evidence.rowCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) return false;
    if (!Array.isArray(evidence.migrationLedger)
      || (!schema.migrationLedgerTablePresent && evidence.migrationLedger.length !== 0)) return false;
    return true;
  } catch {
    return false;
  }
}

function validateProposedConfiguration(configured, evidence) {
  const proposed = evidence.proposedConfiguration;
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)
    || canonicalJson(Object.keys(proposed).sort()) !== canonicalJson(['database', 'kv'])) return false;
  if (!Array.isArray(proposed.database) || proposed.database.length !== 1
    || !Array.isArray(proposed.kv) || proposed.kv.length !== 2) return false;
  const database = proposed.database[0];
  if (!database || typeof database !== 'object' || Array.isArray(database)
    || canonicalJson(Object.keys(database).sort()) !== canonicalJson(['binding', 'id', 'name'])
    || database.binding !== configured.database[0]?.binding
    || database.name !== configured.database[0]?.name
    || !STRICT_UUID.test(database.id ?? '')) return false;
  const remoteDatabases = (evidence.databases ?? [])
    .filter((entry) => normalizeName(entry) === configured.database[0]?.name);
  if (remoteDatabases.length !== 1 || normalizeId(remoteDatabases[0]) !== database.id
    || normalizeId(evidence.databaseInfo) !== database.id) return false;
  const expectedKvBindings = ['CACHE', 'SESSIONS'];
  const proposedBindings = proposed.kv.map((entry) => entry?.binding).sort();
  if (canonicalJson(proposedBindings) !== canonicalJson(expectedKvBindings)) return false;
  for (const namespace of proposed.kv) {
    if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)
      || canonicalJson(Object.keys(namespace).sort()) !== canonicalJson(['binding', 'id'])
      || !STRICT_HEX_ID.test(namespace.id ?? '')) return false;
    const remoteNamespaces = (evidence.kvNamespaces ?? [])
      .filter((entry) => entry?.binding === namespace.binding);
    if (remoteNamespaces.length !== 1 || normalizeId(remoteNamespaces[0]) !== namespace.id) return false;
  }
  return true;
}

function validateSchemaUserVersionEvidence(evidence) {
  const databaseInfo = evidence.databaseInfo;
  const proof = databaseInfo?.schemaUserVersionEvidence;
  if (!Number.isSafeInteger(databaseInfo?.schemaUserVersion) || databaseInfo.schemaUserVersion < 0
    || !proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  if (proof.source === 'read-only-select') {
    return proof.directReadStatus === 'accepted';
  }
  return proof.source === 'fresh-empty-d1-invariant'
    && proof.directReadStatus === 'cloudflare-sqlite-auth-refused'
    && proof.providerErrorCode === 7500
    && proof.remoteReportedTableCount === 0
    && databaseInfo.schemaUserVersion === 0
    && databaseInfo.reportedTableCount === 0
    && evidence.schemaInventory?.userTableCount === 0
    && evidence.schemaInventory?.migrationLedgerTablePresent === false
    && Array.isArray(evidence.schemaInventory?.userTableNames)
    && evidence.schemaInventory.userTableNames.length === 0
    && Array.isArray(evidence.migrationLedger)
    && evidence.migrationLedger.length === 0
    && evidence.rowCounts && typeof evidence.rowCounts === 'object'
    && !Array.isArray(evidence.rowCounts) && Object.keys(evidence.rowCounts).length === 0;
}

export function evaluateStagingEvidence(configured, evidence, humanApproval = null) {
  const blockers = validateConfiguredBoundary(configured).map((message) => ({ code: 'CONFIG_BOUNDARY', message }));
  const checks = [];
  const record = (name, pass, detail) => {
    checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail });
    if (!pass) blockers.push({ code: name, message: detail });
  };

  const authenticatedTargetAccount = evidence.account?.authenticated === true
    && evidence.account?.targetAccountPresent === true
    && evidence.account?.verifiedAccountId === configured.accountId
    && evidence.account?.identitiesRedacted === true;
  record('AUTHENTICATED_TARGET_ACCOUNT', authenticatedTargetAccount,
    authenticatedTargetAccount
      ? 'authenticated membership includes the pinned staging account'
      : evidence.discoveryError?.message ?? 'authenticated token did not prove the pinned staging account; all resource discovery must stop');

  record('CURRENT_TOKEN_SCOPE_INSPECTED', evidence.credential?.scopeInspected === true
    && evidence.credential?.pinnedAccountIncluded === true
    && ['read-only', 'write-capable-or-broad'].includes(evidence.credential?.permissionRisk),
  'current-token policies were inspected and include the pinned Tirak account; only a coarse permission-risk class is retained');

  record('REST_METADATA_VARIANCE_PROPOSED', canonicalJson(evidence.acceptanceVariance) === canonicalJson(REST_METADATA_VARIANCE),
    'official REST read-only metadata is recorded as a fingerprint-bound proposed variance requiring human release-owner confirmation');

  record('RESOURCE_DIAGNOSTICS_SAFE', validateSafeResourceDiagnostics(evidence.resourceDiagnostics),
    'resource diagnostics retain only bounded aggregate counts and unresolved staging-only projections, remain informational, and are excluded from identity acceptance');

  record('PROPOSED_CONFIGURATION_EXACT', validateProposedConfiguration(configured, evidence),
    'proposed local correction contains exactly one remote-matched DB identity and the remote-matched CACHE/SESSIONS identities with no extras');

  record('CONFIGURED_IDENTITIES_CONCRETE', !containsConfiguredPlaceholder(configured),
    'staging configuration contains no placeholder resource identity');

  if (authenticatedTargetAccount) {
    const worker = exactOne(evidence.workers ?? [], (entry) => normalizeName(entry) === configured.worker);
    record('STAGING_WORKER_UNIQUE', worker.exact, `expected one ${configured.worker} Worker, observed ${worker.matches.length}`);
    if (worker.exact) {
      record('STAGING_WORKER_ACTIVE_DEPLOYMENT', worker.matches[0].deploymentCount > 0
        && Array.isArray(worker.matches[0].activeVersionIds) && worker.matches[0].activeVersionIds.length > 0,
      'staging Worker has an active deployment whose version details were inspected read-only');
      record('STAGING_WORKER_BINDINGS_VERIFIED', worker.matches[0].activeBindingsVerified === true,
        'all active staging Worker versions agree on the safe resource-binding projection');
      record('STAGING_WORKER_ENVIRONMENT_SAFE', evidence.workerRuntime?.environment === 'staging',
        'active Worker ENVIRONMENT is exactly staging across every serving version');
      record('STAGING_WORKER_PAYMENT_DISABLED', evidence.workerRuntime?.paymentMode === 'disabled',
        'active Worker PAYMENT_MODE is exactly disabled across every serving version');
      record('STAGING_WORKER_PROMPTPAY_DISABLED', evidence.workerRuntime?.promptPayEnabled === 'false',
        'active Worker PROMPTPAY_ENABLED is exactly false across every serving version');
      const expectedMigrationTag = configured.durableObjectMigrations[0]?.tag;
      record('STAGING_WORKER_MIGRATION_TAG', typeof expectedMigrationTag === 'string'
        && evidence.workerRuntime?.migrationTag === expectedMigrationTag,
      'active Worker Durable Object migration tag matches the configured staging tag');
    }

    const database = exactOne(evidence.databases ?? [], (entry) => normalizeName(entry) === configured.database[0]?.name);
    record('STAGING_D1_UNIQUE', database.exact, `expected one tirak-staging D1 database, observed ${database.matches.length}`);
    if (database.exact) {
      const id = normalizeId(database.matches[0]);
      record('STAGING_D1_ID_VALID', /^[a-f0-9-]{36}$/i.test(id ?? '') && !containsPlaceholder(id), 'D1 candidate has a concrete UUID');
      record('STAGING_D1_INFO_MATCH', normalizeId(evidence.databaseInfo) === id, 'D1 info identity matches list identity');
      if (!containsPlaceholder(configured.database[0]?.id)) {
        record('STAGING_D1_CONFIGURED_ID_MATCH', configured.database[0]?.id === id, 'configured D1 identifier matches authenticated remote evidence');
      }
      record('STAGING_D1_STORAGE_VERSION', typeof evidence.databaseInfo?.storageVersion === 'string' && evidence.databaseInfo.storageVersion.length > 0,
        'D1 platform/storage version was captured from authenticated Cloudflare metadata');
      record('STAGING_D1_SCHEMA_USER_VERSION', validateSchemaUserVersionEvidence(evidence),
        'D1 schema user_version was captured read-only or bounded to zero by the fingerprinted pristine-empty D1 invariant after Cloudflare SQLITE_AUTH refusal');
      record('STAGING_D1_SCHEMA_INVENTORY', validateD1SchemaEvidence(evidence),
        'sqlite_schema evidence contains a consistent nonnegative user-table count with explicit internal-table exclusion');
    }

    for (const binding of ['CACHE', 'SESSIONS']) {
      const namespace = exactOne(evidence.kvNamespaces ?? [], (entry) => entry.binding === binding && isStagingName(normalizeName(entry)));
      record(`STAGING_KV_${binding}_UNIQUE`, namespace.exact, `expected one staging namespace mapped to ${binding}, observed ${namespace.matches.length}`);
      if (namespace.exact) {
        const remoteId = normalizeId(namespace.matches[0]);
        record(`STAGING_KV_${binding}_ID_VALID`, /^[a-f0-9]{32}$/i.test(remoteId ?? ''), `${binding} namespace has a concrete identifier`);
        const configuredNamespace = configured.kv.find((entry) => entry.binding === binding);
        if (!containsPlaceholder(configuredNamespace?.id)) {
          record(`STAGING_KV_${binding}_CONFIGURED_ID_MATCH`, configuredNamespace?.id === remoteId,
            `configured ${binding} identifier matches authenticated remote evidence`);
        }
      }
    }

    for (const configuredBucket of configured.r2) {
      const bucket = exactOne(evidence.r2Buckets ?? [], (entry) => normalizeName(entry) === configuredBucket.name);
      record(`STAGING_R2_${configuredBucket.binding}_UNIQUE`, bucket.exact, `expected one ${configuredBucket.name} bucket, observed ${bucket.matches.length}`);
    }

    const expectedQueues = new Set([
      ...configured.queues.producers.map((entry) => entry.name),
      ...configured.queues.consumers.flatMap((entry) => [entry.name, entry.deadLetterQueue]),
    ]);
    for (const queueName of expectedQueues) {
      const queue = exactOne(evidence.queues ?? [], (entry) => normalizeName(entry) === queueName);
      record(`STAGING_QUEUE_${queueName}_UNIQUE`, queue.exact, `expected one ${queueName} queue/DLQ, observed ${queue.matches.length}`);
    }
    for (const producer of configured.queues.producers) {
      const binding = exactOne(evidence.workerBindings ?? [], (entry) => entry.type === 'queue'
        && entry.binding === producer.binding && entry.name === producer.name);
      record(`STAGING_WORKER_QUEUE_${producer.binding}`, binding.exact,
        `active Worker binds ${producer.binding} to ${producer.name}`);
    }

    for (const durableObject of configured.durableObjects) {
      const object = exactOne(evidence.durableObjects ?? [], (entry) => entry.binding === durableObject.binding && entry.className === durableObject.className);
      record(`STAGING_DO_${durableObject.binding}`, object.exact, `expected deployed ${durableObject.binding}/${durableObject.className} binding, observed ${object.matches.length}`);
      if (object.exact) record(`STAGING_DO_${durableObject.binding}_SQLITE`, object.matches[0].useSqlite === true,
        `${durableObject.binding}/${durableObject.className} uses SQLite-backed Durable Object storage`);
    }

    record('STAGING_MIGRATION_LEDGER_CAPTURED', Array.isArray(evidence.migrationLedger), 'd1_migrations ledger was captured read-only');
    record('STAGING_MIGRATION_STATUS_CAPTURED', Array.isArray(evidence.pendingMigrations), 'local migration inventory was compared with the remote read-only ledger');
    const lineageClear = evidence.migrationLineage?.status === 'clear'
      && Array.isArray(evidence.migrationLineage?.anomalies) && evidence.migrationLineage.anomalies.length === 0;
    const lineageDeferred = evidence.migrationLineage?.status === 'blocked_pending_T028'
      && evidence.migrationLineage?.t028Blocked === true
      && evidence.migrationLineage?.mutationAuthorized === false
      && Array.isArray(evidence.migrationLineage?.anomalies)
      && evidence.migrationLineage.anomalies.length > 0
      && evidence.migrationLineage.anomalies.every((anomaly) => anomaly?.code === 'LOCAL_MIGRATION_PREFIX_DUPLICATE'
        && /^\d+$/.test(anomaly?.prefix ?? '')
        && Array.isArray(anomaly?.files) && anomaly.files.length > 1
        && anomaly.files.every((name) => typeof name === 'string' && /^\d+[A-Za-z0-9_.-]*\.sql$/.test(name)));
    record('STAGING_MIGRATION_LINEAGE_RECORDED', lineageClear || lineageDeferred,
      lineageDeferred
        ? 'duplicate local migration-prefix lineage is recorded as blocked_pending_T028 without suppressing T-025 read-only evidence'
        : 'local migration lineage has no detected duplicate-prefix anomaly');
    record('STAGING_ROW_COUNTS_CAPTURED', validateD1SchemaEvidence(evidence),
      evidence.schemaInventory?.userTableCount === 0
        ? 'sqlite_schema explicitly proves zero user tables after internal-table exclusion; empty user-table row counts are accepted'
        : 'strict per-table row counts match every sqlite_schema user-table name');
  }

  const evidenceForFingerprint = {
    accountId: configured.accountId,
    worker: configured.worker,
    workerBindings: evidence.workerBindings ?? [],
    workerRuntime: evidence.workerRuntime ?? null,
    database: evidence.databases ?? [],
    databaseInfo: evidence.databaseInfo ?? null,
    schemaInventory: evidence.schemaInventory ?? null,
    kvNamespaces: evidence.kvNamespaces ?? [],
    r2Buckets: evidence.r2Buckets ?? [],
    queues: evidence.queues ?? [],
    durableObjects: evidence.durableObjects ?? [],
    migrationLedger: evidence.migrationLedger ?? null,
    pendingMigrations: evidence.pendingMigrations ?? null,
    migrationLineage: evidence.migrationLineage ?? null,
    rowCounts: evidence.rowCounts ?? null,
    proposedConfiguration: evidence.proposedConfiguration ?? null,
    tokenScope: {
      permissionRisk: evidence.credential?.permissionRisk ?? null,
      pinnedAccountIncluded: evidence.credential?.pinnedAccountIncluded ?? false,
      scopeInspected: evidence.credential?.scopeInspected ?? false,
    },
    acceptanceVariance: evidence.acceptanceVariance ?? null,
  };
  const targetFingerprint = authenticatedTargetAccount ? sha256(evidenceForFingerprint) : null;
  const approvalValid = humanApproval !== null
    && humanApproval.taskId === TASK_ID
    && humanApproval.statement === CONFIRMATION_STATEMENT
    && humanApproval.targetFingerprint === targetFingerprint
    && humanApproval.approvedBy === 'human release owner'
    && !Number.isNaN(Date.parse(humanApproval.approvedAt))
    && Array.isArray(humanApproval.acceptedVarianceIds)
    && canonicalJson(humanApproval.acceptedVarianceIds) === canonicalJson([REST_METADATA_VARIANCE_ID]);
  const resourcesVerified = blockers.length === 0;
  const onlyConfigurationCorrectionRemains = approvalValid
    && blockers.length === 1
    && blockers[0]?.code === 'CONFIGURED_IDENTITIES_CONCRETE';
  const status = resourcesVerified && approvalValid
    ? 'HUMAN_CONFIRMED_STAGING_IDENTITIES'
    : onlyConfigurationCorrectionRemains
      ? 'HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION'
      : 'PENDING_HUMAN_CONFIRMATION';

  return {
    status,
    blockers,
    checks,
    targetFingerprint,
    resourcesVerified,
    humanConfirmation: approvalValid ? humanApproval : null,
    localConfigurationCorrectionAuthorized: onlyConfigurationCorrectionRemains,
    localConfigurationCorrectionBoundary: 'Fingerprint-bound human confirmation may authorize only replacement of staging D1/KV placeholder identities with the exact proposedConfiguration values; it never authorizes a remote mutation.',
    mutationAllowed: false,
    mutationBoundary: 'T-025 evidence never authorizes deployment, migration application, secret changes, resource creation/deletion, production access, live Omise charging, or App Store submission.',
  };
}

export function publicConfiguredSummary(configured) {
  return {
    accountId: configured.accountId,
    worker: configured.worker,
    database: configured.database,
    kv: configured.kv,
    r2: configured.r2,
    queues: configured.queues,
    durableObjects: configured.durableObjects,
    durableObjectMigrations: configured.durableObjectMigrations,
    variables: configured.variables,
    containsPlaceholders: containsConfiguredPlaceholder(configured),
  };
}
