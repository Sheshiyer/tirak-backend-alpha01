import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalJson,
  buildSafeResourceDiagnostics,
  CONFIRMATION_STATEMENT,
  CONTRACT_VERSION,
  containsConfiguredPlaceholder,
  evaluateStagingEvidence,
  parseStagingConfig,
  publicConfiguredSummary,
  REST_METADATA_VARIANCE,
  REST_METADATA_VARIANCE_ID,
  TASK_ID,
  validateD1SchemaEvidence,
} from './staging-ledger-lib.mjs';

const FINAL_STATUS = 'HUMAN_CONFIRMED_STAGING_IDENTITIES';
const FINAL_DISCOVERY_STATE = 'READ_ONLY_EVIDENCE_HUMAN_CONFIRMED';
const FINAL_NEXT_ACTION = 'T-025 accepted; T-026 remains separately evidence-gated and mutation remains unauthorized.';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCanonicalEqual(actual, expected, message) {
  assert(canonicalJson(actual) === canonicalJson(expected), message);
}

function assertSafeRequestLog(requestLog, manifest) {
  assert(Array.isArray(requestLog) && requestLog.length > 0, 'accepted ledger has no read-only request evidence');
  const accountId = manifest.configured?.accountId;
  const workerName = manifest.configured?.worker;
  const databaseId = manifest.evidence?.databaseInfo?.id;
  const workerEvidence = (manifest.evidence?.workers ?? []).filter((entry) => entry?.name === workerName);
  const versionIds = workerEvidence[0]?.activeVersionIds;
  assert(/^[a-f0-9]{32}$/i.test(accountId ?? ''), 'request evidence account identity is malformed');
  assert(typeof workerName === 'string' && workerName === 'tirak-backend-staging', 'request evidence Worker identity is malformed');
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(databaseId ?? ''),
    'request evidence D1 identity is malformed');
  assert(workerEvidence.length === 1 && Array.isArray(versionIds) && versionIds.length > 0 && versionIds.length <= 20
    && new Set(versionIds).size === versionIds.length, 'request evidence active Worker versions are malformed');

  const prefix = `/client/v4/accounts/${accountId}`;
  const workerPath = `${prefix}/workers/scripts/${encodeURIComponent(workerName)}`;
  const d1Path = `${prefix}/d1/database/${databaseId}`;
  const specs = [];
  const observedCounts = manifest.evidence?.resourceDiagnostics?.observedCounts;
  const requireRequests = (operation, method, path, min = 1, max = min, allowedFailure = false, pagination = null) => {
    specs.push({ operation, method, path, min, max, allowedFailure, pagination, count: 0, resultTotal: 0 });
  };
  const verificationType = manifest.evidence?.credential?.verificationType;
  if (verificationType === 'user-token') {
    requireRequests('token verification', 'GET', '/client/v4/user/tokens/verify');
    requireRequests('current token details', 'GET', '/client/v4/user/tokens/{verified-current-token}');
  } else if (verificationType === 'account-token') {
    requireRequests('token verification', 'GET', '/client/v4/user/tokens/verify', 1, 1, true);
    requireRequests('account token verification', 'GET', `${prefix}/tokens/verify`);
    requireRequests('current account token details', 'GET', `${prefix}/tokens/{verified-current-token}`);
  } else {
    throw new Error('request evidence token verification type is unsupported');
  }
  requireRequests('account identity', 'GET', prefix);
  requireRequests('Worker list', 'GET', `${prefix}/workers/scripts`, 1, 1, false,
    { mode: 'single', expectedTotal: observedCounts?.workers });
  requireRequests('Worker deployments', 'GET', `${workerPath}/deployments`);
  for (const versionId of versionIds) {
    assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(versionId),
      'request evidence Worker version identity is malformed');
    requireRequests('Worker version detail', 'GET', `${workerPath}/versions/${versionId}`);
  }
  const requirePageList = (operation, path, countKey) => {
    const expectedTotal = observedCounts?.[countKey];
    assert(Number.isSafeInteger(expectedTotal) && expectedTotal >= 0, `${operation} diagnostic count is invalid`);
    requireRequests(operation, 'GET', path, 1, 100, false, { mode: 'page', expectedTotal });
  };
  requirePageList('D1 list', `${prefix}/d1/database`, 'd1Databases');
  requirePageList('KV list', `${prefix}/storage/kv/namespaces`, 'kvNamespaces');
  requireRequests('R2 list', 'GET', `${prefix}/r2/buckets`, 1, 100, false,
    { mode: 'cursor', expectedTotal: observedCounts?.r2Buckets });
  requirePageList('Queue list', `${prefix}/queues`, 'queues');
  requirePageList('Durable Object list', `${prefix}/workers/durable_objects/namespaces`, 'durableObjects');
  requireRequests('D1 detail', 'GET', d1Path);
  const rowCountTables = Object.keys(manifest.evidence?.rowCounts ?? {});
  assert(validateD1SchemaEvidence(manifest.evidence)
    && rowCountTables.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
    'request evidence row-count table inventory is malformed');
  const expectedSelects = 3 + rowCountTables.length
    + (manifest.evidence.schemaInventory.migrationLedgerTablePresent ? 1 : 0);
  requireRequests('D1 SELECT', 'POST', `${d1Path}/query`, expectedSelects, expectedSelects);

  const sqliteAuthFallbackExpected = canonicalJson(
    manifest.evidence?.databaseInfo?.schemaUserVersionEvidence,
  ) === canonicalJson({
    source: 'fresh-empty-d1-invariant',
    directReadStatus: 'cloudflare-sqlite-auth-refused',
    providerErrorCode: 7500,
    remoteReportedTableCount: 0,
  });
  let sqliteAuthFallbackSeen = false;

  const exactRecordKeys = ['method', 'operation', 'outcome', 'path', 'status', 'success'];
  const exactPaginatedRecordKeys = [...exactRecordKeys, 'pagination'].sort();
  for (const record of requestLog) {
    assert(record && typeof record === 'object' && !Array.isArray(record), 'request evidence entry is malformed');
    assert(typeof record.path === 'string' && !/\/tokens\/[a-f0-9]{32}(?:$|[/?#])/i.test(record.path),
      'request evidence retained a token identifier');
    const spec = specs.find((candidate) => candidate.operation === record.operation
      && candidate.method === record.method && candidate.path === record.path);
    assert(spec, 'request evidence contains an extra operation or a path outside the exact manifest-derived set');
    assertCanonicalEqual(Object.keys(record).sort(), spec.pagination ? exactPaginatedRecordKeys : exactRecordKeys,
      'request evidence contains missing or unsafe fields');
    spec.count += 1;
    assert(spec.count <= spec.max, 'request evidence operation exceeded its allowed cardinality');
    if (spec.pagination) {
      assert(record.pagination && typeof record.pagination === 'object' && !Array.isArray(record.pagination)
        && canonicalJson(Object.keys(record.pagination).sort()) === canonicalJson(['mode', 'ordinal', 'resultCount'])
        && record.pagination.mode === spec.pagination.mode
        && Number.isSafeInteger(record.pagination.ordinal) && record.pagination.ordinal === spec.count
        && Number.isSafeInteger(record.pagination.resultCount) && record.pagination.resultCount >= 0,
      'request evidence pagination transcript is malformed, noncontiguous, or uses the wrong mode');
      if (spec.pagination.mode === 'single') {
        assert(record.pagination.resultCount === spec.pagination.expectedTotal,
          'single-page request result count does not match the exact diagnostic total');
      } else if (spec.pagination.expectedTotal > 0) {
        assert(record.pagination.resultCount > 0, 'paginated transcript contains an impossible empty page');
      }
      spec.resultTotal += record.pagination.resultCount;
    }
    if (spec.allowedFailure) {
      assert([401, 403].includes(record.status) && record.outcome === 'api-failure' && record.success === false,
        'account-token fallback did not retain the exact safe user-token verification failure');
    } else if (spec.operation === 'D1 SELECT' && spec.count === 1 && sqliteAuthFallbackExpected) {
      assert(record.status === 400 && record.outcome === 'api-failure' && record.success === false,
        'fresh-empty D1 fallback did not retain the exact safe SQLITE_AUTH refusal');
      sqliteAuthFallbackSeen = true;
    } else {
      assert(Number.isInteger(record.status) && record.status >= 200 && record.status < 300
        && record.outcome === 'accepted-envelope' && record.success === true,
      'request evidence contains an unsafe status or outcome');
    }
  }
  for (const spec of specs) {
    assert(spec.count >= spec.min && spec.count <= spec.max,
      `request evidence is incomplete for ${spec.operation}`);
    if (spec.pagination) {
      assert(Number.isSafeInteger(spec.pagination.expectedTotal) && spec.pagination.expectedTotal >= 0
        && spec.resultTotal === spec.pagination.expectedTotal,
      `request evidence pagination total does not match diagnostics for ${spec.operation}`);
    }
  }
  assert(sqliteAuthFallbackSeen === sqliteAuthFallbackExpected,
    'D1 request evidence disagrees with the fingerprinted schema-version fallback');
}

function assertExactHumanConfirmation(confirmation, targetFingerprint) {
  assert(confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation), 'human confirmation is missing');
  assertCanonicalEqual(Object.keys(confirmation).sort(), [
    'acceptedVarianceIds', 'approvedAt', 'approvedBy', 'statement', 'targetFingerprint', 'taskId',
  ].sort(), 'human confirmation contains missing or unsupported fields');
  assert(confirmation.taskId === TASK_ID, 'human confirmation task does not match T-025');
  assert(confirmation.targetFingerprint === targetFingerprint, 'human confirmation fingerprint does not match the current target');
  assert(confirmation.statement === CONFIRMATION_STATEMENT, 'human confirmation statement is not exact');
  assert(confirmation.approvedBy === 'human release owner', 'human confirmation approver is not the release owner');
  assert(typeof confirmation.approvedAt === 'string'
    && new Date(confirmation.approvedAt).toISOString() === confirmation.approvedAt,
  'human confirmation timestamp is not an exact ISO instant');
  assertCanonicalEqual(confirmation.acceptedVarianceIds, [REST_METADATA_VARIANCE_ID],
    'human confirmation did not accept exactly the fingerprinted REST metadata variance');
}

function assertAcceptedManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'current ledger is malformed');
  assert(manifest.schemaVersion === 2, 'current ledger schema version is unsupported');
  assert(manifest.taskId === TASK_ID, 'current ledger is not T-025');
  assert(manifest.contractVersion === CONTRACT_VERSION, 'current ledger contract version is wrong');
  assert(manifest.environment === 'staging', 'current ledger is not staging-only');
  assert(manifest.authority === 'T-024 approved authenticated read-only staging evidence only', 'current ledger authority changed');
  assert(manifest.discoveryTransport === 'Cloudflare REST API token through fixed read-only client', 'current ledger transport is not the proposed REST variance');
  assert(manifest.discoveryState === FINAL_DISCOVERY_STATE, 'current ledger is not in the human-confirmed discovery state');
  assert(manifest.status === FINAL_STATUS, 'current ledger has not reached final T-025 acceptance');
  assert(manifest.resourcesVerified === true, 'current ledger resources are not fully verified');
  assert(typeof manifest.targetFingerprint === 'string' && /^[a-f0-9]{64}$/.test(manifest.targetFingerprint),
    'current ledger target fingerprint is missing or malformed');
  assert(Array.isArray(manifest.blockers) && manifest.blockers.length === 0, 'current ledger retains acceptance blockers');
  assert(Array.isArray(manifest.checks) && manifest.checks.length > 0
    && manifest.checks.every((check) => check?.status === 'PASS'), 'current ledger has an incomplete machine check');

  assert(manifest.configured?.containsPlaceholders === false
    && !containsConfiguredPlaceholder(manifest.configured), 'current ledger retains placeholder configuration');
  assert(manifest.configured?.accountId === '2c0c96c68f0ee73b6d980054557bca5b',
    'current ledger configured account is not the pinned Tirak account');
  assertCanonicalEqual(manifest.evidence?.acceptanceVariance, REST_METADATA_VARIANCE,
    'current ledger does not fingerprint the exact proposed REST metadata variance');
  assert(manifest.evidence?.credential?.present === true, 'current ledger did not use an authenticated credential');
  assert(manifest.evidence?.credential?.tokenCaptured === false, 'current ledger captured token material');
  assert(manifest.evidence?.credential?.scopeInspected === true
    && manifest.evidence?.credential?.pinnedAccountIncluded === true
    && ['read-only', 'write-capable-or-broad'].includes(manifest.evidence?.credential?.permissionRisk),
  'current ledger lacks the fail-closed current-token scope inspection');
  assert(manifest.evidence?.account?.authenticated === true
    && manifest.evidence?.account?.targetAccountPresent === true
    && manifest.evidence?.account?.verifiedAccountId === manifest.configured.accountId
    && manifest.evidence?.account?.verifiedAccountId === '2c0c96c68f0ee73b6d980054557bca5b'
    && manifest.evidence?.account?.identitiesRedacted === true,
  'current ledger lacks authenticated, redacted pinned-account evidence');
  assert(manifest.evidence?.discoveryError === undefined, 'current ledger retains a discovery error');

  assert(manifest.productionCommandsExecuted === 0, 'current ledger executed a production command');
  assert(manifest.remoteMutationsExecuted === 0, 'current ledger executed a remote mutation');
  assert(manifest.secretsCaptured === false, 'current ledger captured secret material');
  assert(manifest.mutationAllowed === false, 'current ledger authorizes mutation');
  assert(manifest.localConfigurationCorrectionAuthorized === false,
    'final ledger unexpectedly retains local placeholder-correction authority');
  assert(manifest.t026Blocked === false, 'current ledger still blocks T-026');
  assert(manifest.requiredNextAction === FINAL_NEXT_ACTION, 'current ledger next-action boundary is not final');
  assertSafeRequestLog(manifest.requestLog, manifest);
  assertExactHumanConfirmation(manifest.humanConfirmation, manifest.targetFingerprint);

  const recomputed = evaluateStagingEvidence(manifest.configured, manifest.evidence, manifest.humanConfirmation);
  assert(recomputed.resourcesVerified === true, 'current ledger evidence does not recompute as verified');
  assert(recomputed.status === FINAL_STATUS, 'current ledger confirmation does not recompute as accepted');
  for (const key of [
    'status', 'blockers', 'checks', 'targetFingerprint', 'resourcesVerified', 'humanConfirmation',
    'localConfigurationCorrectionAuthorized', 'localConfigurationCorrectionBoundary', 'mutationAllowed', 'mutationBoundary',
  ]) {
    assertCanonicalEqual(manifest[key], recomputed[key], `current ledger ${key} differs from recomputed evidence`);
  }
  return recomputed;
}

function assertOwnerOnlyLedger(path) {
  const resolved = resolve(path);
  const projectRelative = relative(process.cwd(), resolved);
  assert(projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative), 'ledger path must remain inside the project worktree');
  const stat = lstatSync(resolved);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'ledger path must be a regular file');
  assert((stat.mode & 0o777) === 0o600, 'ledger file mode must be exactly 0600');
  if (typeof process.getuid === 'function') assert(stat.uid === process.getuid(), 'ledger file must be owned by the current user');
  const realRelative = relative(process.cwd(), realpathSync(resolved));
  assert(realRelative && !realRelative.startsWith('..') && !isAbsolute(realRelative), 'ledger resolves outside the project worktree');
  return resolved;
}

const concreteConfig = `
account_id = "2c0c96c68f0ee73b6d980054557bca5b"
[env.staging]
name = "tirak-backend-staging"
[[env.staging.d1_databases]]
binding = "DB"
database_name = "tirak-staging"
database_id = "11111111-1111-4111-8111-111111111111"
[[env.staging.r2_buckets]]
binding = "STORAGE"
bucket_name = "tirak-storage-staging"
[[env.staging.kv_namespaces]]
binding = "CACHE"
id = "11111111111111111111111111111111"
[[env.staging.kv_namespaces]]
binding = "SESSIONS"
id = "22222222222222222222222222222222"
[[env.staging.queues.producers]]
binding = "MODERATION_QUEUE"
queue = "tirak-moderation-staging"
[[env.staging.queues.producers]]
binding = "ANALYTICS_QUEUE"
queue = "tirak-analytics-staging"
[[env.staging.queues.producers]]
binding = "NOTIFICATION_QUEUE"
queue = "tirak-notification-staging"
[[env.staging.queues.consumers]]
queue = "tirak-moderation-staging"
dead_letter_queue = "tirak-moderation-dlq-staging"
[[env.staging.queues.consumers]]
queue = "tirak-analytics-staging"
dead_letter_queue = "tirak-analytics-dlq-staging"
[[env.staging.queues.consumers]]
queue = "tirak-notification-staging"
dead_letter_queue = "tirak-notification-dlq-staging"
[[env.staging.durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"
[[env.staging.durable_objects.bindings]]
name = "NOTIFICATION_SERVICE"
class_name = "NotificationService"
[[env.staging.migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom", "NotificationService"]
[env.staging.vars]
ENVIRONMENT = "staging"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"
`;

const evidence = {
  account: {
    authenticated: true,
    targetAccountPresent: true,
    verifiedAccountId: '2c0c96c68f0ee73b6d980054557bca5b',
    identitiesRedacted: true,
  },
  credential: {
    present: true,
    source: 'owner-only-environment-file',
    tokenCaptured: false,
    scopeInspected: true,
    pinnedAccountIncluded: true,
    permissionRisk: 'read-only',
    verificationType: 'user-token',
  },
  acceptanceVariance: REST_METADATA_VARIANCE,
  workers: [{ name: 'tirak-backend-staging', deploymentCount: 1, activeVersionIds: ['11111111-1111-4111-8111-111111111111'], activeBindingsVerified: true }],
  workerBindings: [
    { type: 'queue', binding: 'MODERATION_QUEUE', name: 'tirak-moderation-staging' },
    { type: 'queue', binding: 'ANALYTICS_QUEUE', name: 'tirak-analytics-staging' },
    { type: 'queue', binding: 'NOTIFICATION_QUEUE', name: 'tirak-notification-staging' },
  ],
  workerRuntime: { environment: 'staging', paymentMode: 'disabled', promptPayEnabled: 'false', migrationTag: 'v1' },
  databases: [{ name: 'tirak-staging', uuid: '11111111-1111-4111-8111-111111111111' }],
  databaseInfo: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'tirak-staging',
    storageVersion: 'production',
    schemaUserVersion: 0,
    schemaUserVersionEvidence: { source: 'read-only-select', directReadStatus: 'accepted' },
  },
  schemaInventory: {
    source: 'sqlite_schema',
    excludedInternalTables: ['sqlite_%', '_cf_%', 'd1_migrations'],
    userTableCount: 2,
    userTableNames: ['bookings', 'chat_rooms'],
    migrationLedgerTablePresent: true,
  },
  kvNamespaces: [
    { binding: 'CACHE', title: 'tirak-cache-staging', id: '11111111111111111111111111111111' },
    { binding: 'SESSIONS', title: 'tirak-sessions-staging', id: '22222222222222222222222222222222' },
  ],
  r2Buckets: [{ name: 'tirak-storage-staging' }],
  queues: [
    'tirak-moderation-staging', 'tirak-moderation-dlq-staging',
    'tirak-analytics-staging', 'tirak-analytics-dlq-staging',
    'tirak-notification-staging', 'tirak-notification-dlq-staging',
  ].map((name) => ({ name })),
  durableObjects: [
    { binding: 'CHAT_ROOM', className: 'ChatRoom', useSqlite: true },
    { binding: 'NOTIFICATION_SERVICE', className: 'NotificationService', useSqlite: true },
  ],
  migrationLedger: [{ id: 1, name: '001_initial_schema.sql', applied_at: '2026-01-01T00:00:00Z' }],
  pendingMigrations: ['008_omise_promptpay_payments.sql'],
  migrationLineage: { status: 'clear', anomalies: [], t028Blocked: false, mutationAuthorized: false },
  rowCounts: { bookings: 12, d1_migrations: 1, chat_rooms: 3 },
  proposedConfiguration: {
    database: [{ binding: 'DB', name: 'tirak-staging', id: '11111111-1111-4111-8111-111111111111' }],
    kv: [
      { binding: 'CACHE', id: '11111111111111111111111111111111' },
      { binding: 'SESSIONS', id: '22222222222222222222222222222222' },
    ],
  },
};
evidence.resourceDiagnostics = buildSafeResourceDiagnostics({
  resources: {
    workers: evidence.workers,
    d1Databases: evidence.databases,
    kvNamespaces: evidence.kvNamespaces,
    r2Buckets: evidence.r2Buckets,
    queues: evidence.queues,
    durableObjects: evidence.durableObjects.map((entry) => ({
      script: 'tirak-backend-staging',
      class: entry.className,
      use_sqlite: entry.useSqlite,
    })),
  },
  unresolvedFrozenMatches: {
    workers: false,
    d1Databases: false,
    kvNamespaces: false,
    r2Buckets: false,
    queues: false,
    durableObjects: false,
  },
});

function fixtureRequestLog(verificationType = 'user-token') {
  const accountId = '2c0c96c68f0ee73b6d980054557bca5b';
  const worker = 'tirak-backend-staging';
  const databaseId = '11111111-1111-4111-8111-111111111111';
  const versionId = '11111111-1111-4111-8111-111111111111';
  const prefix = `/client/v4/accounts/${accountId}`;
  const accepted = (operation, method, path) => ({
    operation, method, path, status: 200, outcome: 'accepted-envelope', success: true,
  });
  const listed = (operation, path, mode, resultCount, ordinal = 1) => ({
    ...accepted(operation, 'GET', path),
    pagination: { mode, ordinal, resultCount },
  });
  const tokenFlow = verificationType === 'account-token'
    ? [
      { operation: 'token verification', method: 'GET', path: '/client/v4/user/tokens/verify', status: 401, outcome: 'api-failure', success: false },
      accepted('account token verification', 'GET', `${prefix}/tokens/verify`),
      accepted('current account token details', 'GET', `${prefix}/tokens/{verified-current-token}`),
    ]
    : [
      accepted('token verification', 'GET', '/client/v4/user/tokens/verify'),
      accepted('current token details', 'GET', '/client/v4/user/tokens/{verified-current-token}'),
    ];
  const selectCount = 3 + Object.keys(evidence.rowCounts).length
    + (evidence.schemaInventory.migrationLedgerTablePresent ? 1 : 0);
  return [
    ...tokenFlow,
    accepted('account identity', 'GET', prefix),
    listed('Worker list', `${prefix}/workers/scripts`, 'single', evidence.resourceDiagnostics.observedCounts.workers),
    accepted('Worker deployments', 'GET', `${prefix}/workers/scripts/${worker}/deployments`),
    accepted('Worker version detail', 'GET', `${prefix}/workers/scripts/${worker}/versions/${versionId}`),
    listed('D1 list', `${prefix}/d1/database`, 'page', evidence.resourceDiagnostics.observedCounts.d1Databases),
    listed('KV list', `${prefix}/storage/kv/namespaces`, 'page', evidence.resourceDiagnostics.observedCounts.kvNamespaces),
    listed('R2 list', `${prefix}/r2/buckets`, 'cursor', evidence.resourceDiagnostics.observedCounts.r2Buckets),
    listed('Queue list', `${prefix}/queues`, 'page', evidence.resourceDiagnostics.observedCounts.queues),
    listed('Durable Object list', `${prefix}/workers/durable_objects/namespaces`, 'page', evidence.resourceDiagnostics.observedCounts.durableObjects),
    accepted('D1 detail', 'GET', `${prefix}/d1/database/${databaseId}`),
    ...Array.from({ length: selectCount }, () => accepted('D1 SELECT', 'POST', `${prefix}/d1/database/${databaseId}/query`)),
  ];
}

try {
  const configured = parseStagingConfig(concreteConfig);
  const pending = evaluateStagingEvidence(configured, evidence);
  assert(pending.resourcesVerified, `positive evidence rejected: ${JSON.stringify(pending.blockers)}`);
  assert(pending.status === 'PENDING_HUMAN_CONFIRMATION', 'read-only evidence bypassed human confirmation');
  assert(pending.mutationAllowed === false, 'T-025 incorrectly authorized mutation');

  const diagnosticVariantEvidence = structuredClone(evidence);
  diagnosticVariantEvidence.resourceDiagnostics.observedCounts.workers += 1;
  diagnosticVariantEvidence.resourceDiagnostics.observedCounts.total += 1;
  const diagnosticVariant = evaluateStagingEvidence(configured, diagnosticVariantEvidence);
  assert(diagnosticVariant.resourcesVerified === true
    && diagnosticVariant.targetFingerprint === pending.targetFingerprint,
  'informational diagnostics changed exact acceptance behavior or the human-reviewed identity fingerprint');

  const humanConfirmation = {
    taskId: TASK_ID,
    targetFingerprint: pending.targetFingerprint,
    approvedBy: 'human release owner',
    approvedAt: '2026-07-20T00:00:00.000Z',
    statement: CONFIRMATION_STATEMENT,
    acceptedVarianceIds: [REST_METADATA_VARIANCE_ID],
  };
  const confirmed = evaluateStagingEvidence(configured, evidence, humanConfirmation);
  assert(confirmed.status === FINAL_STATUS, 'exact human confirmation was not recognized');
  assert(confirmed.mutationAllowed === false, 'human identity confirmation improperly authorized mutation');

  const placeholderConfigured = structuredClone(configured);
  placeholderConfigured.database[0].id = 'placeholder-staging-db-id';
  placeholderConfigured.kv[0].id = 'placeholder-cache-staging-id';
  placeholderConfigured.kv[1].id = 'placeholder-sessions-staging-id';
  const placeholderPending = evaluateStagingEvidence(placeholderConfigured, evidence);
  assert(placeholderPending.targetFingerprint === pending.targetFingerprint,
    'placeholder-only configuration changed the evidence fingerprint and created an approval cycle');
  assert(placeholderPending.blockers.length === 1
    && placeholderPending.blockers[0]?.code === 'CONFIGURED_IDENTITIES_CONCRETE',
  'placeholder transition fixture has an unexpected machine-evidence blocker');
  const placeholderApproved = evaluateStagingEvidence(placeholderConfigured, evidence, humanConfirmation);
  assert(placeholderApproved.status === 'HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION'
    && placeholderApproved.humanConfirmation !== null
    && placeholderApproved.localConfigurationCorrectionAuthorized === true
    && placeholderApproved.resourcesVerified === false
    && placeholderApproved.mutationAllowed === false,
  'exact approval could not be recorded safely before local placeholder correction');
  const correctedRerun = evaluateStagingEvidence(configured, evidence, placeholderApproved.humanConfirmation);
  assert(correctedRerun.targetFingerprint === placeholderApproved.targetFingerprint
    && correctedRerun.status === FINAL_STATUS
    && correctedRerun.resourcesVerified === true
    && correctedRerun.localConfigurationCorrectionAuthorized === false,
  'corrected-configuration rerun did not preserve and revalidate the unchanged approval fingerprint');

  const lineageAnomalyEvidence = structuredClone(evidence);
  lineageAnomalyEvidence.migrationLineage = {
    status: 'blocked_pending_T028',
    anomalies: [{
      code: 'LOCAL_MIGRATION_PREFIX_DUPLICATE',
      prefix: '004',
      files: ['004_background_jobs_tables.sql', '004_mobile_app_features.sql'],
    }],
    t028Blocked: true,
    mutationAuthorized: false,
  };
  const lineageAnomaly = evaluateStagingEvidence(configured, lineageAnomalyEvidence);
  assert(lineageAnomaly.resourcesVerified === true, 'T-028 lineage anomaly suppressed otherwise complete T-025 evidence');

  const emptyDatabaseEvidence = structuredClone(evidence);
  emptyDatabaseEvidence.schemaInventory = {
    source: 'sqlite_schema',
    excludedInternalTables: ['sqlite_%', '_cf_%', 'd1_migrations'],
    userTableCount: 0,
    userTableNames: [],
    migrationLedgerTablePresent: false,
  };
  emptyDatabaseEvidence.rowCounts = {};
  emptyDatabaseEvidence.migrationLedger = [];
  const emptyDatabase = evaluateStagingEvidence(configured, emptyDatabaseEvidence);
  assert(emptyDatabase.resourcesVerified === true,
    `explicit sqlite_schema zero-user-table evidence was rejected: ${JSON.stringify(emptyDatabase.blockers)}`);

  const inconsistentEmptyEvidence = structuredClone(emptyDatabaseEvidence);
  inconsistentEmptyEvidence.schemaInventory.userTableCount = 1;
  const inconsistentEmpty = evaluateStagingEvidence(configured, inconsistentEmptyEvidence);
  assert(inconsistentEmpty.resourcesVerified === false
    && inconsistentEmpty.blockers.some((entry) => entry.code === 'STAGING_D1_SCHEMA_INVENTORY'),
  'inconsistent empty-D1 evidence did not fail closed');

  const acceptedFixture = {
    schemaVersion: 2,
    taskId: TASK_ID,
    contractVersion: CONTRACT_VERSION,
    generatedAt: '2026-07-20T00:00:00.000Z',
    environment: 'staging',
    authority: 'T-024 approved authenticated read-only staging evidence only',
    discoveryTransport: 'Cloudflare REST API token through fixed read-only client',
    discoveryState: FINAL_DISCOVERY_STATE,
    ...confirmed,
    configured: publicConfiguredSummary(configured),
    evidence,
    requestLog: fixtureRequestLog(),
    secretsCaptured: false,
    productionCommandsExecuted: 0,
    remoteMutationsExecuted: 0,
    t026Blocked: false,
    requiredNextAction: FINAL_NEXT_ACTION,
  };
  assertAcceptedManifest(acceptedFixture);
  const accountTokenFixture = structuredClone(acceptedFixture);
  accountTokenFixture.evidence.credential.verificationType = 'account-token';
  accountTokenFixture.requestLog = fixtureRequestLog('account-token');
  assertAcceptedManifest(accountTokenFixture);

  const sqliteAuthFallbackEvidence = structuredClone(evidence);
  sqliteAuthFallbackEvidence.databaseInfo.reportedTableCount = 0;
  sqliteAuthFallbackEvidence.databaseInfo.schemaUserVersionEvidence = {
    source: 'fresh-empty-d1-invariant',
    directReadStatus: 'cloudflare-sqlite-auth-refused',
    providerErrorCode: 7500,
    remoteReportedTableCount: 0,
  };
  sqliteAuthFallbackEvidence.schemaInventory = {
    source: 'sqlite_schema',
    excludedInternalTables: ['sqlite_%', '_cf_%', 'd1_migrations'],
    userTableCount: 0,
    userTableNames: [],
    migrationLedgerTablePresent: false,
  };
  sqliteAuthFallbackEvidence.migrationLedger = [];
  sqliteAuthFallbackEvidence.rowCounts = {};
  const sqliteAuthFallbackPending = evaluateStagingEvidence(configured, sqliteAuthFallbackEvidence);
  assert(sqliteAuthFallbackPending.resourcesVerified === true,
    'fresh-empty D1 fallback fixture did not satisfy evidence evaluation');
  const sqliteAuthFallbackConfirmation = {
    ...humanConfirmation,
    targetFingerprint: sqliteAuthFallbackPending.targetFingerprint,
  };
  const sqliteAuthFallbackConfirmed = evaluateStagingEvidence(
    configured,
    sqliteAuthFallbackEvidence,
    sqliteAuthFallbackConfirmation,
  );
  const sqliteAuthFallbackFixture = {
    ...acceptedFixture,
    ...sqliteAuthFallbackConfirmed,
    evidence: sqliteAuthFallbackEvidence,
    requestLog: fixtureRequestLog().filter((entry) => entry.operation !== 'D1 SELECT'),
  };
  const fallbackD1Path = `/client/v4/accounts/${configured.accountId}/d1/database/${configured.database[0].id}/query`;
  sqliteAuthFallbackFixture.requestLog.push(
    { operation: 'D1 SELECT', method: 'POST', path: fallbackD1Path, status: 400, outcome: 'api-failure', success: false },
    { operation: 'D1 SELECT', method: 'POST', path: fallbackD1Path, status: 200, outcome: 'accepted-envelope', success: true },
    { operation: 'D1 SELECT', method: 'POST', path: fallbackD1Path, status: 200, outcome: 'accepted-envelope', success: true },
  );
  assertAcceptedManifest(sqliteAuthFallbackFixture);

  const multiPageFixture = structuredClone(acceptedFixture);
  multiPageFixture.evidence.resourceDiagnostics.observedCounts.kvNamespaces = 101;
  multiPageFixture.evidence.resourceDiagnostics.observedCounts.r2Buckets = 2;
  multiPageFixture.evidence.resourceDiagnostics.observedCounts.total += 100;
  const kvIndex = multiPageFixture.requestLog.findIndex((entry) => entry.operation === 'KV list');
  multiPageFixture.requestLog[kvIndex].pagination.resultCount = 100;
  const kvSecond = structuredClone(multiPageFixture.requestLog[kvIndex]);
  kvSecond.pagination.ordinal = 2;
  kvSecond.pagination.resultCount = 1;
  multiPageFixture.requestLog.splice(kvIndex + 1, 0, kvSecond);
  const r2Index = multiPageFixture.requestLog.findIndex((entry) => entry.operation === 'R2 list');
  const r2Second = structuredClone(multiPageFixture.requestLog[r2Index]);
  r2Second.pagination.ordinal = 2;
  r2Second.pagination.resultCount = 1;
  multiPageFixture.requestLog.splice(r2Index + 1, 0, r2Second);
  assertAcceptedManifest(multiPageFixture);

  const refusals = [];
  const expectRefusal = (name, mutate, sourceFixture = acceptedFixture) => {
    const fixture = structuredClone(sourceFixture);
    mutate(fixture);
    let refused = false;
    try { assertAcceptedManifest(fixture); } catch { refused = true; }
    assert(refused, `${name} bypassed strict manifest acceptance`);
    refusals.push(name);
  };
  expectRefusal('pending status', (fixture) => { fixture.status = 'PENDING_HUMAN_CONFIRMATION'; });
  expectRefusal('resources unverified', (fixture) => { fixture.resourcesVerified = false; });
  expectRefusal('missing fingerprint', (fixture) => { fixture.targetFingerprint = null; });
  expectRefusal('placeholder configuration', (fixture) => {
    fixture.configured.database[0].id = 'placeholder-staging-db-id';
    fixture.configured.containsPlaceholders = true;
  });
  expectRefusal('wrong configured account', (fixture) => { fixture.configured.accountId = 'f'.repeat(32); });
  expectRefusal('wrong confirmation statement', (fixture) => { fixture.humanConfirmation.statement = 'approved'; });
  expectRefusal('wrong confirmation fingerprint', (fixture) => { fixture.humanConfirmation.targetFingerprint = '0'.repeat(64); });
  expectRefusal('unaccepted REST variance', (fixture) => { fixture.humanConfirmation.acceptedVarianceIds = []; });
  expectRefusal('mutation authorized', (fixture) => { fixture.mutationAllowed = true; });
  expectRefusal('remote mutation recorded', (fixture) => { fixture.remoteMutationsExecuted = 1; });
  expectRefusal('secret capture recorded', (fixture) => { fixture.secretsCaptured = true; });
  expectRefusal('one-GET request log', (fixture) => { fixture.requestLog = fixture.requestLog.filter((entry) => entry.operation === 'account identity'); });
  expectRefusal('incomplete operation set', (fixture) => { fixture.requestLog = fixture.requestLog.filter((entry) => entry.operation !== 'Durable Object list'); });
  expectRefusal('wrong request account', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'account identity').path = `/client/v4/accounts/${'f'.repeat(32)}`;
  });
  expectRefusal('wrong request Worker', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'Worker deployments').path = `/client/v4/accounts/2c0c96c68f0ee73b6d980054557bca5b/workers/scripts/tirak-other-staging/deployments`;
  });
  expectRefusal('wrong request D1', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'D1 detail').path = `/client/v4/accounts/2c0c96c68f0ee73b6d980054557bca5b/d1/database/22222222-2222-4222-8222-222222222222`;
  });
  expectRefusal('missing D1 SELECT', (fixture) => { fixture.requestLog = fixture.requestLog.filter((entry) => entry.operation !== 'D1 SELECT'); });
  expectRefusal('extra request evidence', (fixture) => {
    fixture.requestLog.push(structuredClone(fixture.requestLog.find((entry) => entry.operation === 'account identity')));
  });
  expectRefusal('unsafe request outcome', (fixture) => {
    const entry = fixture.requestLog.find((candidate) => candidate.operation === 'Queue list');
    entry.status = 500;
    entry.outcome = 'api-failure';
    entry.success = false;
  });
  expectRefusal('unexpected D1 failure without fallback', (fixture) => {
    const entry = fixture.requestLog.find((candidate) => candidate.operation === 'D1 SELECT');
    entry.status = 400;
    entry.outcome = 'api-failure';
    entry.success = false;
  });
  expectRefusal('wrong D1 fallback status', (fixture) => {
    fixture.requestLog.find((candidate) => candidate.operation === 'D1 SELECT').status = 403;
  }, sqliteAuthFallbackFixture);
  expectRefusal('missing D1 fallback failure', (fixture) => {
    const entry = fixture.requestLog.find((candidate) => candidate.operation === 'D1 SELECT');
    entry.status = 200;
    entry.outcome = 'accepted-envelope';
    entry.success = true;
  }, sqliteAuthFallbackFixture);
  expectRefusal('missing list pagination', (fixture) => {
    delete fixture.requestLog.find((entry) => entry.operation === 'D1 list').pagination;
  });
  const expandKvPaginationFixture = (fixture, secondOrdinal) => {
    fixture.evidence.resourceDiagnostics.observedCounts.kvNamespaces = 101;
    fixture.evidence.resourceDiagnostics.observedCounts.total += 99;
    const firstIndex = fixture.requestLog.findIndex((entry) => entry.operation === 'KV list');
    fixture.requestLog[firstIndex].pagination.resultCount = 100;
    const second = structuredClone(fixture.requestLog[firstIndex]);
    second.pagination.ordinal = secondOrdinal;
    second.pagination.resultCount = 1;
    fixture.requestLog.splice(firstIndex + 1, 0, second);
  };
  expectRefusal('duplicate pagination ordinal', (fixture) => { expandKvPaginationFixture(fixture, 1); });
  expectRefusal('skipped pagination ordinal', (fixture) => { expandKvPaginationFixture(fixture, 3); });
  expectRefusal('wrong pagination mode', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'R2 list').pagination.mode = 'page';
  });
  expectRefusal('wrong pagination result total', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'Queue list').pagination.resultCount -= 1;
  });
  expectRefusal('pagination on non-list operation', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'account identity').pagination = {
      mode: 'single', ordinal: 1, resultCount: 1,
    };
  });
  expectRefusal('extra pagination field', (fixture) => {
    fixture.requestLog.find((entry) => entry.operation === 'Worker list').pagination.cursor = 'redacted';
  });
  expectRefusal('unsafe request field', (fixture) => { fixture.requestLog[0].headers = { Authorization: 'redacted' }; });

  let currentManifest = null;
  const currentManifestPath = process.argv[2];
  if (currentManifestPath) {
    const resolved = assertOwnerOnlyLedger(currentManifestPath);
    currentManifest = JSON.parse(readFileSync(resolved, 'utf8'));
    assertAcceptedManifest(currentManifest);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    positiveFixture: 'PASS',
    humanGate: 'PASS',
    mutationBoundary: 'PASS',
    paginationTranscript: 'PASS',
    twoStageApprovalTransition: 'PASS',
    lineageDeferredToT028: 'PASS',
    strictAcceptanceRefusals: refusals.length,
    currentManifest: currentManifest ? currentManifest.status : 'not supplied',
  }, null, 2));
} catch (error) {
  console.error(`T-025 staging ledger verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
