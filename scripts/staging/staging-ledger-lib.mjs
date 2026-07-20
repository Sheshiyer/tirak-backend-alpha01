import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 'tirak-payments-v1';
export const TASK_ID = 'T-025';
export const READ_ONLY_AUTHORIZATION = 'T-024_APPROVED_READ_ONLY';
export const CONFIRMATION_STATEMENT =
  'I confirm the T-025 staging resource ledger fingerprint and authorize the listed staging identities for later evidence-gated staging work. This does not authorize production access, deployment, migration application, secret mutation, live Omise charging, or App Store submission.';

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

export function isStagingName(valueToCheck) {
  return typeof valueToCheck === 'string'
    && /(?:^|[-_])staging(?:$|[-_])/.test(valueToCheck)
    && !/(?:^|[-_])production(?:$|[-_])|(?:^|[-_])prod(?:$|[-_])|(?:^|[-_])live(?:$|[-_])/i.test(valueToCheck);
}

export function validateConfiguredBoundary(configured) {
  const errors = [];
  if (!/^[a-f0-9]{32}$/i.test(configured.accountId ?? '')) errors.push('configured account_id is missing or malformed');
  if (configured.worker !== 'tirak-backend-staging' || !isStagingName(configured.worker)) errors.push('configured Worker is not the frozen staging Worker');
  if (configured.database.length !== 1 || configured.database[0]?.name !== 'tirak-staging') errors.push('configured D1 target is not exactly tirak-staging');
  if (configured.variables.environment !== 'staging') errors.push('runtime ENVIRONMENT is not staging');
  if (configured.variables.paymentMode !== 'disabled') errors.push('PAYMENT_MODE must remain disabled');
  if (configured.variables.promptPayEnabled !== 'false') errors.push('PROMPTPAY_ENABLED must remain false');
  for (const [label, identity] of [
    ...configured.database.map((entry) => [`D1 ${entry.binding}`, entry.id]),
    ...configured.kv.map((entry) => [`KV ${entry.binding}`, entry.id]),
  ]) {
    if (!identity || containsPlaceholder(identity)) errors.push(`${label} identity is unresolved or placeholder`);
  }

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

export function evaluateStagingEvidence(configured, evidence, humanApproval = null) {
  const blockers = validateConfiguredBoundary(configured).map((message) => ({ code: 'CONFIG_BOUNDARY', message }));
  const checks = [];
  const record = (name, pass, detail) => {
    checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail });
    if (!pass) blockers.push({ code: name, message: detail });
  };

  record('AUTHENTICATED_TARGET_ACCOUNT', evidence.account?.targetAccountPresent === true,
    evidence.account?.targetAccountPresent === true
      ? 'authenticated membership includes the pinned staging account'
      : 'authenticated membership does not include the pinned staging account; all resource discovery must stop');

  if (evidence.account?.targetAccountPresent === true) {
    const worker = exactOne(evidence.workers ?? [], (entry) => normalizeName(entry) === configured.worker);
    record('STAGING_WORKER_UNIQUE', worker.exact, `expected one ${configured.worker} Worker, observed ${worker.matches.length}`);

    const database = exactOne(evidence.databases ?? [], (entry) => normalizeName(entry) === configured.database[0]?.name);
    record('STAGING_D1_UNIQUE', database.exact, `expected one tirak-staging D1 database, observed ${database.matches.length}`);
    if (database.exact) {
      const id = normalizeId(database.matches[0]);
      record('STAGING_D1_ID_VALID', /^[a-f0-9-]{36}$/i.test(id ?? '') && !containsPlaceholder(id), 'D1 candidate has a concrete UUID');
      record('STAGING_D1_INFO_MATCH', normalizeId(evidence.databaseInfo) === id, 'D1 info identity matches list identity');
      record('STAGING_D1_STORAGE_VERSION', typeof evidence.databaseInfo?.storageVersion === 'string' && evidence.databaseInfo.storageVersion.length > 0,
        'D1 storage version is reported by authenticated metadata');
    }

    for (const binding of ['CACHE', 'SESSIONS']) {
      const namespace = exactOne(evidence.kvNamespaces ?? [], (entry) => entry.binding === binding && isStagingName(normalizeName(entry)));
      record(`STAGING_KV_${binding}_UNIQUE`, namespace.exact, `expected one staging namespace mapped to ${binding}, observed ${namespace.matches.length}`);
      if (namespace.exact) record(`STAGING_KV_${binding}_ID_VALID`, /^[a-f0-9]{32}$/i.test(normalizeId(namespace.matches[0]) ?? ''), `${binding} namespace has a concrete identifier`);
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

    for (const durableObject of configured.durableObjects) {
      const object = exactOne(evidence.durableObjects ?? [], (entry) => entry.binding === durableObject.binding && entry.className === durableObject.className);
      record(`STAGING_DO_${durableObject.binding}`, object.exact, `expected deployed ${durableObject.binding}/${durableObject.className} binding, observed ${object.matches.length}`);
    }

    record('STAGING_MIGRATION_LEDGER_CAPTURED', Array.isArray(evidence.migrationLedger), 'd1_migrations ledger was captured read-only');
    record('STAGING_MIGRATION_STATUS_CAPTURED', Array.isArray(evidence.pendingMigrations), 'Wrangler migration-list status was captured read-only');
    record('STAGING_ROW_COUNTS_CAPTURED', evidence.rowCounts && Object.keys(evidence.rowCounts).length > 0
      && Object.values(evidence.rowCounts).every(Number.isSafeInteger), 'per-table row counts were captured using SELECT COUNT(*) only');
  }

  const evidenceForFingerprint = {
    accountId: configured.accountId,
    worker: configured.worker,
    database: evidence.databases ?? [],
    databaseInfo: evidence.databaseInfo ?? null,
    kvNamespaces: evidence.kvNamespaces ?? [],
    r2Buckets: evidence.r2Buckets ?? [],
    queues: evidence.queues ?? [],
    durableObjects: evidence.durableObjects ?? [],
    migrationLedger: evidence.migrationLedger ?? null,
    pendingMigrations: evidence.pendingMigrations ?? null,
    rowCounts: evidence.rowCounts ?? null,
  };
  const targetFingerprint = evidence.account?.targetAccountPresent === true ? sha256(evidenceForFingerprint) : null;
  const approvalValid = humanApproval !== null
    && humanApproval.taskId === TASK_ID
    && humanApproval.statement === CONFIRMATION_STATEMENT
    && humanApproval.targetFingerprint === targetFingerprint
    && humanApproval.approvedBy === 'human release owner'
    && !Number.isNaN(Date.parse(humanApproval.approvedAt));
  const resourcesVerified = blockers.length === 0;
  const status = resourcesVerified && approvalValid
    ? 'HUMAN_CONFIRMED_STAGING_IDENTITIES'
    : 'PENDING_HUMAN_CONFIRMATION';

  return {
    status,
    blockers,
    checks,
    targetFingerprint,
    resourcesVerified,
    humanConfirmation: approvalValid ? humanApproval : null,
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
    containsPlaceholders: [
      ...configured.database.map((entry) => entry.id),
      ...configured.kv.map((entry) => entry.id),
    ].some(containsPlaceholder),
  };
}
