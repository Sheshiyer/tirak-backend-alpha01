import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHostedPins,
  createCallBudget,
  createCloudflareResourceAdapters,
  loadParentRunJourney,
  openHostedWebSocket,
  resolveDispatchRequest,
  sanitizeHostedProof,
  writeOperatorCredentials,
} from './adapter.mjs';
import { HOSTED_RUNTIME } from './constants.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

class MockWs extends EventEmitter {
  constructor(url, _protocols, options) {
    super();
    this.url = url;
    this.options = options;
    this.closed = null;
    this.terminated = false;
    MockWs.instances.push(this);
  }

  close(code, reason) {
    this.closed = { code, reason };
  }

  terminate() {
    this.terminated = true;
  }

  send() {}
}

MockWs.instances = [];

function createIncomingMessageLikeResponse({ statusCode, headers, chunks }) {
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}

describe('assertHostedPins', () => {
  it('accepts the exact pinned hosted QA configuration shape', () => {
    const summary = assertHostedPins({
      name: HOSTED_RUNTIME.workerName,
      account_id: HOSTED_RUNTIME.accountId,
      workers_dev: true,
      preview_urls: false,
      d1_databases: [{ database_id: HOSTED_RUNTIME.d1DatabaseId, database_name: HOSTED_RUNTIME.d1DatabaseName }],
      r2_buckets: [{ bucket_name: HOSTED_RUNTIME.r2BucketName }],
      kv_namespaces: [{ binding: HOSTED_RUNTIME.cacheBinding, id: HOSTED_RUNTIME.cacheNamespaceId }],
      vars: {
        ENVIRONMENT: HOSTED_RUNTIME.environment,
        CORE_QA_MODE: HOSTED_RUNTIME.qaMode,
        PAYMENT_MODE: HOSTED_RUNTIME.paymentMode,
        PROMPTPAY_ENABLED: HOSTED_RUNTIME.promptPayEnabled,
        PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: HOSTED_RUNTIME.paymentProductionPolicyWritesEnabled,
        PUBLIC_ASSET_BASE_URL: HOSTED_RUNTIME.publicAssetBaseUrl,
        FRONTEND_URLS: `${HOSTED_RUNTIME.websiteOrigin},${HOSTED_RUNTIME.adminOrigin}`,
      },
    });

    expect(summary.accountId).toBe(HOSTED_RUNTIME.accountId);
    expect(summary.qaMode).toBe('cohort');
  });

  it('fails closed on a pin mismatch', () => {
    expect(() => assertHostedPins({
      name: HOSTED_RUNTIME.workerName,
      account_id: 'wrong',
      workers_dev: true,
      preview_urls: false,
      d1_databases: [{ database_id: HOSTED_RUNTIME.d1DatabaseId, database_name: HOSTED_RUNTIME.d1DatabaseName }],
      r2_buckets: [{ bucket_name: HOSTED_RUNTIME.r2BucketName }],
      kv_namespaces: [{ binding: HOSTED_RUNTIME.cacheBinding, id: HOSTED_RUNTIME.cacheNamespaceId }],
      vars: {
        ENVIRONMENT: HOSTED_RUNTIME.environment,
        CORE_QA_MODE: HOSTED_RUNTIME.qaMode,
        PAYMENT_MODE: HOSTED_RUNTIME.paymentMode,
        PROMPTPAY_ENABLED: HOSTED_RUNTIME.promptPayEnabled,
        PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED: HOSTED_RUNTIME.paymentProductionPolicyWritesEnabled,
        PUBLIC_ASSET_BASE_URL: HOSTED_RUNTIME.publicAssetBaseUrl,
        FRONTEND_URLS: `${HOSTED_RUNTIME.websiteOrigin},${HOSTED_RUNTIME.adminOrigin}`,
      },
    })).toThrow(/pin check failed/i);
  });
});

describe('resolveDispatchRequest', () => {
  it('rewrites local.test requests to the exact hosted worker and injects website origin', () => {
    const resolved = resolveDispatchRequest('http://local.test/api/bookings?page=2', { method: 'GET' });
    expect(resolved.targetUrl).toBe(`${HOSTED_RUNTIME.workerUrl}/api/bookings?page=2`);
    expect(resolved.headers.get('Origin')).toBe(HOSTED_RUNTIME.websiteOrigin);
    expect(resolved.redirect).toBe('manual');
  });

  it('uses the admin origin for admin paths', () => {
    const resolved = resolveDispatchRequest('http://local.test/api/admin/operations/bookings?mode=tirak', { method: 'GET' });
    expect(resolved.headers.get('Origin')).toBe(HOSTED_RUNTIME.adminOrigin);
  });

  it('does not inherit Authorization when none was supplied', () => {
    const resolved = resolveDispatchRequest(
      'http://local.test/api/chat/rooms/room-1/ws?ticket=single-use-ticket',
      { headers: { Upgrade: 'websocket' } },
    );
    expect(resolved.headers.get('Authorization')).toBeNull();
  });
});

describe('createCallBudget', () => {
  it('fails when the call budget is exceeded', () => {
    const budget = createCallBudget({ maxCalls: 1, overallTimeoutMs: 60_000 });
    budget.note('one');
    expect(() => budget.note('two')).toThrow(/call budget/i);
  });

  it('defaults to the shared 512 call ceiling', () => {
    const budget = createCallBudget();
    expect(budget.snapshot().maxCalls).toBe(512);
  });
});

describe('loadParentRunJourney', () => {
  it('fails closed when the parent module does not export runJourney', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hosted-parent-export-'));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, 'parent.mjs'), 'export const nope = true;\n', 'utf8');

    await expect(loadParentRunJourney(tempDir, { ...HOSTED_RUNTIME, localRuntimeModulePath: './parent.mjs' })).rejects.toMatchObject({
      code: 'RUN_JOURNEY_EXPORT_MISSING',
    });
  });
});

describe('sanitizeHostedProof', () => {
  it('removes raw token fields from proof output', () => {
    const sanitized = sanitizeHostedProof({
      oauth: { token: 'secret', tokenLoaded: true },
      privateArtifacts: { operatorCredentialsPath: '/tmp/private.json', operatorCredentialsWritten: true },
    });
    expect(sanitized.oauth.token).toBeUndefined();
    expect(sanitized.privateArtifacts.operatorCredentialsPath).toBeUndefined();
    expect(sanitized.privateArtifacts.operatorCredentialsWritten).toBe(true);
  });
});

describe('writeOperatorCredentials', () => {
  it('persists only guide traveler and admin credentials', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hosted-credentials-'));
    tempDirs.push(tempDir);

    const filePath = await writeOperatorCredentials(tempDir, {
      adminPassword: 'admin-secret',
      travelerPassword: 'traveler-secret',
      ordinaryPassword: 'ordinary-secret',
      guidePassword: 'guide-secret',
    });

    const written = JSON.parse(await readFile(filePath, 'utf8'));
    expect(Object.keys(written.operators).sort()).toEqual(['admin', 'guide', 'traveler']);
  });
});

describe('openHostedWebSocket', () => {
  it('bridges a successful 101 ticket-only websocket upgrade', async () => {
    const hosted = { ...HOSTED_RUNTIME, workerUrl: 'ws://qa.example.test' };
    const budget = createCallBudget({ maxCalls: 10, overallTimeoutMs: 60_000 });
    const pending = openHostedWebSocket(
      'http://local.test/api/chat/rooms/room-1/ws?ticket=single-use-ticket',
      { headers: { Upgrade: 'websocket' } },
      { callBudget: budget, hosted, WebSocketCtor: MockWs },
    );

    const ws = MockWs.instances.pop();
    expect(ws.url).toBe('ws://qa.example.test/api/chat/rooms/room-1/ws?ticket=single-use-ticket');
    expect(ws.options.headers.origin).toBe(HOSTED_RUNTIME.websiteOrigin);
    expect(ws.options.headers.authorization).toBeUndefined();
    ws.emit('open');

    const response = await pending;
    const deferredErrors = [];
    response.webSocket.addEventListener('error', (event) => {
      deferredErrors.push(event.error?.message || String(event.error));
    });

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    expect(typeof response.webSocket.accept).toBe('function');
    expect(typeof response.webSocket.addEventListener).toBe('function');
    expect(typeof response.webSocket.close).toBe('function');
    ws.emit('error', new Error('deferred transport issue'));
    expect(deferredErrors).toEqual(['deferred transport issue']);
    response.webSocket.close(1000, 'complete');
    expect(ws.closed).toEqual({ code: 1000, reason: 'complete' });
    expect(budget.snapshot().usedCalls).toBe(1);
  });

  it('returns sanitized unexpected-response details for replayed ticket 401 and tolerates delayed ws errors', async () => {
    const hosted = { ...HOSTED_RUNTIME, workerUrl: 'ws://qa.example.test' };
    const pending = openHostedWebSocket(
      'http://local.test/api/chat/rooms/room-1/ws?ticket=raw-secret-ticket',
      { headers: { Upgrade: 'websocket' } },
      { callBudget: createCallBudget({ maxCalls: 10, overallTimeoutMs: 60_000 }), hosted, WebSocketCtor: MockWs },
    );

    const ws = MockWs.instances.pop();
    const responseStream = createIncomingMessageLikeResponse({
      statusCode: 401,
      headers: { 'content-type': 'text/plain' },
      chunks: [
        'ticket replay denied for /api/chat/rooms/room-1/ws?',
        'ticket=raw-secret-ticket',
      ],
    });
    ws.emit('unexpected-response', {}, responseStream);
    expect(() => ws.emit('error', new Error('Opening handshake timed out'))).not.toThrow();

    const response = await pending;

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('ticket=<redacted>');
    expect(await response.text()).not.toContain('raw-secret-ticket');
    expect(response.sanitizedBody).toContain('ticket=<redacted>');
    expect(response.sanitizedBody).not.toContain('raw-secret-ticket');
    expect(ws.terminated).toBe(true);
  });

  it('rejects Authorization-bearing websocket upgrades', async () => {
    const hosted = { ...HOSTED_RUNTIME, workerUrl: 'ws://127.0.0.1:6553' };
    await expect(openHostedWebSocket(
      'http://local.test/api/chat/rooms/room-1/ws?ticket=single-use-ticket',
      { headers: { Upgrade: 'websocket', Authorization: 'Bearer inherited' } },
      { callBudget: createCallBudget({ maxCalls: 10, overallTimeoutMs: 60_000 }), hosted, WebSocketCtor: MockWs },
    )).rejects.toThrow(/Authorization headers/i);
  });
});

describe('createCloudflareResourceAdapters', () => {
  it('allows KV delete only for ratelimit fixture keys', async () => {
    const calls = [];
    const { kv } = createCloudflareResourceAdapters({
      token: 'oauth-token',
      callBudget: createCallBudget({ maxCalls: 10, overallTimeoutMs: 60_000 }),
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        return new Response('', { status: 200 });
      },
    });

    await kv.delete('ratelimit:fixture-key');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/storage/kv/namespaces/');

    await expect(kv.delete('reset:forbidden-key')).rejects.toThrow(/ratelimit: fixture keys only/i);
  });
});
