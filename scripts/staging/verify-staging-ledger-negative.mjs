import {
  buildSafeResourceDiagnostics,
  CONFIRMATION_STATEMENT,
  evaluateStagingEvidence,
  parseStagingConfig,
  REST_METADATA_VARIANCE,
  REST_METADATA_VARIANCE_ID,
} from './staging-ledger-lib.mjs';
import { spawnSync } from 'node:child_process';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseConfig = `
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
const baseEvidence = {
  account: {
    authenticated: true,
    targetAccountPresent: true,
    verifiedAccountId: '2c0c96c68f0ee73b6d980054557bca5b',
    identitiesRedacted: true,
  },
  credential: {
    present: true,
    source: 'offline-fixture',
    tokenCaptured: false,
    scopeInspected: true,
    pinnedAccountIncluded: true,
    permissionRisk: 'read-only',
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
    storageVersion: 'production',
    schemaUserVersion: 0,
    schemaUserVersionEvidence: { source: 'read-only-select', directReadStatus: 'accepted' },
  },
  schemaInventory: {
    source: 'sqlite_schema',
    excludedInternalTables: ['sqlite_%', '_cf_%', 'd1_migrations'],
    userTableCount: 1,
    userTableNames: ['bookings'],
    migrationLedgerTablePresent: false,
  },
  kvNamespaces: [
    { binding: 'CACHE', title: 'tirak-cache-staging', id: '11111111111111111111111111111111' },
    { binding: 'SESSIONS', title: 'tirak-sessions-staging', id: '22222222222222222222222222222222' },
  ],
  r2Buckets: [{ name: 'tirak-storage-staging' }],
  queues: [
    'tirak-moderation-staging', 'tirak-moderation-dlq-staging', 'tirak-analytics-staging',
    'tirak-analytics-dlq-staging', 'tirak-notification-staging', 'tirak-notification-dlq-staging',
  ].map((name) => ({ name })),
  durableObjects: [
    { binding: 'CHAT_ROOM', className: 'ChatRoom', useSqlite: true },
    { binding: 'NOTIFICATION_SERVICE', className: 'NotificationService', useSqlite: true },
  ],
  migrationLedger: [],
  pendingMigrations: [],
  migrationLineage: { status: 'clear', anomalies: [], t028Blocked: false, mutationAuthorized: false },
  rowCounts: { bookings: 0 },
  proposedConfiguration: {
    database: [{ binding: 'DB', name: 'tirak-staging', id: '11111111-1111-4111-8111-111111111111' }],
    kv: [
      { binding: 'CACHE', id: '11111111111111111111111111111111' },
      { binding: 'SESSIONS', id: '22222222222222222222222222222222' },
    ],
  },
};
baseEvidence.resourceDiagnostics = buildSafeResourceDiagnostics({
  resources: {
    workers: baseEvidence.workers,
    d1Databases: baseEvidence.databases,
    kvNamespaces: baseEvidence.kvNamespaces,
    r2Buckets: baseEvidence.r2Buckets,
    queues: baseEvidence.queues,
    durableObjects: baseEvidence.durableObjects.map((entry) => ({
      script: 'tirak-backend-staging', class: entry.className, use_sqlite: entry.useSqlite,
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

try {
  const configured = parseStagingConfig(baseConfig);
  const failures = [];
  const allUnresolved = {
    workers: true,
    d1Databases: true,
    kvNamespaces: true,
    r2Buckets: true,
    queues: true,
    durableObjects: true,
  };
  const diagnosticProjection = buildSafeResourceDiagnostics({
    resources: {
      workers: [{ name: 'tirak-backend-production' }, { name: 'tirak-candidate-staging' }],
      d1Databases: [
        { name: 'tirak-production', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { name: 'tirak-candidate-staging', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      ],
      kvNamespaces: [
        { title: 'tirak-cache-live', id: 'a'.repeat(32) },
        { title: 'tirak-cache-candidate-staging', id: 'b'.repeat(32) },
      ],
      r2Buckets: [{ name: 'tirak-storage-prod' }, { name: 'tirak-storage-candidate-staging' }],
      queues: [{ name: 'tirak-notification-production' }, { name: 'tirak-notification-candidate-staging' }],
      durableObjects: [
        { script: 'tirak-backend-live', class: 'ChatRoom', use_sqlite: true },
        { script: 'tirak-candidate-staging', class: 'ChatRoom', use_sqlite: true },
      ],
    },
    unresolvedFrozenMatches: allUnresolved,
  });
  const persistedCandidates = JSON.stringify(diagnosticProjection.stagingCandidates);
  assert(!/(?:production|prod|live)/i.test(persistedCandidates), 'production-like diagnostic candidate persisted');
  assert(Object.values(diagnosticProjection.stagingCandidates).every((entries) => entries.length === 1),
    'staging-only diagnostic projection did not retain exactly the safe candidates');
  failures.push('production-like diagnostic candidate exclusion');

  const expectDiagnosticRefusal = (name, factory) => {
    let refused = false;
    try { factory(); } catch { refused = true; }
    assert(refused, `${name} diagnostic input was not refused`);
    failures.push(name);
  };
  const emptyDiagnosticResources = {
    workers: [], d1Databases: [], kvNamespaces: [], r2Buckets: [], queues: [], durableObjects: [],
  };
  expectDiagnosticRefusal('malformed staging diagnostic identifier', () => buildSafeResourceDiagnostics({
    resources: { ...emptyDiagnosticResources, d1Databases: [{ name: 'tirak-candidate-staging', uuid: 'not-a-uuid' }] },
    unresolvedFrozenMatches: allUnresolved,
  }));
  expectDiagnosticRefusal('production-like Durable Object diagnostic class', () => buildSafeResourceDiagnostics({
    resources: {
      ...emptyDiagnosticResources,
      durableObjects: [{ script: 'tirak-candidate-staging', class: 'ChatRoomProduction', use_sqlite: true }],
    },
    unresolvedFrozenMatches: allUnresolved,
  }));
  expectDiagnosticRefusal('excessive per-type diagnostic candidates', () => buildSafeResourceDiagnostics({
    resources: {
      ...emptyDiagnosticResources,
      workers: Array.from({ length: 21 }, (_, index) => ({ name: `tirak-worker-${index}-staging` })),
    },
    unresolvedFrozenMatches: allUnresolved,
  }));
  expectDiagnosticRefusal('excessive total diagnostic candidates', () => buildSafeResourceDiagnostics({
    resources: {
      workers: Array.from({ length: 20 }, (_, index) => ({ name: `tirak-worker-${index}-staging` })),
      d1Databases: Array.from({ length: 20 }, (_, index) => ({ name: `tirak-d1-${index}-staging`, uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
      kvNamespaces: Array.from({ length: 20 }, (_, index) => ({ title: `tirak-kv-${index}-staging`, id: 'a'.repeat(32) })),
      r2Buckets: Array.from({ length: 20 }, (_, index) => ({ name: `tirak-r2-${index}-staging` })),
      queues: Array.from({ length: 20 }, (_, index) => ({ name: `tirak-queue-${index}-staging` })),
      durableObjects: Array.from({ length: 20 }, (_, index) => ({ script: `tirak-do-${index}-staging`, class: 'ChatRoom', use_sqlite: true })),
    },
    unresolvedFrozenMatches: allUnresolved,
  }));
  const expectBlocked = (name, mutate) => {
    const evidence = structuredClone(baseEvidence);
    const config = structuredClone(configured);
    mutate({ evidence, config });
    const result = evaluateStagingEvidence(config, evidence);
    assert(!result.resourcesVerified && result.mutationAllowed === false, `${name} did not fail closed`);
    failures.push(name);
  };

  expectBlocked('authenticated account mismatch', ({ evidence }) => { evidence.account.targetAccountPresent = false; });
  expectBlocked('missing current-token scope inspection', ({ evidence }) => { evidence.credential.scopeInspected = false; });
  expectBlocked('current-token scope omits pinned account', ({ evidence }) => { evidence.credential.pinnedAccountIncluded = false; });
  expectBlocked('missing REST metadata variance proposal', ({ evidence }) => { delete evidence.acceptanceVariance; });
  expectBlocked('missing proposed configuration', ({ evidence }) => { delete evidence.proposedConfiguration; });
  expectBlocked('malformed proposed configuration', ({ evidence }) => { evidence.proposedConfiguration.database[0].id = 'not-a-uuid'; });
  expectBlocked('mismatched proposed configuration', ({ evidence }) => { evidence.proposedConfiguration.kv[0].id = '3'.repeat(32); });
  expectBlocked('extra proposed configuration field', ({ evidence }) => { evidence.proposedConfiguration.unreviewed = true; });
  expectBlocked('production-like persisted diagnostic candidate', ({ evidence }) => {
    evidence.resourceDiagnostics.unresolvedFrozenMatches = ['workers'];
    evidence.resourceDiagnostics.stagingCandidates.workers = [{ name: 'tirak-backend-production' }];
  });
  expectBlocked('duplicate D1 staging identity', ({ evidence }) => { evidence.databases.push(structuredClone(evidence.databases[0])); });
  expectBlocked('missing notification DLQ', ({ evidence }) => { evidence.queues = evidence.queues.filter((entry) => entry.name !== 'tirak-notification-dlq-staging'); });
  expectBlocked('Durable Object class mismatch', ({ evidence }) => { evidence.durableObjects[0].className = 'WrongClass'; });
  expectBlocked('non-SQLite Durable Object namespace', ({ evidence }) => { evidence.durableObjects[0].useSqlite = false; });
  expectBlocked('active Worker queue binding mismatch', ({ evidence }) => { evidence.workerBindings[0].name = 'tirak-moderation-production'; });
  expectBlocked('active Worker payment mode enabled', ({ evidence }) => { evidence.workerRuntime.paymentMode = 'live'; });
  expectBlocked('active Worker migration tag mismatch', ({ evidence }) => { evidence.workerRuntime.migrationTag = 'v2'; });
  expectBlocked('production-like R2 name', ({ config }) => { config.r2[0].name = 'tirak-storage-production'; });
  expectBlocked('omitted R2 topology', ({ config }) => { config.r2 = []; });
  expectBlocked('extra Queue producer topology', ({ config }) => { config.queues.producers.push({ binding: 'EXTRA_QUEUE', name: 'tirak-extra-staging' }); });
  expectBlocked('omitted Durable Object topology', ({ config }) => { config.durableObjects.pop(); });
  expectBlocked('wrong Durable Object migration classes', ({ config }) => { config.durableObjectMigrations[0].newSqliteClasses = ['ChatRoom']; });
  expectBlocked('configured D1 identity mismatch', ({ config }) => { config.database[0].id = '33333333-3333-4333-8333-333333333333'; });
  expectBlocked('missing D1 schema user version', ({ evidence }) => { evidence.databaseInfo.schemaUserVersion = null; });
  expectBlocked('missing row counts', ({ evidence }) => { evidence.rowCounts = {}; });
  expectBlocked('inconsistent D1 schema user-table count', ({ evidence }) => { evidence.schemaInventory.userTableCount = 0; });
  expectBlocked('negative D1 schema user-table count', ({ evidence }) => { evidence.schemaInventory.userTableCount = -1; });
  expectBlocked('nonnumeric D1 schema user-table count', ({ evidence }) => { evidence.schemaInventory.userTableCount = '1'; });
  expectBlocked('malformed D1 schema table name', ({ evidence }) => { evidence.schemaInventory.userTableNames = ['bad-name']; });
  expectBlocked('malformed migration-lineage deferral', ({ evidence }) => {
    evidence.migrationLineage = { status: 'blocked_pending_T028', anomalies: [], t028Blocked: true, mutationAuthorized: false };
  });

  const pending = evaluateStagingEvidence(configured, baseEvidence);
  const badApproval = evaluateStagingEvidence(configured, baseEvidence, {
    taskId: 'T-025',
    targetFingerprint: '0'.repeat(64),
    approvedBy: 'human release owner',
    approvedAt: '2026-07-20T00:00:00Z',
    statement: CONFIRMATION_STATEMENT,
    acceptedVarianceIds: [REST_METADATA_VARIANCE_ID],
  });
  assert(pending.resourcesVerified, 'base fixture unexpectedly invalid');
  assert(badApproval.status === 'PENDING_HUMAN_CONFIRMATION', 'wrong fingerprint bypassed human gate');
  failures.push('wrong human-confirmation fingerprint');

  const badVarianceApproval = evaluateStagingEvidence(configured, baseEvidence, {
    taskId: 'T-025',
    targetFingerprint: pending.targetFingerprint,
    approvedBy: 'human release owner',
    approvedAt: '2026-07-20T00:00:00.000Z',
    statement: CONFIRMATION_STATEMENT,
    acceptedVarianceIds: ['UNREVIEWED_VARIANCE'],
  });
  assert(badVarianceApproval.status === 'PENDING_HUMAN_CONFIRMATION', 'wrong variance acceptance bypassed human gate');
  failures.push('wrong REST-variance acceptance');

  const productionProbe = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs', '--environment', 'production'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: 'T-024_APPROVED_READ_ONLY' },
  });
  assert(productionProbe.status !== 0 && /only the literal staging environment/i.test(productionProbe.stderr), 'production CLI target was not refused before discovery');
  failures.push('production CLI target');

  const missingAuthorization = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs', '--credential-mode', 'absent-for-offline-test'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: '' },
  });
  assert(missingAuthorization.status !== 0 && /T-024_APPROVED_READ_ONLY/.test(missingAuthorization.stderr), 'missing read-only authorization was not refused');
  failures.push('missing read-only authorization');

  console.log(JSON.stringify({ status: 'PASS', negativeFixtures: failures, fixtureCount: failures.length }, null, 2));
} catch (error) {
  console.error(`T-025 negative verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
