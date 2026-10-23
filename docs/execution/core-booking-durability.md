# Core booking durability

Reviewed local candidate, 2026-10-05. Integration, QA deployment and physical acceptance remain separate.

## Behavior

Booking creation commits the booking row and its per-user idempotency record in one mandatory D1 batch. The booking insert precedes the foreign-key reference. Same UUID and payload replay the actual booking; changed payload returns409. A duplicate-key or overlap race rolls back the attempted batch and recovers a matching winner. Replay occurs before future-time or current guide eligibility checks, preserving recovery after expiry or archival. The optional legacy no-key path retains its existing behavior. UUID validation applies whenever a key is supplied.

Bangkok calendar inputs use explicit+07:00 for future-time checks, weekday selection and the three-hour reminder UTC timestamp. Availability and overlap rules remain enforced. Public guide eligibility rejects expired/malformed non-null trial dates; legacy null expiry retains existing active/verified guide semantics.

After persistence, analytics, notifications and reminder queue errors are non-fatal. Replays do not enqueue duplicate work. Confirmed/completed booking status never means a charge succeeded. With PAYMENT_MODE=disabled, payment output is pending and cancellation does not read payment tables. Historical reads remain participant-authorized even after a service is archived. There is no reschedule route in this candidate.

## Schema and rollout

Migration022 creates booking_idempotency with composite primary key(user_id,key_hash), canonical payload and separate digest, strict booking/user foreign keys and lookup indexes. Records contain an expiry timestamp; no automatic cleanup job is implemented here. Migration025 adds the fields already used by mobile booking handlers. Both are prerequisites for a fresh reviewed Core baseline. Existing targets may already carry booking columns and must be reconciled before any separately authorized migration. This candidate targets newly isolated QA first. Never blindly apply the whole migration directory or replay quarantined mobile/payment migrations.

The real SQLite durability tests load canonical baseline plus010,012,013,015,017,019,022,023,025,026; no payment008/011 or quarantined004. The shared adapter enforces foreign keys, propagates SQL errors, serializes batches and rolls back real faults. Tests exercise concurrent same/different payloads, per-user key isolation, lost-response replay, expiry/archive recovery, post-insert rollback, missing schema/batch failure, strict fixed-clock Bangkok checks, actual reminder messages, payment-table absence and participant history.

## Verification

Parent verification: TypeScript passed and531tests across48files passed before the final two queue-failure cases were added. Those additional cases directly exercise creation/replay and status confirmation with rejecting notification and analytics queues; the focused durability suite passes all23 cases. Production integration and browser/device proof remain unperformed. Standard commands after installing repository dependencies are npm run typecheck and npm run test. This isolated worktree uses the already installed adjacent dependency binaries without modifying dependencies.

## Remaining acceptance

Reconcile the shared SQLite helper with the onboarding candidate, run the combined full suite and an actual isolated workerd journey, initialize only the new reviewed QA resources, deploy the fenced API, validate admin oversight and native TestFlight/APK behavior, and record physical owner outcomes.
