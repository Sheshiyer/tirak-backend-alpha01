import { readFileSync } from 'node:fs';
import {
  CONFIRMATION_STATEMENT,
  evaluateStagingEvidence,
  parseStagingConfig,
} from './staging-ledger-lib.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  account: { authenticated: true, targetAccountPresent: true, observedMembershipCount: 1, identitiesRedacted: true },
  workers: [{ name: 'tirak-backend-staging', deployments: [{ id: 'deployment-1' }] }],
  databases: [{ name: 'tirak-staging', uuid: '11111111-1111-4111-8111-111111111111' }],
  databaseInfo: { id: '11111111-1111-4111-8111-111111111111', name: 'tirak-staging', storageVersion: 'production' },
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
    { binding: 'CHAT_ROOM', className: 'ChatRoom' },
    { binding: 'NOTIFICATION_SERVICE', className: 'NotificationService' },
  ],
  migrationLedger: [{ id: 1, name: '001_initial_schema.sql', applied_at: '2026-01-01T00:00:00Z' }],
  pendingMigrations: ['008_payment_attempts.sql'],
  rowCounts: { bookings: 12, d1_migrations: 1, chat_rooms: 3 },
};

try {
  const configured = parseStagingConfig(concreteConfig);
  const pending = evaluateStagingEvidence(configured, evidence);
  assert(pending.resourcesVerified, `positive evidence rejected: ${JSON.stringify(pending.blockers)}`);
  assert(pending.status === 'PENDING_HUMAN_CONFIRMATION', 'read-only evidence bypassed human confirmation');
  assert(pending.mutationAllowed === false, 'T-025 incorrectly authorized mutation');
  const confirmed = evaluateStagingEvidence(configured, evidence, {
    taskId: 'T-025',
    targetFingerprint: pending.targetFingerprint,
    approvedBy: 'human release owner',
    approvedAt: '2026-07-20T00:00:00Z',
    statement: CONFIRMATION_STATEMENT,
  });
  assert(confirmed.status === 'HUMAN_CONFIRMED_STAGING_IDENTITIES', 'exact human confirmation was not recognized');
  assert(confirmed.mutationAllowed === false, 'human identity confirmation improperly authorized mutation');

  const currentManifestPath = process.argv[2];
  let currentManifest = null;
  if (currentManifestPath) {
    currentManifest = JSON.parse(readFileSync(currentManifestPath, 'utf8'));
    assert(currentManifest.environment === 'staging', 'current ledger is not staging-only');
    assert(currentManifest.productionCommandsExecuted === 0, 'current ledger executed a production command');
    assert(currentManifest.remoteMutationsExecuted === 0, 'current ledger executed a remote mutation');
    assert(currentManifest.secretsCaptured === false, 'current ledger captured secret material');
  }

  console.log(JSON.stringify({
    status: 'PASS',
    positiveFixture: 'PASS',
    humanGate: 'PASS',
    mutationBoundary: 'PASS',
    currentManifest: currentManifest ? currentManifest.status : 'not supplied',
  }, null, 2));
} catch (error) {
  console.error(`T-025 staging ledger verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
