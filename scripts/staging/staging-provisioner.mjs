import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const PINNED_ACCOUNT_ID = '2c0c96c68f0ee73b6d980054557bca5b';
export const APPLY_CONFIRMATION = 'APPLY T-025 STAGING-ONLY RESOURCE CREATION';
export const BOOTSTRAP_COMPATIBILITY_DATE = '2026-07-21';
export const DISABLED_WORKER_SUBDOMAIN_STATE = Object.freeze({ enabled: false, previews_enabled: false });
export const APPROVED_BOOTSTRAP_SOURCE_DIGEST = '878d5cbd865b43f31c7113bad618464d4790c28cf36aa75672758506631ecd88';

export const STAGING_TARGETS = Object.freeze({
  worker: 'tirak-backend-staging',
  d1: 'tirak-staging',
  kv: Object.freeze(['tirak-cache-staging', 'tirak-sessions-staging']),
  r2: 'tirak-storage-staging',
  queues: Object.freeze([
    'tirak-moderation-staging',
    'tirak-analytics-staging',
    'tirak-notification-staging',
    'tirak-moderation-dlq-staging',
    'tirak-analytics-dlq-staging',
    'tirak-notification-dlq-staging',
  ]),
});

const API_ORIGIN = 'https://api.cloudflare.com';
const API_PREFIX = '/client/v4';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 100;
const MAX_ATTEMPT_HISTORY = 100;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX_ID = /^[a-f0-9]{32}$/i;
const QUEUE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i;
const PRODUCTION_SEGMENT = /(?:^|[-_])(?:prod|production|live)(?:$|[-_])/i;
const APPROVED_WORKER_MULTIPARTS = new WeakMap();

const RESOURCE_SPECS = Object.freeze([
  { kind: 'd1', name: STAGING_TARGETS.d1 },
  ...STAGING_TARGETS.kv.map((name) => ({ kind: 'kv', name })),
  { kind: 'r2', name: STAGING_TARGETS.r2 },
  ...STAGING_TARGETS.queues.map((name) => ({ kind: 'queue', name })),
  { kind: 'worker', name: STAGING_TARGETS.worker },
]);

export class SafeProvisioningError extends Error {
  constructor(message, code = 'STAGING_PROVISIONING_REFUSED') {
    super(message);
    this.name = 'SafeProvisioningError';
    this.code = code;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sourceDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function workerVersionDigest(etag) {
  if (typeof etag !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(etag)) {
    throw new SafeProvisioningError('Worker version ETag was unavailable or malformed', 'WORKER_VERSION_UNAVAILABLE');
  }
  return sha256({ workerScriptEtag: etag });
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertExactTargets(targets) {
  if (!sameCanonical(targets, STAGING_TARGETS)) {
    throw new SafeProvisioningError('resource target overrides are refused', 'TARGET_OVERRIDE_REFUSED');
  }
  for (const spec of RESOURCE_SPECS) {
    if (!SAFE_NAME.test(spec.name) || PRODUCTION_SEGMENT.test(spec.name) || !spec.name.endsWith('-staging')) {
      throw new SafeProvisioningError('a target resource name is not staging-safe', 'TARGET_NAME_REFUSED');
    }
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeProvisioningError(`${label} was malformed`, 'RESPONSE_SHAPE_REFUSED');
  }
  return value;
}

function assertSafeName(name, label) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new SafeProvisioningError(`${label} name was malformed`, 'RESOURCE_RESULT_REFUSED');
  }
  return name;
}

function assertBoundedInventoryLabel(name, label) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new SafeProvisioningError(`${label} inventory label was malformed`, 'RESOURCE_RESULT_REFUSED');
  }
  return name;
}

function normalizeWorker(entry) {
  assertPlainObject(entry, 'Worker inventory entry');
  const name = entry.name ?? entry.id;
  if (entry.name !== undefined && entry.id !== undefined && entry.name !== entry.id) {
    throw new SafeProvisioningError('Worker inventory identity was inconsistent', 'RESOURCE_RESULT_REFUSED');
  }
  return {
    kind: 'worker',
    name: assertSafeName(name, 'Worker'),
    ...(entry.etag === undefined ? {} : { versionDigest: workerVersionDigest(entry.etag) }),
  };
}

function normalizeD1(entry) {
  assertPlainObject(entry, 'D1 inventory entry');
  const name = assertSafeName(entry.name, 'D1');
  const id = entry.uuid ?? entry.id;
  if (!UUID.test(id ?? '')) throw new SafeProvisioningError('D1 inventory identifier was malformed', 'RESOURCE_RESULT_REFUSED');
  return { kind: 'd1', name, id };
}

function normalizeKv(entry) {
  assertPlainObject(entry, 'KV inventory entry');
  // KV titles are user-facing labels and existing unrelated namespaces may
  // legally contain spaces or punctuation. They are never reused as request
  // paths or persisted unless they exactly equal one frozen staging target.
  const name = assertBoundedInventoryLabel(entry.title ?? entry.name, 'KV');
  if (!HEX_ID.test(entry.id ?? '')) throw new SafeProvisioningError('KV inventory identifier was malformed', 'RESOURCE_RESULT_REFUSED');
  return { kind: 'kv', name, id: entry.id };
}

function normalizeR2(entry) {
  assertPlainObject(entry, 'R2 inventory entry');
  return { kind: 'r2', name: assertSafeName(entry.name, 'R2') };
}

function normalizeQueue(entry) {
  assertPlainObject(entry, 'Queue inventory entry');
  const name = assertSafeName(entry.queue_name ?? entry.name, 'Queue');
  const id = entry.queue_id ?? entry.id;
  if (id !== undefined && id !== null && !QUEUE_ID.test(id)) {
    throw new SafeProvisioningError('Queue inventory identifier was malformed', 'RESOURCE_RESULT_REFUSED');
  }
  return { kind: 'queue', name, ...(id ? { id } : {}) };
}

function safeErrorCode(error) {
  return error instanceof SafeProvisioningError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'STAGING_PROVISIONING_REFUSED';
}

function boundedResponseText(response) {
  return response.text().then((text) => {
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new SafeProvisioningError('Cloudflare response exceeded the safe size bound', 'RESPONSE_SIZE_REFUSED');
    }
    return text;
  });
}

function classifyOperation(method, pathname, accountId) {
  const prefix = `${API_PREFIX}/accounts/${accountId}`;
  const allowed = new Map([
    [`GET ${prefix}`, 'account identity'],
    [`GET ${prefix}/workers/scripts`, 'Worker inventory'],
    [`GET ${prefix}/d1/database`, 'D1 inventory'],
    [`GET ${prefix}/storage/kv/namespaces`, 'KV inventory'],
    [`GET ${prefix}/r2/buckets`, 'R2 inventory'],
    [`GET ${prefix}/queues`, 'Queue inventory'],
    [`POST ${prefix}/d1/database`, 'D1 create'],
    [`POST ${prefix}/storage/kv/namespaces`, 'KV create'],
    [`POST ${prefix}/r2/buckets`, 'R2 create'],
    [`POST ${prefix}/queues`, 'Queue create'],
    [`PUT ${prefix}/workers/scripts/${STAGING_TARGETS.worker}`, 'Worker create'],
    [`POST ${prefix}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`, 'Worker subdomain set'],
    [`GET ${prefix}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`, 'Worker subdomain verify'],
  ]);
  const operation = allowed.get(`${method} ${pathname}`);
  if (!operation) throw new SafeProvisioningError('HTTP method or endpoint is outside the staging provisioning allowlist', 'ENDPOINT_REFUSED');
  return operation;
}

async function assertWorkerMultipart(multipart) {
  if (!(multipart instanceof FormData)) {
    throw new SafeProvisioningError('Worker create requires the approved multipart bootstrap', 'CREATE_BODY_REFUSED');
  }
  const approved = APPROVED_WORKER_MULTIPARTS.get(multipart);
  const entries = [...multipart.entries()];
  if (!approved || entries.length !== 2
    || entries[0]?.[0] !== 'metadata' || entries[1]?.[0] !== 'bootstrap-worker.mjs') {
    throw new SafeProvisioningError('Worker multipart fields were not the approved exact pair', 'CREATE_BODY_REFUSED');
  }
  const metadataPart = entries[0][1];
  const modulePart = entries[1][1];
  if (!(metadataPart instanceof Blob) || !(modulePart instanceof Blob)
    || metadataPart.type !== 'application/json' || modulePart.type !== 'application/javascript+module'
    || metadataPart.name !== 'metadata.json' || modulePart.name !== 'bootstrap-worker.mjs'
    || metadataPart.size > 64 * 1024 || modulePart.size > 64 * 1024) {
    throw new SafeProvisioningError('Worker multipart file contract was malformed', 'CREATE_BODY_REFUSED');
  }
  let metadata;
  let moduleSource;
  try {
    metadata = JSON.parse(await metadataPart.text());
    moduleSource = await modulePart.text();
  } catch {
    throw new SafeProvisioningError('Worker multipart content was malformed', 'CREATE_BODY_REFUSED');
  }
  if (!sameCanonical(metadata, approved.metadata)
    || moduleSource !== approved.bootstrapSource
    || sourceDigest(moduleSource) !== APPROVED_BOOTSTRAP_SOURCE_DIGEST) {
    throw new SafeProvisioningError('Worker multipart content differed from the approved inert bootstrap', 'CREATE_BODY_REFUSED');
  }
}

async function assertMutationBody(operation, json, multipart) {
  if (operation === 'Worker subdomain set') {
    if (multipart !== undefined || !sameCanonical(json, DISABLED_WORKER_SUBDOMAIN_STATE)) {
      throw new SafeProvisioningError('Worker subdomain mutation must be exactly disabled', 'SUBDOMAIN_BODY_REFUSED');
    }
    return;
  }
  if (!operation.endsWith(' create')) return;
  if (operation === 'Worker create') {
    if (json !== undefined) {
      throw new SafeProvisioningError('Worker create requires only the fixed multipart bootstrap', 'CREATE_BODY_REFUSED');
    }
    await assertWorkerMultipart(multipart);
    return;
  }
  if (multipart !== undefined || !json || typeof json !== 'object' || Array.isArray(json)) {
    throw new SafeProvisioningError('resource create body was malformed', 'CREATE_BODY_REFUSED');
  }
  const contracts = {
    'KV create': { key: 'title', names: STAGING_TARGETS.kv },
    'Queue create': { key: 'queue_name', names: STAGING_TARGETS.queues },
  };
  if (operation === 'D1 create') {
    if (!sameCanonical(json, {
      name: STAGING_TARGETS.d1,
      primary_location_hint: 'apac',
      read_replication: { mode: 'disabled' },
    })) throw new SafeProvisioningError('D1 create body did not match the exact APAC/non-replicated contract', 'CREATE_BODY_REFUSED');
    return;
  }
  if (operation === 'R2 create') {
    if (!sameCanonical(json, { name: STAGING_TARGETS.r2, locationHint: 'apac' })) {
      throw new SafeProvisioningError('R2 create body did not match the exact APAC contract', 'CREATE_BODY_REFUSED');
    }
    return;
  }
  const contract = contracts[operation];
  if (!contract || Object.keys(json).length !== 1 || !Object.hasOwn(json, contract.key)
    || !contract.names.includes(json[contract.key]) || PRODUCTION_SEGMENT.test(json[contract.key])) {
    throw new SafeProvisioningError('resource create body did not match the exact staging target', 'CREATE_BODY_REFUSED');
  }
}

export function createCloudflareStagingProvisioningClient({
  token,
  accountId = PINNED_ACCOUNT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof token !== 'string' || token.length < 8) throw new SafeProvisioningError('Cloudflare API token is absent', 'TOKEN_MISSING');
  if (accountId !== PINNED_ACCOUNT_ID) throw new SafeProvisioningError('Cloudflare account does not match the pinned account', 'ACCOUNT_MISMATCH');
  if (typeof fetchImpl !== 'function') throw new SafeProvisioningError('fetch implementation is unavailable', 'FETCH_UNAVAILABLE');

  async function request(method, path, { json, multipart, searchParams } = {}) {
    if (!['GET', 'POST', 'PUT'].includes(method)) {
      throw new SafeProvisioningError('unknown HTTP method refused', 'METHOD_REFUSED');
    }
    if (typeof path !== 'string' || path.includes('?') || path.includes('#')) {
      throw new SafeProvisioningError('endpoint path was malformed', 'ENDPOINT_REFUSED');
    }
    const url = new URL(`${API_ORIGIN}${API_PREFIX}${path}`);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith(`${API_PREFIX}/`)) {
      throw new SafeProvisioningError('API origin is outside the fixed Cloudflare boundary', 'ENDPOINT_REFUSED');
    }
    if (PRODUCTION_SEGMENT.test(url.pathname)) {
      throw new SafeProvisioningError('production-like endpoint refused', 'PRODUCTION_REFUSED');
    }
    const operation = classifyOperation(method, url.pathname, accountId);
    if (searchParams) {
      const allowedKeys = operation === 'R2 inventory'
        ? ['cursor']
        : ['D1 inventory', 'KV inventory', 'Queue inventory'].includes(operation)
          ? ['page', 'per_page']
          : [];
      if (Object.keys(searchParams).some((key) => !allowedKeys.includes(key))
        || allowedKeys.length === 0
        || allowedKeys.length === 2 && !sameCanonical(Object.keys(searchParams).sort(), allowedKeys.sort())) {
        throw new SafeProvisioningError('pagination parameters are outside the exact inventory endpoint contract', 'PAGINATION_REFUSED');
      }
      for (const [key, value] of Object.entries(searchParams)) {
        const valid = key === 'cursor'
          ? typeof value === 'string' && value.length > 0 && value.length <= 512
          : key === 'page'
            ? Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGES
            : key === 'per_page' && value === 100;
        if (!valid) {
          throw new SafeProvisioningError('list pagination parameters were malformed', 'PAGINATION_REFUSED');
        }
        url.searchParams.set(key, String(value));
      }
    }
    if (method === 'GET' && (json !== undefined || multipart !== undefined)) {
      throw new SafeProvisioningError('GET request bodies are refused', 'METHOD_REFUSED');
    }
    if (json !== undefined && multipart !== undefined) {
      throw new SafeProvisioningError('multiple request body forms are refused', 'METHOD_REFUSED');
    }
    await assertMutationBody(operation, json, multipart);
    const body = multipart ?? (json === undefined ? undefined : JSON.stringify(json));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(operation === 'Worker create' ? { 'If-None-Match': '*' } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SafeProvisioningError(`Cloudflare ${operation} failed before a trusted response`, 'NETWORK_FAILURE');
    }
    if (response.redirected || response.status >= 300 && response.status < 400) {
      throw new SafeProvisioningError('Cloudflare redirect response refused', 'REDIRECT_REFUSED');
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
      throw new SafeProvisioningError('Cloudflare response content type was malformed', 'RESPONSE_SHAPE_REFUSED');
    }
    let envelope;
    try {
      envelope = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof SafeProvisioningError) throw error;
      throw new SafeProvisioningError('Cloudflare response JSON was malformed', 'RESPONSE_SHAPE_REFUSED');
    }
    assertPlainObject(envelope, 'Cloudflare response envelope');
    if (typeof envelope.success !== 'boolean' || !Object.hasOwn(envelope, 'result')) {
      throw new SafeProvisioningError('Cloudflare response envelope was malformed', 'RESPONSE_SHAPE_REFUSED');
    }
    if (!response.ok || envelope.success !== true) {
      throw new SafeProvisioningError(`Cloudflare ${operation} returned a refused result`, 'API_FAILURE');
    }
    return { result: envelope.result, resultInfo: envelope.result_info ?? null, operation };
  }

  async function pageList(path, normalize) {
    const all = [];
    let expectedTotal = null;
    let expectedPages = null;
    let expectedPerPage = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await request('GET', path, { searchParams: { page, per_page: 100 } });
      if (!Array.isArray(response.result)) throw new SafeProvisioningError('paged inventory result was malformed', 'RESPONSE_SHAPE_REFUSED');
      const info = assertPlainObject(response.resultInfo, 'paged inventory completeness metadata');
      for (const key of ['page', 'per_page', 'count', 'total_count']) {
        if (!Number.isSafeInteger(info[key]) || info[key] < 0) {
          throw new SafeProvisioningError('paged inventory completeness metadata was malformed', 'PAGINATION_REFUSED');
        }
      }
      if (info.per_page < 1 || info.per_page > 100) {
        throw new SafeProvisioningError('paged inventory page size was outside the requested bound', 'PAGINATION_REFUSED');
      }
      const derivedPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
      if (info.total_pages !== undefined
        && (!Number.isSafeInteger(info.total_pages) || info.total_pages !== derivedPages)) {
        throw new SafeProvisioningError('paged inventory optional page total was inconsistent', 'PAGINATION_REFUSED');
      }
      if (info.page !== page || info.count !== response.result.length || page > derivedPages) {
        throw new SafeProvisioningError('paged inventory completeness metadata was inconsistent', 'PAGINATION_REFUSED');
      }
      if (expectedTotal === null) {
        expectedTotal = info.total_count;
        expectedPages = derivedPages;
        expectedPerPage = info.per_page;
      } else if (expectedTotal !== info.total_count || expectedPages !== derivedPages
        || expectedPerPage !== info.per_page) {
        throw new SafeProvisioningError('paged inventory totals changed during traversal', 'PAGINATION_REFUSED');
      }
      all.push(...response.result.map(normalize));
      if (all.length > expectedTotal) throw new SafeProvisioningError('paged inventory exceeded its declared total', 'PAGINATION_REFUSED');
      if (page === expectedPages) {
        if (all.length !== expectedTotal) throw new SafeProvisioningError('paged inventory ended before its declared total', 'PAGINATION_REFUSED');
        return all;
      }
      if (response.result.length === 0) throw new SafeProvisioningError('paged inventory stopped before completion', 'PAGINATION_REFUSED');
    }
    throw new SafeProvisioningError('paged inventory exceeded the traversal bound', 'PAGINATION_REFUSED');
  }

  async function workerSinglePage() {
    const response = await request('GET', `/accounts/${accountId}/workers/scripts`);
    if (!Array.isArray(response.result)) throw new SafeProvisioningError('Worker inventory result was malformed', 'RESPONSE_SHAPE_REFUSED');
    const workers = response.result.map(normalizeWorker);
    let completeness = { mode: 'documented-single-page', resultCount: workers.length };
    if (response.resultInfo !== null) {
      const info = assertPlainObject(response.resultInfo, 'Worker SinglePage completeness metadata');
      const allowed = new Set(['page', 'per_page', 'count', 'total_count', 'totalCount', 'total_pages', 'totalPages']);
      if (Object.keys(info).length === 0 || Object.keys(info).some((key) => !allowed.has(key))) {
        throw new SafeProvisioningError('Worker SinglePage completeness metadata contained unknown or empty fields', 'WORKER_COMPLETENESS_REFUSED');
      }
      const count = info.count;
      const total = info.total_count ?? info.totalCount;
      const totalPages = info.total_pages ?? info.totalPages;
      if (count !== undefined && (!Number.isSafeInteger(count) || count !== workers.length)
        || total !== undefined && (!Number.isSafeInteger(total) || total !== workers.length)
        || count !== undefined && total !== undefined && count !== total
        || info.page !== undefined && info.page !== 1
        || info.per_page !== undefined && (!Number.isSafeInteger(info.per_page) || info.per_page < workers.length)
        || totalPages !== undefined && totalPages !== 1) {
        throw new SafeProvisioningError('Worker SinglePage completeness metadata was inconsistent', 'WORKER_COMPLETENESS_REFUSED');
      }
      if (count === undefined && total === undefined) {
        throw new SafeProvisioningError('Worker SinglePage metadata did not prove its result count', 'WORKER_COMPLETENESS_REFUSED');
      }
      completeness = { mode: 'validated-single-page-metadata', resultCount: workers.length };
    }
    return {
      workers,
      proof: {
        fingerprint: sha256({ names: workers.map((entry) => entry.name).sort(), completeness }),
        resultCount: workers.length,
      },
    };
  }

  async function r2List() {
    const all = [];
    const seen = new Set();
    let cursor = null;
    for (let ordinal = 0; ordinal < MAX_PAGES; ordinal += 1) {
      const response = await request('GET', `/accounts/${accountId}/r2/buckets`, {
        searchParams: cursor === null ? undefined : { cursor },
      });
      const result = assertPlainObject(response.result, 'R2 inventory result');
      if (!Array.isArray(result.buckets)) throw new SafeProvisioningError('R2 inventory bucket list was malformed', 'RESPONSE_SHAPE_REFUSED');
      all.push(...result.buckets.map(normalizeR2));
      const next = result.cursor ?? null;
      if (next === null || next === '') return all;
      if (typeof next !== 'string' || next.length > 512 || seen.has(next)) {
        throw new SafeProvisioningError('R2 inventory continuation metadata was malformed', 'PAGINATION_REFUSED');
      }
      seen.add(next);
      cursor = next;
    }
    throw new SafeProvisioningError('R2 inventory exceeded the traversal bound', 'PAGINATION_REFUSED');
  }

  async function inventory() {
    const account = await request('GET', `/accounts/${accountId}`);
    if (assertPlainObject(account.result, 'account identity result').id !== accountId) {
      throw new SafeProvisioningError('authenticated account did not match the pinned account', 'ACCOUNT_MISMATCH');
    }
    const workerInventory = await workerSinglePage();
    const d1 = await pageList(`/accounts/${accountId}/d1/database`, normalizeD1);
    const kv = await pageList(`/accounts/${accountId}/storage/kv/namespaces`, normalizeKv);
    const r2 = await r2List();
    const queues = await pageList(`/accounts/${accountId}/queues`, normalizeQueue);
    return { worker: workerInventory.workers, workerProof: workerInventory.proof, d1, kv, r2, queue: queues };
  }

  async function proveWorkerCreateOnly(expectedProof) {
    if (!expectedProof || typeof expectedProof.fingerprint !== 'string' || !Number.isSafeInteger(expectedProof.resultCount)) {
      throw new SafeProvisioningError('initial Worker absence proof was unavailable', 'WORKER_CREATE_ONLY_UNPROVEN');
    }
    const account = await request('GET', `/accounts/${accountId}`);
    if (assertPlainObject(account.result, 'account identity result').id !== accountId) {
      throw new SafeProvisioningError('authenticated account changed before Worker upload', 'ACCOUNT_MISMATCH');
    }
    const current = await workerSinglePage();
    if (current.workers.some((entry) => entry.name === STAGING_TARGETS.worker)) {
      throw new SafeProvisioningError('staging Worker appeared before create-only upload', 'WORKER_ABSENCE_STALE');
    }
    if (!sameCanonical(current.proof, expectedProof)) {
      throw new SafeProvisioningError('Worker inventory changed before create-only upload', 'WORKER_INVENTORY_DRIFT');
    }
    return true;
  }

  function exactDisabledSubdomain(result) {
    const value = assertPlainObject(result, 'Worker subdomain result');
    if (!sameCanonical(value, DISABLED_WORKER_SUBDOMAIN_STATE)) {
      throw new SafeProvisioningError('Worker subdomain state was not exactly disabled', 'SUBDOMAIN_STATE_REFUSED');
    }
    return value;
  }

  async function disableAndVerifyWorkerSubdomain() {
    const path = `/accounts/${accountId}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`;
    const changed = await request('POST', path, { json: DISABLED_WORKER_SUBDOMAIN_STATE });
    exactDisabledSubdomain(changed.result);
    return verifyWorkerSubdomainDisabled();
  }

  async function verifyWorkerSubdomainDisabled() {
    const path = `/accounts/${accountId}/workers/scripts/${STAGING_TARGETS.worker}/subdomain`;
    const verified = await request('GET', path);
    exactDisabledSubdomain(verified.result);
    return DISABLED_WORKER_SUBDOMAIN_STATE;
  }

  return {
    request,
    inventory,
    proveWorkerCreateOnly,
    disableAndVerifyWorkerSubdomain,
    verifyWorkerSubdomainDisabled,
    accountId,
  };
}

function projectInventory(inventory) {
  const exact = [];
  const missing = [];
  const counts = {};
  for (const kind of ['worker', 'd1', 'kv', 'r2', 'queue']) {
    if (!Array.isArray(inventory[kind])) throw new SafeProvisioningError('complete inventory was malformed', 'INVENTORY_REFUSED');
    counts[kind] = inventory[kind].length;
  }
  for (const spec of RESOURCE_SPECS) {
    const matches = inventory[spec.kind].filter((entry) => entry.name === spec.name);
    if (matches.length > 1) throw new SafeProvisioningError('duplicate exact staging resource identities refused', 'DUPLICATE_TARGET_REFUSED');
    if (matches.length === 0) missing.push({ ...spec });
    else exact.push({
      kind: spec.kind,
      name: spec.name,
      ...(matches[0].id ? { id: matches[0].id } : {}),
      ...(matches[0].versionDigest ? { versionDigest: matches[0].versionDigest } : {}),
    });
  }
  const safeProjection = { counts, exact, missing };
  return { ...safeProjection, fingerprint: sha256(safeProjection) };
}

function privateAtomicWrite(path, ledger) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(dirname(target));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new SafeProvisioningError('ledger parent must be a real directory', 'LEDGER_PATH_REFUSED');
  }
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SafeProvisioningError('ledger must be a regular file', 'LEDGER_PATH_REFUSED');
    if ((stat.mode & 0o777) !== 0o600) throw new SafeProvisioningError('existing ledger must be owner-only mode 0600', 'LEDGER_MODE_REFUSED');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new SafeProvisioningError('existing ledger owner did not match the current user', 'LEDGER_OWNER_REFUSED');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function targetSummary() {
  return {
    worker: STAGING_TARGETS.worker,
    d1: STAGING_TARGETS.d1,
    kv: [...STAGING_TARGETS.kv],
    r2: STAGING_TARGETS.r2,
    queues: [...STAGING_TARGETS.queues],
  };
}

function safeAttemptSnapshot(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || candidate.taskId !== 'T-025' || candidate.environment !== 'staging'
    || candidate.accountId !== PINNED_ACCOUNT_ID
    || typeof candidate.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.status)
    || !Array.isArray(candidate.resources) || candidate.resources.length !== RESOURCE_SPECS.length
    || !candidate.mutationCounts || typeof candidate.mutationCounts !== 'object' || Array.isArray(candidate.mutationCounts)) {
    throw new SafeProvisioningError('prior provisioning attempt ledger was malformed', 'PRIOR_ATTEMPT_REFUSED');
  }
  const fingerprint = (value) => {
    if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
      throw new SafeProvisioningError('prior attempt fingerprint was malformed', 'PRIOR_ATTEMPT_REFUSED');
    }
    return value;
  };
  const resources = candidate.resources.map((resource, index) => {
    const expected = RESOURCE_SPECS[index];
    if (resource?.sequence !== index + 1 || resource.kind !== expected.kind || resource.name !== expected.name
      || typeof resource.outcome !== 'string' || !/^[a-z][a-z-]{0,47}$/.test(resource.outcome)) {
      throw new SafeProvisioningError('prior attempt resource evidence was malformed', 'PRIOR_ATTEMPT_REFUSED');
    }
    const result = { sequence: index + 1, kind: expected.kind, name: expected.name, outcome: resource.outcome };
    if (resource.id !== undefined) {
      const validId = expected.kind === 'd1' ? UUID.test(resource.id)
        : expected.kind === 'queue' ? QUEUE_ID.test(resource.id)
          : expected.kind === 'kv' && HEX_ID.test(resource.id);
      if (!validId) throw new SafeProvisioningError('prior attempt resource identifier was malformed', 'PRIOR_ATTEMPT_REFUSED');
      result.id = resource.id;
    }
    if (resource.versionDigest !== undefined) {
      if (expected.kind !== 'worker' || !/^[a-f0-9]{64}$/.test(resource.versionDigest)) {
        throw new SafeProvisioningError('prior attempt Worker version digest was malformed', 'PRIOR_ATTEMPT_REFUSED');
      }
      result.versionDigest = resource.versionDigest;
    }
    return result;
  });
  const mutationCounts = {};
  for (const [key, count] of Object.entries(candidate.mutationCounts)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key) || !Number.isSafeInteger(count) || count < 0) {
      throw new SafeProvisioningError('prior attempt mutation counts were malformed', 'PRIOR_ATTEMPT_REFUSED');
    }
    mutationCounts[key] = count;
  }
  for (const key of ['productionMutations', 'deleteMutations', 'renameMutations', 'secretMutations', 'd1SchemaMutations']) {
    if (mutationCounts[key] !== 0) throw new SafeProvisioningError('prior attempt crossed a forbidden mutation boundary', 'PRIOR_ATTEMPT_REFUSED');
  }
  const error = candidate.error === null
    ? null
    : candidate.error && typeof candidate.error === 'object' && !Array.isArray(candidate.error)
      && Object.keys(candidate.error).length === 1 && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.error.code)
      ? { code: candidate.error.code }
      : (() => { throw new SafeProvisioningError('prior attempt error evidence was malformed', 'PRIOR_ATTEMPT_REFUSED'); })();
  const attemptId = typeof candidate.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(candidate.attemptId)
    ? candidate.attemptId
    : `legacy-${sha256({ startedAt: candidate.startedAt, status: candidate.status }).slice(0, 24)}`;
  const workerProvenance = candidate.workerProvenance && typeof candidate.workerProvenance === 'object'
    && !Array.isArray(candidate.workerProvenance)
    && typeof candidate.workerProvenance.status === 'string'
    && /^[a-z][a-z-]{0,63}$/.test(candidate.workerProvenance.status)
    && (candidate.workerProvenance.sourceAttemptId === null
      || typeof candidate.workerProvenance.sourceAttemptId === 'string'
        && /^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{24})$/.test(candidate.workerProvenance.sourceAttemptId))
    ? {
      status: candidate.workerProvenance.status,
      sourceAttemptId: candidate.workerProvenance.sourceAttemptId,
    }
    : null;
  return {
    taskId: 'T-025',
    environment: 'staging',
    accountId: PINNED_ACCOUNT_ID,
    attemptId,
    mode: candidate.mode === 'apply' || candidate.mode === 'plan'
      ? candidate.mode
      : (() => { throw new SafeProvisioningError('prior attempt mode was malformed', 'PRIOR_ATTEMPT_REFUSED'); })(),
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : null,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null,
    status: candidate.status,
    preFingerprint: fingerprint(candidate.preFingerprint ?? null),
    postFingerprint: fingerprint(candidate.postFingerprint ?? null),
    resources,
    mutationCounts,
    workerCreatePrecondition: sameCanonical(candidate.workerCreatePrecondition, {
      header: 'If-None-Match',
      value: '*',
    }) ? { header: 'If-None-Match', value: '*' } : null,
    workerProvenance,
    bootstrapControl: candidate.bootstrapControl && typeof candidate.bootstrapControl === 'object'
      && typeof candidate.bootstrapControl.status === 'string' && /^[a-z][a-z-]{0,47}$/.test(candidate.bootstrapControl.status)
      && sameCanonical(candidate.bootstrapControl.requestedState, DISABLED_WORKER_SUBDOMAIN_STATE)
      ? {
        status: candidate.bootstrapControl.status,
        requestedState: DISABLED_WORKER_SUBDOMAIN_STATE,
        verifiedState: sameCanonical(candidate.bootstrapControl.verifiedState, DISABLED_WORKER_SUBDOMAIN_STATE)
          ? DISABLED_WORKER_SUBDOMAIN_STATE
          : null,
      }
      : null,
    durableObjectProvisioningMigration: candidate.durableObjectProvisioningMigration
      && typeof candidate.durableObjectProvisioningMigration === 'object'
      && typeof candidate.durableObjectProvisioningMigration.status === 'string'
      && /^[a-z][a-z-]{0,47}$/.test(candidate.durableObjectProvisioningMigration.status)
      && candidate.durableObjectProvisioningMigration.newTag === 'v1'
      && sameCanonical(candidate.durableObjectProvisioningMigration.newSqliteClasses, ['ChatRoom', 'NotificationService'])
      ? {
        status: candidate.durableObjectProvisioningMigration.status,
        newTag: 'v1',
        newSqliteClasses: ['ChatRoom', 'NotificationService'],
      }
      : null,
    error,
  };
}

function priorWorkerCreationProof(attemptHistory) {
  const directProofs = new Map();
  let latestProof = null;
  for (const attempt of attemptHistory) {
    const worker = attempt.resources.find((resource) => resource.kind === 'worker'
      && resource.name === STAGING_TARGETS.worker);
    const counts = attempt.mutationCounts;
    const directBase = attempt.mode === 'apply'
      && ['CONVERGED', 'PARTIAL_FAILURE_DURABLE'].includes(attempt.status)
      && sameCanonical(attempt.workerCreatePrecondition, { header: 'If-None-Match', value: '*' })
      && /^[a-f0-9]{64}$/.test(worker?.versionDigest ?? '')
      && ['created', 'created-control-failed'].includes(worker?.outcome)
      && attempt.durableObjectProvisioningMigration?.status === 'accepted-with-worker-create'
      && counts.durableObjectProvisioningMigrationsAttempted === 1
      && counts.confirmedDurableObjectProvisioningMigrations === 1
      && counts.confirmedCreates >= 1;
    if (directBase) {
      const fullyVerified = worker.outcome === 'created'
        && attempt.bootstrapControl?.status === 'disabled-and-verified'
        && sameCanonical(attempt.bootstrapControl.verifiedState, DISABLED_WORKER_SUBDOMAIN_STATE)
        && counts.workerSubdomainControlAttempts === 1
        && counts.confirmedWorkerSubdomainControls === 1
        && counts.failedWorkerSubdomainControls === 0;
      const recoveryRequired = attempt.status === 'PARTIAL_FAILURE_DURABLE'
        && worker.outcome === 'created-control-failed'
        && attempt.bootstrapControl?.status === 'failed'
        && attempt.bootstrapControl.verifiedState === null
        && counts.workerSubdomainControlAttempts === 1
        && counts.confirmedWorkerSubdomainControls === 0
        && counts.failedWorkerSubdomainControls === 1;
      if (fullyVerified || recoveryRequired) {
        const proof = {
          sourceAttemptId: attempt.attemptId,
          versionDigest: worker.versionDigest,
          controlState: fullyVerified ? 'verified' : 'recovery-required',
        };
        directProofs.set(attempt.attemptId, proof);
        latestProof = proof;
      }
    }

    const source = directProofs.get(attempt.workerProvenance?.sourceAttemptId);
    const recovered = source
      && attempt.mode === 'apply'
      && attempt.status === 'CONVERGED'
      && worker?.outcome === 'reused-provenance-control-recovered'
      && worker.versionDigest === source.versionDigest
      && attempt.workerProvenance.status === 'same-ledger-control-recovered'
      && attempt.bootstrapControl?.status === 'disabled-and-verified-control-recovered'
      && sameCanonical(attempt.bootstrapControl.verifiedState, DISABLED_WORKER_SUBDOMAIN_STATE)
      && attempt.durableObjectProvisioningMigration?.status === 'accepted-prior-provenance'
      && counts.workerSubdomainControlAttempts === 1
      && counts.confirmedWorkerSubdomainControls === 1
      && counts.failedWorkerSubdomainControls === 0
      && counts.remoteMutationAttempts === 1
      && counts.confirmedRemoteMutations === 1
      && counts.confirmedCreates === 0;
    if (recovered) {
      latestProof = { ...source, controlState: 'verified' };
    }
  }
  return latestProof;
}

function loadAttemptHistory(path) {
  try {
    const stat = lstatSync(resolve(path));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024
      || (stat.mode & 0o777) !== 0o600
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new SafeProvisioningError('prior provisioning ledger was not a bounded owner-only file', 'PRIOR_ATTEMPT_REFUSED');
    }
    const previous = JSON.parse(readFileSync(resolve(path), 'utf8'));
    if (!Array.isArray(previous.attemptHistory) || previous.attemptHistory.length >= MAX_ATTEMPT_HISTORY) {
      throw new SafeProvisioningError('prior provisioning attempt history was malformed or full', 'PRIOR_ATTEMPT_REFUSED');
    }
    const history = previous.attemptHistory.map(safeAttemptSnapshot);
    history.push(safeAttemptSnapshot(previous));
    return history;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error instanceof SafeProvisioningError) throw error;
    throw new SafeProvisioningError('prior provisioning ledger could not be parsed safely', 'PRIOR_ATTEMPT_REFUSED');
  }
}

function newLedger({ mode, now, attemptHistory }) {
  return {
    schemaVersion: 1,
    taskId: 'T-025',
    attemptId: randomUUID(),
    attemptHistory,
    environment: 'staging',
    accountId: PINNED_ACCOUNT_ID,
    mode,
    status: 'INITIALIZED',
    startedAt: now(),
    updatedAt: now(),
    target: targetSummary(),
    preFingerprint: null,
    postFingerprint: null,
    preInventoryComplete: false,
    postInventoryComplete: false,
    inventoryCounts: { pre: null, post: null },
    exactMissingDiff: [],
    resources: RESOURCE_SPECS.map((spec, index) => ({ sequence: index + 1, ...spec, outcome: 'pending' })),
    mutationCounts: {
      plannedCreates: 0,
      durableObjectProvisioningMigrationsPlanned: 1,
      durableObjectProvisioningMigrationsAttempted: 0,
      confirmedDurableObjectProvisioningMigrations: 0,
      createAttempts: 0,
      confirmedCreates: 0,
      failedCreates: 0,
      reused: 0,
      remoteMutationAttempts: 0,
      confirmedRemoteMutations: 0,
      workerSubdomainControlAttempts: 0,
      confirmedWorkerSubdomainControls: 0,
      failedWorkerSubdomainControls: 0,
      productionMutations: 0,
      deleteMutations: 0,
      renameMutations: 0,
      secretMutations: 0,
      d1SchemaMutations: 0,
    },
    safety: {
      tokenStored: false,
      headersStored: false,
      requestBodiesStored: false,
      paginationValuesStored: false,
      rawErrorsStored: false,
      serializedCreates: true,
      genericUpdateOperationsAllowed: false,
      exactWorkerSubdomainDisableControlAllowed: true,
      durableObjectV1InitializationAllowedOnlyDuringWorkerCreate: true,
      existingWorkerReuseRequiresSameLedgerProvenance: true,
    },
    workerProvenance: {
      status: 'not-evaluated',
      sourceAttemptId: null,
    },
    workerCreatePrecondition: {
      header: 'If-None-Match',
      value: '*',
    },
    durableObjectProvisioningMigration: {
      status: 'planned',
      newTag: 'v1',
      newSqliteClasses: ['ChatRoom', 'NotificationService'],
    },
    bootstrapControl: {
      status: 'not-required-yet',
      requestedState: DISABLED_WORKER_SUBDOMAIN_STATE,
      verifiedState: null,
    },
    error: null,
  };
}

function publicIdentity(resource) {
  return {
    kind: resource.kind,
    name: resource.name,
    ...(resource.id ? { id: resource.id } : {}),
    ...(resource.versionDigest ? { versionDigest: resource.versionDigest } : {}),
  };
}

function requireCreateResult(spec, result) {
  assertPlainObject(result, `${spec.kind} create result`);
  if (spec.kind === 'worker') {
    const name = result.name ?? result.id;
    if (name !== spec.name) throw new SafeProvisioningError('Worker create result identity did not match', 'CREATE_RESULT_REFUSED');
    return { kind: spec.kind, name, versionDigest: workerVersionDigest(result.etag) };
  }
  if (spec.kind === 'd1') {
    const normalized = normalizeD1(result);
    if (normalized.name !== spec.name) throw new SafeProvisioningError('D1 create result identity did not match', 'CREATE_RESULT_REFUSED');
    return normalized;
  }
  if (spec.kind === 'kv') {
    const normalized = normalizeKv(result);
    if (normalized.name !== spec.name) throw new SafeProvisioningError('KV create result identity did not match', 'CREATE_RESULT_REFUSED');
    return normalized;
  }
  if (spec.kind === 'r2') {
    const normalized = normalizeR2(result);
    if (normalized.name !== spec.name) throw new SafeProvisioningError('R2 create result identity did not match', 'CREATE_RESULT_REFUSED');
    return normalized;
  }
  const normalized = normalizeQueue(result);
  if (normalized.name !== spec.name) throw new SafeProvisioningError('Queue create result identity did not match', 'CREATE_RESULT_REFUSED');
  return normalized;
}

function identityFor(resources, kind, name) {
  const entry = resources.find((candidate) => candidate.kind === kind && candidate.name === name
    && ['created', 'reused'].includes(candidate.outcome));
  if (!entry) throw new SafeProvisioningError('bootstrap dependency identity was unavailable', 'BOOTSTRAP_DEPENDENCY_MISSING');
  return entry;
}

function bootstrapMultipart(resources, bootstrapSource) {
  if (typeof bootstrapSource !== 'string'
    || sourceDigest(bootstrapSource) !== APPROVED_BOOTSTRAP_SOURCE_DIGEST) {
    throw new SafeProvisioningError('bootstrap module did not satisfy the inert contract', 'BOOTSTRAP_SOURCE_REFUSED');
  }
  const db = identityFor(resources, 'd1', STAGING_TARGETS.d1);
  const cache = identityFor(resources, 'kv', STAGING_TARGETS.kv[0]);
  const sessions = identityFor(resources, 'kv', STAGING_TARGETS.kv[1]);
  if (!UUID.test(db.id ?? '') || !HEX_ID.test(cache.id ?? '') || !HEX_ID.test(sessions.id ?? '')) {
    throw new SafeProvisioningError('bootstrap binding identifiers were malformed', 'BOOTSTRAP_DEPENDENCY_MISSING');
  }
  const bindings = [
    { type: 'd1', name: 'DB', id: db.id },
    { type: 'kv_namespace', name: 'CACHE', namespace_id: cache.id },
    { type: 'kv_namespace', name: 'SESSIONS', namespace_id: sessions.id },
    { type: 'r2_bucket', name: 'STORAGE', bucket_name: STAGING_TARGETS.r2 },
    { type: 'queue', name: 'MODERATION_QUEUE', queue_name: STAGING_TARGETS.queues[0] },
    { type: 'queue', name: 'ANALYTICS_QUEUE', queue_name: STAGING_TARGETS.queues[1] },
    { type: 'queue', name: 'NOTIFICATION_QUEUE', queue_name: STAGING_TARGETS.queues[2] },
    { type: 'durable_object_namespace', name: 'CHAT_ROOM', class_name: 'ChatRoom' },
    { type: 'durable_object_namespace', name: 'NOTIFICATION_SERVICE', class_name: 'NotificationService' },
    { type: 'plain_text', name: 'ENVIRONMENT', text: 'staging' },
    { type: 'plain_text', name: 'PAYMENT_MODE', text: 'disabled' },
    { type: 'plain_text', name: 'PROMPTPAY_ENABLED', text: 'false' },
  ];
  const metadata = {
    main_module: 'bootstrap-worker.mjs',
    compatibility_date: BOOTSTRAP_COMPATIBILITY_DATE,
    bindings,
    migrations: {
      new_tag: 'v1',
      steps: [{ new_sqlite_classes: ['ChatRoom', 'NotificationService'] }],
    },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('bootstrap-worker.mjs', new Blob([bootstrapSource], { type: 'application/javascript+module' }), 'bootstrap-worker.mjs');
  APPROVED_WORKER_MULTIPARTS.set(form, { metadata, bootstrapSource });
  return form;
}

async function createOne(client, spec, resources, bootstrapSource, initialWorkerProof, beforeWorkerUpload) {
  const prefix = `/accounts/${PINNED_ACCOUNT_ID}`;
  let response;
  if (spec.kind === 'd1') response = await client.request('POST', `${prefix}/d1/database`, {
    json: {
      name: spec.name,
      primary_location_hint: 'apac',
      read_replication: { mode: 'disabled' },
    },
  });
  else if (spec.kind === 'kv') response = await client.request('POST', `${prefix}/storage/kv/namespaces`, { json: { title: spec.name } });
  else if (spec.kind === 'r2') response = await client.request('POST', `${prefix}/r2/buckets`, {
    json: { name: spec.name, locationHint: 'apac' },
  });
  else if (spec.kind === 'queue') response = await client.request('POST', `${prefix}/queues`, { json: { queue_name: spec.name } });
  else {
    await client.proveWorkerCreateOnly(initialWorkerProof);
    await beforeWorkerUpload();
    response = await client.request('PUT', `${prefix}/workers/scripts/${STAGING_TARGETS.worker}`, {
      multipart: bootstrapMultipart(resources, bootstrapSource),
    });
  }
  return requireCreateResult(spec, response.result);
}

export async function runStagingProvisioning({
  mode = 'plan',
  confirmation = null,
  token,
  accountId = PINNED_ACCOUNT_ID,
  ledgerPath,
  fetchImpl,
  bootstrapSource,
  targets = STAGING_TARGETS,
  now = () => new Date().toISOString(),
} = {}) {
  if (!['plan', 'apply'].includes(mode)) throw new SafeProvisioningError('provisioning mode was unsupported', 'MODE_REFUSED');
  if (mode === 'apply' && confirmation !== APPLY_CONFIRMATION) {
    throw new SafeProvisioningError('apply requires the exact staging-only confirmation', 'APPLY_CONFIRMATION_REFUSED');
  }
  if (accountId !== PINNED_ACCOUNT_ID) throw new SafeProvisioningError('account override refused', 'ACCOUNT_MISMATCH');
  if (typeof ledgerPath !== 'string' || ledgerPath.length === 0) throw new SafeProvisioningError('ledger path is required', 'LEDGER_PATH_REFUSED');
  assertExactTargets(targets);
  const attemptHistory = loadAttemptHistory(ledgerPath);
  const workerCreationProof = priorWorkerCreationProof(attemptHistory);
  const ledger = newLedger({ mode, now, attemptHistory });
  const persist = () => {
    ledger.updatedAt = now();
    privateAtomicWrite(ledgerPath, ledger);
  };
  persist();
  let client;
  let pre;
  try {
    client = createCloudflareStagingProvisioningClient({ token, accountId, fetchImpl });
    ledger.status = 'PRE_INVENTORY_IN_PROGRESS';
    persist();
    const rawPreInventory = await client.inventory();
    const initialWorkerProof = rawPreInventory.workerProof;
    pre = projectInventory(rawPreInventory);
    ledger.preFingerprint = pre.fingerprint;
    ledger.preInventoryComplete = true;
    ledger.inventoryCounts.pre = pre.counts;
    ledger.exactMissingDiff = pre.missing;
    ledger.mutationCounts.plannedCreates = pre.missing.length;
    const workerExists = pre.exact.some((entry) => entry.kind === 'worker');
    const existingWorker = pre.exact.find((entry) => entry.kind === 'worker');
    const workerVersionMatchesProof = workerExists && workerCreationProof
      ? existingWorker.versionDigest === workerCreationProof.versionDigest
      : false;
    ledger.mutationCounts.durableObjectProvisioningMigrationsPlanned = workerExists ? 0 : 1;
    if (workerExists && workerCreationProof) {
      ledger.workerProvenance = {
        status: workerVersionMatchesProof ? 'same-ledger-proof-found' : 'remote-version-mismatch',
        sourceAttemptId: workerCreationProof.sourceAttemptId,
      };
      ledger.durableObjectProvisioningMigration.status = 'accepted-prior-provenance';
      ledger.bootstrapControl.status = workerCreationProof.controlState === 'recovery-required'
        ? 'prior-control-failure-recovery-required'
        : 'prior-verification-recheck-required';
    } else if (workerExists) {
      ledger.workerProvenance.status = 'unproven-existing-worker';
      ledger.durableObjectProvisioningMigration.status = 'not-planned-existing-worker-unproven';
      ledger.bootstrapControl.status = 'not-authorized-existing-worker-unproven';
    }
    for (const resource of ledger.resources) {
      const match = pre.exact.find((entry) => entry.kind === resource.kind && entry.name === resource.name);
      if (match) {
        if (resource.kind === 'worker') {
          Object.assign(resource, publicIdentity(match), {
            outcome: workerCreationProof
              ? workerVersionMatchesProof ? 'existing-worker-provenance' : 'existing-worker-version-mismatch'
              : 'existing-worker-unproven',
          });
        } else {
          Object.assign(resource, publicIdentity(match), { outcome: 'reused' });
          ledger.mutationCounts.reused += 1;
        }
      } else {
        resource.outcome = 'planned-create';
      }
    }
    ledger.status = mode === 'plan' ? 'PLANNED_NO_MUTATIONS' : 'APPLY_READY';
    if (mode === 'plan') {
      ledger.postFingerprint = pre.fingerprint;
      ledger.inventoryCounts.post = pre.counts;
      persist();
      return ledger;
    }
    if (workerExists && !workerCreationProof) {
      throw new SafeProvisioningError('existing staging Worker is outside create-only provisioning authority', 'EXISTING_WORKER_REFUSED');
    }
    if (workerExists && !workerVersionMatchesProof) {
      throw new SafeProvisioningError('existing staging Worker version differed from same-ledger creation evidence', 'WORKER_VERSION_MISMATCH');
    }
    if (workerExists) {
      const resource = ledger.resources.find((entry) => entry.kind === 'worker');
      ledger.mutationCounts.reused += 1;
      if (workerCreationProof.controlState === 'recovery-required') {
        resource.outcome = 'control-recovery-in-progress';
        ledger.workerProvenance.status = 'same-ledger-control-recovery-in-progress';
        ledger.bootstrapControl.status = 'mutation-in-progress';
        ledger.mutationCounts.workerSubdomainControlAttempts += 1;
        ledger.mutationCounts.remoteMutationAttempts += 1;
        persist();
        try {
          await client.disableAndVerifyWorkerSubdomain();
          resource.outcome = 'reused-provenance-control-recovered';
          ledger.workerProvenance.status = 'same-ledger-control-recovered';
          ledger.bootstrapControl.status = 'disabled-and-verified-control-recovered';
          ledger.bootstrapControl.verifiedState = DISABLED_WORKER_SUBDOMAIN_STATE;
          ledger.mutationCounts.confirmedWorkerSubdomainControls += 1;
          ledger.mutationCounts.confirmedRemoteMutations += 1;
        } catch (error) {
          resource.outcome = 'control-recovery-failed';
          ledger.bootstrapControl.status = 'failed';
          ledger.mutationCounts.failedWorkerSubdomainControls += 1;
          ledger.status = 'PARTIAL_FAILURE_DURABLE';
          ledger.error = { code: safeErrorCode(error) };
          persist();
          throw new SafeProvisioningError('Worker control-only recovery failed; inspect the redacted durable ledger', safeErrorCode(error));
        }
      } else {
        await client.verifyWorkerSubdomainDisabled();
        resource.outcome = 'reused-provenance';
        ledger.workerProvenance.status = 'same-ledger-proof-and-live-control-verified';
        ledger.bootstrapControl.status = 'disabled-and-verified-prior-provenance';
        ledger.bootstrapControl.verifiedState = DISABLED_WORKER_SUBDOMAIN_STATE;
      }
    }
    persist();

    for (const spec of pre.missing) {
      const resource = ledger.resources.find((entry) => entry.kind === spec.kind && entry.name === spec.name);
      resource.outcome = 'create-in-progress';
      ledger.mutationCounts.createAttempts += 1;
      ledger.status = 'APPLY_IN_PROGRESS';
      persist();
      let resourceCreateConfirmed = false;
      try {
        if (spec.kind !== 'worker') {
          ledger.mutationCounts.remoteMutationAttempts += 1;
          persist();
        }
        const created = await createOne(
          client,
          spec,
          ledger.resources,
          bootstrapSource,
          initialWorkerProof,
          async () => {
            ledger.mutationCounts.remoteMutationAttempts += 1;
            ledger.mutationCounts.durableObjectProvisioningMigrationsAttempted += 1;
            ledger.durableObjectProvisioningMigration.status = 'upload-in-progress';
            persist();
          },
        );
        resourceCreateConfirmed = true;
        Object.assign(resource, publicIdentity(created), {
          outcome: spec.kind === 'worker' ? 'created-control-pending' : 'created',
        });
        ledger.mutationCounts.confirmedCreates += 1;
        ledger.mutationCounts.confirmedRemoteMutations += 1;
        if (spec.kind === 'worker') {
          ledger.mutationCounts.confirmedDurableObjectProvisioningMigrations += 1;
          ledger.durableObjectProvisioningMigration.status = 'accepted-with-worker-create';
        }
        persist();
        if (spec.kind === 'worker') {
          ledger.bootstrapControl.status = 'mutation-in-progress';
          ledger.mutationCounts.workerSubdomainControlAttempts += 1;
          ledger.mutationCounts.remoteMutationAttempts += 1;
          persist();
          await client.disableAndVerifyWorkerSubdomain();
          ledger.bootstrapControl.status = 'disabled-and-verified';
          ledger.bootstrapControl.verifiedState = DISABLED_WORKER_SUBDOMAIN_STATE;
          ledger.mutationCounts.confirmedWorkerSubdomainControls += 1;
          ledger.mutationCounts.confirmedRemoteMutations += 1;
          resource.outcome = 'created';
          persist();
        }
      } catch (error) {
        if (resourceCreateConfirmed && spec.kind === 'worker') {
          resource.outcome = 'created-control-failed';
          ledger.bootstrapControl.status = 'failed';
          ledger.mutationCounts.failedWorkerSubdomainControls += 1;
        } else {
          resource.outcome = 'failed';
          ledger.mutationCounts.failedCreates += 1;
          if (spec.kind === 'worker' && ledger.mutationCounts.durableObjectProvisioningMigrationsAttempted === 1) {
            ledger.durableObjectProvisioningMigration.status = 'failed';
          }
        }
        ledger.status = 'PARTIAL_FAILURE_DURABLE';
        ledger.error = { code: safeErrorCode(error) };
        persist();
        throw new SafeProvisioningError('staging provisioning stopped; inspect the redacted durable ledger', safeErrorCode(error));
      }
    }

    ledger.status = 'POST_INVENTORY_IN_PROGRESS';
    persist();
    const post = projectInventory(await client.inventory());
    if (post.missing.length !== 0) throw new SafeProvisioningError('post-apply inventory remained incomplete', 'POSTCONDITION_REFUSED');
    const postWorker = post.exact.find((entry) => entry.kind === 'worker');
    const ledgerWorker = ledger.resources.find((entry) => entry.kind === 'worker');
    if (!postWorker?.versionDigest || postWorker.versionDigest !== ledgerWorker?.versionDigest) {
      throw new SafeProvisioningError('post-apply Worker version did not match the accepted upload', 'WORKER_VERSION_MISMATCH');
    }
    ledger.postFingerprint = post.fingerprint;
    ledger.postInventoryComplete = true;
    ledger.inventoryCounts.post = post.counts;
    ledger.status = 'CONVERGED';
    ledger.error = null;
    persist();
    return ledger;
  } catch (error) {
    if (ledger.status !== 'PARTIAL_FAILURE_DURABLE') {
      ledger.status = ledger.mutationCounts.remoteMutationAttempts > 0 ? 'PARTIAL_FAILURE_DURABLE' : 'REFUSED_NO_MUTATIONS';
      ledger.error = { code: safeErrorCode(error) };
      persist();
    }
    throw error instanceof SafeProvisioningError
      ? error
      : new SafeProvisioningError('staging provisioning was refused safely', 'STAGING_PROVISIONING_REFUSED');
  }
}
