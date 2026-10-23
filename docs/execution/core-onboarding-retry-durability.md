# Core onboarding retry durability

Date: `2026-10-05`

## Scope

This execution pass was limited to the owned files:

- `src/routes/admin/supplierOnboarding.ts`
- `src/routes/supplierOnboarding.ts`
- `tests/routes/core-onboarding-retry-durability.test.ts`
- `docs/execution/core-onboarding-retry-durability.md`

No changes were made to middleware, CORS, shared index/config wiring, lifecycle
test files owned by other workers, runtime scripts, or deployment state.

## Implemented corrections

- Public onboarding replay now requires both the stored `payload_digest` match
  and a reproducible `status_token_hash` match. Same key plus same payload now
  returns the exact persisted `applicationId`, `statusToken`, and current
  status on both the normal replay path and the unique-race recovery path.
- Public onboarding now fails closed on email-collision lookup faults instead of
  swallowing D1 errors, and the insert path is guarded with
  `WHERE NOT EXISTS (...)` to avoid partial `201` outcomes in same-email races.
- Corrupt replay state or key-rotation drift no longer degrade into a partial
  success response without a token. They now return a controlled
  `409 IDEMPOTENCY_RECOVERY_FAILED` while preserving the already-persisted row.
- Admin approval retries against an already approved application now return the
  persisted `approvedUserId`, `reviewedUserId`, current `status`, and stored
  invitation-delivery truth instead of a blanket `409`.
- Admin approval still rejects rejected or otherwise mismatched states with
  `409 ALREADY_REVIEWED`; it never reports a successful receipt when no real
  approved guide link exists.
- In `ENVIRONMENT=core-qa`, approval now fails closed before CAS unless the
  reviewer is both an active `users` admin and an active
  `core_qa_accounts(role='admin')` member. Missing QA tables surface `503`
  instead of silently skipping cohort enrollment.
- QA guide cohort enrollment remains inside the same atomic batch and is
  guarded by reviewer identity, application provenance, and active admin
  membership.
- Post-commit invitation reporting no longer invents `accepted`/delivered state
  in the API receipt or persisted application row. Provider acceptance keeps the
  user-facing delivery state at `pending`; failures persist `failed`.

## Verification

Targeted real SQLite durability suite:

```bash
npx vitest run tests/routes/core-onboarding-retry-durability.test.ts --reporter=verbose --testTimeout=10000
```

Observed result:

- `7/7` tests passed.
- Coverage includes deterministic replay, unique-race recovery,
  key-rotation/hash mismatch fail-closed behavior, same-email concurrency,
  already-approved admin retries, core-qa reviewer gating, atomic rollback on
  QA cohort insert failure, and truthful invitation-delivery persistence.

Full repository verification was run after the targeted suite:

```bash
npm run typecheck
npm run test
```

Those command results are recorded in the final handoff for this task.

## Known limits

- This pass does not claim any deployment, migration apply, secret mutation,
  runtime script change, or external email delivery proof.
- The structured email-delivery operational log still records provider
  acceptance as `accepted` inside `recordEmailOutcome`; this pass intentionally
  did not modify shared communication utilities outside the owned surface.
