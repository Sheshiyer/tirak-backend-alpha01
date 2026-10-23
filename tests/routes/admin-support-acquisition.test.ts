import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { adminRoutes } from '@/routes/admin';
import { generateJWT } from '@/utils/auth';
import { createTestEnv } from '@tests/setup';

describe('Core admin support and acquisition readback', () => {
  let db: DatabaseSync; let env: ReturnType<typeof createTestEnv>; let app: Hono; let failRead = false;
  const id = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); failRead = false;
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,user_type TEXT,status TEXT);
      INSERT INTO users VALUES ('admin','admin@example.invalid','admin','active'),('customer','customer@example.invalid','customer','active');
      CREATE TABLE core_support_requests(id TEXT PRIMARY KEY,mode TEXT,kind TEXT,status TEXT,name TEXT,email_normalized TEXT,subject TEXT,message TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE core_acquisition_conversions(resource_kind TEXT,resource_id TEXT,landing_path TEXT,utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,utm_content TEXT,accepted_at TEXT);`);
    env = createTestEnv(); env.DB = { prepare(sql: string) {
      const statement = (values: any[] = []): any => ({ bind: (...params: any[]) => statement(params),
        first: async () => { if (failRead && /core_support|core_acquisition/.test(sql)) throw new Error('Unavailable'); return db.prepare(sql).get(...values) ?? null; },
        all: async () => { if (failRead) throw new Error('Unavailable'); return { success: true, results: db.prepare(sql).all(...values) }; },
      }); return statement();
    } } as any;
    app = new Hono(); app.route('/api/admin', adminRoutes as any);
  });
  afterEach(() => db.close());
  const read = async (path: string, user?: string) => app.request('/api/admin' + path, {
    headers: user ? { Authorization: 'Bearer ' + await generateJWT({ sub: user, email: user + '@example.invalid', userType: user === 'admin' ? 'admin' : 'customer' }, env.JWT_SECRET) } : {},
  }, env);
  const seed = () => db.exec(`INSERT INTO core_support_requests VALUES ('${id}','tirak','contact','received','Internal Test','test@example.invalid','Test request','Recorded message','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');
    INSERT INTO core_support_requests VALUES ('22222222-2222-4222-8222-222222222222','tirakplus','contact','received','Other mode','other@example.invalid','Private','Other message','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');
    INSERT INTO core_acquisition_conversions VALUES ('interest','${id}','/travelers','newsletter','email','launch',NULL,'2026-10-23T00:00:00Z');`);
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
    expect(detail.data).toMatchObject({id,mode:'tirak',email:'test@example.invalid',message:'Recorded message'});
    expect((await (await read('/support-requests?page=2&limit=1','admin')).json() as any).data).toMatchObject({items:[],pagination:{page:2,total:1,totalPages:1}});
    expect((await (await read('/support-requests?status=closed','admin')).json() as any).data.items).toEqual([]);
    expect((await read('/support-requests/22222222-2222-4222-8222-222222222222','admin')).status).toBe(404);
    expect((await read('/support-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin')).status).toBe(404);
  });
  it('reads real attributed records, filters by kind/campaign, and does not infer conversions for legacy records', async () => {
    seed();const result=await (await read('/acquisition?kind=interest&campaign=launch','admin')).json() as any;
    expect(result.data.items).toEqual([{resource_kind:'interest',resource_id:id,landing_path:'/travelers',utm_source:'newsletter',utm_medium:'email',utm_campaign:'launch',utm_content:null,accepted_at:'2026-10-23T00:00:00Z'}]);
    expect(result.data.pagination).toMatchObject({page:1,limit:20,total:1,totalPages:1});
    for (const query of ['?kind=guide_application','?campaign=other','?page=2']) expect((await (await read('/acquisition'+query,'admin')).json() as any).data.items).toEqual([]);
  });
  it('rejects invalid/ambiguous filters and malformed request ids', async () => {
    for (const q of ['?page=0','?limit=101','?page=1&page=2','?kind=bad','?status=bad','?mode=tirakplus','?kind=contact&kind=contact']) expect((await read('/support-requests'+q,'admin')).status).toBe(400);
    expect((await read('/support-requests/not-a-uuid','admin')).status).toBe(400);
    for (const q of ['?page=0','?page=1&page=2','?kind=bad','?campaign=','?campaign=bad%20tag','?mode=tirakplus']) expect((await read('/acquisition'+q,'admin')).status).toBe(400);
  });
});
