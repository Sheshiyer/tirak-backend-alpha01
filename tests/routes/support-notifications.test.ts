import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import { createTestEnv } from '@tests/setup';
import { supportRequestRoutes } from '@/routes/supportRequests';
import { adminRoutes } from '@/routes/admin';
import { generateJWT } from '@/utils/auth';
import { processSupportNotification, readSupportNotification, processSupportNotifications } from '@/background/supportNotifications';
import worker from '@/index';
describe('Core support durable owner notification', () => {
  let state: ReturnType<typeof commsDatabase>; let env: ReturnType<typeof createTestEnv>; let app: Hono; let id: string;
  let failOutcomeWrite = false;
  const providerId = '123e4567-e89b-12d3-a456-426614174099'; const now = 1800000000000;
  beforeEach(async () => {
    failOutcomeWrite = false;
    state = commsDatabase(readFileSync('migrations/027_core_support_requests.sql','utf8') + readFileSync('migrations/029_core_support_review.sql','utf8') + readFileSync('migrations/030_core_support_notifications.sql','utf8') + `CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,user_type TEXT,status TEXT); INSERT INTO users VALUES ('admin','admin@example.invalid','admin','active'),('customer','customer@example.invalid','customer','active');`, { failRun: sql => failOutcomeWrite && sql.startsWith('UPDATE core_support_notification_outbox SET status=?,provider_request_id=') ? new Error('synthetic outcome write failure') : null });
    env = createTestEnv(); env.DB = state.db as any; env.SUPPORT_NOTIFICATIONS_ENABLED = 'true'; env.EMAIL_PROVIDER = 'resend'; env.RESEND_API_KEY = 'synthetic-not-a-real-provider-key'; env.EMAIL_FROM = 'noreply@tirak.app';
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ id: providerId })));
    app = new Hono(); app.route('/api/support-requests', supportRequestRoutes as any); app.route('/api/admin', adminRoutes as any);
    const response = await app.request('/api/support-requests', { method: 'POST', headers: { 'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID() }, body: JSON.stringify({ kind:'contact',name:'Private sender',email:'private@example.invalid',subject:'Private subject',message:'Personal message stays in admin' }) }, env);
    expect(response.status).toBe(201); id = (await response.json() as any).data.requestId;
  });
  afterEach(() => { state.sqlite.close(); vi.unstubAllGlobals(); });
  it('intake atomically creates one pending outbox and rolls back if queue insert fails', async () => {
    expect((await readSupportNotification(env,id)).status).toBe('pending');
    state.sqlite.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON core_support_notification_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    const response = await app.request('/api/support-requests', { method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({kind:'contact',name:'Other',email:'other@example.invalid',subject:'Other subject',message:'Other message'}) },env);
    expect(response.status).toBe(500); expect((await response.json() as any).data).toBeUndefined(); expect(state.sqlite.prepare('SELECT COUNT(*) n FROM core_support_requests').get()).toMatchObject({n:1}); expect(state.sqlite.prepare('SELECT COUNT(*) n FROM core_support_notification_outbox').get()).toMatchObject({n:1});
  });
  it('disabled delivery is visible and sends nothing, then configured retry stores provider acceptance only', async () => {
    env.SUPPORT_NOTIFICATIONS_ENABLED='false'; await processSupportNotification(env,id,false,now);
    expect(await readSupportNotification(env,id)).toMatchObject({status:'unconfigured',attempts:0,lastErrorCode:'DISABLED'}); expect(fetch).not.toHaveBeenCalled();
    env.SUPPORT_NOTIFICATIONS_ENABLED='true'; await processSupportNotification(env,id,true,now+1);
    expect(await readSupportNotification(env,id)).toMatchObject({status:'provider_accepted',attempts:1,providerRequestId:providerId});
    const init = vi.mocked(fetch).mock.calls[0][1]!; const body=JSON.parse(String(init.body)); expect(body.to).toEqual(['contact@tirak.app']); expect(String(init.body)).not.toContain('private@example.invalid'); expect(String(init.body)).not.toContain('Personal message'); expect(new Headers(init.headers).get('Idempotency-Key')).toBe('tirak-support/'+id);
    await processSupportNotification(env,id,true,now+2); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('projects disabled delivery without polling or rewriting the pending outbox', async () => {
    env.SUPPORT_NOTIFICATIONS_ENABLED = 'false';
    const prepare = vi.spyOn(env.DB, 'prepare');
    const waitUntil = vi.fn();
    await worker.scheduled({} as ScheduledController, env, { waitUntil } as unknown as ExecutionContext);
    expect(prepare).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(await readSupportNotification(env, id)).toMatchObject({ status: 'unconfigured', lastErrorCode: 'DISABLED', nextAttemptAt: null });
    expect(state.sqlite.prepare('SELECT status, attempts FROM core_support_notification_outbox').get()).toEqual({ status: 'pending', attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('concurrent claims make one provider call', async () => {
    await Promise.all([processSupportNotification(env,id,true,now),processSupportNotification(env,id,true,now)]); expect(fetch).toHaveBeenCalledTimes(1); expect((await readSupportNotification(env,id)).attempts).toBe(1);
  });
  it('a lost database acknowledgement recovers through the same provider key after lease expiry', async () => {
    const keys = new Set<string>();
    vi.mocked(fetch).mockImplementation(async (_, init) => { keys.add(new Headers(init?.headers).get('Idempotency-Key')!); return Response.json({ id: providerId }); });
    failOutcomeWrite = true;
    await expect(processSupportNotification(env,id,true,now)).rejects.toThrow('synthetic outcome');
    expect((await readSupportNotification(env,id)).status).toBe('processing');
    await processSupportNotification(env,id,true,now+1000); expect(fetch).toHaveBeenCalledTimes(1);
    failOutcomeWrite = false; await processSupportNotification(env,id,true,now+60001);
    expect(fetch).toHaveBeenCalledTimes(2); expect(keys.size).toBe(1); expect(await readSupportNotification(env,id)).toMatchObject({status:'provider_accepted',providerRequestId:providerId,attempts:2});
  });
  it('manual retry is administrator-only and disabled retries make no provider call', async () => {
    env.SUPPORT_NOTIFICATIONS_ENABLED='false';
    const retry = async (user?:string) => app.request('/api/admin/support-requests/'+id+'/notification/retry', {method:'POST',headers:user?{Authorization:'Bearer '+await generateJWT({sub:user,email:user+'@example.invalid',userType:user==='admin'?'admin':'customer'},env.JWT_SECRET)}:{}},env);
    expect((await retry()).status).toBe(401); expect((await retry('customer')).status).toBe(403);
    const response=await retry('admin'); expect(response.status).toBe(200); expect((await response.json() as any).data).toMatchObject({requestId:id,status:'unconfigured',attempts:0}); expect(fetch).not.toHaveBeenCalled();
  });
  it('uncertain provider outcome retries with identical message/key and stops before expiry', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('synthetic unknown outcome'));
    await processSupportNotification(env,id,true,now); expect(await readSupportNotification(env,id)).toMatchObject({status:'retry_due',lastErrorCode:'OUTCOME_UNKNOWN'});
    const first=vi.mocked(fetch).mock.calls[0][1]!;
    await processSupportNotification(env,id,true,now+60001); const second=vi.mocked(fetch).mock.calls[1][1]!;
    expect(second.body).toBe(first.body); expect(new Headers(second.headers).get('Idempotency-Key')).toBe(new Headers(first.headers).get('Idempotency-Key'));
    state.sqlite.prepare("UPDATE core_support_notification_outbox SET status='retry_due',provider_request_id=NULL,accepted_at=NULL").run();
    await processSupportNotification(env,id,true,now+23*3600000); expect((await readSupportNotification(env,id)).status).toBe('needs_review'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('provider configuration change requires review and QA policy blocks external send', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('unknown')); await processSupportNotification(env,id,true,now); env.RESEND_API_KEY='different-synthetic-key'; await processSupportNotification(env,id,true,now+60001); expect(await readSupportNotification(env,id)).toMatchObject({status:'needs_review',lastErrorCode:'CONFIG_CHANGED'}); expect(fetch).toHaveBeenCalledTimes(1);
    state.sqlite.prepare("UPDATE core_support_notification_outbox SET status='pending',attempts=0,first_attempt_at=NULL,config_digest=NULL").run(); env.ENVIRONMENT='core-qa'; env.CORE_QA_MODE='cohort'; await processSupportNotification(env,id,true,now+60002); expect((await readSupportNotification(env,id)).status).toBe('unconfigured'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('notification state is administrator-only and scheduler recovers pending rows', async () => {
    const request = async (user?:string) => app.request('/api/admin/support-requests/'+id+'/notification', {headers:user?{Authorization:'Bearer '+await generateJWT({sub:user,email:user+'@example.invalid',userType:user==='admin'?'admin':'customer'},env.JWT_SECRET)}:{}},env);
    expect((await request()).status).toBe(401);expect((await request('customer')).status).toBe(403);expect((await request('admin')).status).toBe(200);
    await processSupportNotifications(env); expect((await readSupportNotification(env,id)).status).toBe('provider_accepted');
    const body=(await (await request('admin')).json() as any).data; expect(body).not.toHaveProperty('config_digest'); expect(body).not.toHaveProperty('lease_token');
  });
});
