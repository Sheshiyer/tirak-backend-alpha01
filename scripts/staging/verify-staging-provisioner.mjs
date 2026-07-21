import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLY_CONFIRMATION,
  createCloudflareStagingProvisioningClient,
  PINNED_ACCOUNT_ID,
  runStagingProvisioning,
  SafeProvisioningError,
  STAGING_TARGETS,
} from './staging-provisioner.mjs';

const TOKEN = 'offline-fixture-token-never-sent';
const HOSTILE = 'raw-error-with-secret-and-request-body';
const WORKER_ETAG = '"tirak-backend-staging-bootstrap-v1"';
const bootstrapSource = readFileSync(new URL('./bootstrap-worker.mjs', import.meta.url), 'utf8');
const bootstrapConfig = readFileSync(new URL('../../wrangler.staging-bootstrap.toml', import.meta.url), 'utf8');
const provisioningCliSource = readFileSync(new URL('./provision-staging-resources.mjs', import.meta.url), 'utf8');
const gitignoreSource = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof SafeProvisioningError, `expected SafeProvisioningError, received ${error?.constructor?.name}`);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    passed += 1;
    return;
  }
  throw new Error(`expected ${code} refusal`);
}

function uuid(index) {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

function makeState({ full = false } = {}) {
  const state = {
    workers: [],
    d1: [],
    kv: [],
    r2: [],
    queues: [],
    subdomain: { enabled: false, previews_enabled: false },
  };
  if (full) {
    state.workers.push({ id: STAGING_TARGETS.worker, etag: WORKER_ETAG });
    state.d1.push({ name: STAGING_TARGETS.d1, uuid: uuid(1) });
    state.kv.push(
      { title: STAGING_TARGETS.kv[0], id: 'a'.repeat(32) },
      { title: STAGING_TARGETS.kv[1], id: 'b'.repeat(32) },
    );
    state.r2.push({ name: STAGING_TARGETS.r2 });
    STAGING_TARGETS.queues.forEach((queueName, index) => state.queues.push({ queue_name: queueName, queue_id: uuid(index + 10) }));
  }
  return state;
}

function jsonResponse(result, { status = 200, success = true, resultInfo, contentType = 'application/json' } = {}) {
  return new Response(JSON.stringify({ success, result, ...(resultInfo === undefined ? {} : { result_info: resultInfo }) }), {
    status,
    headers: { 'content-type': contentType },
  });
}

function pageInfo(items) {
  return { page: 1, per_page: 100, count: items.length, total_count: items.length };
}

function makeMock(state, {
  accountId = PINNED_ACCOUNT_ID,
  failCreateName = null,
  failSubdomain = false,
  wrongCreateName = null,
  malformedOperation = null,
  redirectOperation = null,
  workerResultInfo = undefined,
  workerAppearsOnListCall = null,
  workerDriftsOnListCall = null,
  workerAppearsAtPut = false,
  subdomainSetResult = null,
  subdomainGetResult = null,
} = {}) {
  const calls = [];
  let createActive = 0;
  let maxConcurrentCreates = 0;
  let workerListCalls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const key = `${method} ${path}`;
    const prefix = `/client/v4/accounts/${PINNED_ACCOUNT_ID}`;
    const createCall = method === 'POST' || method === 'PUT';
    const ifNoneMatch = init.headers?.['If-None-Match'];
    calls.push({ method, path, search: url.search, redirect: init.redirect, ifNoneMatch });
    const exactWorkerPut = method === 'PUT' && path === `${prefix}/workers/scripts/${STAGING_TARGETS.worker}`;
    assert(exactWorkerPut ? ifNoneMatch === '*' : ifNoneMatch === undefined,
      'If-None-Match was absent from Worker create or escaped its exact endpoint');
    if (createCall) {
      createActive += 1;
      maxConcurrentCreates = Math.max(maxConcurrentCreates, createActive);
      await Promise.resolve();
    }
    try {
      if (redirectOperation === key) return jsonResponse({}, { status: 302 });
      if (malformedOperation === key) return jsonResponse({ malformed: true }, { resultInfo: null });
      if (method === 'GET' && path === prefix) return jsonResponse({ id: accountId });
      if (method === 'GET' && path === `${prefix}/workers/scripts`) {
        workerListCalls += 1;
        if (workerListCalls === workerAppearsOnListCall
          && !state.workers.some((entry) => (entry.id ?? entry.name) === STAGING_TARGETS.worker)) {
          state.workers.push({ id: STAGING_TARGETS.worker });
        }
        if (workerListCalls === workerDriftsOnListCall) state.workers.push({ id: 'unrelated-worker-staging' });
        const info = typeof workerResultInfo === 'function' ? workerResultInfo(state.workers, workerListCalls) : workerResultInfo;
        return jsonResponse(state.workers, { resultInfo: info });
      }
      if (method === 'GET' && path === `${prefix}/d1/database`) return jsonResponse(state.d1, { resultInfo: pageInfo(state.d1) });
      if (method === 'GET' && path === `${prefix}/storage/kv/namespaces`) return jsonResponse(state.kv, { resultInfo: pageInfo(state.kv) });
      if (method === 'GET' && path === `${prefix}/r2/buckets`) return jsonResponse({ buckets: state.r2, cursor: null });
      if (method === 'GET' && path === `${prefix}/queues`) return jsonResponse(state.queues, { resultInfo: pageInfo(state.queues) });
      if (path === `${prefix}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`) {
        if (method === 'POST') {
          const body = JSON.parse(init.body);
          assert(JSON.stringify(body) === JSON.stringify({ enabled: false, previews_enabled: false }), 'Worker subdomain body mismatch');
          if (failSubdomain) throw new Error(`${HOSTILE}:${TOKEN}`);
          state.subdomain = { enabled: false, previews_enabled: false };
          return jsonResponse(subdomainSetResult ?? state.subdomain);
        }
        if (method === 'GET') return jsonResponse(subdomainGetResult ?? state.subdomain);
      }

      let name;
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        name = body.name ?? body.title ?? body.queue_name;
        if (path === `${prefix}/d1/database`) {
          assert(JSON.stringify(body) === JSON.stringify({
            name: STAGING_TARGETS.d1,
            primary_location_hint: 'apac',
            read_replication: { mode: 'disabled' },
          }), 'D1 create body mismatch');
        }
        if (path === `${prefix}/r2/buckets`) {
          assert(JSON.stringify(body) === JSON.stringify({ name: STAGING_TARGETS.r2, locationHint: 'apac' }), 'R2 create body mismatch');
        }
      } else if (method === 'PUT') {
        name = decodeURIComponent(path.split('/').at(-1));
        assert(init.body instanceof FormData, 'Worker create did not use a multipart upload');
        assert(JSON.stringify([...init.body.keys()]) === JSON.stringify(['metadata', 'bootstrap-worker.mjs']), 'Worker multipart fields mismatch');
        const metadataPart = init.body.get('metadata');
        const modulePart = init.body.get('bootstrap-worker.mjs');
        const metadata = JSON.parse(await metadataPart.text());
        const expectedMetadata = {
          main_module: 'bootstrap-worker.mjs',
          compatibility_date: '2026-07-21',
          bindings: [
            { type: 'd1', name: 'DB', id: state.d1.find((entry) => entry.name === STAGING_TARGETS.d1).uuid },
            { type: 'kv_namespace', name: 'CACHE', namespace_id: state.kv.find((entry) => entry.title === STAGING_TARGETS.kv[0]).id },
            { type: 'kv_namespace', name: 'SESSIONS', namespace_id: state.kv.find((entry) => entry.title === STAGING_TARGETS.kv[1]).id },
            { type: 'r2_bucket', name: 'STORAGE', bucket_name: STAGING_TARGETS.r2 },
            { type: 'queue', name: 'MODERATION_QUEUE', queue_name: STAGING_TARGETS.queues[0] },
            { type: 'queue', name: 'ANALYTICS_QUEUE', queue_name: STAGING_TARGETS.queues[1] },
            { type: 'queue', name: 'NOTIFICATION_QUEUE', queue_name: STAGING_TARGETS.queues[2] },
            { type: 'durable_object_namespace', name: 'CHAT_ROOM', class_name: 'ChatRoom' },
            { type: 'durable_object_namespace', name: 'NOTIFICATION_SERVICE', class_name: 'NotificationService' },
            { type: 'plain_text', name: 'ENVIRONMENT', text: 'staging' },
            { type: 'plain_text', name: 'PAYMENT_MODE', text: 'disabled' },
            { type: 'plain_text', name: 'PROMPTPAY_ENABLED', text: 'false' },
          ],
          migrations: {
            new_tag: 'v1',
            steps: [{ new_sqlite_classes: ['ChatRoom', 'NotificationService'] }],
          },
        };
        assert(JSON.stringify(metadata) === JSON.stringify(expectedMetadata), 'Worker multipart metadata mismatch');
        assert(metadataPart.type === 'application/json', 'Worker metadata media type mismatch');
        assert(modulePart.type === 'application/javascript+module' && await modulePart.text() === bootstrapSource,
          'Worker module part mismatch');
      }
      if (name === failCreateName) throw new Error(`${HOSTILE}:${TOKEN}`);
      const resultName = name === wrongCreateName ? 'tirak-wrong-staging' : name;
      if (method === 'POST' && path === `${prefix}/d1/database`) {
        const result = { name: resultName, uuid: uuid(1) };
        state.d1.push(result);
        return jsonResponse(result);
      }
      if (method === 'POST' && path === `${prefix}/storage/kv/namespaces`) {
        const id = resultName === STAGING_TARGETS.kv[0] ? 'a'.repeat(32) : 'b'.repeat(32);
        const result = { title: resultName, id };
        state.kv.push(result);
        return jsonResponse(result);
      }
      if (method === 'POST' && path === `${prefix}/r2/buckets`) {
        const result = { name: resultName };
        state.r2.push(result);
        return jsonResponse(result);
      }
      if (method === 'POST' && path === `${prefix}/queues`) {
        const result = { queue_name: resultName, queue_id: uuid(state.queues.length + 10) };
        state.queues.push(result);
        return jsonResponse(result);
      }
      if (method === 'PUT' && path === `${prefix}/workers/scripts/${STAGING_TARGETS.worker}`) {
        if (workerAppearsAtPut) {
          state.workers.push({ id: STAGING_TARGETS.worker, etag: '"external-race-version"' });
          return jsonResponse({}, { status: 412, success: false });
        }
        const result = { name: resultName, etag: WORKER_ETAG };
        state.workers.push({ id: resultName, etag: WORKER_ETAG });
        return jsonResponse(result);
      }
      throw new Error(`unexpected offline mock request ${key}`);
    } finally {
      if (createCall) createActive -= 1;
    }
  };
  return { fetchImpl, calls, maxConcurrentCreates: () => maxConcurrentCreates };
}

function ledgerPath(label) {
  const directory = mkdtempSync(join(tmpdir(), `tirak-t025-${label}-`));
  return join(directory, 'ledger.json');
}

function assertZeroForbiddenCounts(ledger) {
  for (const key of ['productionMutations', 'deleteMutations', 'renameMutations', 'secretMutations', 'd1SchemaMutations']) {
    assert(ledger.mutationCounts[key] === 0, `${key} was not explicitly zero`);
  }
}

// Static bootstrap contract: isolated, inert, current, and free of live application surfaces.
{
  const module = await import('./bootstrap-worker.mjs');
  const response = await module.default.fetch();
  assert(response.status === 503 && response.headers.get('cache-control') === 'no-store', 'bootstrap fetch was not inert/no-store');
  assert(Object.keys(module.default).join(',') === 'fetch', 'bootstrap default export exposes a non-fetch handler');
  assert(typeof module.ChatRoom === 'function' && typeof module.NotificationService === 'function', 'bootstrap Durable Object classes missing');
  for (const exact of [
    'name = "tirak-backend-staging"',
    'account_id = "2c0c96c68f0ee73b6d980054557bca5b"',
    'compatibility_date = "2026-07-21"',
    'workers_dev = false',
    'database_name = "tirak-staging"',
    'bucket_name = "tirak-storage-staging"',
    'new_sqlite_classes = ["ChatRoom", "NotificationService"]',
    'PAYMENT_MODE = "disabled"',
    'PROMPTPAY_ENABLED = "false"',
  ]) assert(bootstrapConfig.includes(exact), `bootstrap config omitted ${exact}`);
  assert((bootstrapConfig.match(/^\[\[kv_namespaces\]\]$/gm) ?? []).length === 2, 'bootstrap config KV binding count mismatch');
  assert((bootstrapConfig.match(/^\[\[queues\.producers\]\]$/gm) ?? []).length === 3, 'bootstrap producer count mismatch');
  assert((bootstrapConfig.match(/^\[\[durable_objects\.bindings\]\]$/gm) ?? []).length === 2, 'bootstrap Durable Object count mismatch');
  for (const forbidden of [/^\s*routes?\s*=/m, /\[\[queues\.consumers\]\]/, /send_email/i, /secret/i]) {
    assert(!forbidden.test(bootstrapConfig), `bootstrap config exposed forbidden surface ${forbidden}`);
  }
  assert(provisioningCliSource.includes('assertCredentialGitBoundary')
    && provisioningCliSource.includes('loadStagingCredentials')
    && provisioningCliSource.includes('DEFAULT_STAGING_ENV_FILE')
    && !provisioningCliSource.includes('process.env.TIRAK_CLOUDFLARE_API_TOKEN'),
  'provisioning CLI does not use the restricted owner-only credential loader');
  assert(gitignoreSource.split(/\r?\n/).includes('docs/execution/phase-2/t-025-staging-provisioning-ledger.json'),
    'owner-only provisioning ledger is not Git-ignored');
  passed += 1;
}

// Default plan: full fresh inventory, exact missing diff, no creates, private ledger.
{
  const state = makeState();
  const mock = makeMock(state);
  const path = ledgerPath('plan');
  const ledger = await runStagingProvisioning({ token: TOKEN, ledgerPath: path, fetchImpl: mock.fetchImpl, bootstrapSource });
  assert(ledger.mode === 'plan' && ledger.status === 'PLANNED_NO_MUTATIONS', 'default plan status mismatch');
  assert(ledger.exactMissingDiff.length === 11, 'default plan did not compute the exact complete missing diff');
  assert(mock.calls.filter((entry) => ['POST', 'PUT'].includes(entry.method)).length === 0, 'default plan attempted a create');
  assert(new Set(mock.calls.filter((entry) => entry.method === 'GET').map((entry) => entry.path)).size === 6,
    'default plan did not perform the complete account and five-resource inventory');
  assert((statSync(path).mode & 0o777) === 0o600, 'plan ledger mode was not 0600');
  assertZeroForbiddenCounts(ledger);
  passed += 1;
}

// Full apply: eleven serialized creates, then a second complete inventory and converged fingerprints.
let convergedState;
let convergedLedgerPath;
{
  convergedState = makeState();
  const mock = makeMock(convergedState, { workerResultInfo: (workers) => ({ count: workers.length, total_count: workers.length }) });
  convergedLedgerPath = ledgerPath('apply');
  const ledger = await runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: convergedLedgerPath,
    fetchImpl: mock.fetchImpl, bootstrapSource,
  });
  const mutations = mock.calls.filter((entry) => ['POST', 'PUT'].includes(entry.method));
  assert(ledger.status === 'CONVERGED' && ledger.preInventoryComplete && ledger.postInventoryComplete, 'full apply did not converge');
  assert(mutations.length === 12 && ledger.mutationCounts.confirmedCreates === 11
    && ledger.mutationCounts.confirmedRemoteMutations === 12, 'full apply mutation count mismatch');
  assert(mock.maxConcurrentCreates() === 1, 'creates were not serialized');
  const workerUploadIndex = mock.calls.findIndex((entry) => entry.method === 'PUT');
  assert(workerUploadIndex > 1
    && mock.calls[workerUploadIndex].ifNoneMatch === '*'
    && mock.calls[workerUploadIndex - 2].path === `/client/v4/accounts/${PINNED_ACCOUNT_ID}`
    && mock.calls[workerUploadIndex - 1].path.endsWith('/workers/scripts'),
  'Worker upload lacked the immediate account/list absence recheck');
  assert(mock.calls[workerUploadIndex + 1].method === 'POST' && mock.calls[workerUploadIndex + 1].path.endsWith('/subdomain')
    && mock.calls[workerUploadIndex + 2].method === 'GET' && mock.calls[workerUploadIndex + 2].path.endsWith('/subdomain'),
  'Worker subdomain disable was not immediately GET-verified');
  assert(ledger.resources.every((entry) => entry.outcome === 'created'), 'full apply resource outcomes were incomplete');
  assert(ledger.preFingerprint !== ledger.postFingerprint, 'full apply fingerprints did not reflect convergence');
  assert(ledger.bootstrapControl.status === 'disabled-and-verified'
    && JSON.stringify(ledger.bootstrapControl.verifiedState) === JSON.stringify({ enabled: false, previews_enabled: false })
    && ledger.mutationCounts.confirmedWorkerSubdomainControls === 1,
  'Worker subdomain control was not separately ledgered');
  assert(ledger.durableObjectProvisioningMigration.status === 'accepted-with-worker-create'
    && ledger.mutationCounts.durableObjectProvisioningMigrationsAttempted === 1
    && ledger.mutationCounts.confirmedDurableObjectProvisioningMigrations === 1
    && ledger.mutationCounts.d1SchemaMutations === 0,
  'Durable Object provisioning migration lifecycle was not ledgered distinctly');
  for (const suffix of ['/workers/scripts', '/d1/database', '/storage/kv/namespaces', '/r2/buckets', '/queues']) {
    const expected = suffix === '/workers/scripts' ? 3 : 2;
    assert(mock.calls.filter((entry) => entry.method === 'GET' && entry.path.endsWith(suffix)).length === expected,
      `full apply did not perform fresh pre/post inventory for ${suffix}`);
  }
  assertZeroForbiddenCounts(ledger);
  passed += 1;
}

// A second apply on the same ledger accepts only its creation provenance and performs zero mutations.
{
  const mock = makeMock(convergedState);
  const ledger = await runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: convergedLedgerPath,
    fetchImpl: mock.fetchImpl, bootstrapSource,
  });
  assert(ledger.status === 'CONVERGED' && ledger.exactMissingDiff.length === 0
    && ledger.resources.find((entry) => entry.kind === 'worker').outcome === 'reused-provenance'
    && ledger.workerProvenance.status === 'same-ledger-proof-and-live-control-verified'
    && ledger.attemptHistory.at(-1)?.resources.find((entry) => entry.kind === 'worker')?.outcome === 'created',
  'same-ledger second apply did not retain and consume Worker creation provenance');
  assert(mock.calls.filter((entry) => ['POST', 'PUT'].includes(entry.method)).length === 0
    && ledger.mutationCounts.remoteMutationAttempts === 0
    && ledger.mutationCounts.confirmedRemoteMutations === 0,
  'same-ledger second apply performed a mutation');
  assert(mock.calls.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/subdomain')).length === 1
    && ledger.bootstrapControl.status === 'disabled-and-verified-prior-provenance'
    && ledger.durableObjectProvisioningMigration.status === 'accepted-prior-provenance'
    && ledger.mutationCounts.durableObjectProvisioningMigrationsPlanned === 0,
  'same-ledger reuse did not reverify disabled topology or preserve accepted v1 provenance');
  passed += 1;
}

// Same-ledger provenance is bound to the immutable Worker upload ETag digest.
{
  convergedState.workers[0].etag = '"externally-modified-version"';
  const mock = makeMock(convergedState);
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: convergedLedgerPath,
    fetchImpl: mock.fetchImpl, bootstrapSource,
  }), 'WORKER_VERSION_MISMATCH');
  assert(mock.calls.every((entry) => !['POST', 'PUT'].includes(entry.method) && !entry.path.endsWith('/subdomain')),
    'ETag mismatch reached a mutation or subdomain control endpoint');
}

// A separate ledger has no provenance: plan labels it unproven and apply refuses without mutation.
{
  const mock = makeMock(convergedState);
  const ledger = await runStagingProvisioning({
    token: TOKEN, ledgerPath: ledgerPath('convergence-plan'),
    fetchImpl: mock.fetchImpl, bootstrapSource,
  });
  assert(ledger.status === 'PLANNED_NO_MUTATIONS' && ledger.exactMissingDiff.length === 0
    && ledger.resources.filter((entry) => entry.kind !== 'worker').every((entry) => entry.outcome === 'reused')
    && ledger.resources.find((entry) => entry.kind === 'worker').outcome === 'existing-worker-unproven',
  'second plan incorrectly treated the existing Worker as reusable');
  const applyMock = makeMock(convergedState);
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: ledgerPath('existing-worker'),
    fetchImpl: applyMock.fetchImpl, bootstrapSource,
  }), 'EXISTING_WORKER_REFUSED');
  assert(applyMock.calls.filter((entry) => ['POST', 'PUT'].includes(entry.method)).length === 0,
    'existing Worker refusal attempted a mutation');
  passed += 1;
}

// Partial failure is durable, then same-path retry preserves it and converges.
{
  const state = makeState();
  const mock = makeMock(state, { failCreateName: STAGING_TARGETS.queues[2] });
  const path = ledgerPath('partial');
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: mock.fetchImpl, bootstrapSource,
  }), 'NETWORK_FAILURE');
  const raw = readFileSync(path, 'utf8');
  const ledger = JSON.parse(raw);
  assert(ledger.status === 'PARTIAL_FAILURE_DURABLE', 'partial failure was not durable');
  assert(ledger.mutationCounts.confirmedCreates > 0 && ledger.mutationCounts.failedCreates === 1, 'partial mutation counts were incomplete');
  assert(ledger.error?.code === 'NETWORK_FAILURE', 'partial ledger did not retain only a safe error code');
  for (const forbidden of [TOKEN, HOSTILE, 'Authorization', 'Bearer ', 'requestBody', 'raw-error']) {
    assert(!raw.includes(forbidden), `partial ledger leaked forbidden value ${forbidden}`);
  }
  assertZeroForbiddenCounts(ledger);
  const retry = await runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: makeMock(state).fetchImpl, bootstrapSource,
  });
  assert(retry.status === 'CONVERGED' && retry.attemptHistory.length === 1
    && retry.attemptHistory[0].status === 'PARTIAL_FAILURE_DURABLE'
    && retry.attemptHistory[0].error?.code === 'NETWORK_FAILURE',
  'same-path retry erased the durable partial-failure attempt');
  passed += 1;
}

// A retry discovery failure also preserves the immediately preceding partial attempt.
{
  const state = makeState();
  const path = ledgerPath('retry-discovery');
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: makeMock(state, { failCreateName: STAGING_TARGETS.queues[0] }).fetchImpl, bootstrapSource,
  }), 'NETWORK_FAILURE');
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: makeMock(state, { accountId: 'f'.repeat(32) }).fetchImpl, bootstrapSource,
  }), 'ACCOUNT_MISMATCH');
  const retryLedger = JSON.parse(readFileSync(path, 'utf8'));
  assert(retryLedger.status === 'REFUSED_NO_MUTATIONS'
    && retryLedger.attemptHistory.at(-1)?.status === 'PARTIAL_FAILURE_DURABLE'
    && retryLedger.attemptHistory.at(-1)?.error?.code === 'NETWORK_FAILURE',
  'retry discovery failure erased prior partial evidence');
  passed += 1;
}

// Duplicate exact identities are refused after the complete inventory and before mutations.
{
  const state = makeState({ full: true });
  state.d1.push({ name: STAGING_TARGETS.d1, uuid: uuid(99) });
  const mock = makeMock(state);
  await expectCode(() => runStagingProvisioning({ token: TOKEN, ledgerPath: ledgerPath('duplicate'), fetchImpl: mock.fetchImpl, bootstrapSource }),
    'DUPLICATE_TARGET_REFUSED');
  assert(mock.calls.filter((entry) => ['POST', 'PUT'].includes(entry.method)).length === 0, 'duplicate refusal attempted mutation');
}

// Worker SinglePage completeness and create-only absence proofs fail closed.
await expectCode(() => runStagingProvisioning({
  token: TOKEN,
  ledgerPath: ledgerPath('worker-truncated'),
  fetchImpl: makeMock(makeState(), { workerResultInfo: { count: 0, total_count: 1 } }).fetchImpl,
}), 'WORKER_COMPLETENESS_REFUSED');
await expectCode(() => runStagingProvisioning({
  token: TOKEN,
  ledgerPath: ledgerPath('worker-omitted'),
  fetchImpl: makeMock(makeState(), { workerResultInfo: { count: 0, total_count: 0, total_pages: 2 } }).fetchImpl,
}), 'WORKER_COMPLETENESS_REFUSED');

{
  const state = makeState({ full: true });
  state.workers = [];
  const mock = makeMock(state, { workerAppearsOnListCall: 2 });
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN,
    ledgerPath: ledgerPath('worker-appears'), fetchImpl: mock.fetchImpl, bootstrapSource,
  }), 'WORKER_ABSENCE_STALE');
  assert(mock.calls.every((entry) => entry.method !== 'PUT'), 'Worker appeared after discovery but upload still ran');
}

{
  const state = makeState({ full: true });
  state.workers = [];
  const mock = makeMock(state, { workerDriftsOnListCall: 2 });
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN,
    ledgerPath: ledgerPath('worker-drift'), fetchImpl: mock.fetchImpl, bootstrapSource,
  }), 'WORKER_INVENTORY_DRIFT');
  assert(mock.calls.every((entry) => entry.method !== 'PUT'), 'Worker inventory drifted but upload still ran');
}

// Conditional PUT closes the final list-to-upload race and a retry never uploads over the winner.
{
  const state = makeState({ full: true });
  state.workers = [];
  const path = ledgerPath('worker-put-race');
  const firstMock = makeMock(state, { workerAppearsAtPut: true });
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN,
    ledgerPath: path, fetchImpl: firstMock.fetchImpl, bootstrapSource,
  }), 'API_FAILURE');
  const failedLedger = JSON.parse(readFileSync(path, 'utf8'));
  assert(failedLedger.status === 'PARTIAL_FAILURE_DURABLE'
    && failedLedger.resources.find((entry) => entry.kind === 'worker').outcome === 'failed'
    && firstMock.calls.filter((entry) => entry.method === 'PUT').length === 1
    && state.workers.filter((entry) => entry.id === STAGING_TARGETS.worker).length === 1,
  'conditional Worker PUT race was not durably fail-closed');
  const retryMock = makeMock(state);
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN,
    ledgerPath: path, fetchImpl: retryMock.fetchImpl, bootstrapSource,
  }), 'EXISTING_WORKER_REFUSED');
  assert(retryMock.calls.every((entry) => entry.method !== 'PUT'), 'race retry attempted a second Worker upload');
}

// A same-ledger retry recovers only subdomain control after an accepted conditional upload.
{
  const state = makeState({ full: true });
  state.workers = [];
  const path = ledgerPath('subdomain-mismatch');
  const firstMock = makeMock(state, { subdomainGetResult: { enabled: true, previews_enabled: false } });
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: firstMock.fetchImpl,
    bootstrapSource,
  }), 'SUBDOMAIN_STATE_REFUSED');
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  assert(ledger.status === 'PARTIAL_FAILURE_DURABLE'
    && ledger.resources.find((entry) => entry.kind === 'worker').outcome === 'created-control-failed'
    && ledger.mutationCounts.failedWorkerSubdomainControls === 1
    && ledger.mutationCounts.confirmedCreates === 1
    && ledger.mutationCounts.confirmedDurableObjectProvisioningMigrations === 1
    && ledger.durableObjectProvisioningMigration.status === 'accepted-with-worker-create'
    && /^[a-f0-9]{64}$/.test(ledger.resources.find((entry) => entry.kind === 'worker').versionDigest),
  'subdomain verification failure was not ledgered separately');
  const retryMock = makeMock(state);
  const recovered = await runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: retryMock.fetchImpl, bootstrapSource,
  });
  assert(recovered.status === 'CONVERGED'
    && recovered.resources.find((entry) => entry.kind === 'worker').outcome === 'reused-provenance-control-recovered'
    && recovered.workerProvenance.status === 'same-ledger-control-recovered'
    && recovered.mutationCounts.remoteMutationAttempts === 1
    && recovered.mutationCounts.confirmedWorkerSubdomainControls === 1,
  'same-ledger control-only recovery did not converge');
  assert(firstMock.calls.filter((entry) => entry.method === 'PUT').length === 1
    && retryMock.calls.every((entry) => entry.method !== 'PUT')
    && retryMock.calls.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/subdomain')).length === 1
    && retryMock.calls.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/subdomain')).length === 1,
  'control recovery repeated upload or omitted exact POST/GET verification');
  passed += 1;
}

// Account mismatch is refused both locally and from authenticated response evidence.
await expectCode(() => runStagingProvisioning({
  token: TOKEN, accountId: 'f'.repeat(32), ledgerPath: ledgerPath('account-local'), fetchImpl: makeMock(makeState()).fetchImpl,
}), 'ACCOUNT_MISMATCH');
await expectCode(() => runStagingProvisioning({
  token: TOKEN, ledgerPath: ledgerPath('account-response'), fetchImpl: makeMock(makeState(), { accountId: 'f'.repeat(32) }).fetchImpl,
}), 'ACCOUNT_MISMATCH');

// Target/name overrides and production-like targets are impossible.
await expectCode(() => runStagingProvisioning({
  token: TOKEN, ledgerPath: ledgerPath('name'), fetchImpl: makeMock(makeState()).fetchImpl,
  targets: { ...STAGING_TARGETS, worker: 'tirak-backend-production' },
}), 'TARGET_OVERRIDE_REFUSED');

// Exact apply confirmation is mandatory.
await expectCode(() => runStagingProvisioning({
  mode: 'apply', confirmation: 'yes', token: TOKEN, ledgerPath: ledgerPath('confirmation'), fetchImpl: makeMock(makeState()).fetchImpl,
}), 'APPLY_CONFIRMATION_REFUSED');

// Method, endpoint, and production endpoint allowlists refuse unexpected requests before fetch.
{
  const client = createCloudflareStagingProvisioningClient({ token: TOKEN, fetchImpl: async () => { throw new Error('must not fetch'); } });
  await expectCode(() => client.request('DELETE', `/accounts/${PINNED_ACCOUNT_ID}/queues`), 'METHOD_REFUSED');
  await expectCode(() => client.request('GET', `/accounts/${PINNED_ACCOUNT_ID}/members`), 'ENDPOINT_REFUSED');
  await expectCode(() => client.request('PUT', `/accounts/${PINNED_ACCOUNT_ID}/workers/scripts/tirak-backend-production`), 'PRODUCTION_REFUSED');
  await expectCode(() => client.request('GET', `/accounts/${PINNED_ACCOUNT_ID}`, { searchParams: { page: 1 } }), 'PAGINATION_REFUSED');
  await expectCode(() => client.request('POST', `/accounts/${PINNED_ACCOUNT_ID}/d1/database`, {
    json: { name: 'tirak-production' },
  }), 'CREATE_BODY_REFUSED');
  await expectCode(() => client.request('POST', `/accounts/${PINNED_ACCOUNT_ID}/d1/database`, {
    json: { name: STAGING_TARGETS.d1, primary_location_hint: 'apac' },
  }), 'CREATE_BODY_REFUSED');
  await expectCode(() => client.request('POST', `/accounts/${PINNED_ACCOUNT_ID}/r2/buckets`, {
    json: { name: STAGING_TARGETS.r2, locationHint: 'enam' },
  }), 'CREATE_BODY_REFUSED');
  await expectCode(() => client.request('POST', `/accounts/${PINNED_ACCOUNT_ID}/queues`, {
    json: { queue_name: STAGING_TARGETS.queues[0], extra: true },
  }), 'CREATE_BODY_REFUSED');
  await expectCode(() => client.request('POST', `/accounts/${PINNED_ACCOUNT_ID}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`, {
    json: { enabled: true, previews_enabled: false },
  }), 'SUBDOMAIN_BODY_REFUSED');
}

// An adversarial Worker multipart is rejected by deep validation before transport.
{
  let transports = 0;
  const client = createCloudflareStagingProvisioningClient({
    token: TOKEN,
    fetchImpl: async () => {
      transports += 1;
      throw new Error('transport must remain unreachable');
    },
  });
  const adversarial = new FormData();
  adversarial.append('metadata', new Blob([JSON.stringify({
    main_module: 'bootstrap-worker.mjs',
    compatibility_date: '2026-07-21',
    bindings: [{ type: 'secret_text', name: 'ESCAPED_SECRET', text: 'forbidden' }],
    migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['ChatRoom', 'NotificationService'] }] },
  })], { type: 'application/json' }), 'metadata.json');
  adversarial.append('bootstrap-worker.mjs', new Blob(['export default { queue() {} };'], {
    type: 'application/javascript+module',
  }), 'bootstrap-worker.mjs');
  await expectCode(() => client.request('PUT', `/accounts/${PINNED_ACCOUNT_ID}/workers/scripts/${STAGING_TARGETS.worker}`, {
    multipart: adversarial,
  }), 'CREATE_BODY_REFUSED');
  assert(transports === 0, 'adversarial Worker multipart reached transport');
}

// Malformed inventory and create results fail closed.
{
  const malformed = makeMock(makeState(), {
    malformedOperation: `GET /client/v4/accounts/${PINNED_ACCOUNT_ID}/d1/database`,
  });
  await expectCode(() => runStagingProvisioning({
    token: TOKEN, ledgerPath: ledgerPath('malformed-inventory'), fetchImpl: malformed.fetchImpl,
  }), 'RESPONSE_SHAPE_REFUSED');

  const wrong = makeMock(makeState(), { wrongCreateName: STAGING_TARGETS.d1 });
  const path = ledgerPath('wrong-create');
  await expectCode(() => runStagingProvisioning({
    mode: 'apply', confirmation: APPLY_CONFIRMATION, token: TOKEN, ledgerPath: path,
    fetchImpl: wrong.fetchImpl, bootstrapSource,
  }), 'CREATE_RESULT_REFUSED');
  assert(JSON.parse(readFileSync(path, 'utf8')).status === 'PARTIAL_FAILURE_DURABLE', 'malformed create result was not durable');
}

// Redirect responses are refused even with fetch redirect:error requested.
{
  const key = `GET /client/v4/accounts/${PINNED_ACCOUNT_ID}`;
  const mock = makeMock(makeState(), { redirectOperation: key });
  await expectCode(() => runStagingProvisioning({ token: TOKEN, ledgerPath: ledgerPath('redirect'), fetchImpl: mock.fetchImpl }),
    'REDIRECT_REFUSED');
  assert(mock.calls[0]?.redirect === 'error', 'redirect:error was not passed to fetch');
}

// Ledger schema contains no request transcript/body/query/continuation data or raw errors.
{
  const state = makeState({ full: true });
  state.workers.push({ id: 'unrelated-production-worker' });
  const path = ledgerPath('redaction');
  await runStagingProvisioning({ token: TOKEN, ledgerPath: path, fetchImpl: makeMock(state).fetchImpl, bootstrapSource });
  const raw = readFileSync(path, 'utf8');
  for (const forbidden of [TOKEN, 'unrelated-production-worker', 'Authorization', 'headers":', 'requestBodies":', 'cursor-value', 'query=', HOSTILE]) {
    assert(!raw.includes(forbidden), `ledger redaction failed for ${forbidden}`);
  }
  passed += 1;
}

console.log(`T-025 staging provisioner offline verification passed: ${passed} checks; live requests: 0`);
