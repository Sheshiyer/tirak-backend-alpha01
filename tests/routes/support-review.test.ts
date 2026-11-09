import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { supportRequestRoutes } from '@/routes/supportRequests';
import { adminRoutes } from '@/routes/admin';
import { generateJWT } from '@/utils/auth';
import { createTestEnv } from '@tests/setup';
describe('Core support review transaction', () => {
  let state: ReturnType<typeof commsDatabase>; let env: ReturnType<typeof createTestEnv>; let app: Hono; let requestId: string;
  beforeEach(async () => {
    state = commsDatabase(readFileSync('migrations/027_core_support_requests.sql', 'utf8') + readFileSync('migrations/029_core_support_review.sql', 'utf8') + readFileSync('migrations/030_core_support_notifications.sql', 'utf8') + `CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,user_type TEXT,status TEXT); INSERT INTO users VALUES ('admin','admin@example.invalid','admin','active'), ('customer','customer@example.invalid','customer','active'); CREATE TABLE bookings(id TEXT PRIMARY KEY); INSERT INTO bookings VALUES ('keep-booking');`);
    env = createTestEnv(); env.DB = state.db as any; app = new Hono(); app.route('/api/support-requests', supportRequestRoutes as any); app.route('/api/admin', adminRoutes as any);
    const response = await app.request('/api/support-requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ kind: 'privacy_deletion', name: 'Synthetic requester', email: 'request@example.invalid', subject: 'Review request', message: 'Record intent only' }) }, env);
    requestId = (await response.json() as any).data.requestId;
  });
  afterEach(() => state.sqlite.close());
  const auth = async (user = 'admin') => ({ Authorization: 'Bearer ' + await generateJWT({ sub: user, email: user + '@example.invalid', userType: user === 'admin' ? 'admin' : 'customer' }, env.JWT_SECRET) });
  const patch = async (body: unknown, user = 'admin') => app.request('/api/admin/support-requests/' + requestId, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...await auth(user) }, body: JSON.stringify(body) }, env);
  const action = () => ({ actionId: crypto.randomUUID(), status: 'in_review', expectedRevision: 0, note: 'Identity review started; no deletion performed.' });
  it('atomically records actor/status/note and exact retry adds no second event', async () => {
    const body = action(); const first = await patch(body); expect(first.status).toBe(200); expect((await first.json() as any).data.revision).toBe(1);
    expect((await (await patch(body)).json() as any).data.replayed).toBe(true);
    expect((await patch({ ...body, note: 'Changed' })).status).toBe(409);
    const events = state.sqlite.prepare('SELECT actor_id,from_status,to_status,revision,note FROM core_support_review_events').all(); expect(events).toEqual([{ actor_id: 'admin', from_status: 'received', to_status: 'in_review', revision: 1, note: body.note }]);
    const history = await app.request('/api/admin/support-requests/' + requestId + '/history', { headers: await auth() }, env); expect(history.status).toBe(200); expect(history.headers.get('Cache-Control')).toBe('no-store'); expect((await history.json() as any).data.items).toHaveLength(1);
    expect(state.sqlite.prepare('SELECT COUNT(*) n FROM users').get()).toMatchObject({ n: 2 }); expect(state.sqlite.prepare('SELECT id FROM bookings').all()).toEqual([{ id: 'keep-booking' }]);
  });
  it('rejects invalid transitions, non-admin review and stale revisions', async () => {
    expect((await patch({ ...action(), status: 'resolved' })).status).toBe(400); expect((await patch(action(), 'customer')).status).toBe(403);
    const response = await app.request('/api/admin/support-requests/' + requestId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action()) }, env); expect(response.status).toBe(401);
    expect((await patch(action())).status).toBe(200); expect((await patch({ ...action(), status: 'closed' })).status).toBe(409);
  });
  it.each([{ note: '' }, { note: 'x'.repeat(1001) }, { expectedRevision: -1 }, { note: 'bad\u0000note' }])('rejects invalid review details before mutation: %j', async change => {
    expect((await patch({ ...action(), ...change })).status).toBe(400);
    expect(state.sqlite.prepare('SELECT revision FROM core_support_requests').get()).toMatchObject({ revision: 0 });
    expect(state.sqlite.prepare('SELECT COUNT(*) n FROM core_support_review_events').get()).toMatchObject({ n: 0 });
  });
  it('audit insertion failure rolls back status and revision', async () => {
    state.sqlite.exec("CREATE TRIGGER fail_review BEFORE INSERT ON core_support_review_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    expect((await patch(action())).status).toBe(500); expect(state.sqlite.prepare('SELECT status,revision FROM core_support_requests').get()).toMatchObject({ status: 'received', revision: 0 }); expect(state.sqlite.prepare('SELECT COUNT(*) n FROM core_support_review_events').get()).toMatchObject({ n: 0 });
  });
  it('two reviewers racing from one revision produce one status change and one event', async () => {
    const results = await Promise.all([patch(action()), patch({ ...action(), status: 'closed' })]); expect(results.map(r => r.status).sort()).toEqual([200,409]);
    expect(state.sqlite.prepare('SELECT revision FROM core_support_requests').get()).toMatchObject({ revision: 1 }); expect(state.sqlite.prepare('SELECT COUNT(*) n FROM core_support_review_events').get()).toMatchObject({ n: 1 });
  });
});
