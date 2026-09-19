/** Local SQLite integration probe. No provider/network requests or real user data. */
import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from '../../src/routes/auth';
import { userRoutes } from '../../src/routes/users';
import { chatRoutes } from '../../src/routes/chat';
import { requestEmailVerification, verifyEmailCode } from '../../src/services/email-verification';
import { getAccountConsents, saveAccountConsents, ACCOUNT_POLICY_VERSION } from '../../src/services/account-consents';
import { userManagementRoutes } from '../../src/routes/admin/users';
import { analyticsRoutes } from '../../src/routes/admin/analytics';
import { ChatRoom } from '../../src/durable-objects/ChatRoom';

const sqlite = new Database(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(await Bun.file(new URL('../../migrations/baseline/canonical-baseline.sql', import.meta.url)).text());
// Rehearse the isolated non-payment compatibility candidate; these columns are
// absent from the frozen baseline. Target introspection remains a release gate.
sqlite.exec(await Bun.file(new URL('../fixtures/016_customer_registration_fields.sql', import.meta.url)).text());
sqlite.exec(await Bun.file(new URL('../../migrations/010_booking_chat_expansion.sql', import.meta.url)).text());
const migration = await Bun.file(new URL('../../migrations/015_account_trust.sql', import.meta.url)).text();
sqlite.exec(migration);
sqlite.exec(migration); // Additive migration is safe to reapply locally.
const database = {
  prepare(sql: string) {
    const statement = (values: unknown[] = []) => ({
      bind: (...params: unknown[]) => statement(params),
      first: async () => sqlite.query(sql).get(...values as never[]) ?? null,
      all: async () => ({ results: sqlite.query(sql).all(...values as never[]), success: true }),
      execute: () => ({ success: true, meta: { changes: sqlite.query(sql).run(...values as never[]).changes } }),
      run: async () => statement(values).execute(),
    });
    return statement();
  },
  batch: async (statements: Array<{ execute(): unknown }>) => sqlite.transaction(() => statements.map(s => s.execute()))(),
};
const cache = new Map<string, string>();
const sent: Array<{ html?: string }> = [];
const env: any = {
  DB: database, JWT_SECRET: 'local-integration-secret-not-for-deployment', ENVIRONMENT: 'test',
  CACHE: { get: async (key: string) => cache.get(key) ?? null, put: async (key: string, value: string) => { cache.set(key, value); }, delete: async (key: string) => { cache.delete(key); } },
  SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
  ANALYTICS_QUEUE: { send: async () => {} },
  EMAIL_FROM: 'noreply@example.test',
  EMAIL: { send: async (mail: { html?: string }) => { sent.push(mail); return { messageId: 'local-only' }; } },
  FRONTEND_URLS: 'http://127.0.0.1:4178,http://localhost:8082,http://127.0.0.1:8082',
};
const rooms = new Map<string, ChatRoom>();
env.CHAT_ROOM = { idFromName: (id: string) => id, get: (id: string) => ({
  fetch: (url: string, init: RequestInit) => {
    if (!rooms.has(id)) rooms.set(id, new ChatRoom({ id: { toString: () => id } } as never, env));
    return rooms.get(id)!.fetch(new Request(url, init));
  },
}) };
const app = new Hono();
app.use('*', cors({ origin: ['http://127.0.0.1:4178', 'http://localhost:8082', 'http://127.0.0.1:8082'], allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'] }));
app.route('/api/auth', authRoutes);
app.route('/api/users', userRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/admin/users', userManagementRoutes);
app.route('/api/admin/analytics', analyticsRoutes);
if (process.argv.includes('--serve')) {
  app.get('/__local/email', c => c.json({ code: sent.at(-1)?.html?.match(/code is (\d{6})/)?.[1] ?? null }));
  app.get('/health', c => c.json({ status: 'ok', environment: 'local-fixture' }));
}
const call = async (path: string, body?: unknown, token?: string, method = 'POST') => {
  const response = await app.request(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env);
  return { status: response.status, body: await response.json() };
};
const registration = await call('/api/auth/register', {
  email: 'account@example.test', phone: '+66812345001', password: 'ExamplePass123!', userType: 'customer', name: 'Local Test',
  policyAcceptance: { termsVersion: ACCOUNT_POLICY_VERSION, privacyVersion: ACCOUNT_POLICY_VERSION },
  marketingOptIn: true, analyticsOptIn: false,
});
assert.equal(registration.status, 201, JSON.stringify(registration.body));
assert.equal(registration.body.data.user.emailVerified, false);
assert.equal(registration.body.data.user.phoneVerified, false);
assert.equal(registration.body.data.emailVerification.deliveryStatus, 'sent');
const { accessToken: token, user } = registration.body.data;
assert.equal(sent.length, 1);
const code = sent[0]?.html?.match(/code is (\d{6})/)?.[1];
assert.ok(code);
const challenge = sqlite.query('SELECT * FROM email_verification_challenges WHERE user_id = ?').get(user.id) as { code_hash: string };
assert.ok(!challenge.code_hash.includes(code));
const login = await call('/api/auth/login', { identifier: user.email, password: 'ExamplePass123!' });
assert.equal(login.body.data.user.emailVerified, false);
sqlite.query("UPDATE users SET status = 'pending' WHERE id = ?").run(user.id);
const pendingLogin = await call('/api/auth/login', { identifier: user.email, password: 'ExamplePass123!' });
assert.equal(pendingLogin.body.data.user.emailVerified, false);
assert.equal(pendingLogin.body.data.user.phoneVerified, false);
assert.equal((await call('/api/auth/verify-email', { code })).status, 401);
assert.equal((await call('/api/auth/email-verification/request', {}, token)).status, 200);
assert.equal(sent.length, 1, 'Cooldown must avoid duplicate sends');
assert.equal((await call('/api/auth/verify-email', { code }, token)).status, 200);
assert.equal((await call('/api/auth/verify-email', { code }, token)).status, 400, 'Code is consumed');
assert.equal((sqlite.query('SELECT email_verified FROM users WHERE id = ?').get(user.id) as { email_verified: number }).email_verified, 1);
let preferences = await call('/api/users/me/consents', undefined, token, 'GET');
assert.equal(preferences.body.data.marketingOptIn, true);
assert.equal(preferences.body.data.analyticsOptIn, false);
assert.equal(preferences.body.data.termsVersion, ACCOUNT_POLICY_VERSION);
assert.ok(preferences.body.data.acceptedAt);
assert.equal((await call('/api/users/me/consents', { marketingOptIn: false, analyticsOptIn: true }, token, 'PUT')).status, 200);
preferences = await call('/api/users/me/consents', undefined, token, 'GET');
assert.equal(preferences.body.data.marketingOptIn, false);
assert.equal(preferences.body.data.analyticsOptIn, true);
assert.equal((await call('/api/users/me/consents', { marketingOptIn: 'true', analyticsOptIn: false }, token, 'PUT')).status, 400);
assert.equal((await call('/api/users/me/consents', undefined, undefined, 'GET')).status, 401);
assert.equal((sqlite.query('SELECT COUNT(*) as total FROM account_consent_events WHERE user_id = ?').get(user.id) as { total: number }).total, 6);

// Use explicit logical times to exercise expiry, retries and failed provider delivery.
const future = Date.now() + 120_000;
await requestEmailVerification(env as never, user, future);
const lockedCode = sent.at(-1)?.html?.match(/code is (\d{6})/)?.[1];
assert.ok(lockedCode);
const incorrectCode = lockedCode === '000000' ? '000001' : '000000';
for (let i = 0; i < 5; i++) assert.equal(await verifyEmailCode(env as never, user, incorrectCode, future), false);
assert.equal(await verifyEmailCode(env as never, user, lockedCode, future), false, 'Five failures lock the challenge');
await requestEmailVerification(env as never, user, future + 120_000);
const expiredCode = sent.at(-1)?.html?.match(/code is (\d{6})/)?.[1];
assert.ok(expiredCode);
assert.equal(await verifyEmailCode(env as never, user, expiredCode, future + 800_000), false);
const failingEnv = { ...env, EMAIL: { send: async () => { throw new Error('Local simulated provider outage'); } } };
const unavailable = await requestEmailVerification(failingEnv as never, user, future + 900_000);
assert.equal(unavailable.deliveryStatus, 'unavailable');
assert.equal((sqlite.query('SELECT delivery_status FROM email_verification_challenges WHERE user_id = ?').get(user.id) as { delivery_status: string }).delivery_status, 'failed');
assert.equal((await getAccountConsents(database as never, 'unknown-user')).analyticsOptIn, false);

// A failed event write rolls the entire preference update back.
sqlite.exec("CREATE TRIGGER fail_consent_event BEFORE INSERT ON account_consent_events BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
await assert.rejects(saveAccountConsents(database as never, user.id, { marketingOptIn: true, analyticsOptIn: false }));
assert.equal((await getAccountConsents(database as never, user.id)).marketingOptIn, false);
sqlite.exec('DROP TRIGGER fail_consent_event');

// Exercise real Hono -> Durable Object -> SQLite messaging against approved 010.
const supplier = await call('/api/auth/register', { email: 'guide@example.test', phone: '+66812345002', password: 'ExamplePass123!', userType: 'supplier', name: 'Local Guide' });
assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
const supplierId = supplier.body.data.user.id;
const serviceId = crypto.randomUUID();
const bookingId = crypto.randomUUID();
sqlite.query(`INSERT INTO supplier_services (id, supplier_id, title, price_min, price_max, duration_hours) VALUES (?, ?, 'Local fixture', 100, 100, 1)`).run(serviceId, supplierId);
sqlite.query(`INSERT INTO bookings (id, customer_id, supplier_id, service_id, scheduled_at, duration, total_amount, status) VALUES (?, ?, ?, ?, '2026-10-01T12:00:00Z', 60, 100, 'confirmed')`).run(bookingId, user.id, supplierId, serviceId);
const createdRoom = await call('/api/chat/rooms', { bookingId }, token);
assert.equal(createdRoom.status, 201, JSON.stringify(createdRoom.body));
const roomId = createdRoom.body.data.roomId ?? createdRoom.body.data.id;
assert.ok(roomId);
const message = await call(`/api/chat/rooms/${roomId}/messages`, { messageType: 'text', content: 'Persisted local message' }, token);
assert.equal(message.status, 201, JSON.stringify(message.body));
const detail = await call(`/api/chat/rooms/${roomId}`, undefined, supplier.body.data.accessToken, 'GET');
assert.equal(detail.status, 200, JSON.stringify(detail.body));
assert.equal(detail.body.data.messages[0].content, 'Persisted local message');
assert.ok((sqlite.query('SELECT last_message_at FROM booking_chat_rooms WHERE id = ?').get(roomId) as { last_message_at: string }).last_message_at);
assert.equal((sqlite.query('SELECT COUNT(*) as total FROM chat_messages').get() as { total: number }).total, 0, 'Legacy history stays untouched');
const realChatNamespace = env.CHAT_ROOM;
env.CHAT_ROOM = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response('Local upgrade forwarded') }) };
const ticketResult = await call(`/api/chat/rooms/${roomId}/socket-ticket`, {}, token);
assert.equal(ticketResult.status, 200, JSON.stringify(ticketResult.body));
const ticket = ticketResult.body.data.ticket;
const upgrade = (id: string, value: string) => app.request(`http://localhost/api/chat/rooms/${id}/ws?ticket=${value}`, { headers: { Upgrade: 'websocket' } }, env);
assert.equal((await upgrade(crypto.randomUUID(), ticket)).status, 401, 'Ticket is bound to one room');
assert.equal((await upgrade(roomId, ticket)).status, 200);
assert.equal((await upgrade(roomId, ticket)).status, 401, 'Ticket is one-use');
const expiringTicket = await call(`/api/chat/rooms/${roomId}/socket-ticket`, {}, token);
sqlite.exec('UPDATE chat_socket_tickets SET expires_at = 0');
assert.equal((await upgrade(roomId, expiringTicket.body.data.ticket)).status, 401);
env.CHAT_ROOM = realChatNamespace;
sqlite.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
assert.equal((await call(`/api/chat/rooms/${roomId}/messages`, { messageType: 'text', content: 'Must be denied' }, token)).status, 404);
assert.equal((await call(`/api/chat/rooms/${roomId}`, undefined, token, 'GET')).status, 404);
const admin = await call('/api/auth/register', { email: 'local-admin@example.test', phone: '+66812345003', password: 'TirakLocal123!', userType: 'customer', name: 'Local QA Admin' });
assert.equal(admin.status, 201);
sqlite.query("UPDATE users SET user_type = 'admin' WHERE id = ?").run(admin.body.data.user.id);
const adminToken = admin.body.data.accessToken;
const contacts = await call('/api/admin/users', undefined, adminToken, 'GET');
assert.equal(contacts.status, 200, JSON.stringify(contacts.body));
assert.ok(JSON.stringify(contacts.body).includes('marketingOptIn'));
const contactDetails = await call(`/api/admin/users/${user.id}`, undefined, adminToken, 'GET');
assert.equal(contactDetails.status, 200, JSON.stringify(contactDetails.body));
assert.equal(contactDetails.body.data.user.analyticsOptIn, 1);
assert.equal(contactDetails.body.data.user.marketingOptIn, 0);
assert.equal(contactDetails.body.data.user.password_hash, undefined);
for (const report of ['users', 'bookings', 'performance']) {
  const result = await call(`/api/admin/analytics/${report}`, undefined, adminToken, 'GET');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  if (report === 'performance') {
    assert.equal(result.body.data.healthMetrics, null, 'No simulated infrastructure health');
    assert.equal(result.body.data.chatActivity.reduce((total: number, day: { message_count: number }) => total + day.message_count, 0), 1, 'Approved booking chat contributes to real reporting');
  }
}
assert.deepEqual(sqlite.query('PRAGMA foreign_key_check').all(), []);
console.log('PASS: local SQLite account registration, verification, cooldown, expiry, lockout, replay, consent rollback, chat persistence/tickets/authorization, admin contacts and analytics.');
if (process.argv.includes('--serve')) {
  const unverified = await call('/api/auth/register', { email: 'unverified@example.test', phone: '+66812345004', password: 'ExamplePass123!', userType: 'customer', name: 'Local Unverified User' });
  assert.equal(unverified.status, 201);
  Bun.serve({ hostname: '127.0.0.1', port: 8787, fetch: request => app.fetch(request, env) });
  console.log('Local fixture API listening on http://127.0.0.1:8787 (in-memory, no external mail).');
} else {
  sqlite.close();
}
