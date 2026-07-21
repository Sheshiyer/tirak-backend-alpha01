import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertCredentialGitBoundary,
  assertReadOnlySelect,
  classifyCurrentTokenPolicies,
  createCloudflareReadOnlyClient,
  extractSafeWorkerBindings,
  extractSafeWorkerRuntime,
  filterConfiguredWorkerBindings,
  loadStagingCredentials,
  parseRestrictedEnv,
  PINNED_TIRAK_ACCOUNT_ID,
  requireNonnegativeSafeInteger,
  requireMatchingServingProjection,
} from './cloudflare-read-only-client.mjs';

const TOKEN = 'mock-token-never-log-this-value';
const TOKEN_ID = 'a'.repeat(32);
const OTHER_TOKEN_ID = 'b'.repeat(32);
const READ_PERMISSION_ID = 'c'.repeat(32);
const WRITE_PERMISSION_ID = 'd'.repeat(32);
const DATABASE_ID = '11111111-1111-4111-8111-111111111111';
const PINNED_ACCOUNT_RESOURCE = `com.cloudflare.api.account.${PINNED_TIRAK_ACCOUNT_ID}`;
const envelope = (result, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

function expectRefusal(name, action, pattern) {
  return Promise.resolve()
    .then(action)
    .then(() => { throw new Error(`${name} unexpectedly succeeded`); })
    .catch((error) => {
      if (error.message === `${name} unexpectedly succeeded`) throw error;
      assert.match(error.message, pattern, `${name} returned an unexpected safe error`);
      assert(!error.message.includes(TOKEN), `${name} exposed the token`);
      return name;
    });
}

try {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    const page = Number(url.searchParams.get('page') ?? 1);
    if (url.pathname.endsWith('/d1/database')) {
      return envelope([{ name: `database-${page}`, uuid: DATABASE_ID }], {
        result_info: { page, count: 1, per_page: 100, total_count: 2 },
      });
    }
    if (url.pathname.endsWith(`/d1/database/${DATABASE_ID}/query`)) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { sql: 'SELECT COUNT(*) AS row_count FROM "bookings"' });
      return envelope([{ success: true, results: [{ row_count: 3 }], meta: { changes: 0, rows_written: 0 } }]);
    }
    return envelope({ status: 'active' });
  };
  const client = createCloudflareReadOnlyClient({ token: TOKEN, fetchImpl: mockFetch });
  const databases = await client.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database`);
  assert.deepEqual(databases.map((entry) => entry.name), ['database-1', 'database-2']);
  const query = await client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
    sql: 'SELECT COUNT(*) AS row_count FROM "bookings"',
  });
  assert.equal(query.result[0].results[0].row_count, 3);
  assert.equal(client.requestLog.length, 3);
  assert.deepEqual(client.requestLog.slice(0, 2).map((record) => record.pagination), [
    { mode: 'page', ordinal: 1, resultCount: 1 },
    { mode: 'page', ordinal: 2, resultCount: 1 },
  ]);
  assert.equal(Object.hasOwn(client.requestLog[2], 'pagination'), false, 'D1 SELECT received list pagination evidence');
  assert(!JSON.stringify(client.requestLog).includes(TOKEN));

  const tokenScopeCalls = [];
  const tokenScopeClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      tokenScopeCalls.push({ path: url.pathname, method: options.method });
      if (url.pathname === '/client/v4/user/tokens/verify') {
        return envelope({ id: TOKEN_ID, status: 'active' });
      }
      if (url.pathname === `/client/v4/user/tokens/${TOKEN_ID}`) {
        assert.equal(options.method, 'GET');
        return envelope({
          id: TOKEN_ID,
          status: 'active',
          policies: [{
            effect: 'allow',
            resources: { [PINNED_ACCOUNT_RESOURCE]: { [PINNED_ACCOUNT_RESOURCE]: '*' } },
            permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
          }],
        });
      }
      throw new Error('offline mock refused an unexpected Cloudflare path');
    },
  });
  const tokenScope = await tokenScopeClient.inspectCurrentTokenScope();
  assert.deepEqual(tokenScope, {
    active: true,
    verificationType: 'user-token',
    permissionRisk: 'read-only',
    pinnedAccountIncluded: true,
  });
  assert.deepEqual(tokenScopeCalls, [
    { path: '/client/v4/user/tokens/verify', method: 'GET' },
    { path: `/client/v4/user/tokens/${TOKEN_ID}`, method: 'GET' },
  ]);
  assert.equal(tokenScopeClient.requestLog.length, 2);
  assert(tokenScopeClient.requestLog.every((record) => !Object.hasOwn(record, 'pagination')));
  assert(!JSON.stringify(tokenScopeClient.requestLog).includes(TOKEN_ID));
  assert(!JSON.stringify(tokenScopeClient.requestLog).includes(TOKEN));

  const writeCapableScope = classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${PINNED_TIRAK_ACCOUNT_ID}`]: '*' },
      permission_groups: [{ id: WRITE_PERMISSION_ID, name: 'Workers Scripts Write' }],
    }],
  }, { expectedTokenId: TOKEN_ID });
  assert.deepEqual(writeCapableScope, {
    permissionRisk: 'write-capable-or-broad',
    pinnedAccountIncluded: true,
  });

  const nestedBroadReadScope = classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: { 'com.cloudflare.api.account.*': '*' } },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID });
  assert.deepEqual(nestedBroadReadScope, {
    permissionRisk: 'write-capable-or-broad',
    pinnedAccountIncluded: true,
  });

  const safeBindings = extractSafeWorkerBindings({ resources: { bindings: [
    { type: 'd1', name: 'DB', database_id: DATABASE_ID },
    { type: 'kv_namespace', name: 'CACHE', namespace_id: '1'.repeat(32) },
    { type: 'queue', name: 'MODERATION_QUEUE', queue_name: 'tirak-moderation-staging' },
    { type: 'secret_text', name: 'OMISE_SECRET_KEY', text: TOKEN },
  ] } });
  assert.equal(safeBindings.length, 3);
  assert(!JSON.stringify(safeBindings).includes('OMISE_SECRET_KEY'));
  assert(!JSON.stringify(safeBindings).includes(TOKEN));
  const configuredBindings = filterConfiguredWorkerBindings([
    ...safeBindings,
    { type: 'd1', binding: 'PRODUCTION_DB', id: '2'.repeat(36) },
    { type: 'r2_bucket', binding: 'PRODUCTION_STORAGE', name: 'tirak-storage-production' },
  ], {
    worker: 'tirak-backend-staging',
    database: [{ binding: 'DB' }],
    kv: [{ binding: 'CACHE' }],
    r2: [],
    queues: { producers: [] },
    durableObjects: [],
  });
  assert(!JSON.stringify(configuredBindings).includes('PRODUCTION'));
  assert(!JSON.stringify(configuredBindings).includes('tirak-storage-production'));
  const safeRuntime = extractSafeWorkerRuntime({ resources: {
    bindings: [
      { type: 'plain_text', name: 'ENVIRONMENT', text: 'staging' },
      { type: 'plain_text', name: 'PAYMENT_MODE', text: 'disabled' },
      { type: 'plain_text', name: 'PROMPTPAY_ENABLED', text: 'false' },
      { type: 'plain_text', name: 'UNRELATED_SECRETISH_VALUE', text: TOKEN },
    ],
    script_runtime: { migration_tag: 'v1' },
  } });
  assert.deepEqual(safeRuntime, { environment: 'staging', paymentMode: 'disabled', promptPayEnabled: 'false', migrationTag: 'v1' });
  assert(!JSON.stringify(safeRuntime).includes(TOKEN));

  const deployment = await client.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/workers/scripts/tirak-backend-staging/deployments`);
  assert.equal(deployment.result.status, 'active');
  const version = await client.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/workers/scripts/tirak-backend-staging/versions/${DATABASE_ID}`);
  assert.equal(version.result.status, 'active');
  assert(client.requestLog.slice(-2).every((record) => !Object.hasOwn(record, 'pagination')));

  const cursorCalls = [];
  const cursorClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      cursorCalls.push(String(url));
      return url.searchParams.has('cursor')
        ? envelope({ buckets: [{ name: 'tirak-two-staging' }] })
        : envelope({ buckets: [{ name: 'tirak-one-staging' }], cursor: 'opaque-next' });
    },
  });
  const buckets = await cursorClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/r2/buckets`);
  assert.deepEqual(buckets.map((entry) => entry.name), ['tirak-one-staging', 'tirak-two-staging']);
  assert.equal(cursorCalls.length, 2);
  assert.deepEqual(cursorClient.requestLog.map((record) => record.pagination), [
    { mode: 'cursor', ordinal: 1, resultCount: 1 },
    { mode: 'cursor', ordinal: 2, resultCount: 1 },
  ]);
  assert(!JSON.stringify(cursorClient.requestLog).includes('opaque-next'));
  assert(!JSON.stringify(cursorClient.requestLog).includes(TOKEN));

  const workerListPath = `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/workers/scripts`;
  const completeWorkerCalls = [];
  const completeWorkerClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      completeWorkerCalls.push(String(url));
      assert.equal(url.search, '');
      return envelope([
        { id: 'worker-one', name: 'tirak-backend-staging' },
        { id: 'worker-two', name: 'tirak-notifications-staging' },
      ]);
    },
  });
  const completeWorkers = await completeWorkerClient.list(workerListPath);
  assert.deepEqual(completeWorkers.map((worker) => worker.name), [
    'tirak-backend-staging',
    'tirak-notifications-staging',
  ]);
  assert.equal(completeWorkerCalls.length, 1);
  assert.deepEqual(completeWorkerClient.requestLog[0].pagination, {
    mode: 'single',
    ordinal: 1,
    resultCount: 2,
  });
  assert(!JSON.stringify(completeWorkerClient.requestLog).includes(TOKEN));

  const refused = [];
  const partialWorkerClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([
      { id: 'worker-one', name: 'tirak-backend-staging' },
    ], { result_info: { page: 1, count: 1, total_count: 2, total_pages: 1 } }),
  });
  refused.push(await expectRefusal('incomplete Worker count', () => partialWorkerClient.list(workerListPath), /single-page.*incomplete results/i));

  const inconsistentKvPagesClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([
      { id: '1'.repeat(32), title: 'tirak-cache-staging' },
    ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 2 } }),
  });
  refused.push(await expectRefusal('inconsistent KV page totals', () => inconsistentKvPagesClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/storage/kv/namespaces`), /page and total pages were inconsistent/i));

  const excessiveD1PagesClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([
      { uuid: DATABASE_ID, name: 'tirak-staging' },
    ], { result_info: { page: 1, count: 1, total_count: 101, total_pages: 101 } }),
  });
  refused.push(await expectRefusal('excessive D1 pages', () => excessiveD1PagesClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database`), /exceeded the safe bound/i));

  const unprovenKvClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([
      { id: '1'.repeat(32), title: 'tirak-cache-staging' },
    ]),
  });
  refused.push(await expectRefusal('unproven KV completeness', () => unprovenKvClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/storage/kv/namespaces`), /omitted valid completeness metadata/i));

  const missingTotalCountKvClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([
      { id: '1'.repeat(32), title: 'tirak-cache-staging' },
    ], { result_info: { page: 1, count: 1, per_page: 100 } }),
  });
  refused.push(await expectRefusal('missing KV total count', () => missingTotalCountKvClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/storage/kv/namespaces`), /omitted valid completeness metadata/i));

  const changingTotalKvClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get('page'));
      return envelope([
        { id: String(page).repeat(32), title: `tirak-cache-${page}-staging` },
      ], { result_info: { page, count: 1, per_page: 100, total_count: page === 1 ? 2 : 3 } });
    },
  });
  refused.push(await expectRefusal('changing KV total count', () => changingTotalKvClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/storage/kv/namespaces`), /totals changed between pages/i));

  refused.push(await expectRefusal('unknown token detail path', () => tokenScopeClient.request('GET', `/user/tokens/${OTHER_TOKEN_ID}`), /outside the read-only allowlist/i));
  refused.push(await expectRefusal('stale current token detail path', () => tokenScopeClient.request('GET', `/user/tokens/${TOKEN_ID}`), /outside the read-only allowlist/i));
  assert.equal(tokenScopeCalls.length, 2, 'refused token-detail paths reached the offline fetch mock');
  refused.push(await expectRefusal('mismatched token detail', () => classifyCurrentTokenPolicies({
    id: OTHER_TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${PINNED_TIRAK_ACCOUNT_ID}`]: '*' },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /did not match the verified token/i));
  refused.push(await expectRefusal('malformed token policies', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [`com.cloudflare.api.account.${PINNED_TIRAK_ACCOUNT_ID}`]: '*' },
      permission_groups: 'Workers Scripts Read',
    }],
  }, { expectedTokenId: TOKEN_ID }), /permission groups were malformed/i));
  refused.push(await expectRefusal('nested token resource array', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: [] },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /resource leaf was malformed/i));
  refused.push(await expectRefusal('nested token resource non-star leaf', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: { [PINNED_ACCOUNT_RESOURCE]: 'read' } },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /resource leaf was malformed/i));
  refused.push(await expectRefusal('nested token resource malformed key', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: { 'com.cloudflare.api.account..invalid': '*' } },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /resource key was malformed/i));
  refused.push(await expectRefusal('nested token resource empty object', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: {} },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /resources were empty/i));

  let excessiveDepthResources = '*';
  for (let depth = 0; depth < 5; depth += 1) {
    excessiveDepthResources = { [PINNED_ACCOUNT_RESOURCE]: excessiveDepthResources };
  }
  refused.push(await expectRefusal('nested token resource excessive depth', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: excessiveDepthResources,
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /exceeded the safe depth/i));

  const excessiveResourceEntries = Object.fromEntries(Array.from({ length: 257 }, (_entry, index) => [
    `com.cloudflare.api.account.resource-${index}`,
    '*',
  ]));
  refused.push(await expectRefusal('nested token resource excessive entries', () => classifyCurrentTokenPolicies({
    id: TOKEN_ID,
    status: 'active',
    policies: [{
      effect: 'allow',
      resources: { [PINNED_ACCOUNT_RESOURCE]: excessiveResourceEntries },
      permission_groups: [{ id: READ_PERMISSION_ID, name: 'Workers Scripts Read' }],
    }],
  }, { expectedTokenId: TOKEN_ID }), /exceeded the safe entry count/i));
  refused.push(await expectRefusal('wrong account', () => createCloudflareReadOnlyClient({ token: TOKEN, accountId: '0'.repeat(32) }), /pinned Tirak account/i));
  refused.push(await expectRefusal('wrong host', () => client.request('GET', 'https://attacker.invalid/steal'), /fixed allowlist/i));
  refused.push(await expectRefusal('wrong path', () => client.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/billing`), /outside the read-only allowlist/i));
  refused.push(await expectRefusal('wrong method', () => client.request('DELETE', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/workers/scripts`), /outside the read-only allowlist/i));
  refused.push(await expectRefusal('non SELECT', () => client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'DELETE FROM bookings' }), /single SELECT/i));
  refused.push(await expectRefusal('multi statement', () => client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'SELECT 1; DROP TABLE bookings' }), /single SELECT/i));
  refused.push(await expectRefusal('WITH statement', () => client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'WITH values AS (SELECT 1) SELECT * FROM values' }), /single SELECT/i));
  refused.push(await expectRefusal('load extension', () => client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: "SELECT load_extension('bad')" }), /single SELECT/i));

  const templatedClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: mockFetch,
    selectTemplateValidator: (sql) => sql === 'SELECT 1',
  });
  refused.push(await expectRefusal('unowned SELECT template', () => templatedClient.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'SELECT 2' }), /collector-owned template/i));

  const hostileClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: `steal ${TOKEN} Authorization: Bearer ${TOKEN}` }],
      result: null,
    }), { status: 403, headers: { 'content-type': 'application/json' } }),
  });
  refused.push(await expectRefusal('adversarial error redaction', () => hostileClient.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}`), /HTTP 403/i));
  assert(!JSON.stringify(hostileClient.requestLog).includes(TOKEN));

  const queuePageClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      return envelope([{ queue_name: `tirak-queue-${page}-staging`, queue_id: String(page) }], {
        result_info: { page, count: 1, total_count: 2, total_pages: 2 },
      });
    },
  });
  const queuePages = await queuePageClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/queues`);
  assert.equal(queuePages.length, 2);

  const incompleteQueueClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async (url) => Number(url.searchParams.get('page') ?? 1) === 1
      ? envelope([{ queue_name: 'tirak-moderation-staging' }], { result_info: { page: 1, count: 1, total_count: 2, total_pages: 2 } })
      : envelope([], { result_info: { page: 2, count: 0, total_count: 2, total_pages: 2 } }),
  });
  refused.push(await expectRefusal('incomplete queue pagination', () => incompleteQueueClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/queues`), /ended before its declared total/i));

  const contradictoryQueueClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([{ queue_name: 'tirak-moderation-staging' }], {
      result_info: { page: 1, count: 1, total_count: 2, total_pages: 1 },
    }),
  });
  refused.push(await expectRefusal('contradictory queue pagination', () => contradictoryQueueClient.list(`/accounts/${PINNED_TIRAK_ACCOUNT_ID}/queues`), /ended before its declared total/i));

  const ambiguousD1Client = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => envelope([{ success: true, results: [], meta: { changes: 1, rows_written: 1 } }]),
  });
  refused.push(await expectRefusal('D1 mutation metadata', () => ambiguousD1Client.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'SELECT 1' }), /zero writes/i));
  for (const [name, value] of [['null', null], ['string', '0'], ['missing', undefined]]) {
    const invalidMetaClient = createCloudflareReadOnlyClient({
      token: TOKEN,
      fetchImpl: async () => envelope([{ success: true, results: [], meta: {
        ...(value !== undefined ? { changes: value, rows_written: value } : {}),
      } }]),
    });
    refused.push(await expectRefusal(`D1 ${name} mutation metadata`, () => invalidMetaClient.request('POST', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, { sql: 'SELECT 1' }), /zero writes/i));
  }

  assert.equal(assertReadOnlySelect('SELECT 1;'), 'SELECT 1');
  assert.equal(requireNonnegativeSafeInteger(0, 'fixture'), 0);
  assert.throws(() => requireNonnegativeSafeInteger(null, 'fixture'), /numeric nonnegative safe integer/i);
  assert.throws(() => requireNonnegativeSafeInteger('0', 'fixture'), /numeric nonnegative safe integer/i);
  assert.throws(() => requireNonnegativeSafeInteger(undefined, 'fixture'), /numeric nonnegative safe integer/i);
  assert.deepEqual(requireMatchingServingProjection(null, [], 'fixture bindings'), []);
  assert.throws(() => requireMatchingServingProjection([], [{ type: 'd1', binding: 'DB', id: DATABASE_ID }], 'fixture bindings'), /disagree/i);
  assert.throws(() => parseRestrictedEnv('TIRAK_CLOUDFLARE_API_TOKEN=$(cat /secret)'), /unsafe interpolation/i);
  assert.throws(() => parseRestrictedEnv('UNKNOWN_KEY=value'), /unsupported staging environment key/i);
  assert.throws(() => parseRestrictedEnv('TIRAK_CLOUDFLARE_API_TOKEN=one\nTIRAK_CLOUDFLARE_API_TOKEN=two'), /duplicate staging environment key/i);
  assert.throws(() => parseRestrictedEnv('TIRAK_CLOUDFLARE_API_TOKEN="unterminated'), /unbalanced quote/i);
  assert.throws(() => loadStagingCredentials({ processEnv: { TIRAK_CLOUDFLARE_API_TOKEN: 'cfk_not-a-bearer-token' } }), /global API keys/i);

  const nonJsonClient = createCloudflareReadOnlyClient({
    token: TOKEN,
    fetchImpl: async () => new Response('<html>redirected</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  refused.push(await expectRefusal('non JSON response', () => nonJsonClient.request('GET', `/accounts/${PINNED_TIRAK_ACCOUNT_ID}`), /non-JSON content type/i));
  assert.equal(nonJsonClient.requestLog.length, 1, 'non-JSON response disappeared from request evidence');

  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'tirak-t025-env-'));
  const envPath = join(fixtureDirectory, '.env.tirak-staging');
  writeFileSync(envPath, `TIRAK_CLOUDFLARE_API_TOKEN=${TOKEN}\n`, { mode: 0o644 });
  assert.throws(() => loadStagingCredentials({ envFilePath: envPath, processEnv: {} }), /exactly 0600/i);
  chmodSync(envPath, 0o600);
  const credential = loadStagingCredentials({ envFilePath: envPath, processEnv: {} });
  assert.equal(credential.credentialPresent, true);
  const symlinkPath = join(fixtureDirectory, '.env.symlink');
  symlinkSync(envPath, symlinkPath);
  assert.throws(() => loadStagingCredentials({ envFilePath: symlinkPath, processEnv: {} }), /regular file/i);

  const ignored = spawnSync('git', ['check-ignore', '--quiet', '.env.tirak-staging'], { cwd: process.cwd() });
  assert.equal(ignored.status, 0, '.env.tirak-staging is not ignored by Git');
  assert.equal(assertCredentialGitBoundary({ envFilePath: join(process.cwd(), '.env.tirak-staging') }), true);
  assert.throws(() => assertCredentialGitBoundary({
    envFilePath: join(process.cwd(), '.env.tirak-staging'),
    spawnImpl: (_command, args) => ({ status: args[0] === 'check-ignore' ? 0 : 0 }),
  }), /tracked by Git/i);

  const projectFixture = mkdtempSync('.t025-output-test-');
  try {
    const pendingOutput = join(projectFixture, 'pending.json');
    const pendingProbe = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs', '--credential-mode', 'absent-for-offline-test', '--output', pendingOutput], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TIRAK_CLOUDFLARE_API_TOKEN: TOKEN, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: 'T-024_APPROVED_READ_ONLY' },
    });
    assert.equal(pendingProbe.status, 2, 'missing token did not remain a clean pending state');
    const pendingLedger = JSON.parse(readFileSync(pendingOutput, 'utf8'));
    assert.equal(pendingLedger.evidence.discoveryError.code, 'TOKEN_MISSING');
    assert.equal(pendingLedger.evidence.credential.source, 'forced-absent-offline-test');
    assert.equal(pendingLedger.evidence.credential.present, false);
    assert.equal(pendingLedger.requestLog.length, 0);

    const targetPath = join(projectFixture, 'target.json');
    const symlinkOutput = join(projectFixture, 'ledger-link.json');
    writeFileSync(targetPath, '{}\n', { mode: 0o600 });
    symlinkSync(targetPath, symlinkOutput);
    const outputProbe = spawnSync('node', ['scripts/staging/collect-staging-ledger.mjs', '--credential-mode', 'absent-for-offline-test', '--output', symlinkOutput], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TIRAK_CLOUDFLARE_API_TOKEN: TOKEN, TIRAK_STAGING_READ_ONLY_AUTHORIZATION: 'T-024_APPROVED_READ_ONLY' },
    });
    assert.notEqual(outputProbe.status, 0);
    assert.match(outputProbe.stderr, /regular file, not a symlink/i);
  } finally {
    rmSync(projectFixture, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    status: 'PASS',
    allowedDiscovery: 'PASS',
    pagePagination: 'PASS',
    cursorPagination: 'PASS',
    workerListCompleteness: 'PASS',
    pagedListCompleteness: 'PASS',
    refusalFixtures: refused,
    credentialFileMode: 'PASS',
    credentialSymlink: 'PASS',
    credentialGitIgnore: 'PASS',
    missingCredentialPending: 'PASS',
    ledgerOutputSymlink: 'PASS',
    tokenRedaction: 'PASS',
    currentTokenDetails: 'PASS',
    currentTokenScopeClassification: 'PASS',
    nestedTokenResources: 'PASS',
    paginationEvidence: 'PASS',
    liveCloudflareRequests: 0,
  }, null, 2));
} catch (error) {
  console.error(`T-025 Cloudflare read-only client verification: FAIL\n${error.message}`);
  process.exitCode = 1;
}
