import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
export const CLOUDFLARE_API_PREFIX = '/client/v4';
export const PINNED_TIRAK_ACCOUNT_ID = '2c0c96c68f0ee73b6d980054557bca5b';
export const DEFAULT_STAGING_ENV_FILE = '.env.tirak-staging';

const ENV_KEYS = new Set([
  'TIRAK_CLOUDFLARE_API_TOKEN',
  'TIRAK_CLOUDFLARE_ACCOUNT_ID',
  'TIRAK_STAGING_READ_ONLY_AUTHORIZATION',
]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const CLOUDFLARE_IDENTIFIER = /^[a-f0-9]{32}$/i;
const CLOUDFLARE_RESOURCE = /^com\.cloudflare\.api\.(?:[a-z][a-z0-9_-]{0,63}|[a-f0-9]{32}|\*)(?:\.(?:[a-z][a-z0-9_-]{0,63}|[a-f0-9]{32}|\*)){1,7}$/i;
const MAX_TOKEN_RESOURCE_KEY_LENGTH = 256;
const MAX_TOKEN_RESOURCE_DEPTH = 4;
const MAX_TOKEN_RESOURCE_ENTRIES = 256;

export class SafeCloudflareError extends Error {
  constructor(message, code = 'CLOUDFLARE_READ_ONLY_REFUSED') {
    super(message);
    this.name = 'SafeCloudflareError';
    this.code = code;
  }
}

export function requireNonnegativeSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SafeCloudflareError(`${label} must be a numeric nonnegative safe integer`, 'D1_INTEGER_INVALID');
  }
  return value;
}

export function requireMatchingServingProjection(previous, next, label) {
  if (previous !== null && JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new SafeCloudflareError(`active Worker versions disagree on ${label}`, 'WORKER_ACTIVE_PROJECTION_DRIFT');
  }
  return next;
}

export function assertCredentialGitBoundary({
  envFilePath,
  cwd = process.cwd(),
  spawnImpl = spawnSync,
} = {}) {
  const relativePath = relative(resolve(cwd), resolve(envFilePath ?? DEFAULT_STAGING_ENV_FILE));
  if (relativePath !== DEFAULT_STAGING_ENV_FILE) {
    throw new SafeCloudflareError('credential file must use the fixed project-local staging path', 'ENV_GIT_BOUNDARY');
  }
  const ignored = spawnImpl('git', ['check-ignore', '--quiet', '--', relativePath], { cwd, stdio: 'ignore' });
  if (ignored.status !== 0) {
    throw new SafeCloudflareError('credential file path is not protected by Git ignore rules', 'ENV_GIT_BOUNDARY');
  }
  const tracked = spawnImpl('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd, stdio: 'ignore' });
  if (tracked.status === 0) {
    throw new SafeCloudflareError('credential file is tracked by Git and must not be loaded', 'ENV_GIT_BOUNDARY');
  }
  if (tracked.status !== 1) {
    throw new SafeCloudflareError('credential Git tracking state could not be proven safely', 'ENV_GIT_BOUNDARY');
  }
  return true;
}

function decodeEnvValue(raw, key) {
  const value = raw.trim();
  if (!value) return '';
  if (/\$\{|\$\(|`|\0|\r|\n/.test(value)) {
    throw new SafeCloudflareError(`unsafe interpolation or multiline value refused for ${key}`, 'ENV_UNSAFE_VALUE');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const decoded = value.slice(1, -1);
    if (decoded.includes(value[0])) throw new SafeCloudflareError(`embedded quote refused for ${key}`, 'ENV_UNSAFE_VALUE');
    return decoded;
  }
  if (value.startsWith('"') || value.endsWith('"') || value.startsWith("'") || value.endsWith("'")) {
    throw new SafeCloudflareError(`unbalanced quote refused for ${key}`, 'ENV_UNSAFE_VALUE');
  }
  if (/\s+#/.test(value)) throw new SafeCloudflareError(`inline comments are not supported for ${key}`, 'ENV_UNSAFE_VALUE');
  return value;
}

export function parseRestrictedEnv(text) {
  if (text.includes('\0')) throw new SafeCloudflareError('NUL byte refused in staging environment file', 'ENV_NUL_BYTE');
  const result = {};
  const seen = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new SafeCloudflareError(`invalid staging environment entry on line ${index + 1}`, 'ENV_INVALID_LINE');
    const [, key, raw] = match;
    if (!ENV_KEYS.has(key)) throw new SafeCloudflareError(`unsupported staging environment key ${key}`, 'ENV_UNKNOWN_KEY');
    if (seen.has(key)) throw new SafeCloudflareError(`duplicate staging environment key ${key}`, 'ENV_DUPLICATE_KEY');
    seen.add(key);
    result[key] = decodeEnvValue(raw, key);
  }
  return result;
}

export function loadStagingCredentials({ envFilePath, processEnv = process.env, allowMissing = true } = {}) {
  let fileValues = {};
  let source = 'process-environment';
  if (envFilePath) {
    try {
      const stat = lstatSync(envFilePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SafeCloudflareError('staging environment path must be a regular file, not a symlink', 'ENV_FILE_TYPE');
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new SafeCloudflareError('staging environment file must be owned by the current user', 'ENV_FILE_OWNER');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new SafeCloudflareError('staging environment file mode must be exactly 0600', 'ENV_FILE_MODE');
      }
      fileValues = parseRestrictedEnv(readFileSync(envFilePath, 'utf8'));
      source = 'owner-only-environment-file';
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const merged = { ...fileValues };
  for (const key of ENV_KEYS) {
    if (processEnv[key] !== undefined && processEnv[key] !== '') {
      if (fileValues[key] && fileValues[key] !== processEnv[key]) {
        throw new SafeCloudflareError(`conflicting ${key} values refused`, 'ENV_CONFLICT');
      }
      merged[key] = processEnv[key];
      source = fileValues[key] ? 'matching-process-and-file' : 'process-environment';
    }
  }

  const accountId = merged.TIRAK_CLOUDFLARE_ACCOUNT_ID || PINNED_TIRAK_ACCOUNT_ID;
  if (accountId !== PINNED_TIRAK_ACCOUNT_ID) {
    throw new SafeCloudflareError('Cloudflare account does not match the pinned Tirak account', 'ACCOUNT_MISMATCH');
  }
  const token = merged.TIRAK_CLOUDFLARE_API_TOKEN || '';
  if (token.startsWith('cfk_')) {
    throw new SafeCloudflareError('legacy Cloudflare global API keys are not accepted as bearer tokens', 'TOKEN_TYPE_REFUSED');
  }
  if (!token && !allowMissing) throw new SafeCloudflareError('Cloudflare API token is missing', 'TOKEN_MISSING');
  return {
    token,
    accountId,
    authorization: merged.TIRAK_STAGING_READ_ONLY_AUTHORIZATION || '',
    credentialPresent: token.length > 0,
    source,
  };
}

export function assertReadOnlySelect(sql) {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > 4096) {
    throw new SafeCloudflareError('D1 query must be a bounded SELECT statement', 'SQL_REFUSED');
  }
  const normalized = sql.trim();
  const withoutTerminal = normalized.endsWith(';') ? normalized.slice(0, -1).trimEnd() : normalized;
  if (!/^SELECT\b/i.test(withoutTerminal)
    || withoutTerminal.includes(';')
    || /--|\/\*|\*\//.test(withoutTerminal)
    || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|UPSERT|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOAD_EXTENSION)\b/i.test(withoutTerminal)) {
    throw new SafeCloudflareError('D1 query refused because it is not one single SELECT', 'SQL_REFUSED');
  }
  return withoutTerminal;
}

function assertSafeSegment(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new SafeCloudflareError(`invalid ${label} path segment`, 'PATH_REFUSED');
  }
}

function classifyAllowedPath(method, pathname, {
  accountId,
  workerName,
  verifiedTokenId = null,
  verifiedTokenType = null,
}) {
  const prefix = `${CLOUDFLARE_API_PREFIX}/accounts/${accountId}`;
  if (method === 'GET' && pathname === `${CLOUDFLARE_API_PREFIX}/user/tokens/verify`) return 'token verification';
  if (method === 'GET' && pathname === `${prefix}/tokens/verify`) return 'account token verification';
  if (verifiedTokenId && verifiedTokenType === 'user-token'
    && method === 'GET'
    && pathname === `${CLOUDFLARE_API_PREFIX}/user/tokens/${verifiedTokenId}`) return 'current token details';
  if (verifiedTokenId && verifiedTokenType === 'account-token'
    && method === 'GET'
    && pathname === `${prefix}/tokens/${verifiedTokenId}`) return 'current account token details';
  if (method === 'GET' && pathname === prefix) return 'account identity';
  if (method === 'GET' && pathname === `${prefix}/workers/scripts`) return 'Worker list';
  if (method === 'GET' && pathname === `${prefix}/workers/scripts/${encodeURIComponent(workerName)}/deployments`) return 'Worker deployments';
  const versionMatch = pathname.match(new RegExp(`^${prefix}/workers/scripts/${encodeURIComponent(workerName)}/versions/([a-f0-9-]{36})$`, 'i'));
  if (method === 'GET' && versionMatch) {
    assertSafeSegment(versionMatch[1], 'Worker version', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    return 'Worker version detail';
  }
  if (method === 'GET' && pathname === `${prefix}/d1/database`) return 'D1 list';
  if (method === 'GET' && pathname === `${prefix}/storage/kv/namespaces`) return 'KV list';
  if (method === 'GET' && pathname === `${prefix}/r2/buckets`) return 'R2 list';
  if (method === 'GET' && pathname === `${prefix}/queues`) return 'Queue list';
  if (method === 'GET' && pathname === `${prefix}/workers/durable_objects/namespaces`) return 'Durable Object list';
  const d1Match = pathname.match(new RegExp(`^${prefix}/d1/database/([a-f0-9-]{36})(/query)?$`, 'i'));
  if (d1Match) {
    assertSafeSegment(d1Match[1], 'D1 database', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    if (method === 'GET' && !d1Match[2]) return 'D1 detail';
    if (method === 'POST' && d1Match[2] === '/query') return 'D1 SELECT';
  }
  throw new SafeCloudflareError(`Cloudflare ${method} path is outside the read-only allowlist`, 'PATH_REFUSED');
}

function assertPlainObject(value, message) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new SafeCloudflareError(message, 'TOKEN_POLICY_INVALID');
  }
  return value;
}

function visitTokenResourceMap(resources, observeResourceKey, bounds) {
  function visit(resourceMap, depth) {
    if (depth > MAX_TOKEN_RESOURCE_DEPTH) {
      throw new SafeCloudflareError('Cloudflare current-token resources exceeded the safe depth', 'TOKEN_POLICY_INVALID');
    }
    const safeMap = assertPlainObject(resourceMap, 'Cloudflare current-token resources were malformed');
    const entries = Object.entries(safeMap);
    if (entries.length === 0) {
      throw new SafeCloudflareError('Cloudflare current-token resources were empty', 'TOKEN_POLICY_INVALID');
    }
    for (const [resource, target] of entries) {
      bounds.entryCount += 1;
      if (bounds.entryCount > MAX_TOKEN_RESOURCE_ENTRIES) {
        throw new SafeCloudflareError('Cloudflare current-token resources exceeded the safe entry count', 'TOKEN_POLICY_INVALID');
      }
      if (resource.length > MAX_TOKEN_RESOURCE_KEY_LENGTH || !CLOUDFLARE_RESOURCE.test(resource)) {
        throw new SafeCloudflareError('Cloudflare current-token resource key was malformed', 'TOKEN_POLICY_INVALID');
      }
      observeResourceKey(resource);
      if (target === '*') continue;
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new SafeCloudflareError('Cloudflare current-token resource leaf was malformed', 'TOKEN_POLICY_INVALID');
      }
      visit(target, depth + 1);
    }
  }

  visit(resources, 1);
}

export function classifyCurrentTokenPolicies(tokenDetails, {
  expectedTokenId,
  accountId = PINNED_TIRAK_ACCOUNT_ID,
} = {}) {
  if (accountId !== PINNED_TIRAK_ACCOUNT_ID) {
    throw new SafeCloudflareError('Cloudflare account does not match the pinned Tirak account', 'ACCOUNT_MISMATCH');
  }
  if (typeof expectedTokenId !== 'string' || !CLOUDFLARE_IDENTIFIER.test(expectedTokenId)) {
    throw new SafeCloudflareError('verified Cloudflare token identifier was malformed', 'TOKEN_ID_INVALID');
  }
  const details = assertPlainObject(tokenDetails, 'Cloudflare current-token details were malformed');
  if (details.id !== expectedTokenId) {
    throw new SafeCloudflareError('Cloudflare current-token details did not match the verified token', 'TOKEN_ID_MISMATCH');
  }
  if (details.status !== 'active') {
    throw new SafeCloudflareError('Cloudflare current-token details did not prove an active token', 'TOKEN_INACTIVE');
  }
  if (!Array.isArray(details.policies) || details.policies.length === 0) {
    throw new SafeCloudflareError('Cloudflare current-token policies were malformed', 'TOKEN_POLICY_INVALID');
  }

  let pinnedAccountIncluded = false;
  let broadResourceScope = false;
  let writeCapable = false;
  const pinnedAccountResource = `com.cloudflare.api.account.${accountId}`;
  const resourceBounds = { entryCount: 0 };

  for (const policy of details.policies) {
    const safePolicy = assertPlainObject(policy, 'Cloudflare current-token policy was malformed');
    if (safePolicy.effect !== 'allow') {
      throw new SafeCloudflareError('Cloudflare current-token policy effect was unsupported', 'TOKEN_POLICY_INVALID');
    }
    visitTokenResourceMap(safePolicy.resources, (resource) => {
      if (resource === pinnedAccountResource) pinnedAccountIncluded = true;
      if (resource === 'com.cloudflare.api.account.*') {
        pinnedAccountIncluded = true;
        broadResourceScope = true;
      } else if (resource !== pinnedAccountResource) {
        broadResourceScope = true;
      }
    }, resourceBounds);

    if (!Array.isArray(safePolicy.permission_groups) || safePolicy.permission_groups.length === 0) {
      throw new SafeCloudflareError('Cloudflare current-token permission groups were malformed', 'TOKEN_POLICY_INVALID');
    }
    for (const permission of safePolicy.permission_groups) {
      const safePermission = assertPlainObject(permission, 'Cloudflare current-token permission group was malformed');
      if (typeof safePermission.id !== 'string' || !CLOUDFLARE_IDENTIFIER.test(safePermission.id)
        || typeof safePermission.name !== 'string' || safePermission.name.length === 0 || safePermission.name.length > 200
        || safePermission.name.trim() !== safePermission.name || /[\u0000-\u001f\u007f]/u.test(safePermission.name)) {
        throw new SafeCloudflareError('Cloudflare current-token permission group was malformed', 'TOKEN_POLICY_INVALID');
      }
      if (!/\bRead$/u.test(safePermission.name)) writeCapable = true;
    }
  }

  return {
    permissionRisk: writeCapable || broadResourceScope ? 'write-capable-or-broad' : 'read-only',
    pinnedAccountIncluded,
  };
}

function validateSearchParams(url) {
  const allowed = new Set(['page', 'per_page', 'cursor']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new SafeCloudflareError('unsupported Cloudflare query parameter refused', 'PATH_REFUSED');
  }
}

async function boundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeCloudflareError('Cloudflare response exceeded the size limit', 'RESPONSE_TOO_LARGE');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new SafeCloudflareError('Cloudflare response exceeded the size limit', 'RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new SafeCloudflareError('Cloudflare response exceeded the size limit', 'RESPONSE_TOO_LARGE');
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function parseEnvelope(text, status) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new SafeCloudflareError(`Cloudflare returned invalid JSON (HTTP ${status})`, 'RESPONSE_INVALID');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.success !== 'boolean') {
    throw new SafeCloudflareError(`Cloudflare returned an invalid API envelope (HTTP ${status})`, 'RESPONSE_INVALID');
  }
  return envelope;
}

function resultItems(result) {
  if (Array.isArray(result)) return result;
  for (const key of ['items', 'databases', 'namespaces', 'buckets', 'queues', 'scripts', 'versions']) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

export function extractSafeWorkerBindings(versionDetail) {
  const rawBindings = versionDetail?.resources?.bindings;
  if (!Array.isArray(rawBindings)) return [];
  const safe = [];
  for (const binding of rawBindings) {
    const type = String(binding?.type ?? '').toLowerCase();
    const name = typeof binding?.name === 'string' ? binding.name : null;
    if (type === 'd1' && name && typeof binding.database_id === 'string') {
      safe.push({ type, binding: name, id: binding.database_id });
    } else if (type === 'kv_namespace' && name && typeof binding.namespace_id === 'string') {
      safe.push({ type, binding: name, id: binding.namespace_id });
    } else if (type === 'r2_bucket' && name && typeof binding.bucket_name === 'string') {
      safe.push({ type, binding: name, name: binding.bucket_name });
    } else if (type === 'queue' && name && typeof binding.queue_name === 'string') {
      safe.push({ type, binding: name, name: binding.queue_name });
    } else if (type === 'durable_object_namespace' && name && typeof binding.class_name === 'string') {
      safe.push({
        type,
        binding: name,
        className: binding.class_name,
        ...(typeof binding.namespace_id === 'string' ? { namespaceId: binding.namespace_id } : {}),
        ...(typeof binding.script_name === 'string' ? { script: binding.script_name } : {}),
      });
    }
  }
  return safe.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function extractSafeWorkerRuntime(versionDetail) {
  const rawBindings = Array.isArray(versionDetail?.resources?.bindings) ? versionDetail.resources.bindings : [];
  const exactSafeValue = (name, expected) => {
    const matches = rawBindings.filter((binding) => binding?.type === 'plain_text' && binding?.name === name);
    return matches.length === 1 && matches[0]?.text === expected ? expected : 'NONCOMPLIANT';
  };
  const rawMigrationTag = versionDetail?.resources?.script_runtime?.migration_tag;
  const migrationTag = typeof rawMigrationTag === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(rawMigrationTag)
    ? rawMigrationTag
    : 'NONCOMPLIANT';
  return {
    environment: exactSafeValue('ENVIRONMENT', 'staging'),
    paymentMode: exactSafeValue('PAYMENT_MODE', 'disabled'),
    promptPayEnabled: exactSafeValue('PROMPTPAY_ENABLED', 'false'),
    migrationTag,
  };
}

export function filterConfiguredWorkerBindings(bindings, configured) {
  return bindings.filter((binding) => {
    if (binding.type === 'd1') return configured.database.some((entry) => entry.binding === binding.binding);
    if (binding.type === 'kv_namespace') return configured.kv.some((entry) => entry.binding === binding.binding);
    if (binding.type === 'r2_bucket') {
      return configured.r2.some((entry) => entry.binding === binding.binding && entry.name === binding.name);
    }
    if (binding.type === 'queue') {
      return configured.queues.producers.some((entry) => entry.binding === binding.binding && entry.name === binding.name);
    }
    if (binding.type === 'durable_object_namespace') {
      return configured.durableObjects.some((entry) => entry.binding === binding.binding && entry.className === binding.className)
        && (!binding.script || binding.script === configured.worker);
    }
    return false;
  });
}

export function createCloudflareReadOnlyClient({
  token,
  accountId = PINNED_TIRAK_ACCOUNT_ID,
  workerName = 'tirak-backend-staging',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  selectTemplateValidator = null,
} = {}) {
  if (!token) throw new SafeCloudflareError('Cloudflare API token is missing', 'TOKEN_MISSING');
  if (accountId !== PINNED_TIRAK_ACCOUNT_ID) throw new SafeCloudflareError('Cloudflare account does not match the pinned Tirak account', 'ACCOUNT_MISMATCH');
  if (workerName !== 'tirak-backend-staging') throw new SafeCloudflareError('Worker does not match the pinned staging Worker', 'WORKER_MISMATCH');
  if (typeof fetchImpl !== 'function') throw new SafeCloudflareError('fetch implementation is unavailable', 'FETCH_UNAVAILABLE');
  const requestLog = [];
  const currentTokenDetailsGrant = Symbol('current-token-details-grant');
  const requestRecordReference = Symbol('request-record-reference');
  let verifiedToken = null;

  async function request(method, path, options = {}) {
    const { sql, searchParams, allowHttpFailure = false } = options;
    const url = new URL(`${CLOUDFLARE_API_ORIGIN}${CLOUDFLARE_API_PREFIX}${path}`);
    if (url.origin !== CLOUDFLARE_API_ORIGIN || !url.pathname.startsWith(`${CLOUDFLARE_API_PREFIX}/`)) {
      throw new SafeCloudflareError('Cloudflare API origin is outside the fixed allowlist', 'HOST_REFUSED');
    }
    if (searchParams) for (const [key, value] of Object.entries(searchParams)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    validateSearchParams(url);
    const grantedToken = options[currentTokenDetailsGrant] === verifiedToken ? verifiedToken : null;
    const operation = classifyAllowedPath(method, url.pathname, {
      accountId,
      workerName,
      verifiedTokenId: grantedToken?.id ?? null,
      verifiedTokenType: grantedToken?.verificationType ?? null,
    });
    const evidencePath = operation === 'current token details'
      ? `${CLOUDFLARE_API_PREFIX}/user/tokens/{verified-current-token}`
      : operation === 'current account token details'
        ? `${CLOUDFLARE_API_PREFIX}/accounts/${accountId}/tokens/{verified-current-token}`
        : url.pathname;
    let body;
    if (method === 'POST') {
      const normalizedSql = assertReadOnlySelect(sql);
      if (selectTemplateValidator && selectTemplateValidator(normalizedSql) !== true) {
        throw new SafeCloudflareError('D1 SELECT is outside the collector-owned template allowlist', 'SQL_TEMPLATE_REFUSED');
      }
      body = JSON.stringify({ sql: normalizedSql });
    }
    else if (sql !== undefined) throw new SafeCloudflareError('SQL body is only valid for D1 POST query', 'METHOD_REFUSED');

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      requestLog.push({ operation, method, path: evidencePath, outcome: 'network-error' });
      throw new SafeCloudflareError(`Cloudflare ${operation} request failed before a trusted response`, 'NETWORK_FAILURE');
    }
    const requestRecord = {
      operation,
      method,
      path: evidencePath,
      status: response.status,
      outcome: 'response-received',
      success: false,
    };
    requestLog.push(requestRecord);
    const text = await boundedText(response);
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
      throw new SafeCloudflareError(`Cloudflare returned a non-JSON content type (HTTP ${response.status})`, 'RESPONSE_INVALID');
    }
    const envelope = parseEnvelope(text, response.status);
    requestRecord.success = response.ok && envelope.success === true;
    requestRecord.outcome = requestRecord.success ? 'accepted-envelope' : 'api-failure';
    if (!response.ok || envelope.success !== true) {
      if (allowHttpFailure) {
        const errorCodes = Array.isArray(envelope.errors)
          ? envelope.errors.map((entry) => entry?.code)
            .filter((code) => Number.isSafeInteger(code) && code >= 0)
            .slice(0, 10)
          : [];
        return { ok: false, status: response.status, errorCodes };
      }
      throw new SafeCloudflareError(`Cloudflare ${operation} request was refused (HTTP ${response.status})`, 'API_FAILURE');
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new SafeCloudflareError(`Cloudflare ${operation} response omitted its result`, 'RESPONSE_INVALID');
    }
    if (operation === 'D1 SELECT') {
      if (!Array.isArray(envelope.result) || envelope.result.length !== 1) {
        throw new SafeCloudflareError('D1 SELECT response must contain exactly one result', 'D1_RESULT_INVALID');
      }
      const inner = envelope.result[0];
      if (inner?.success !== true
        || typeof inner?.meta?.changes !== 'number' || inner.meta.changes !== 0
        || typeof inner?.meta?.rows_written !== 'number' || inner.meta.rows_written !== 0
        || !Array.isArray(inner?.results)) {
        throw new SafeCloudflareError('D1 SELECT response did not prove zero writes and zero changes', 'D1_MUTATION_PROOF_MISSING');
      }
    }
    const acceptedResponse = {
      ok: true,
      result: envelope.result,
      resultInfo: envelope.result_info ?? null,
      status: response.status,
    };
    Object.defineProperty(acceptedResponse, requestRecordReference, { value: requestRecord });
    return acceptedResponse;
  }

  function attachPaginationEvidence(response, { mode, ordinal, resultCount }) {
    const requestRecord = response?.[requestRecordReference];
    if (!requestRecord || !requestLog.includes(requestRecord) || Object.hasOwn(requestRecord, 'pagination')
      || !['single', 'page', 'cursor'].includes(mode)
      || !Number.isSafeInteger(ordinal) || ordinal < 1
      || !Number.isSafeInteger(resultCount) || resultCount < 0) {
      throw new SafeCloudflareError('Cloudflare pagination evidence could not be attached safely', 'PAGINATION_EVIDENCE_INVALID');
    }
    requestRecord.pagination = { mode, ordinal, resultCount };
  }

  async function singlePage(path, { requireComplete = false } = {}) {
    const response = await request('GET', path);
    const items = resultItems(response.result);
    attachPaginationEvidence(response, { mode: 'single', ordinal: 1, resultCount: items.length });
    if (requireComplete) {
      const declaredCount = Number(response.resultInfo?.count ?? items.length);
      const declaredTotal = Number(response.resultInfo?.total_count ?? response.resultInfo?.totalCount ?? declaredCount);
      if (!Number.isSafeInteger(declaredCount) || !Number.isSafeInteger(declaredTotal)
        || declaredCount !== items.length || declaredTotal !== items.length) {
        throw new SafeCloudflareError('single-page Cloudflare response declared incomplete results', 'INCOMPLETE_SINGLE_PAGE');
      }
    }
    return items;
  }

  async function pagedList(path, { requireCompleteMetadata = false } = {}) {
    const all = [];
    let page = 1;
    let expectedTotalCount = null;
    let expectedTotalPages = null;
    for (let iteration = 0; iteration < MAX_PAGES; iteration += 1) {
      const response = await request('GET', path, { searchParams: { page, per_page: 100 } });
      const items = resultItems(response.result);
      attachPaginationEvidence(response, { mode: 'page', ordinal: page, resultCount: items.length });
      all.push(...items);
      const strictTotalPagesValue = response.resultInfo?.total_pages ?? response.resultInfo?.totalPages;
      if (requireCompleteMetadata
        && (!response.resultInfo || typeof response.resultInfo !== 'object' || Array.isArray(response.resultInfo)
          || typeof response.resultInfo.page !== 'number' || !Number.isSafeInteger(response.resultInfo.page)
          || typeof response.resultInfo.count !== 'number' || !Number.isSafeInteger(response.resultInfo.count)
          || typeof response.resultInfo.total_count !== 'number' || !Number.isSafeInteger(response.resultInfo.total_count)
          || (strictTotalPagesValue !== undefined
            && (typeof strictTotalPagesValue !== 'number' || !Number.isSafeInteger(strictTotalPagesValue))))) {
        throw new SafeCloudflareError('Cloudflare paged list omitted valid completeness metadata', 'PAGINATION_REFUSED');
      }
      const totalPagesValue = strictTotalPagesValue;
      const totalCountValue = response.resultInfo?.total_count ?? response.resultInfo?.totalCount;
      const reportedPageValue = response.resultInfo?.page;
      const reportedCountValue = response.resultInfo?.count;
      if (reportedPageValue !== undefined && Number(reportedPageValue) !== page) {
        throw new SafeCloudflareError('Cloudflare pagination reported an unexpected page', 'PAGINATION_REFUSED');
      }
      if (reportedCountValue !== undefined
        && (!Number.isSafeInteger(Number(reportedCountValue)) || Number(reportedCountValue) !== items.length)) {
        throw new SafeCloudflareError('Cloudflare pagination item count was inconsistent', 'PAGINATION_REFUSED');
      }
      const totalCount = totalCountValue === undefined ? null : Number(totalCountValue);
      if (totalCount !== null && (!Number.isSafeInteger(totalCount) || totalCount < 0 || all.length > totalCount)) {
        throw new SafeCloudflareError('Cloudflare pagination total count was inconsistent', 'PAGINATION_REFUSED');
      }
      if (requireCompleteMetadata) {
        const normalizedTotalPages = totalPagesValue === undefined ? null : Number(totalPagesValue);
        if (expectedTotalCount === null) {
          expectedTotalCount = totalCount;
          expectedTotalPages = normalizedTotalPages;
        } else if (totalCount !== expectedTotalCount || normalizedTotalPages !== expectedTotalPages) {
          throw new SafeCloudflareError('Cloudflare pagination totals changed between pages', 'PAGINATION_REFUSED');
        }
      }
      if (totalPagesValue !== undefined) {
        const totalPages = Number(totalPagesValue);
        if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES) {
          throw new SafeCloudflareError('Cloudflare pagination metadata exceeded the safe bound', 'PAGINATION_REFUSED');
        }
        if (page > totalPages) {
          throw new SafeCloudflareError('Cloudflare pagination page and total pages were inconsistent', 'PAGINATION_REFUSED');
        }
        if (requireCompleteMetadata && page < totalPages && totalCount !== null && all.length >= totalCount) {
          throw new SafeCloudflareError('Cloudflare pagination page and total pages were inconsistent', 'PAGINATION_REFUSED');
        }
        if (page >= totalPages) {
          if (totalCount !== null && all.length !== totalCount) {
            throw new SafeCloudflareError('Cloudflare pagination ended before its declared total', 'PAGINATION_REFUSED');
          }
          return all;
        }
        if (items.length === 0) throw new SafeCloudflareError('Cloudflare pagination ended before its declared total', 'PAGINATION_REFUSED');
      } else if (totalCountValue !== undefined) {
        if (all.length >= totalCount) return all;
        if (items.length === 0) throw new SafeCloudflareError('Cloudflare pagination ended before its declared total', 'PAGINATION_REFUSED');
      } else {
        return all;
      }
      page += 1;
    }
    throw new SafeCloudflareError('Cloudflare pagination exceeded the safe page bound', 'PAGINATION_REFUSED');
  }

  async function cursorList(path) {
    const all = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let iteration = 0; iteration < MAX_PAGES; iteration += 1) {
      const response = await request('GET', path, { searchParams: cursor ? { cursor } : undefined });
      const items = resultItems(response.result);
      attachPaginationEvidence(response, { mode: 'cursor', ordinal: iteration + 1, resultCount: items.length });
      all.push(...items);
      const nextCursor = response.result?.cursor ?? response.resultInfo?.cursor ?? null;
      if (!nextCursor) return all;
      if (typeof nextCursor !== 'string' || seenCursors.has(nextCursor)) {
        throw new SafeCloudflareError('Cloudflare pagination metadata exceeded the safe bound', 'PAGINATION_REFUSED');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new SafeCloudflareError('Cloudflare pagination exceeded the safe page bound', 'PAGINATION_REFUSED');
  }

  async function list(path) {
    // Cloudflare's Workers Scripts list is an official SinglePage response: no page params or result_info required.
    if (path.endsWith('/workers/scripts')) return singlePage(path, { requireComplete: true });
    if (path.endsWith('/r2/buckets')) return cursorList(path);
    return pagedList(path, { requireCompleteMetadata: true });
  }

  function verifiedResult(result, verificationType) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.id !== 'string' || !CLOUDFLARE_IDENTIFIER.test(result.id)
      || typeof result.status !== 'string') {
      throw new SafeCloudflareError('Cloudflare token verification response was malformed', 'TOKEN_VERIFY_INVALID');
    }
    if (result.status !== 'active') return { active: false, verificationType };
    verifiedToken = { id: result.id, verificationType };
    return { active: true, verificationType };
  }

  async function verifyCurrentToken() {
    verifiedToken = null;
    const user = await request('GET', '/user/tokens/verify', { allowHttpFailure: true });
    if (user.ok) return verifiedResult(user.result, 'user-token');
    const account = await request('GET', `/accounts/${accountId}/tokens/verify`, { allowHttpFailure: true });
    if (!account.ok) throw new SafeCloudflareError('Cloudflare API token verification was refused', 'TOKEN_INVALID');
    return verifiedResult(account.result, 'account-token');
  }

  async function verifyToken() {
    try {
      return await verifyCurrentToken();
    } finally {
      verifiedToken = null;
    }
  }

  async function inspectCurrentTokenScope() {
    const verification = await verifyCurrentToken();
    if (!verification.active || !verifiedToken) {
      verifiedToken = null;
      throw new SafeCloudflareError('Cloudflare API token is not active', 'TOKEN_INACTIVE');
    }
    const tokenReference = verifiedToken;
    const detailsPath = tokenReference.verificationType === 'user-token'
      ? `/user/tokens/${tokenReference.id}`
      : `/accounts/${accountId}/tokens/${tokenReference.id}`;
    try {
      const details = await request('GET', detailsPath, { [currentTokenDetailsGrant]: tokenReference });
      return {
        ...verification,
        ...classifyCurrentTokenPolicies(details.result, {
          expectedTokenId: tokenReference.id,
          accountId,
        }),
      };
    } finally {
      verifiedToken = null;
    }
  }

  return {
    request,
    list,
    singlePage,
    verifyToken,
    inspectCurrentTokenScope,
    requestLog,
    accountId,
    workerName,
  };
}
