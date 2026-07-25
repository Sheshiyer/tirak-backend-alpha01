# Supplier Onboarding Backend Endpoint Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `POST /api/supplier-onboarding` to the tirak-backend Cloudflare Worker so the admin app's supplier onboarding form (PR #29, merged) has a live endpoint — submissions persist to D1, and admins can list applications.

**Architecture:** New D1 table `supplier_onboarding_applications` (migration 012, idempotent per repo invariant), a public Hono route module with the repo's standard `zValidator` + `jsonSuccess/jsonError` + rate-limit conventions mounted in the no-JWT section of `src/index.ts` (public vendors post without a token; the admin modal's bearer token passes through harmlessly), plus an admin list endpoint `GET /api/admin/supplier-onboarding` mounted in the admin sub-app (auth + adminOnly already applied there).

**Tech Stack:** Hono 4, `@hono/zod-validator` + zod, Cloudflare D1 (SQLite), vitest (repo has real test suite in `tests/`).

**Repo conventions (verified, follow exactly):**
- Routes: `src/routes/<name>.ts`, `new Hono<{ Bindings: Env; Variables: Variables }>()`, `createRateLimit('general')` via `.use('*', ...)` for public modules (see `src/routes/public.ts:29`).
- Responses: `jsonSuccess(c, data, message?, status?)` / `jsonError(c, error, message?, status?)` from `src/utils/response.ts` — these produce the `ApiEnvelope` shape the admin app's `apiRequest` expects (`{success, data, ...}`).
- Validation: `zValidator('json', schema)` (see `src/routes/admin/users.ts:318`).
- Admin list pattern: `validatePagination()` middleware + `jsonPaginated(c, items, createPagination(page, limit, total))` (see `src/routes/admin/users.ts:52-168`).
- Migrations: idempotent (`IF NOT EXISTS` everywhere), numbered `012_*.sql`, applied via Wrangler ledger only.
- Tests: route tests in `tests/routes/*.test.ts` using `createTestEnv()` mock from `tests/setup.ts` (mock DB: `prepare().bind().run/first/all`); migration tests in `tests/migrations/` applying SQL to in-memory SQLite via `tests/migrations/helpers/sqlite.ts`.
- Admin sub-app mounting: `src/routes/admin/index.ts:42-48` (`admin.route('/...', ...)`); top-level mounting: `src/index.ts:115-135`.

**Contract with the admin app (frozen — do not change field names):**
```
POST /api/supplier-onboarding
{ businessName, contactName, email, phone, location, bio?, brochureUrls: string[], categories: [{name, memberCount}], mode: "tirak"|"tirakplus" }
→ 201 { success: true, data: { applicationId: string } }

GET /api/admin/supplier-onboarding?page=1&limit=20&status=pending
→ { success: true, data: { items: [...], pagination: {...} } }
```

---

### Task 1: Migration 012 — `supplier_onboarding_applications` table

**Files:**
- Create: `migrations/012_supplier_onboarding.sql`
- Test: `tests/migrations/supplier-onboarding.test.ts`

**Step 1: Write the failing migration test**

Create `tests/migrations/supplier-onboarding.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applySql, createDb, fullSchemaDump } from './helpers/sqlite';

const migrationPath = resolve(import.meta.dirname, '../../migrations/012_supplier_onboarding.sql');

function loadSql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('012_supplier_onboarding migration', () => {
  it('creates the supplier_onboarding_applications table with the contract columns', () => {
    const db = createDb();
    applySql(db, loadSql(), '012_supplier_onboarding.sql');

    const table = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'supplier_onboarding_applications'")
      .get() as { sql: string } | undefined;

    expect(table).toBeDefined();
    for (const column of [
      'id',
      'business_name',
      'contact_name',
      'email',
      'phone',
      'location',
      'bio',
      'brochure_urls',
      'categories',
      'mode',
      'status',
      'created_at',
      'updated_at',
      'reviewed_user_id',
    ]) {
      expect(table!.sql).toContain(column);
    }
  });

  it('is idempotent — applying twice is a no-op', () => {
    const db = createDb();
    const sql = loadSql();
    applySql(db, sql, '012_supplier_onboarding.sql');
    const first = fullSchemaDump(db);
    expect(() => applySql(db, sql, '012_supplier_onboarding.sql')).not.toThrow();
    expect(fullSchemaDump(db)).toEqual(first);
  });
});
```

Note: check `tests/migrations/helpers/sqlite.ts` exports first — if `fullSchemaDump` or `applySql`/`createDb` signatures differ, adapt the test to the real helpers (keep the two test cases).

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migrations/supplier-onboarding.test.ts`
Expected: FAIL — `migrations/012_supplier_onboarding.sql` does not exist (readFileSync throws).

**Step 3: Write the migration**

Create `migrations/012_supplier_onboarding.sql`:

```sql
-- Supplier onboarding applications: self-serve vendor intake for admin review.
--
-- Contract source: tirak-admin-command-center PR #29
-- (src/lib/api.ts SupplierOnboardingPayload). Field names here are snake_case
-- mirrors of that frozen payload; do not rename without a frontend change.
--
-- Idempotent: every statement uses IF NOT EXISTS. Apply only through the
-- Wrangler migration ledger; never via raw directory replay.

CREATE TABLE IF NOT EXISTS supplier_onboarding_applications (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  location TEXT NOT NULL,
  bio TEXT,
  brochure_urls TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'tirak' CHECK (mode IN ('tirak', 'tirakplus')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_status
  ON supplier_onboarding_applications (status, created_at);

CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_mode
  ON supplier_onboarding_applications (mode, status);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/migrations/supplier-onboarding.test.ts`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add migrations/012_supplier_onboarding.sql tests/migrations/supplier-onboarding.test.ts
git commit -m "feat(migrations): 012 supplier_onboarding_applications table"
```

---

### Task 2: Public POST route — `src/routes/supplierOnboarding.ts`

**Files:**
- Create: `src/routes/supplierOnboarding.ts`
- Test: `tests/routes/supplier-onboarding.test.ts`

**Step 1: Write the failing route test**

Create `tests/routes/supplier-onboarding.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { supplierOnboardingRoutes } from '@/routes/supplierOnboarding';
import { createTestEnv } from '@tests/setup';

describe('Supplier Onboarding Routes', () => {
  let app: Hono;
  let testEnv: any;
  let lastInsert: { query: string; params: unknown[] } | null;

  const validPayload = {
    businessName: 'Siam Wellness Co.',
    contactName: 'Chanida Wongsa',
    email: 'chanida@example.com',
    phone: '+66957890123',
    location: 'Bangkok',
    bio: 'Spa and massage studio',
    brochureUrls: ['https://example.com/brochure.pdf'],
    categories: [
      { name: 'Traditional Thai Massage', memberCount: 4 },
      { name: 'Aromatherapy', memberCount: 2 },
    ],
    mode: 'tirak',
  };

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    lastInsert = null;
    testEnv.DB.prepare = (query: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          lastInsert = { query, params };
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    });
    app.route('/supplier-onboarding', supplierOnboardingRoutes);
  });

  function post(body: unknown) {
    return app.request(
      '/supplier-onboarding',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      testEnv
    );
  }

  it('accepts a valid application and returns an applicationId', async () => {
    const res = await post(validPayload);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.applicationId).toBe('string');
    expect(body.data.applicationId.length).toBeGreaterThan(0);
  });

  it('persists brochureUrls and categories as JSON with snake_case columns', async () => {
    await post(validPayload);
    expect(lastInsert).not.toBeNull();
    expect(lastInsert!.query).toContain('supplier_onboarding_applications');
    expect(lastInsert!.params).toContain(JSON.stringify(validPayload.brochureUrls));
    expect(lastInsert!.params).toContain(JSON.stringify(validPayload.categories));
  });

  it('rejects missing required fields with 400', async () => {
    const res = await post({ ...validPayload, businessName: '' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid brochure URL with 400', async () => {
    const res = await post({ ...validPayload, brochureUrls: ['not-a-url'] });
    expect(res.status).toBe(400);
  });

  it('rejects an empty categories array with 400', async () => {
    const res = await post({ ...validPayload, categories: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid mode with 400', async () => {
    const res = await post({ ...validPayload, mode: 'enterprise' });
    expect(res.status).toBe(400);
  });
});
```

Note: rate limiting middleware — check `createRateLimit('general')` behavior in tests (see how other public route tests handle it, e.g. `tests/routes/auth.test.ts`). If it requires KV/ctx not in the mock env, follow the existing pattern for public route tests; if no public route test exists as precedent, keep middleware but verify tests pass with `createTestEnv()` — if they fail on rate-limit internals, mirror whatever `auth.test.ts` does since auth routes also mount rate limits.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes/supplier-onboarding.test.ts`
Expected: FAIL — `@/routes/supplierOnboarding` does not exist.

**Step 3: Write the route**

Create `src/routes/supplierOnboarding.ts`:

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const supplierOnboardingRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const onboardingSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(8).max(32),
  location: z.string().trim().min(2).max(200),
  bio: z.string().trim().max(500).optional(),
  brochureUrls: z.array(z.string().trim().url()).max(5).default([]),
  categories: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        memberCount: z.number().int().min(1).max(100000),
      })
    )
    .min(1)
    .max(50),
  mode: z.enum(['tirak', 'tirakplus']).default('tirak'),
});

supplierOnboardingRoutes.use('*', createRateLimit('general'));

supplierOnboardingRoutes.post('/', zValidator('json', onboardingSchema), async (c) => {
  const payload = c.req.valid('json');

  try {
    const applicationId = crypto.randomUUID();

    const result = await c.env.DB.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, bio,
        brochure_urls, categories, mode, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `)
      .bind(
        applicationId,
        payload.businessName,
        payload.contactName,
        payload.email,
        payload.phone,
        payload.location,
        payload.bio ?? null,
        JSON.stringify(payload.brochureUrls),
        JSON.stringify(payload.categories),
        payload.mode
      )
      .run();

    if (!result.success) {
      return jsonError(c, 'ONBOARDING_INSERT_FAILED', 'Could not save the application.', 500);
    }

    return jsonSuccess(c, { applicationId }, 'Application received.', 201);
  } catch (error) {
    console.error('Supplier onboarding submission failed:', error);
    return jsonError(c, 'ONBOARDING_SUBMISSION_FAILED', 'Submission failed.', 500);
  }
});

export { supplierOnboardingRoutes };
```

Note: check how other routes generate IDs (`crypto.randomUUID()` vs a repo util in `src/utils/`) — if a util exists, use it instead. Also confirm `jsonSuccess` accepts a status 4th arg (verified: `src/utils/response.ts:62` has `status = 200` param).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routes/supplier-onboarding.test.ts`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add src/routes/supplierOnboarding.ts tests/routes/supplier-onboarding.test.ts
git commit -m "feat(routes): public POST /supplier-onboarding with zod validation"
```

---

### Task 3: Mount routes — public POST + admin GET list

**Files:**
- Modify: `src/index.ts` (import ~line 4-14, mount ~line 119)
- Create: `src/routes/admin/supplierOnboarding.ts`
- Modify: `src/routes/admin/index.ts` (mount ~line 43-48)
- Test: extend `tests/routes/supplier-onboarding.test.ts` (admin list cases)

**Step 1: Write failing admin list tests**

Append to `tests/routes/supplier-onboarding.test.ts`:

```typescript
describe('Admin Supplier Onboarding List', () => {
  it('returns paginated applications', async () => {
    const { adminSupplierOnboardingRoutes } = await import('@/routes/admin/supplierOnboarding');
    const adminApp = new Hono();
    const env = createTestEnv();
    env.DB.prepare = () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => ({ total: 1 }),
        all: async () => ({
          results: [
            {
              id: 'app-1',
              business_name: 'Siam Wellness Co.',
              contact_name: 'Chanida Wongsa',
              email: 'chanida@example.com',
              phone: '+66957890123',
              location: 'Bangkok',
              bio: null,
              brochure_urls: '["https://example.com/brochure.pdf"]',
              categories: '[{"name":"Massage","memberCount":4}]',
              mode: 'tirak',
              status: 'pending',
              created_at: '2026-07-25 00:00:00',
            },
          ],
        }),
      }),
    });
    adminApp.route('/supplier-onboarding', adminSupplierOnboardingRoutes);

    const res = await adminApp.request('/supplier-onboarding?page=1&limit=20', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].brochureUrls).toEqual(['https://example.com/brochure.pdf']);
    expect(body.data.items[0].categories).toEqual([{ name: 'Massage', memberCount: 4 }]);
    expect(body.data.pagination).toBeDefined();
  });
});
```

Note: `validatePagination()` reads query and sets `validatedQuery` on context — check `src/middleware/validation.ts` for exact behavior and mirror how `tests/routes/` tests paginated admin routes today; adapt the mock/request accordingly.

**Step 2: Run to verify failure**

Run: `npx vitest run tests/routes/supplier-onboarding.test.ts`
Expected: FAIL — `@/routes/admin/supplierOnboarding` missing.

**Step 3: Create the admin list route**

Create `src/routes/admin/supplierOnboarding.ts`:

```typescript
import { Hono } from 'hono';
import { validatePagination } from '../../middleware/validation';
import { jsonPaginated, jsonError, createPagination } from '../../utils/response';
import type { Env, Variables } from '../../index';

const adminSupplierOnboarding = new Hono<{ Bindings: Env; Variables: Variables }>();

adminSupplierOnboarding.get('/', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  const allowedStatuses = ['pending', 'approved', 'rejected'];

  if (status && !allowedStatuses.includes(status)) {
    return jsonError(c, 'INVALID_STATUS', 'Status must be pending, approved, or rejected.', 400);
  }

  try {
    const where = status ? 'WHERE status = ?' : '';
    const bindValues = status ? [status] : [];

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM supplier_onboarding_applications ${where}`
    )
      .bind(...bindValues)
      .first();
    const total = Number(countRow?.total ?? 0);

    const offset = (page - 1) * limit;
    const rows = await c.env.DB.prepare(`
      SELECT id, business_name, contact_name, email, phone, location, bio,
             brochure_urls, categories, mode, status, created_at
      FROM supplier_onboarding_applications
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
      .bind(...bindValues, limit, offset)
      .all();

    const items = (rows.results ?? []).map((row: Record<string, unknown>) => ({
      id: row.id,
      businessName: row.business_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      location: row.location,
      bio: row.bio,
      brochureUrls: JSON.parse((row.brochure_urls as string) || '[]'),
      categories: JSON.parse((row.categories as string) || '[]'),
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
    }));

    return jsonPaginated(c, items, createPagination(page, limit, total), 'Supplier onboarding applications.');
  } catch (error) {
    console.error('Failed to list supplier onboarding applications:', error);
    return jsonError(c, 'ONBOARDING_LIST_FAILED', 'Could not load applications.', 500);
  }
});

export { adminSupplierOnboarding as adminSupplierOnboardingRoutes };
```

**Step 4: Mount both routes**

In `src/index.ts`:
- Add import with the other route imports (~line 4-14, alphabetical-ish placement near suppliers):
  ```typescript
  import { supplierOnboardingRoutes } from './routes/supplierOnboarding';
  ```
- In the no-JWT section after line 119 (`app.route('/api/public', publicRoutes);`):
  ```typescript
  app.route('/api/supplier-onboarding', supplierOnboardingRoutes);
  ```

In `src/routes/admin/index.ts`:
- Add import at top:
  ```typescript
  import { adminSupplierOnboardingRoutes } from './supplierOnboarding';
  ```
- Add mount after line 48 (`admin.route('/operations', operationRoutes);`):
  ```typescript
  admin.route('/supplier-onboarding', adminSupplierOnboardingRoutes);
  ```

**Step 5: Run tests + typecheck to verify**

Run: `npx vitest run tests/routes/supplier-onboarding.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no TS errors.

**Step 6: Commit**

```bash
git add src/index.ts src/routes/admin/index.ts src/routes/admin/supplierOnboarding.ts tests/routes/supplier-onboarding.test.ts
git commit -m "feat(routes): mount supplier-onboarding public POST and admin list endpoints"
```

---

### Task 4: Full verification + local end-to-end smoke

**Files:** none (verification only)

**Step 1: Run the full repo gates**

Run: `npm run test:run && npx tsc --noEmit && npm run lint`
Expected: full suite passes (pre-existing failures, if any, must be identified as pre-existing — run `git stash`-free baseline comparison only if failures appear in files you did not touch; report them, do not fix unrelated failures).

**Step 2: Local smoke test against the real worker**

Run: `npx wrangler dev --local` (in a background shell), then:

```bash
curl -s -X POST http://localhost:8787/api/supplier-onboarding \
  -H 'Content-Type: application/json' \
  -d '{"businessName":"Smoke Test Co","contactName":"Test Person","email":"smoke@example.com","phone":"+66000000000","location":"Bangkok","brochureUrls":["https://example.com/b.pdf"],"categories":[{"name":"Massage","memberCount":2}],"mode":"tirak"}'
```
Expected: `{"success":true,"data":{"applicationId":"..."},"message":"Application received."}` with 201. If the local D1 lacks the table, apply the migration locally first: `npx wrangler d1 execute tirak-development --local --file=migrations/012_supplier_onboarding.sql`.

**Step 3: Commit any fixes, then report**

Report the smoke-test response body verbatim. Deployment to staging/prod (`wrangler deploy` + `wrangler d1 migrations apply`) is a separate, human-gated step — do NOT deploy.
