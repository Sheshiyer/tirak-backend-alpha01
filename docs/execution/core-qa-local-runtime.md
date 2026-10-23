# Core QA local runtime

This document covers the owned disposable local Core QA runtime harness only.
It never targets retained or remote infrastructure.

## Scope

- Script entrypoint: `scripts/core-qa/run-local-runtime.mjs`
- Deterministic fresh schema generator: `scripts/core-qa/fresh-schema.mjs`
- Runtime tests: `tests/runtime/core-qa-fresh-schema.test.ts`, `tests/runtime/core-qa-local-runtime.test.ts`
- Actual app surface: bundled `src/index.ts` with the real routes, middleware, D1, KV, R2, queues, and durable objects.

## Frozen schema lineage

The harness generates a disposable fresh schema from the accepted frozen chain only:

- `baseline/canonical-baseline.sql`
- `010_booking_chat_expansion.sql`
- `012_supplier_onboarding.sql`
- `013_supplier_onboarding_review.sql`
- `015_account_trust.sql`
- `017_core_guide_management.sql`
- `019_password_reset_consumptions.sql`
- `020_core_onboarding_lifecycle.sql`
- `021_evidence_interest_cohort.sql`
- `022_core_booking_idempotency.sql`
- `023_core_customer_registration_fields.sql`
- `024_core_api_repairs.sql`
- `025_core_booking_mobile_fields.sql`
- `026_core_notification_prerequisites.sql`

Excluded by design: payment `008`, payment `011`, quarantine `004`, chat `009`, and payment `014`.

## Guards

- All state is disposable and local-only.
- Synthetic secrets are written under a mode `600` file outside Git in a temp root.
- The script removes the temp runtime root during cleanup.
- The Worker bundle comes from `wrangler deploy --dry-run --config wrangler.core-qa.toml --outdir .wrangler/core-qa-local-runtime`, not a hand-rolled `esbuild` bundle.
- The harness does not override `HOME` or shared Wrangler config; the repository `wrangler.core-qa.toml` dry-run config is the only bundle input.
- The generated schema is byte-deterministic; no timestamp is embedded, and the baseline `.sql` bytes must match the pinned baseline hash, not only the `.sha256` sidecar.
- Only sanitized counts, statuses, and integrity summaries are written to the proof artifact.
- Passwords, JWTs, reset tokens, capability tokens, and raw synthetic account rows are never printed.
- The script seeds only three baseline synthetic cohort accounts directly with local `bcryptjs` hashes (`admin`, `traveler`, `ordinary`), then exercises the actual onboarding approval and invite-activation flow to create the synthetic guide.
- The script uses real auth logins to obtain admin/traveler/ordinary/guide tokens; it does not mint manual JWTs for the journey.
- Every route expectation is asserted exactly by HTTP status, canonical envelope shape, IDs, and key values. Any mismatch throws immediately.
- Diagnostics stay bounded and sanitized on failure: status, `error`, `message`, and short body preview only. Raw bodies and secrets are never dumped.
- Hard timeout: 180 seconds.

## Run

```bash
node scripts/core-qa/run-local-runtime.mjs
```

The script writes bounded artifacts under `scripts/core-qa/generated/`:

- `core-qa-fresh-schema.sql`
- `core-qa-local-proof.json`
- Wrangler-emitted local bundle under `.wrangler/core-qa-local-runtime/index.js`

## Parent runtime verification

On 2026-10-05 the parent operator ran the actual Wrangler bundle in Miniflare/workerd and completed108 strict route steps. Ticket-only socket upgrade returned101, replay401, and a REST message was broadcast through the live socket. Foreign-key violations were zero. Application, evidence, activation, verification, publication, booking and terminal chat history were persisted; completed booking payment remained pending and earnings unavailable.

The external producer seat cannot bind loopback (`listen EPERM`); that seat limitation does not apply to the successful parent execution. Fixture rate-window resets remove only disposable `ratelimit:` KV keys between journey phases; production limits are unchanged.49 inactive pagination fixtures use batches of8 inserts below D1's100-bound-parameter limit.

## Current proof status

- The generator verifies both the pinned baseline sidecar hash and the actual baseline SQL bytes hash, then emits a deterministic combined schema artifact.
- The runtime script first asks Wrangler to emit the same Worker bundle shape it would deploy, then feeds that `index.js` bundle to Miniflare with the real durable object class bindings.
- The scripted journey now follows the actual Core QA contract end to end: valid traveler register, supplier onboarding intake + replay + status token read, evidence upload, admin approval, invite activation, owner guide service/schedule management, admin moderation verification, traveler-only discovery/public visibility, future Bangkok booking create + replay + changed-payload conflict, guide confirm/completed with payment remaining `pending`, admin booking queue reads, participant chat create/send/read/search/socket-ticket with outsider denial, service archive, and preserved booking/chat history after archive.
- Anonymous and non-cohort users are asserted hidden or denied in the actual QA boundary cases rather than treated as public discovery callers.
- The proof artifact records only sanitized statuses, route/method sanity results, integrity checks, cohort linkage facts, idempotency digests, reset-consumption count, and non-secret booking/chat/public visibility outcomes.
- If Miniflare/workerd cannot bind loopback in this seat and exits with `listen EPERM`, the artifact remains `ok=false` with `verificationState: "unverified"`; that condition is reported as environment-blocked, not as a passed proof.

## 2026-10-05 chat QA boundary correction

- Historical participant reads are intentionally split from live chat eligibility.
  Persisted booking chat history remains readable only to the exact traveler and
  assigned guide for terminal bookings (`completed`, `cancelled`) through room
  list/detail, message search, and mark-read.
- Live chat actions remain limited to active booking states
  (`confirmed`, `in_progress`): room create, message send, socket-ticket issue,
  and websocket upgrade are denied once the booking becomes terminal.
- In `ENVIRONMENT=core-qa` with `CORE_QA_MODE=cohort`, the boundary now owns
  only the exact no-bearer websocket route
  `GET /api/chat/rooms/:roomId/ws?ticket=...`. It validates the hashed ticket
  against D1 without consuming it, requires an active DB user, exact room/user
  binding, active QA cohort membership, and guide provenance. The chat route
  performs the atomic single-use consume immediately before the websocket is
  forwarded.
- QA no-cache headers are re-applied after downstream handlers return so a
  later route cannot replace them with public asset caching headers. Early
  boundary failures still fail closed with the same no-cache envelope.
