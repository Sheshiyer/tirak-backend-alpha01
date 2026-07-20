import {
  CONFIRMATION_STATEMENT,
  evaluateStagingEvidence,
  parseStagingConfig,
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
[env.staging.vars]
ENVIRONMENT = "staging"
PAYMENT_MODE = "disabled"
PROMPTPAY_ENABLED = "false"
`;
const baseEvidence = {
  account: { authenticated: true, targetAccountPresent: true },
  workers: [{ name: 'tirak-backend-staging' }],
  databases: [{ name: 'tirak-staging', uuid: '11111111-1111-4111-8111-111111111111' }],
  databaseInfo: { id: '11111111-1111-4111-8111-111111111111', storageVersion: 'production' },
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
    { binding: 'CHAT_ROOM', className: 'ChatRoom' },
    { binding: 'NOTIFICATION_SERVICE', className: 'NotificationService' },
  ],
  migrationLedger: [],
  pendingMigrations: [],
  rowCounts: { bookings: 0 },
};

try {
  const configured = parseStagingConfig(baseConfig);
  const failures = [];
  const expectBlocked = (name, mutate) => {
    const evidence = structuredClone(baseEvidence);
    const config = structuredClone(configured);
    mutate({ evidence, config });
    const result = evaluateStagingEvidence(config, evidence);
    assert(!result.resourcesVerified && result.mutationAllowed === false, `${name} did not fail closed`);
    failures.push(name);
  };

  expectBlocked('authenticated account mismatch', ({ evidence }) => { evidence.account.targetAccountPresent = false; });
  expectBlocked('duplicate D1 staging identity', ({ evidence }) => { evidence.databases.push(structuredClone(evidence.databases[0])); });
  expectBlocked('missing notification DLQ', ({ evidence }) => { evidence.queues = evidence.queues.filter((entry) => entry.name !== 'tirak-notification-dlq-staging'); });
  expectBlocked('Durable Object class mismatch', ({ evidence }) => { evidence.durableObjects[0].className = 'WrongClass'; });
  expectBlocked('production-like R2 name', ({ config }) => { config.r2[0].name = 'tirak-storage-production'; });
  expectBlocked('configured D1 placeholder', ({ config }) => { config.database[0].id = 'placeholder-staging-db-id'; });
  expectBlocked('missing row counts', ({ evidence }) => { evidence.rowCounts = {}; });

  const pending = evaluateStagingEvidence(configured, baseEvidence);
  const badApproval = evaluateStagingEvidence(configured, baseEvidence, {
    taskId: 'T-025',
    targetFingerprint: '0'.repeat(64),
    approvedBy: 'human release owner',
    approvedAt: '2026-07-20T00:00:00Z',
    statement: CONFIRMATION_STATEMENT,
  });
  assert(pending.resourcesVerified, 'base fixture unexpectedly invalid');
  assert(badApproval.status === 'PENDING_HUMAN_CONFIRMATION', 'wrong fingerprint bypassed human gate');
  failures.push('wrong human-confirmation fingerprint');

  const productionProbe = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs', '--environment', 'production'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: 'T-024_APPROVED_READ_ONLY' },
  });
  assert(productionProbe.status !== 0 && /only the literal staging environment/i.test(productionProbe.stderr), 'production CLI target was not refused before discovery');
  failures.push('production CLI target');

  const missingAuthorization = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: '' },
  });
  assert(missingAuthorization.status !== 0 && /T-024_APPROVED_READ_ONLY/.test(missingAuthorization.stderr), 'missing read-only authorization was not refused');
  failures.push('missing read-only authorization');

  console.log(JSON.stringify({ status: 'PASS', negativeFixtures: failures, fixtureCount: failures.length }, null, 2));
} catch (error) {
  console.error(`T-025 negative verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
