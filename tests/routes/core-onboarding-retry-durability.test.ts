import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { supplierOnboardingRoutes } from '@/routes/supplierOnboarding';
import { adminSupplierOnboardingRoutes } from '@/routes/admin/supplierOnboarding';
import { commsDatabase } from '@tests/helpers/comms-sqlite';
import type { Env, Variables } from '@/index';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations');

function loadMigration(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
}

function buildMigratedDb(
  faults?: Parameters<typeof commsDatabase>[1],
) {
  const baseline = readFileSync(
    resolve(MIGRATIONS_DIR, 'baseline/canonical-baseline.sql'),
    'utf8',
  );

  const migrationFiles = [
    '010_booking_chat_expansion.sql',
    '012_supplier_onboarding.sql',
    '013_supplier_onboarding_review.sql',
    '015_account_trust.sql',
    '017_core_guide_management.sql',
    '019_password_reset_consumptions.sql',
    '020_core_onboarding_lifecycle.sql',
    '021_evidence_interest_cohort.sql',
    '022_core_booking_idempotency.sql',
    '023_core_customer_registration_fields.sql',
    '024_core_api_repairs.sql',
    '025_core_booking_mobile_fields.sql',
    '026_core_notification_prerequisites.sql',
  ];

  const allSql = [baseline, ...migrationFiles.map(loadMigration)].join('\n;\n');
  return commsDatabase(allSql, faults);
}

function createApp(
  db: ReturnType<typeof commsDatabase>['db'],
  envOverrides: Partial<Env> = {},
  adminUserId = 'admin-reviewer-1',
) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const env: Env = {
    DB: db as unknown as D1Database,
    STORAGE: {
      put: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
      head: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue({ objects: [] }),
    } as any,
    CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as any,
    SESSIONS: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as any,
    MODERATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
    ANALYTICS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
    NOTIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
    CHAT_ROOM: { get: vi.fn() } as any,
    NOTIFICATION_SERVICE: { get: vi.fn() } as any,
    JWT_SECRET: 'durability-test-secret',
    ENVIRONMENT: 'test',
    FRONTEND_URLS: 'http://localhost:3000,http://localhost:5174',
    EMAIL_PROVIDER: 'disabled',
    ...envOverrides,
  };

  app.route('/api/supplier-onboarding', supplierOnboardingRoutes);

  const adminApp = new Hono<{ Bindings: Env; Variables: Variables }>();
  adminApp.use('*', async (c, next) => {
    c.set('userId', adminUserId);
    c.set('userType', 'admin');
    await next();
  });
  adminApp.route('/admin/supplier-onboarding', adminSupplierOnboardingRoutes);
  app.route('/api', adminApp);

  return { app, env };
}

const BASE_PAYLOAD = {
  businessName: 'Retry Durability Guide',
  contactName: 'Retry Guide',
  email: 'retry@foundation.test',
  phone: '+66950000000',
  location: 'Bangkok',
  bio: 'Retry path coverage',
  brochureUrls: [],
  categories: [{ name: 'Testing', memberCount: 2 }],
  mode: 'tirak',
  applicationData: {
    firstName: 'Retry',
    lastName: 'Guide',
    serviceDrafts: [{ title: 'Tour', price: 900, currency: 'THB' as const, durationMinutes: 90 }],
    schedule: {
      timeZone: 'Asia/Bangkok' as const,
      days: [
        { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', isAvailable: false },
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isAvailable: true },
        { dayOfWeek: 2, startTime: '09:00', endTime: '17:00', isAvailable: true },
        { dayOfWeek: 3, startTime: '09:00', endTime: '17:00', isAvailable: true },
        { dayOfWeek: 4, startTime: '09:00', endTime: '17:00', isAvailable: true },
        { dayOfWeek: 5, startTime: '09:00', endTime: '17:00', isAvailable: true },
        { dayOfWeek: 6, startTime: '09:00', endTime: '17:00', isAvailable: false },
      ],
    },
  },
};

async function submitApplication(
  app: Hono,
  env: Env,
  payload: Record<string, unknown> = BASE_PAYLOAD,
  headers: Record<string, string> = {},
) {
  return app.request('/api/supplier-onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  }, env);
}

async function seedRequiredEvidence(
  app: Hono,
  env: Env,
  applicationId: string,
  statusToken: string,
) {
  for (const kind of ['id_front', 'id_back', 'selfie']) {
    await env.DB.prepare(
      `INSERT INTO supplier_onboarding_evidence (
        id, application_id, kind, r2_key, file_size, mime_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      crypto.randomUUID(),
      applicationId,
      kind,
      `private-core-onboarding/${applicationId}/${kind}`,
      1024,
      'image/jpeg',
    ).run();
  }
}

describe('Core onboarding retry durability (real SQLite)', () => {
  let db: ReturnType<typeof commsDatabase>['db'];
  let sqlite: ReturnType<typeof commsDatabase>['sqlite'];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    const built = buildMigratedDb();
    db = built.db;
    sqlite = built.sqlite;
  });

  it('replays the exact receipt for same key + same payload on both normal and raced paths', async () => {
    const { app, env } = createApp(db);
    const key = crypto.randomUUID();

    const first = await submitApplication(app, env, BASE_PAYLOAD, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const replay = await submitApplication(app, env, BASE_PAYLOAD, { 'Idempotency-Key': key });
    expect(replay.status).toBe(201);
    const replayBody = await replay.json();

    expect(replayBody.data.applicationId).toBe(firstBody.data.applicationId);
    expect(replayBody.data.statusToken).toBe(firstBody.data.statusToken);
    expect(replayBody.data.status).toBe('pending');

    const raceBuilt = buildMigratedDb();
    const { app: raceApp, env: raceEnv } = createApp(raceBuilt.db);

    const seeded = await submitApplication(raceApp, raceEnv, { ...BASE_PAYLOAD, email: 'race-seed@foundation.test' }, { 'Idempotency-Key': key });
    expect(seeded.status).toBe(201);
    const seededBody = await seeded.json();

    const originalPrepare = raceEnv.DB.prepare.bind(raceEnv.DB);
    raceEnv.DB.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes('INSERT INTO supplier_onboarding_applications')) {
        return statement;
      }

      return {
        ...statement,
        bind: (...args: unknown[]) => ({
          ...statement.bind(...args),
          async run() {
            throw new Error('UNIQUE constraint failed: supplier_onboarding_applications.idempotency_key_hash');
          },
        }),
      };
    }) as typeof raceEnv.DB.prepare;

    const raced = await submitApplication(
      raceApp,
      raceEnv,
      { ...BASE_PAYLOAD, email: 'race-seed@foundation.test' },
      { 'Idempotency-Key': key },
    );
    expect(raced.status).toBe(201);
    const racedBody = await raced.json();
    expect(racedBody.data.applicationId).toBe(seededBody.data.applicationId);
    expect(racedBody.data.statusToken).toBe(seededBody.data.statusToken);
    expect(racedBody.data.status).toBe('pending');
  });

  it('fails closed when replay token hash cannot be reproduced', async () => {
    const { app, env } = createApp(db);
    const key = crypto.randomUUID();

    const first = await submitApplication(app, env, BASE_PAYLOAD, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const mutatedEnv = { ...env, JWT_SECRET: 'rotated-secret' };
    const replay = await submitApplication(app, mutatedEnv, BASE_PAYLOAD, { 'Idempotency-Key': key });
    expect(replay.status).toBe(409);
    const replayBody = await replay.json();
    expect(replayBody.error).toBe('IDEMPOTENCY_RECOVERY_FAILED');

    const row = sqlite.prepare(
      'SELECT COUNT(*) AS cnt FROM supplier_onboarding_applications WHERE id = ?'
    ).get(firstBody.data.applicationId) as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('handles same-email concurrency and lookup faults without partial success', async () => {
    const { app, env } = createApp(db);

    const [first, second] = await Promise.all([
      submitApplication(app, env, { ...BASE_PAYLOAD, email: 'same-email@foundation.test' }),
      submitApplication(app, env, { ...BASE_PAYLOAD, email: 'same-email@foundation.test' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const count = sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM supplier_onboarding_applications WHERE email_normalized = 'same-email@foundation.test'`
    ).get() as { cnt: number };
    expect(count.cnt).toBe(1);

    const faultyBuilt = buildMigratedDb({
      failFirst: (sql) => sql.includes('SELECT id FROM supplier_onboarding_applications WHERE email_normalized = ?')
        ? new Error('d1 lookup failure')
        : null,
    });
    const { app: faultyApp, env: faultyEnv } = createApp(faultyBuilt.db);
    const faulty = await submitApplication(faultyApp, faultyEnv, { ...BASE_PAYLOAD, email: 'faulty@foundation.test' });
    expect(faulty.status).toBe(500);
    expect((await faulty.json()).error).toBe('ONBOARDING_DB_ERROR');
  });

  it('returns persisted approval winner state on already-approved retry and rejects mismatched state', async () => {
    const { app, env } = createApp(db);
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'approved@foundation.test' });
    const submittedBody = await submitted.json();
    await seedRequiredEvidence(app, env, submittedBody.data.applicationId, submittedBody.data.statusToken);

    const firstApprove = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(firstApprove.status).toBe(200);
    const firstApproveBody = await firstApprove.json();

    const retryApprove = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(retryApprove.status).toBe(409);
    const retryBody = await retryApprove.json();
    expect(retryBody.error).toBe('ALREADY_REVIEWED');
    expect(retryBody.data.approvedUserId).toBe(firstApproveBody.data.approvedUserId);
    expect(retryBody.data.reviewedUserId).toBe('admin-reviewer-1');
    expect(retryBody.data.status).toBe('approved');
    expect(retryBody.data.invitationDelivery.status).toBeDefined();

    const rejected = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'rejected@foundation.test' });
    const rejectedId = (await rejected.json()).data.applicationId;
    const rejectRes = await app.request(`/api/admin/supplier-onboarding/${rejectedId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Docs mismatch' }),
    }, env);
    expect(rejectRes.status).toBe(200);

    const rejectRetry = await app.request(`/api/admin/supplier-onboarding/${rejectedId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(rejectRetry.status).toBe(409);
    expect((await rejectRetry.json()).error).toBe('ALREADY_REVIEWED');

    await env.DB.prepare(
      `INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, email_normalized, phone, location, bio,
        brochure_urls, categories, mode, status, reviewed_user_id, approved_user_id,
        reviewed_at, invitation_delivery_status
      ) VALUES (?, 'Broken', 'Broken', 'broken@foundation.test', 'broken@foundation.test',
        '+66959999999', 'Bangkok', NULL, '[]', '[{"name":"Broken","memberCount":1}]',
        'tirak', 'approved', 'admin-reviewer-1', NULL, datetime('now'), 'unknown')`
    ).bind(crypto.randomUUID()).run();

    const mismatchedId = sqlite.prepare(
      `SELECT id FROM supplier_onboarding_applications WHERE email_normalized = 'broken@foundation.test'`
    ).get() as { id: string };

    const mismatchedRetry = await app.request(`/api/admin/supplier-onboarding/${mismatchedId.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(mismatchedRetry.status).toBe(409);
    expect((await mismatchedRetry.json()).error).toBe('ALREADY_REVIEWED');
  });

  it('reject loses cleanly to a committed approval and cannot flip the application state back', async () => {
    const { app, env } = createApp(db);
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'approve-reject-race@foundation.test' });
    const submittedBody = await submitted.json();
    await seedRequiredEvidence(app, env, submittedBody.data.applicationId, submittedBody.data.statusToken);

    const approve = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(approve.status).toBe(200);
    const approveBody = await approve.json();

    const reject = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'late rejection should lose' }),
    }, env);
    expect(reject.status).toBe(409);
    const rejectBody = await reject.json();
    expect(rejectBody.error).toBe('ALREADY_REVIEWED');
    expect(rejectBody.data.approvedUserId).toBe(approveBody.data.approvedUserId);
    expect(rejectBody.data.reviewedUserId).toBe('admin-reviewer-1');
    expect(rejectBody.data.status).toBe('approved');

    const appRow = sqlite.prepare(
      `SELECT status, approved_user_id, reviewed_user_id, rejection_reason
       FROM supplier_onboarding_applications WHERE id = ?`
    ).get(submittedBody.data.applicationId) as {
      status: string;
      approved_user_id: string | null;
      reviewed_user_id: string | null;
      rejection_reason: string | null;
    };
    expect(appRow.status).toBe('approved');
    expect(appRow.approved_user_id).toBe(approveBody.data.approvedUserId);
    expect(appRow.reviewed_user_id).toBe('admin-reviewer-1');
    expect(appRow.rejection_reason).toBeNull();
  });

  it('cannot overwrite approval when rejection is paused immediately before its write', async () => {
    const { app, env } = createApp(db);
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'interleaved-review@foundation.test' });
    const applicationId = (await submitted.json()).data.applicationId;
    await seedRequiredEvidence(app, env, applicationId, 'unused');
    let reachedWrite!: () => void;
    let releaseWrite!: () => void;
    const waiting = new Promise<void>((resolve) => { reachedWrite = resolve; });
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("SET status = 'rejected'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async () => { reachedWrite(); await gate; return run(); };
        return bound;
      };
      return statement;
    };
    const rejection = app.request(`/api/admin/supplier-onboarding/${applicationId}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'racing rejection' }),
    }, env);
    await waiting;
    try {
      const approved = await app.request(`/api/admin/supplier-onboarding/${applicationId}/approve`, { method: 'POST' }, env);
      expect(approved.status).toBe(200);
    } finally { releaseWrite(); }
    expect((await rejection).status).toBe(409);
    const row = sqlite.prepare('SELECT status, approved_user_id, rejection_reason FROM supplier_onboarding_applications WHERE id = ?').get(applicationId) as any;
    expect(row.status).toBe('approved');
    expect(row.approved_user_id).toBeTruthy();
    expect(row.rejection_reason).toBeNull();
  });

  it.each(['{broken-json', 'null', null])('rejects malformed persisted details %s before any provisioning write', async (storedDetails) => {
    const { app, env } = createApp(db);
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'corrupt-details@foundation.test' });
    const applicationId = (await submitted.json()).data.applicationId;
    await seedRequiredEvidence(app, env, applicationId, 'unused');
    sqlite.prepare('UPDATE supplier_onboarding_applications SET application_data = ? WHERE id = ?').run(storedDetails, applicationId);
    const count = sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as any;
    const approved = await app.request(`/api/admin/supplier-onboarding/${applicationId}/approve`, { method: 'POST' }, env);
    expect(approved.status).toBe(400);
    expect((await approved.json()).error).toBe('INVALID_APPLICATION_DATA');
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as any).count).toBe(count.count);
    expect((sqlite.prepare('SELECT status FROM supplier_onboarding_applications WHERE id = ?').get(applicationId) as any).status).toBe('pending');
  });

  it('fails closed in core-qa before CAS unless reviewer is active admin and active QA admin', async () => {
    const { app, env } = createApp(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' }, 'qa-admin-1');
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'qa-guide@foundation.test' });
    const submittedBody = await submitted.json();
    await seedRequiredEvidence(app, env, submittedBody.data.applicationId, submittedBody.data.statusToken);

    const noReviewer = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(noReviewer.status).toBe(403);
    expect((await noReviewer.json()).error).toBe('QA_ACCESS_DENIED');

    await env.DB.prepare(
      `INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language)
       VALUES ('qa-admin-1', 'qa-admin-1@test.local', '+66000000001', 'x', 'admin', 'active', 1, 1, 'en')`
    ).run();

    const noQaMembership = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(noQaMembership.status).toBe(403);
    expect((await noQaMembership.json()).error).toBe('QA_ACCESS_DENIED');

    await env.DB.prepare(
      `INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES ('qa-admin-1', 'admin', datetime('now'))`
    ).run();

    const approved = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();

    const qaGuide = sqlite.prepare(
      `SELECT source_application_id, enrolled_by
       FROM core_qa_accounts
       WHERE user_id = ? AND role = 'guide'`
    ).get(approvedBody.data.approvedUserId) as { source_application_id: string; enrolled_by: string } | undefined;
    expect(qaGuide).toBeDefined();
    expect(qaGuide?.source_application_id).toBe(submittedBody.data.applicationId);
    expect(qaGuide?.enrolled_by).toBe('qa-admin-1');
  });

  it('rolls back all provisioning rows when QA cohort insert cannot commit', async () => {
    const { app, env } = createApp(db, { ENVIRONMENT: 'core-qa', CORE_QA_MODE: 'cohort' }, 'qa-admin-2');

    await env.DB.prepare(
      `INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language)
       VALUES ('qa-admin-2', 'qa-admin-2@test.local', '+66000000002', 'x', 'admin', 'active', 1, 1, 'en')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO core_qa_accounts (user_id, role, enrolled_at) VALUES ('qa-admin-2', 'admin', datetime('now'))`
    ).run();

    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'rollback@foundation.test' });
    const submittedBody = await submitted.json();
    await seedRequiredEvidence(app, env, submittedBody.data.applicationId, submittedBody.data.statusToken);

    await env.DB.prepare(
      `INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language)
       VALUES ('existing-guide-user', 'existing-guide@test.local', '+66000000003', 'x', 'supplier', 'active', 1, 1, 'en')`
    ).run();

    await env.DB.prepare(
      `INSERT INTO core_qa_accounts (user_id, role, source_application_id, enrolled_by, enrolled_at)
       VALUES ('existing-guide-user', 'guide', ?, 'qa-admin-2', datetime('now'))`
    ).bind(submittedBody.data.applicationId).run();

    const res = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, env);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('APPROVE_FAILED');

    const appRow = sqlite.prepare(
      'SELECT status, approved_user_id, reviewed_user_id FROM supplier_onboarding_applications WHERE id = ?'
    ).get(submittedBody.data.applicationId) as { status: string; approved_user_id: string | null; reviewed_user_id: string | null };
    expect(appRow.status).toBe('pending');
    expect(appRow.approved_user_id).toBeNull();
    expect(appRow.reviewed_user_id).toBeNull();

    const users = sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM users WHERE email = 'rollback@foundation.test'`
    ).get() as { cnt: number };
    expect(users.cnt).toBe(0);

    const profiles = sqlite.prepare(
      `SELECT COUNT(*) AS cnt FROM supplier_profiles WHERE display_name LIKE 'Retry%'`
    ).get() as { cnt: number };
    expect(profiles.cnt).toBe(0);
  });

  it('never claims accepted invitation delivery after post-commit send', async () => {
    const { app, env } = createApp(db);
    const submitted = await submitApplication(app, env, { ...BASE_PAYLOAD, email: 'invite@foundation.test' });
    const submittedBody = await submitted.json();
    await seedRequiredEvidence(app, env, submittedBody.data.applicationId, submittedBody.data.statusToken);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ id: '8c06d24e-6621-4f18-bf75-5797c4bcfa35' }),
    }));

    const approved = await app.request(`/api/admin/supplier-onboarding/${submittedBody.data.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'admin.tirak.app' },
    }, {
      ...env,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'test-key',
      EMAIL_FROM: 'noreply@example.test',
    });
    expect(approved.status).toBe(200);
    const body = await approved.json();
    expect(body.data.emailSent).toBe(true);
    expect(body.data.invitationDelivery.status).toBe('pending');

    const appRow = sqlite.prepare(
      'SELECT invitation_delivery_status FROM supplier_onboarding_applications WHERE id = ?'
    ).get(submittedBody.data.applicationId) as { invitation_delivery_status: string };
    expect(appRow.invitation_delivery_status).toBe('pending');
  });
});
