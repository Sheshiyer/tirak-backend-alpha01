# T-025 Staging Resource Identity and Ledger Evidence

Status: **ACCEPTED — HUMAN-CONFIRMED STAGING IDENTITIES; T-026 SEPARATELY GATED**

Generated: `2026-07-21`

Offline provisioning build updated: `2026-07-21`

Contract: `tirak-payments-v1`

Authority: T-024 permits authenticated read-only staging discovery. On `2026-07-21`, the human release owner additionally authorized staging resource provisioning or renaming in the pinned account. That authority covered only the exact frozen staging identities and inert evidence bootstrap; it did not authorize deletion, production access, live Omise activity, App Store submission, application deployment, secret mutation, D1 application-schema migration, or bypass of later task gates.

## T-025 staging-only provisioning build

The repository contains a bounded provisioning implementation, and the explicitly authorized live staging run completed on `2026-07-21`. It created the exact D1, two KV namespaces, R2 bucket, six queues, inert Worker, and two SQLite Durable Object namespaces. The first Worker upload attempts failed before creation because the module part used the classic-script media type; the durable ledger retained the partial history, the media type was corrected to Wrangler's `application/javascript+module`, and the conditional retry converged. A second identical apply reused all 11 resources with `exactMissingDiff: []` and zero remote mutation attempts. No deletion, rename, production, secret, D1 application-schema, live Omise, or App Store mutation occurred.

`npm run staging:provision:plan` is the default read-only entry point. There is deliberately no package script for apply. A live create run is reachable only by directly invoking `scripts/staging/provision-staging-resources.mjs` with both `--apply` and the exact confirmation `APPLY T-025 STAGING-ONLY RESOURCE CREATION`. The account and resource manifest cannot be overridden: account `2c0c96c68f0ee73b6d980054557bca5b`; Worker `tirak-backend-staging`; D1 `tirak-staging`; KV `tirak-cache-staging` and `tirak-sessions-staging`; R2 `tirak-storage-staging`; producer queues `tirak-moderation-staging`, `tirak-analytics-staging`, and `tirak-notification-staging`; and their matching three `-dlq-staging` queues.

Every plan/apply performs a fresh complete account and five-resource inventory before computing the exact missing diff. The documented Worker `SinglePage` response is accepted without pagination metadata, but any metadata the API supplies must prove the exact returned count and one-page completeness. Directly before a create-only Worker upload, apply repeats the pinned-account `GET` and the complete Worker list; an appearing exact Worker, any list-evidence drift, omission/truncation evidence, or inability to prove absence refuses the upload. An existing exact Worker is reported as unproven and apply refuses it without mutation because this bootstrap provisioner does not independently prove an existing Worker's active topology.

Apply creates only missing resources, one request at a time, and performs another complete inventory before convergence. D1 creation is exactly pinned to `primary_location_hint: apac` with `read_replication.mode: disabled`; R2 creation is pinned to `locationHint: apac`. The allowlist contains only the required `GET`, create `POST`, bootstrap-Worker `PUT`, and exact Worker-subdomain-control routes. After a successful create-only upload, apply sends exactly `{enabled:false, previews_enabled:false}` to the fixed Worker subdomain endpoint and immediately `GET`-verifies the same two-field state. No route endpoint is allowed. Unknown methods/endpoints/bodies, redirects, account/name drift, duplicates, malformed/incomplete pagination, and malformed results fail closed. Delete, rename, generic update, production, secret, email, Queue-consumer, and D1-schema operations have no implementation path.

The provisioning ledger is written incrementally and atomically as an owner-only `0600` file, and its local path is Git-ignored because Git cannot preserve owner-only semantics. Before a retry begins discovery, the preceding attempt is projected into a bounded append-only `attemptHistory`; failure→retry convergence and retry-discovery failure therefore cannot erase a prior `PARTIAL_FAILURE_DURABLE` record. The ledger retains only safe target identities, complete-inventory counts, pre/post fingerprints, exact missing diff, created/reused/failed outcomes, safe error codes, and mutation counts. It separately records the one allowed Worker-subdomain disable control and the planned/attempted/accepted Durable Object `v1` initialization lifecycle, while explicitly retaining zero production, delete, rename, secret, and D1-schema mutations. Tokens, headers, request bodies, query/continuation values, unrelated resource names, and raw errors are never serialized.

`wrangler.staging-bootstrap.toml` and `scripts/staging/bootstrap-worker.mjs` are isolated from the T-036 application deployment. The config disables `workers_dev`, declares no routes, consumers, secrets, or email bindings, and contains only the frozen D1/KV/R2 bindings, three producer bindings, disabled-payment variables, and the two SQLite Durable Object classes in migration `v1`. The actual REST multipart uses the current Wrangler upload shape `migrations: {new_tag:"v1", steps:[{new_sqlite_classes:["ChatRoom","NotificationService"]}]}` rather than serializing TOML's `[[migrations]]` form. Its D1/KV config identifiers are conspicuous dry-run sentinels, not claimed live identities. The module exports no queue handler and every fetch surface returns `503` with `Cache-Control: no-store`.

Fresh D1 acceptance now records `sqlite_schema` evidence with explicit exclusion of `sqlite_%`, `_cf_%`, and the `d1_migrations` bookkeeping table. A numeric nonnegative `userTableCount: 0` that agrees with an empty explicit user-table list is accepted; malformed, negative, duplicate, unsorted, or count/list-inconsistent evidence remains blocked. Non-empty databases still require a strict one-to-one row-count inventory.

The CLI loads the fixed `.env.tirak-staging` path only through the existing restricted parser after Git-ignore/untracked, regular-file, owner, and exact-`0600` checks; shell sourcing is not required and token material is never printed.

Offline verification is provided by `npm run staging:provision:test`; its 39 checks cover plan/full apply, strict Worker SinglePage evidence, immediate absence recheck plus atomic `If-None-Match: *` create-only upload, PUT-race refusal without overwrite, asynchronous exact multipart/source-digest validation, ETag-digest-bound provenance and modification refusal, APAC request bodies, subdomain disable/verification, same-ledger control-only recovery, provenance-bound zero-mutation convergence, unproven existing-Worker refusal, fresh post-inventory, retry convergence/history preservation, serialized creation, durable partial failure, duplicates, account/name/confirmation/endpoint/method/body/pagination/response/redirect refusal, redaction, ignored-ledger/credential-loader policy, and the static bootstrap contract with zero live requests. Bootstrap syntax/config resolution is separately checked by `npm run staging:bootstrap:dry-run`. Both are offline-only and neither authorizes or performs a live deployment.

## Outcome

T-025 uses Cloudflare's official REST API through a fixed deny-by-default read-only client because Wrangler OAuth did not expose the authenticated metadata path required by the frozen evidence contract. This transport change was a **proposed acceptance variance**, not an assumed pass. Its exact descriptor is included in `targetFingerprint`, and the human release owner's exact fingerprint confirmation explicitly accepted that variance. The strict final verifier now passes, so T-025 is accepted and T-026 is unblocked but remains a separate evidence-gated task with no mutation authority inherited from this confirmation.

Authenticated preflight passed for the pinned account. After provisioning, two consecutive strict discovery runs produced the same target fingerprint, `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10`, with 16 allowlisted read-only requests each, zero production commands, zero remote mutations, and zero secrets captured. Exact Worker, D1, KV, R2, Queue/DLQ, and SQLite Durable Object identities all pass. The active Worker reports `ENVIRONMENT=staging`, `PAYMENT_MODE=disabled`, `PROMPTPAY_ENABLED=false`, and migration tag `v1`.

Cloudflare refuses both read-only SQLite user-version forms with `SQLITE_AUTH` code `7500`. The fingerprinted evidence therefore accepts `schemaUserVersion: 0` only under the strict fresh-empty invariant: D1 detail reports `num_tables: 0`; `sqlite_schema` returns no user or migration-ledger tables; the independent count query returns zero; the row-count manifest is exactly empty; and the provisioning ledger proves no D1 schema mutation. Any disagreement remains fail-closed.

The human release owner confirmed the exact fingerprint and statement. The main `wrangler.toml` now contains only the exact remote-matched staging D1 and two KV identities from `proposedConfiguration`; final read-only rediscovery preserved the fingerprint, removed every blocker, and reached `HUMAN_CONFIRMED_STAGING_IDENTITIES` with `resourcesVerified: true` and `mutationAllowed: false`.

The provisioning authority has now been consumed for the exact staging bootstrap. The current broad token remains capability rather than authority for any other action. Rotation requires separate secret-mutation authority and was not performed by T-025.

The populated credential file is deliberately absent from Git. The collector never serializes the token, request headers, response error bodies, or secret-valued Worker bindings. The JSON ledger is written atomically as an owner-only regular file with mode `0600`.

## Local credential setup

Do not paste a token into chat, an issue, a shell command, or a committed file. Prefer an account-scoped read-only token instead of a full-scoped token.

```bash
cp .env.example .env.tirak-staging
chmod 600 .env.tirak-staging
```

Edit `.env.tirak-staging` locally and populate `TIRAK_CLOUDFLARE_API_TOKEN`. The account remains pinned to `2c0c96c68f0ee73b6d980054557bca5b`. Before reading the file, both preflight and discovery prove the fixed path is Git-ignored and untracked. The parser accepts only the three keys in `.env.example` and refuses symlinks, non-regular files, wrong ownership, modes other than `0600`, duplicates, unknown keys, interpolation, command substitution, multiline values, and NUL bytes.

That proof is point-in-time protection at credential load, not an absolute claim that Git can never be forced to stage the file. A later manual `git add -f` remains an operator residual; release review must continue to verify that `.env.tirak-staging` is untracked and absent from staged changes.

The preferred token is restricted to this one account with `Workers Scripts Read`, `D1 Read`, `Workers KV Storage Read`, `Workers R2 Storage Read`, and `Queues Read`. Those reads cover the account/resource evidence in T-025; the collector does not require edit permissions. If a temporary full-scoped token is used, preflight reports only the coarse `write-capable-or-broad` risk classification. It must be rotated under separate secret-mutation authority before later sensitive work; T-025 does not authorize or perform that rotation.

Then run:

```bash
npm run staging:preflight
npm run staging:discover
```

`staging:preflight` performs token verification, one current-token details `GET` bound to the identifier returned by that verification, and the exact pinned-account `GET`. It emits only whether the policy is `read-only` or `write-capable-or-broad` and whether the pinned account is included. It emits no permission names, account name, token identifier, token value, request headers, or raw response. Both official flat and nested resource maps are accepted, but every level must be a nonempty plain object with valid Cloudflare resource keys and `*` leaves; depth and total entries are bounded. Malformed policy/resource data, a mismatched details identifier, or absence of the pinned account fails closed. The full discovery begins only after that check passes.

Discovery repeats `inspectCurrentTokenScope`; preflight alone cannot authorize or bypass discovery. The ledger retains only the coarse permission-risk class, successful pinned-account inclusion, and verification type.

## Read-only API boundary

`scripts/staging/cloudflare-read-only-client.mjs` hardcodes `https://api.cloudflare.com/client/v4`, the pinned account, and `tirak-backend-staging`. It permits only:

- token verification, exact verified-current-token details, and the pinned account identity preflight;
- Worker script listing, active deployments, and exact active version details;
- D1 list/detail plus internally generated, single-statement `SELECT` queries;
- KV namespace, R2 bucket, Queue, and Durable Object namespace listing.

The details endpoint is enabled transiently only for the exact safe identifier returned by the successful verify response; unknown, caller-selected, and stale token-detail paths remain outside the allowlist. Its request evidence uses a fixed placeholder and cannot retain the identifier. All redirects are refused. Requests have bounded timeouts, response-size limits, endpoint-specific bounded pagination, and sanitized errors. Queue enumeration follows Cloudflare's bounded page metadata and refuses inconsistent or incomplete results. D1 query responses must contain exactly one successful result and prove numeric `changes: 0` and `rows_written: 0` without type coercion.

The collector filters exact staging candidates immediately and never persists production list entries. Active Worker version responses are reduced immediately to the configured staging D1, KV, R2, Queue, and Durable Object bindings; unrelated and secret-valued binding types are discarded before comparison or evidence persistence. A second projection retains only compliance states for `ENVIRONMENT`, `PAYMENT_MODE`, `PROMPTPAY_ENABLED`, and the migration tag—never arbitrary plain-text values. Every active gradual-deployment version must agree on both projections.

## Missing-match diagnostics

When an exact frozen resource match is absent or ambiguous, the ledger persists a bounded informational diagnostic instead of raw Cloudflare list responses. It contains aggregate observed counts and, only for unresolved resource types, minimal staging-only candidate projections for Worker, D1, KV, R2, Queue/DLQ, and Durable Object resources.

- Every candidate name must satisfy the existing staging-name predicate, a bounded resource-name shape, and an explicit rejection of `prod`, `production`, and `live` segments.
- Worker and R2 candidates retain names only. Queue candidates also retain names only. D1 and KV candidates retain identifiers only after their names pass the staging filter and their identifiers pass the existing UUID/32-hex shapes. Durable Object candidates retain only the staging Worker name, bounded non-production-like class name, and SQLite boolean; namespace identifiers and unknown fields are discarded.
- Each observed resource count is bounded at `10,000`, their aggregate at `60,000`, each candidate list at `20`, and all candidate lists together at `100`. Malformed or excessive candidate projections fail closed.
- Unknown response fields, production-like names, unrelated account resource names, secret bindings, headers, token data, and raw responses are never retained.
- Diagnostics set `informationalOnly: true`, `acceptanceEffect: NONE`, and `mutationAllowed: false`. They cannot make an identity check pass or authorize any change.

These diagnostics are explicitly excluded from `targetFingerprint`: they are troubleshooting context, not a human-reviewed resource selection. Tests prove that bounded count-only changes do not alter the fingerprint or exact-match acceptance behavior. If a candidate is later selected for identity correction, it must first become authenticated exact evidence through the normal frozen-match and human-confirmation flow; the diagnostic itself is never promoted.

## Historical pre-provisioning adjudication (superseded)

The following section records why the `2026-07-20` zero-candidate run stopped safely. It is historical and has been superseded by the live provisioning and repeated discovery evidence above.

The current verdict is `BLOCKED_ON_STAGING_RESOURCE_STATE_AND_AUTHORITY`, not an authentication, response-shape, or unverified-classifier failure:

- **Authentication and target account — PASS:** account-token verification, current-token policy inspection, and the exact pinned account identity request succeeded. The credential loader, client constructor, account response check, and every account-scoped path independently pin the same account identifier.
- **Live response parsing — PASS:** all six resource list endpoints returned trusted `200` JSON envelopes, `discoveryError` is absent, and bounded arrays containing 58 resources reached the diagnostic projector. A response-shape or pagination defect would have failed closed instead of producing counts.
- **Staging classification — PASS:** the same `buildSafeResourceDiagnostics` function used by the collector and offline fixtures applies `isStagingName`, explicit production-segment refusal, identifier validation, field minimization, and cardinality limits. A staging-labeled D1/KV entry with a malformed identifier would raise `RESOURCE_DIAGNOSTIC_INVALID`; it cannot disappear silently. The live projection contains zero candidates for every type, matching the zero-candidate fixture behavior without persisting a non-staging resource name.
- **D1 query omission — INTENTIONAL:** D1 detail and collector-owned `SELECT` queries are reachable only after exactly one frozen `tirak-staging` database exposes a valid UUID and matches the active Worker binding. No such database exists in the live evidence, so constructing a query target would require guessing an identity and was correctly refused.
- **Freshness and eventual D1 execution — BOUNDED:** token scope, account identity, resource lists, active deployment/version bindings, D1 detail, and any D1 queries are fetched inside one collector process; no binding result is loaded from a cache or prior ledger, and every rerun reauthenticates. The current blocked run never entered the D1 branch. Before a future complete T-025 run is accepted, the strict manifest must still prove the exact active binding and query target from that run; a post-query deployment re-read is a defensible additional TOCTOU hardening if the staging Worker can change concurrently.
- **Mutation gate — CODE-ENFORCED:** `classifyAllowedPath` in `cloudflare-read-only-client.mjs` contains no create, update, delete, deploy, rename, secret, migration-apply, Omise, App Store, or production route. Its only allowed `POST` is the exact D1 `/query` path, and `assertReadOnlySelect` plus the collector-owned template validator refuse everything except one bounded `SELECT`. The collector exposes no generic request or provisioning command to operators.
- **Account data state — BLOCKED:** resources exist in the account, but none is an exact or staging-safe Tirak candidate under the frozen naming boundary.
- **Authority — BLOCKED:** creating or renaming the required staging resources, or changing the pinned account, exceeds T-024. The broad token is capability, not permission to act.

“Safely blocked” therefore means: target authentication proved; all permitted reads succeeded; response parsing and classifier paths were live-exercised; no target identity was guessed; strict acceptance still fails; zero production commands, D1 queries, remote mutations, and secret captures occurred; and the only plausible next actions require a new explicit authority decision.

## Identity and migration gates

The collector requires unique exact matches for the Worker, D1 database, two KV namespaces, R2 bucket, all queues/DLQs, and both SQLite-backed Durable Object bindings. It separately captures Cloudflare's D1 platform/storage version and SQLite `user_version`, plus the migration ledger and per-table row counts through read-only queries. Active runtime must remain staging with payments and PromptPay disabled, and its Durable Object migration tag must match the configured staging tag.

Pending migrations are computed by comparing full local filenames against `d1_migrations`. The repository currently contains both `004_background_jobs_tables.sql` and `004_mobile_app_features.sql`. Discovery records this as `migrationLineage.status: blocked_pending_T028`, including the duplicate prefix and filenames, but it does not suppress the remote migration ledger, schema version, per-table row counts, or resource-identity evidence needed by T-025. It grants no migration mutation authority. T-028 owns the separately reviewed lineage decision.

Placeholder D1/KV identifiers in `wrangler.toml` do not prevent read-only discovery, but they do prevent final T-025 acceptance. Authenticated evidence produces a concrete `proposedConfiguration` inside the ledger. The evidence fingerprint deliberately depends on the authenticated target and proposal, not on whether those same identities have already replaced placeholders in local configuration.

`PROPOSED_CONFIGURATION_EXACT` is a machine blocker unless the proposal contains exactly one `DB`/`tirak-staging` UUID matching both the unique remote D1 list result and D1 detail, plus exactly `CACHE` and `SESSIONS` identifiers matching the unique verified namespace evidence. Missing, malformed, mismatched, duplicate, or extra proposal fields prevent the placeholder-only intermediate approval state, so the confirmation workflow cannot authorize correction from an unproven proposal.

This creates a non-cyclic two-stage gate:

1. Read-only discovery captures evidence and a fingerprint while placeholder configuration remains a blocker.
2. The human release owner may record the exact fingerprint and exact `CONFIRMATION_STATEMENT`. This also accepts the fingerprinted REST metadata variance, but leaves T-025 in `HUMAN_CONFIRMED_PENDING_LOCAL_CONFIGURATION_CORRECTION`, keeps `resourcesVerified: false`, and keeps `mutationAllowed: false`.
3. That intermediate state authorizes only replacement of staging D1/KV placeholders with the exact `proposedConfiguration` identities.
4. Discovery is rerun. It safely reloads the prior confirmation, recomputes the fingerprint, checks configured identities against remote evidence, and accepts the confirmation only if the fingerprint is unchanged and every blocker is gone.

## Verification

- Manifest: `docs/execution/phase-2/t-025-staging-resource-ledger.json`
- Manifest SHA-256: `9a57d8436120ed8f22d52f6a5e455fbc378a61bbd728a8825ba6124934fb9e87`
- API requests executed in current evidence: `16` allowlisted read-only requests, including D1 detail and collector-owned zero-write queries
- Production commands executed: `0`
- Remote mutations executed: `0`
- Secrets captured: `false`
- Ledger file mode: `0600`
- Positive evidence, diagnostic fingerprint exclusion, exact human gate, two-stage transition, lineage deferral, and mutation-boundary fixtures: `npm run staging:verify:fixtures`
- Strict final-manifest refusals: `30/30 PASS`
- Staging negative fixtures: `38/38 PASS`
- Direct API mock checks: `33/33` refusal fixtures plus positive SinglePage, page-pagination, cursor-pagination, redaction, and scope checks pass
- Live Cloudflare requests from tests: `0`

The direct API tests cover the allowed current-token details `GET`, flat and nested resource maps, nested pinned-account and broad-scope classification, nested array/non-star/empty/deep/oversized refusal, unknown and stale token-detail refusal, identifier redaction, read-only/write-capable/broad classification, malformed and mismatched policy refusal, allowed discovery calls, page and cursor pagination, wrong account/host/path/method, incomplete Queue results, non-SELECT, multiple statements, `WITH`, `LOAD_EXTENSION`, unowned SQL templates, strictly numeric D1 mutation metadata, hostile error redaction, production-binding filtering, safe runtime projection, production-like diagnostic exclusion, malformed/excessive diagnostic refusal, secret-file permissions/symlinks, and Git ignore/tracking behavior. Collector subprocesses use an explicit forced-absent credential mode, so verification cannot read a real token file or make a live Cloudflare request after one exists.

Strict final-manifest verification derives the complete allowed request set from the manifest's pinned account, frozen Worker, active version IDs, exact D1 identity, and row-count table inventory. It requires successful token verification/details/account evidence; Worker list/deployment/every active version; D1 list/detail and the exact expected number of collector-owned `SELECT` requests; and KV, R2, Queue, and Durable Object lists. Missing, extra, duplicated singleton, wrong-account, wrong-Worker, wrong-D1, unsafe status, and unsafe outcome records fail. Account tokens may contain exactly one initial user-token verification failure (`401` or `403`) before successful account-token verification and details. The first D1 `SELECT` may contain exactly one `400` failure only when the fingerprinted schema-version proof is the exact `SQLITE_AUTH` code `7500` pristine-empty fallback; absent, reordered, or differently statused fallbacks fail. No other failed request is accepted.

Every successful list record additionally retains only `pagination: { mode, ordinal, resultCount }`: Worker uses `single`; D1, KV, Queue, and Durable Objects use `page`; R2 uses `cursor`. Values and cursor tokens are never retained. The final verifier requires the exact three-field shape, correct mode, contiguous one-based ordinals in transcript order, bounded nonempty pages for nonzero inventories, and result-count sums exactly equal to the matching `resourceDiagnostics.observedCounts`. Non-list operations must not contain pagination metadata. Missing metadata, duplicate/skipped ordinals, wrong modes, wrong aggregate totals, pagination on non-list records, and extra pagination fields fail closed.

## Human confirmation boundary

When authenticated evidence is complete, the ledger computes `targetFingerprint`. The human release owner must confirm that exact fingerprint using `CONFIRMATION_STATEMENT` from `scripts/staging/staging-ledger-lib.mjs`. That confirmation still leaves `mutationAllowed: false` and does not authorize deployment, migration application, secret mutation, production activity, live Omise charging, or App Store submission.

The confirmation command accepts only the exact current fingerprint and exact statement, rereads and recomputes the owner-only ledger, refuses every non-placeholder machine blocker, and writes atomically with mode `0600`:

```bash
npm run staging:confirm -- --fingerprint '<exact-targetFingerprint>' --statement 'I confirm the T-025 staging resource ledger fingerprint and authorize the listed staging identities for later evidence-gated staging work. This does not authorize production access, deployment, migration application, secret mutation, live Omise charging, or App Store submission.'
```

`npm run staging:verify` is the strict completion gate. It intentionally fails unless resources are verified, configuration has no placeholders, the fingerprint and exact confirmation recompute, the REST variance is accepted, status is final, the request log remains read-only, the owner-only file mode is `0600`, and all zero-production/zero-mutation/zero-secret assertions hold. Use `npm run staging:verify:fixtures` for offline verifier fixtures before the live manifest reaches that final state.
