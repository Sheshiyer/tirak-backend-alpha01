import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { adminRoutes } from '@/routes/admin';
import { generateJWT } from '@/utils/auth';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { createTestEnv } from '@tests/setup';

describe('Core admin support and acquisition readback', () => {
  let db: ReturnType<typeof commsDatabase>['sqlite'];
  let env: ReturnType<typeof createTestEnv>;
  let app: Hono;
  let failRead = false;
  const id = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    failRead = false;
    const schema = [
      '027_core_support_requests',
      '028_core_acquisition',
      '029_core_support_review',
    ].map(name => readFileSync(`migrations/${name}.sql`, 'utf8')).join('\n');
    const readFault = (sql: string) => failRead && /core_support|core_acquisition/.test(sql)
      ? new Error('Unavailable') : null;
    const state = commsDatabase(schema, { failFirst: readFault, failAll: readFault });
    db = state.sqlite;
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,user_type TEXT,status TEXT);
      INSERT INTO users VALUES ('admin','admin@example.invalid','admin','active'),('customer','customer@example.invalid','customer','active');`);
    env = createTestEnv(); env.DB = state.db as unknown as D1Database;
    app = new Hono(); app.route('/api/admin', adminRoutes as any);
  });
  afterEach(() => db.close());
  const read = async (path: string, user?: string) => app.request('/api/admin' + path, {
    headers: user ? { Authorization: 'Bearer ' + await generateJWT({ sub: user, email: user + '@example.invalid', userType: user === 'admin' ? 'admin' : 'customer' }, env.JWT_SECRET) } : {},
  }, env);
  const seed = () => {
    db.prepare(`INSERT INTO core_support_requests (
      id, kind, name, email_normalized, subject, message, idempotency_key_hash, payload_digest, created_at, updated_at
    ) VALUES (?, 'contact', 'Internal Test', 'test@example.invalid', 'Test request', 'Recorded message', ?, ?, '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`)
      .run(id, 'a'.repeat(64), 'b'.repeat(64));
    db.prepare(`INSERT INTO core_acquisition_conversions VALUES (
      'interest', ?, '/tirak', 'newsletter', 'email', 'launch', NULL, '2026-10-23T00:00:00Z'
    )`).run(id);
  };
  it('requires an active admin for both lists and private support detail', async () => {
    seed();
    for (const path of ['/support-requests', '/support-requests/' + id, '/acquisition']) {
      expect((await read(path)).status).toBe(401); expect((await read(path, 'customer')).status).toBe(403);
      expect((await read(path, 'admin')).status).toBe(200);
    }
    db.exec("UPDATE users SET status='suspended' WHERE id='admin'");
    for (const path of ['/support-requests','/support-requests/'+id,'/acquisition']) expect((await read(path,'admin')).status).toBe(401);
  });
  it('returns honest empty results and never masks storage failure as zero', async () => {
    for (const path of ['/support-requests','/acquisition']) {
      const response=await read(path,'admin'); expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await response.json() as any).data).toMatchObject({items:[],pagination:{total:0,totalPages:0}});
    }
    failRead=true;
    for (const path of ['/support-requests','/support-requests/'+id,'/acquisition']) {
      const response=await read(path,'admin');expect(response.status).toBe(500);expect((await response.json() as any).data).toBeUndefined();
    }
  });
  it('reads scoped support summaries and detail with working filters and pagination', async () => {
    seed();
    const list=await (await read('/support-requests?page=1&limit=20&kind=contact&status=received','admin')).json() as any;
    expect(list.data.items).toEqual([{id,kind:'contact',status:'received',name:'Internal Test',subject:'Test request',created_at:'2026-10-23T00:00:00Z'}]);
    const detail=await (await read('/support-requests/'+id,'admin')).json() as any;
    expect(detail.data).toMatchObject({id,mode:'tirak',email:'test@example.invalid',message:'Recorded message',revision:0});
    expect((await (await read('/support-requests?page=2&limit=1','admin')).json() as any).data).toMatchObject({items:[],pagination:{page:2,total:1,totalPages:1}});
    expect((await (await read('/support-requests?status=closed','admin')).json() as any).data.items).toEqual([]);
    expect((await read('/support-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin')).status).toBe(404);
  });
  it('reads real attributed records without exposing contact data and filters by kind or campaign', async () => {
    seed();const result=await (await read('/acquisition?kind=interest&campaign=launch','admin')).json() as any;
    expect(result.data.items).toEqual([{resource_kind:'interest',resource_id:id,landing_path:'/tirak',utm_source:'newsletter',utm_medium:'email',utm_campaign:'launch',utm_content:null,accepted_at:'2026-10-23T00:00:00Z'}]);
    expect(result.data.pagination).toMatchObject({page:1,limit:20,total:1,totalPages:1});
    for (const query of ['?kind=guide_application','?campaign=other','?page=2']) expect((await (await read('/acquisition'+query,'admin')).json() as any).data.items).toEqual([]);
  });
  it('rejects invalid/ambiguous filters and malformed request ids', async () => {
    for (const q of ['?page=0','?limit=101','?page=1&page=2','?kind=bad','?status=bad','?mode=tirakplus','?kind=contact&kind=contact']) expect((await read('/support-requests'+q,'admin')).status).toBe(400);
    expect((await read('/support-requests/not-a-uuid','admin')).status).toBe(400);
    for (const q of ['?page=0','?page=1&page=2','?kind=bad','?campaign=','?campaign=bad%20tag','?mode=tirakplus']) expect((await read('/acquisition'+q,'admin')).status).toBe(400);
  });
});
