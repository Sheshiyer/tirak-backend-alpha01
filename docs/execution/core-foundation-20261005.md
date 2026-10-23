# Core backend foundation — implementation receipt

## Scope

Fixed all six review findings from APPROVAL-REVIEW-FINDINGS-20261005.md against
the CONNECTED-CORE-CONTRACT-20261005.md. Added evidence routes, interest route,
QA boundary middleware, and migration 021. Real SQLite foundation tests cover the
full lifecycle.

## Changes

### Modified files
- `src/utils/supplier-onboarding.ts` — separated key hash from payload digest,
  added HMAC-derived status token for replay recovery, strict canonical
  applicationData validation (unknown keys rejected, currency=THB,
  timeZone=Asia/Bangkok, integer dayOfWeek, finite price, no duplicates)
- `src/routes/supplierOnboarding.ts` — fixed intake: separate key hash (UNIQUE)
  and payload digest, HMAC replay token, DB errors not swallowed, race recovery,
  email collision 409
- `src/routes/admin/supplierOnboarding.ts` — atomic D1 batch CAS approval:
  UPDATE pending first, INSERT SELECT users/profile/services/schedule
  conditioned on CAS success, CAS loser returns actual winning state, email
  after commit with truthful delivery status
- `src/routes/uploads.ts` — private evidence prefix guard: private-core-onboarding/
  refused before R2 fetch (encoded/case/path bypass tested)
- `src/index.ts` — added QA boundary middleware after CORS, evidence routes,
  interest routes, Idempotency-Key in CORS allowHeaders
- `src/utils/communication.ts` — QA email recipient guard (core-qa permits only
  mrhigh3r@gmail.com), EMAIL_PROVIDER disabled check

### New files
- `src/middleware/coreQa.ts` — QA boundary: JWT + active user + core_qa_accounts
  membership for all API routes in ENVIRONMENT=core-qa; bootstrap exception
  allowlist; no-cache headers; missing table 503; revoked 403
- `src/routes/evidence.ts` — POST /supplier-onboarding/:id/evidence with bearer
  statusToken, kind validation, R2 private prefix, DB metadata, duplicate
  idempotent-safe, R2/DB failure no false complete
- `src/routes/interest.ts` — POST /api/interest, normalized email/name/source,
  idempotent with key+digest, returns interestId
- `migrations/020_core_onboarding_lifecycle.sql` — updated: separate
  idempotency_key_hash (UNIQUE) and payload_digest columns
- `migrations/021_evidence_interest_cohort.sql` — evidence, interest, cohort
  tables; invitation_delivery_status column
- `wrangler.core-qa.toml` — copied from template; distinct D1/R2/KV/queues;
  ENVIRONMENT=core-qa, CORE_QA_MODE=cohort, EMAIL_PROVIDER=disabled

### New tests
- `tests/routes/core-foundation-lifecycle.test.ts` — 24 tests using real migrated
  SQLite (node:sqlite via comms-sqlite adapter): idempotency replay/conflict,
  email collision, canonical validation, full lifecycle approval/activation/
  profile/service/schedule, CAS loser, reject, interest idempotency, evidence
  auth/rejection/kind validation, QA boundary (anonymous/bootstrap/missing
  table/non-QA), public prefix guard

## Test results

- **604 tests pass across 48 test files** (up from 569/46)
- TypeScript typecheck: clean (zero errors)
- 24 new real SQLite foundation tests
- All existing mock tests updated for new batch-based approval flow

## Limits and remaining gates

- Real D1 batch semantics differ from SQLite's serial execution in comms-sqlite;
  the transactional wrapper provides equivalent rollback behavior for tests.
- QA cohort enrollment in approval batch requires core_qa_accounts table
  (migration 021); tests cover the "table missing" path.
- Email delivery remains truthful: EMAIL_PROVIDER=disabled in core-qa,
  provider acceptance ≠ delivery, KV failure blocks reset link send.
- wrangler.core-qa.toml copied from template; no JWT secret in Git.
- No deploy, remote SQL, secret reads, outbound sends, commit/push performed.
