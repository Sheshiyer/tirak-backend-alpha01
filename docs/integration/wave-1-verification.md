# Wave 1 Verification Notes

Date: 2026-05-18

## Commands Run

### Dependency Install

`npm install`

Initial result: failed due to `vitest` 3.x conflicting with `@vitest/coverage-v8` 1.x.

Resolution applied: updated `@vitest/coverage-v8` in `package.json` from `^1.6.0` to `^3.2.4`.

Second result: install succeeded.

Package lock now resolves:

- `hono` to `4.12.19`.
- `jws` to `3.2.3`.
- `@vitest/coverage-v8` to `3.2.4`.

### Typecheck

`npm run typecheck`

Result: failed.

Representative failure clusters:

- Hono middleware return typing: multiple `TS7030` not-all-code-paths-return errors in `src/middleware/*`.
- D1 result typing: multiple `{}` / `unknown` values passed into `JSON.parse`, `Date`, arithmetic, or response objects.
- Validation middleware typing: `c.req.valid('query')` inferred as `never` in several routes.
- Profile type drift: mobile fields such as `dateOfBirth`, `gender`, `profileImages`, and `notificationPreferences` are used but missing from shared types.
- WebSocket event union mismatch: `"error"` and `"connected"` are sent but not allowed in the event union.

Follow-up repair result:

`npm run typecheck -- --pretty false`

Result: still failed.

Fixed clusters:

- Shared middleware now returns `await next()` consistently.
- WebSocket service event union now includes connection, pong, and error events.
- Route pagination/date validation no longer reads `c.req.valid('query')` from the custom validation middleware path.

Remaining representative clusters:

- Background jobs still have strict-null and `PromiseSettledResult` narrowing issues.
- D1 rows still flow as `unknown` / `{}` into `JSON.parse`, `Date`, arithmetic, and response payloads in multiple routes.
- Profile/user routes still reference fields not represented in the current shared database types.
- Upload routes still need multipart/file presence guards before using `File` values.

### Tests

`npm run test:run`

Result: failed.

Summary:

- 6 test files failed.
- 37 tests passed.
- 107 tests failed.

Representative failure clusters:

- Test utilities expect exports that no longer exist or were renamed, including `executeQuery`, `buildPaginationQuery`, `sanitizeInput`, `validateUUID`, `formatDatabaseError`, `userRegistrationSchema`, `userLoginSchema`, `bookingCreateSchema`, `reviewCreateSchema`, `validateEmail`, `validatePhone`, and `validatePassword`.
- Route tests instantiate Hono routes without passing Cloudflare env bindings, causing `c.env.CACHE` and `c.env.DB` runtime errors.
- WebSocket tests use Node `Response`, which rejects status `101`; Cloudflare Workers supports the upgrade response shape, so test harness needs an environment-compatible adapter.

Follow-up repair result:

`npm run test:run -- --reporter=default`

Result: still failed, but improved materially.

- 4 test files passed.
- 2 test files failed.
- 112 tests passed.
- 32 tests failed.

Focused suites now passing:

- `tests/utils/database.test.ts`: 31/31.
- `tests/utils/validation.test.ts`: 31/31.
- `tests/utils/auth.test.ts`: 23/23.
- `tests/services/websocket.test.ts`: 26/26.

Fixed clusters:

- Restored current compatibility exports for backend database, validation, and auth utilities.
- Added Node-test-compatible WebSocket upgrade response handling while preserving Cloudflare Workers status `101` semantics.
- Corrected route test harness calls so Cloudflare env bindings are passed as the third Hono `app.request` argument.

Remaining test clusters:

- `tests/routes/auth.test.ts` still expects an older route contract for login identifiers, refresh/OTP paths, and error envelope codes.
- `tests/routes/bookings.test.ts` still uses magic `Bearer valid-jwt-token` values while production middleware verifies signed JWTs and active database users.
- Booking route tests need a realistic auth fixture and DB prepare mock that supports both auth lookup and booking queries.

### Production Audit

`npm audit --omit=dev --json`

Initial result: failed with 2 production vulnerability groups:

- `hono`: high severity group, fix available.
- `jws`: high severity transitive dependency group, fix available.

Resolution applied: `npm audit fix --omit=dev`, followed by `npm install` to restore dev dependencies.

Final production audit result: 0 vulnerabilities.

### Full Dev Audit

`npm audit --json`

Result: still reports 5 dev-only vulnerability groups:

- `defu`
- `happy-dom`
- `miniflare`
- `undici`
- `wrangler`

## Wave 1 Status

Toolchain install and production dependency audit are fixed. Backend correctness is not verified yet. Typecheck, test harness, duplicated migrations, and dev-tool advisories remain launch blockers before staging deployment.

### Muse Migration Syntax Check

Command:

`sqlite3 :memory: '.read migrations/001_initial_schema.sql' '.read migrations/005_muse_ai_foundation.sql' '.tables'`

Result: passed. The new Muse tables load against the base schema in SQLite.
