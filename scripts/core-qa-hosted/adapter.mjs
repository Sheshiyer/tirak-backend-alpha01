import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  HOSTED_RUNTIME,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  SYNTHETIC_IDENTITIES,
} from './constants.mjs';
import { readOAuthToml, readWranglerToml } from './python-toml.mjs';

function syntheticSecret(label) {
  return `${label}_${randomBytes(18).toString('base64url')}`;
}

function sanitizeError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'unknown error'),
    code: error?.code || null,
  };
}

function sanitizePreview(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

function isWebSocketUpgrade(headers) {
  return String(headers.get('upgrade') || '').toLowerCase() === 'websocket';
}

function isPinnedSocketPath(pathname, hosted = HOSTED_RUNTIME) {
  return hosted.socketPathPattern.test(pathname);
}

function createWebSocketFacade(socket) {
  const listeners = new Map();
  const add = (type, handler) => {
    if (typeof handler !== 'function') return;
    const key = String(type);
    let bucket = listeners.get(key);
    if (!bucket) {
      bucket = new Set();
      listeners.set(key, bucket);
    }
    bucket.add(handler);
  };
  const remove = (type, handler) => {
    listeners.get(String(type))?.delete(handler);
  };
  const emit = (type, event) => {
    for (const handler of listeners.get(type) || []) {
      try {
        handler(event);
      } catch {}
    }
  };

  socket.on('message', (data, isBinary) => {
    emit('message', { data: isBinary ? data : data.toString('utf8') });
  });
  socket.on('close', (code, reasonBuffer) => {
    emit('close', { code, reason: Buffer.from(reasonBuffer || '').toString('utf8') });
  });
  socket.on('error', (error) => {
    emit('error', { error });
  });
  socket.on('open', () => {
    emit('open', { type: 'open' });
  });

  return {
    accept() {},
    addEventListener(type, handler) {
      add(type, handler);
    },
    removeEventListener(type, handler) {
      remove(type, handler);
    },
    close(code = 1000, reason = '') {
      try {
        socket.close(code, String(reason));
      } catch {
        socket.terminate();
      }
    },
    send(data) {
      socket.send(data);
    },
  };
}

function isAdminLikePath(pathname) {
  return pathname.startsWith('/api/admin/') || pathname.startsWith('/auth/');
}

function sanitizeResponseForProof(response, bodyText) {
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    headers: {
      'cache-control': response.headers.get('cache-control'),
      'x-tirak-qa-environment': response.headers.get('x-tirak-qa-environment'),
      'x-tirak-qa-mode': response.headers.get('x-tirak-qa-mode'),
      'content-type': response.headers.get('content-type'),
    },
    body: json
      ? {
          success: json.success ?? null,
          error: json.error ?? null,
          message: json.message ?? null,
          keys: json.data && typeof json.data === 'object' ? Object.keys(json.data).slice(0, 12) : [],
        }
      : { preview: sanitizePreview(bodyText) },
  };
}

function unpackCloudflareResult(payload) {
  if (!payload || payload.success !== true) {
    throw new Error(`Cloudflare API request failed: ${sanitizePreview(payload?.errors?.[0]?.message || payload?.messages?.[0]?.message || 'unknown error')}`);
  }
  return payload.result;
}

function unpackD1Payload(payload) {
  const result = unpackCloudflareResult(payload);
  if (Array.isArray(result)) {
    return result[0] || { results: [] };
  }
  if (result && typeof result === 'object' && Array.isArray(result.results)) {
    return result;
  }
  return { results: [], meta: result?.meta || null, success: true };
}

function normalizeD1Value(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function createCallBudget({ maxCalls = HOSTED_RUNTIME.maxCallCount, overallTimeoutMs = HOSTED_RUNTIME.overallTimeoutMs } = {}) {
  const startedAt = Date.now();
  let count = 0;
  return {
    note(label) {
      if (Date.now() - startedAt > overallTimeoutMs) {
        const error = new Error(`Hosted runtime exceeded overall timeout of ${overallTimeoutMs}ms`);
        error.code = 'OVERALL_TIMEOUT';
        throw error;
      }
      count += 1;
      if (count > maxCalls) {
        const error = new Error(`Hosted runtime exceeded call budget of ${maxCalls} while attempting ${label}`);
        error.code = 'CALL_BUDGET_EXCEEDED';
        throw error;
      }
      return count;
    },
    snapshot() {
      return {
        maxCalls,
        usedCalls: count,
        remainingCalls: Math.max(0, maxCalls - count),
        elapsedMs: Date.now() - startedAt,
        overallTimeoutMs,
      };
    },
  };
}

export function resolveDispatchRequest(input, init = {}, hosted = HOSTED_RUNTIME) {
  const original = input instanceof Request ? input.url : String(input);
  const source = new URL(original);
  if (source.origin !== 'http://local.test') {
    throw new Error(`Hosted worker adapter only accepts local.test requests, received ${source.origin}`);
  }
  const target = new URL(`${source.pathname}${source.search}`, hosted.workerUrl);
  const headers = new Headers(input instanceof Request ? input.headers : init.headers || {});
  if (!headers.has('Origin')) {
    headers.set('Origin', isAdminLikePath(source.pathname) ? hosted.adminOrigin : hosted.websiteOrigin);
  }
  return {
    targetUrl: target.toString(),
    method: init.method || (input instanceof Request ? input.method : 'GET'),
    headers,
    redirect: 'manual',
    body: init.body,
  };
}

function sanitizeBodyPreview(text) {
  return sanitizePreview(String(text || '').replace(/ticket=[^&\s"']+/gi, 'ticket=<redacted>'));
}

async function consumeResponseText(response) {
  if (!response) return '';
  if (typeof response.text === 'function') return response.text();
  if (response.body === undefined || response.body === null) return '';
  return String(response.body);
}

export async function openHostedWebSocket(input, init = {}, { callBudget, hosted = HOSTED_RUNTIME, WebSocketCtor = WebSocket } = {}) {
  const resolved = resolveDispatchRequest(input, init, hosted);
  const source = new URL(input instanceof Request ? input.url : String(input));
  if (!isPinnedSocketPath(source.pathname, hosted)) {
    throw new Error(`Hosted worker adapter only supports ticket websocket upgrade on pinned QA chat path, received ${source.pathname}`);
  }
  if (!isWebSocketUpgrade(resolved.headers)) {
    throw new Error('Hosted worker adapter websocket bridge requires Upgrade: websocket');
  }
  if (resolved.headers.has('authorization')) {
    throw new Error('Hosted worker adapter websocket bridge rejects inherited Authorization headers');
  }

  callBudget.note(resolved.targetUrl);

  return await new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(resolved.targetUrl, [], {
      followRedirects: false,
      headers: Object.fromEntries(resolved.headers.entries()),
      handshakeTimeout: hosted.perCallTimeoutMs,
      perMessageDeflate: false,
    });

    const settle = (fn, value) => {
      cleanup();
      fn(value);
    };
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('unexpected-response');
      ws.removeAllListeners('error');
    };

    ws.once('open', () => {
      settle(resolve, {
        status: 101,
        ok: true,
        headers: new Headers(),
        webSocket: createWebSocketFacade(ws),
      });
    });

    ws.once('unexpected-response', async (_request, response) => {
      const body = await consumeResponseText(response);
      settle(resolve, {
        status: response.statusCode || 500,
        ok: false,
        headers: new Headers(response.headers || {}),
        text: async () => body,
        bodyUsed: false,
        sanitizedBody: sanitizeBodyPreview(body),
      });
    });

    ws.once('error', (error) => {
      const wrapped = new Error(`Hosted websocket bridge failed: ${sanitizePreview(error?.message || error)}`);
      wrapped.code = error?.code || 'HOSTED_WEBSOCKET_FAILED';
      settle(reject, wrapped);
    });
  });
}

export function assertHostedPins(config, hosted = HOSTED_RUNTIME) {
  const vars = config.vars || {};
  const d1 = Array.isArray(config.d1_databases) ? config.d1_databases[0] : null;
  const r2 = Array.isArray(config.r2_buckets) ? config.r2_buckets[0] : null;
  const cache = Array.isArray(config.kv_namespaces)
    ? config.kv_namespaces.find((entry) => entry.binding === hosted.cacheBinding)
    : null;

  const mismatches = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(`${label} expected ${expected}, got ${actual}`);
  };

  expect('name', config.name, hosted.workerName);
  expect('account_id', config.account_id, hosted.accountId);
  expect('workers_dev', config.workers_dev, true);
  expect('preview_urls', config.preview_urls, false);
  expect('d1 database_id', d1?.database_id, hosted.d1DatabaseId);
  expect('d1 database_name', d1?.database_name, hosted.d1DatabaseName);
  expect('r2 bucket_name', r2?.bucket_name, hosted.r2BucketName);
  expect('cache namespace id', cache?.id, hosted.cacheNamespaceId);
  expect('vars.ENVIRONMENT', vars.ENVIRONMENT, hosted.environment);
  expect('vars.CORE_QA_MODE', vars.CORE_QA_MODE, hosted.qaMode);
  expect('vars.PAYMENT_MODE', vars.PAYMENT_MODE, hosted.paymentMode);
  expect('vars.PROMPTPAY_ENABLED', vars.PROMPTPAY_ENABLED, hosted.promptPayEnabled);
  expect(
    'vars.PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED',
    vars.PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED,
    hosted.paymentProductionPolicyWritesEnabled,
  );
  expect('vars.PUBLIC_ASSET_BASE_URL', vars.PUBLIC_ASSET_BASE_URL, hosted.publicAssetBaseUrl);

  const frontendUrls = String(vars.FRONTEND_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!frontendUrls.includes(hosted.websiteOrigin) || !frontendUrls.includes(hosted.adminOrigin)) {
    mismatches.push('vars.FRONTEND_URLS missing exact QA website/admin origins');
  }

  if (mismatches.length > 0) {
    throw new Error(`Hosted QA pin check failed: ${mismatches.join('; ')}`);
  }

  return {
    workerName: config.name,
    accountId: config.account_id,
    d1DatabaseId: d1.database_id,
    r2BucketName: r2.bucket_name,
    cacheNamespaceId: cache.id,
    paymentMode: vars.PAYMENT_MODE,
    promptPayEnabled: vars.PROMPTPAY_ENABLED,
    qaMode: vars.CORE_QA_MODE,
  };
}

export async function loadPinnedHostedConfig(repoRoot, hosted = HOSTED_RUNTIME) {
  const filePath = path.join(repoRoot, hosted.wranglerConfigPath);
  const parsed = await readWranglerToml(filePath);
  return assertHostedPins(parsed, hosted);
}

export async function loadWranglerOAuthToken(hosted = HOSTED_RUNTIME) {
  const parsed = await readOAuthToml(hosted.oauthConfigPath);
  const token = String(parsed?.oauth_token || '').trim();
  if (!token) {
    throw new Error(`Wrangler OAuth token missing in ${hosted.oauthConfigPath}`);
  }
  return {
    token,
    expirationTime: parsed?.expiration_time || null,
    scopes: Array.isArray(parsed?.scopes) ? parsed.scopes.map((value) => String(value)) : [],
  };
}

export function createCloudflareFetch({ token, callBudget, perCallTimeoutMs = HOSTED_RUNTIME.perCallTimeoutMs, fetchImpl = fetch }) {
  return async function cloudflareFetch(url, init = {}) {
    callBudget.note(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`Timed out after ${perCallTimeoutMs}ms`)), perCallTimeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

export function createCloudflareResourceAdapters({ token, callBudget, hosted = HOSTED_RUNTIME, fetchImpl = fetch }) {
  const cloudflareFetch = createCloudflareFetch({ token, callBudget, fetchImpl, perCallTimeoutMs: hosted.perCallTimeoutMs });
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${hosted.accountId}`;

  async function apiJson(url, init = {}) {
    const response = await cloudflareFetch(url, init);
    const { json, text } = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Cloudflare API HTTP ${response.status}: ${sanitizePreview(text)}`);
    }
    return json;
  }

  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return createD1Statement(sql, params);
        },
        run() {
          return createD1Statement(sql, []).run();
        },
        first() {
          return createD1Statement(sql, []).first();
        },
        all() {
          return createD1Statement(sql, []).all();
        },
      };
    },
  };

  function createD1Statement(sql, params) {
    const body = JSON.stringify({ sql, params: params.map(normalizeD1Value) });
    const endpoint = `${apiBase}/d1/database/${hosted.d1DatabaseId}/query`;

    return {
      async run() {
        const payload = await apiJson(endpoint, { method: 'POST', headers: jsonHeaders(), body });
        const result = unpackD1Payload(payload);
        return {
          success: result.success !== false,
          results: Array.isArray(result.results) ? result.results : [],
          meta: result.meta || null,
        };
      },
      async first() {
        const result = await this.run();
        return result.results[0] || null;
      },
      async all() {
        return this.run();
      },
    };
  }

  const kv = {
    async list({ prefix = '' } = {}) {
      const url = new URL(`${apiBase}/storage/kv/namespaces/${hosted.cacheNamespaceId}/keys`);
      if (prefix) url.searchParams.set('prefix', prefix);
      const payload = await apiJson(url.toString());
      const result = unpackCloudflareResult(payload);
      return { keys: Array.isArray(result) ? result : result?.result || result?.keys || [] };
    },
    async get(key) {
      const response = await cloudflareFetch(
        `${apiBase}/storage/kv/namespaces/${hosted.cacheNamespaceId}/values/${encodeURIComponent(key)}`,
        { method: 'GET' },
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`KV get failed with HTTP ${response.status}: ${sanitizePreview(text)}`);
      }
      return response.text();
    },
    async delete(key) {
      if (!String(key).startsWith('ratelimit:')) {
        throw new Error('Hosted KV delete is restricted to ratelimit: fixture keys only');
      }
      const response = await cloudflareFetch(
        `${apiBase}/storage/kv/namespaces/${hosted.cacheNamespaceId}/values/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
      if (response.status === 404) return;
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`KV delete failed with HTTP ${response.status}: ${sanitizePreview(text)}`);
      }
    },
  };

  const r2 = {
    async list({ prefix = '' } = {}) {
      const url = new URL(`${apiBase}/r2/buckets/${hosted.r2BucketName}/objects`);
      if (prefix) url.searchParams.set('prefix', prefix);
      const payload = await apiJson(url.toString());
      const result = unpackCloudflareResult(payload);
      const objects = Array.isArray(result?.objects) ? result.objects : Array.isArray(result) ? result : [];
      return {
        objects: objects.map((object) => ({
          key: object.key,
          size: object.size,
          httpEtag: object.httpEtag || null,
          uploaded: object.uploaded || null,
        })),
      };
    },
  };

  return { db, kv, r2, apiJson };
}

export function createHostedWorkerAdapter({ token, callBudget, hosted = HOSTED_RUNTIME, fetchImpl = fetch }) {
  const { db, kv, r2 } = createCloudflareResourceAdapters({ token, callBudget, hosted, fetchImpl });

  return {
    async dispatchFetch(input, init = {}) {
      const resolved = resolveDispatchRequest(input, init, hosted);
      if (isWebSocketUpgrade(resolved.headers)) {
        return openHostedWebSocket(input, init, { callBudget, hosted });
      }
      callBudget.note(resolved.targetUrl);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error(`Timed out after ${hosted.perCallTimeoutMs}ms`)), hosted.perCallTimeoutMs);
      try {
        return await fetchImpl(resolved.targetUrl, {
          method: resolved.method,
          headers: resolved.headers,
          body: resolved.body,
          redirect: resolved.redirect,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    },
    async getD1Database(binding) {
      if (binding !== hosted.d1Binding) throw new Error(`Unsupported D1 binding ${binding}`);
      return db;
    },
    async getKVNamespace(binding) {
      if (binding !== hosted.cacheBinding) throw new Error(`Unsupported KV binding ${binding}`);
      return kv;
    },
    async getR2Bucket(binding) {
      if (binding !== hosted.r2Binding) throw new Error(`Unsupported R2 binding ${binding}`);
      return r2;
    },
  };
}

export async function loadParentRunJourney(repoRoot, hosted = HOSTED_RUNTIME) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, hosted.localRuntimeModulePath)).href;
  const loaded = await import(moduleUrl);
  if (typeof loaded.runJourney !== 'function') {
    const error = new Error('Hosted QA adapter requires scripts/core-qa/run-local-runtime.mjs to export runJourney({ worker, secrets, proof }).');
    error.code = 'RUN_JOURNEY_EXPORT_MISSING';
    throw error;
  }
  return loaded.runJourney;
}

export async function createPrivateHostedRuntimeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tirak-core-qa-hosted-'));
  const privateDir = path.join(root, 'private');
  await mkdir(privateDir, { recursive: true });
  await chmod(privateDir, PRIVATE_DIR_MODE);
  return { root, privateDir };
}

export async function writePrivateJson(filePath, payload) {
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  await chmod(filePath, PRIVATE_FILE_MODE);
  return filePath;
}

export function createHostedSecrets() {
  return {
    adminPassword: syntheticSecret('qa_admin_password'),
    travelerPassword: syntheticSecret('qa_traveler_password'),
    ordinaryPassword: syntheticSecret('qa_ordinary_password'),
    guidePassword: syntheticSecret('qa_guide_password'),
    jwtSecret: syntheticSecret('qa_runtime_jwt_secret_unused'),
  };
}

export async function writeOperatorCredentials(privateDir, secrets, hosted = HOSTED_RUNTIME) {
  const payload = {
    workerUrl: hosted.workerUrl,
    environment: hosted.environment,
    generatedAt: new Date().toISOString(),
    operators: {
      admin: { email: SYNTHETIC_IDENTITIES.admin, password: secrets.adminPassword },
      traveler: { email: SYNTHETIC_IDENTITIES.traveler, password: secrets.travelerPassword },
      guide: { email: SYNTHETIC_IDENTITIES.guide, password: secrets.guidePassword },
    },
  };
  const filePath = path.join(privateDir, 'operator-credentials.json');
  await writePrivateJson(filePath, payload);
  return filePath;
}

export async function preflightHostedRuntime({ worker, proof, hosted = HOSTED_RUNTIME }) {
  const db = await worker.getD1Database(hosted.d1Binding);
  const healthResponse = await worker.dispatchFetch('http://local.test/health', { method: 'GET' });
  const healthText = await healthResponse.text();
  let healthJson = null;
  try {
    healthJson = healthText ? JSON.parse(healthText) : null;
  } catch {
    healthJson = null;
  }

  const health = {
    status: healthResponse.status,
    environment: healthJson?.environment || null,
    bodyStatus: healthJson?.status || null,
    paymentsDisabledConfigured: hosted.paymentMode === 'disabled' && hosted.promptPayEnabled === 'false',
  };

  if (health.status !== 200) {
    throw new Error(`Hosted health preflight failed with HTTP ${health.status}`);
  }
  if (health.environment !== hosted.environment || health.bodyStatus !== 'ok') {
    throw new Error(`Hosted health preflight returned unexpected body: ${sanitizePreview(JSON.stringify(health))}`);
  }

  const qaBoundaryProbe = await worker.dispatchFetch('http://local.test/api/companions?limit=1&page=1', { method: 'GET' });
  const qaBoundary = {
    status: qaBoundaryProbe.status,
    qaEnvironmentHeader: qaBoundaryProbe.headers.get('x-tirak-qa-environment'),
    qaModeHeader: qaBoundaryProbe.headers.get('x-tirak-qa-mode'),
    cacheControl: qaBoundaryProbe.headers.get('cache-control'),
  };

  if (qaBoundary.status !== 401) {
    throw new Error(`Hosted QA boundary preflight expected 401, got ${qaBoundary.status}`);
  }
  if (qaBoundary.qaEnvironmentHeader !== hosted.environment || qaBoundary.qaModeHeader !== hosted.qaMode) {
    throw new Error(`Hosted QA headers mismatch: ${sanitizePreview(JSON.stringify(qaBoundary))}`);
  }

  const tableRows = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'core_qa_accounts', 'supplier_onboarding_applications', 'interests') ORDER BY name ASC`,
  ).all();
  const tables = Array.isArray(tableRows.results) ? tableRows.results.map((row) => row.name) : [];
  const requiredTables = ['core_qa_accounts', 'interests', 'supplier_onboarding_applications', 'users'];
  for (const table of requiredTables) {
    if (!tables.includes(table)) {
      throw new Error(`Hosted database preflight missing required table ${table}`);
    }
  }

  const syntheticUserCountRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM users WHERE lower(email) IN (?, ?, ?, ?)',
  ).bind(
    SYNTHETIC_IDENTITIES.admin,
    SYNTHETIC_IDENTITIES.traveler,
    SYNTHETIC_IDENTITIES.ordinary,
    SYNTHETIC_IDENTITIES.futureTraveler,
  ).first();
  const syntheticApplicationCountRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM supplier_onboarding_applications WHERE lower(email) = ?',
  ).bind(SYNTHETIC_IDENTITIES.guide).first();
  const syntheticInterestCountRow = await db.prepare(
    'SELECT COUNT(*) AS total FROM interests WHERE lower(email) = ?',
  ).bind(SYNTHETIC_IDENTITIES.interest).first();
  const syntheticGuideMembershipRow = await db.prepare(
    `SELECT COUNT(*) AS total
       FROM core_qa_accounts qa
       JOIN users user ON user.id = qa.user_id
      WHERE lower(user.email) = ?`,
  ).bind(SYNTHETIC_IDENTITIES.guide).first();

  const syntheticFootprint = {
    users: Number(syntheticUserCountRow?.total || 0),
    applications: Number(syntheticApplicationCountRow?.total || 0),
    interests: Number(syntheticInterestCountRow?.total || 0),
    guideMemberships: Number(syntheticGuideMembershipRow?.total || 0),
  };

  if (Object.values(syntheticFootprint).some((value) => value > 0)) {
    throw new Error(`Hosted database preflight found existing synthetic QA data: ${sanitizePreview(JSON.stringify(syntheticFootprint))}`);
  }

  proof.preflight = {
    health,
    qaBoundary,
    tables,
    syntheticFootprint,
  };
}

export async function runHostedJourney({ repoRoot, proof, fetchImpl = fetch, hosted = HOSTED_RUNTIME }) {
  const pins = await loadPinnedHostedConfig(repoRoot, hosted);
  const oauth = await loadWranglerOAuthToken(hosted);
  const callBudget = createCallBudget({ maxCalls: hosted.maxCallCount, overallTimeoutMs: hosted.overallTimeoutMs });
  const worker = createHostedWorkerAdapter({ token: oauth.token, callBudget, hosted, fetchImpl });
  const runJourney = await loadParentRunJourney(repoRoot, hosted);
  const secrets = createHostedSecrets();
  const runtimeRoot = await createPrivateHostedRuntimeRoot();
  const operatorCredentialsPath = await writeOperatorCredentials(runtimeRoot.privateDir, secrets, hosted);
  proof.mode = 'hosted-remote';
  proof.pins = pins;
  proof.oauth = {
    configPath: hosted.oauthConfigPath,
    expirationTime: oauth.expirationTime,
    scopes: oauth.scopes,
    tokenLoaded: true,
  };
  proof.callBudget = callBudget.snapshot();
  proof.runtimeBudget = {
    maxNetworkCalls: hosted.maxCallCount,
    perCallTimeoutMs: hosted.perCallTimeoutMs,
    overallTimeoutMs: hosted.overallTimeoutMs,
  };

  try {
    await preflightHostedRuntime({ worker, proof, hosted });
    await runJourney({ worker, secrets, proof });
  } catch (error) {
    proof.ok = false;
    proof.error = sanitizeError(error);
    throw error;
  } finally {
    proof.callBudget = callBudget.snapshot();
    proof.privateArtifacts = {
      operatorCredentialsWritten: true,
      operatorCredentialsFile: path.basename(operatorCredentialsPath),
      tempRootBasename: path.basename(runtimeRoot.root),
    };
  }
}

export function sanitizeHostedProof(proof) {
  const clone = JSON.parse(JSON.stringify(proof || {}));
  delete clone.oauth?.token;
  delete clone.privateArtifacts?.operatorCredentialsPath;
  return clone;
}

export async function fetchForProof(url, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, init);
  const bodyText = await response.text();
  return sanitizeResponseForProof(response, bodyText);
}
