# Core QA hosted runtime

This surface owns only `scripts/core-qa-hosted/*`. It is the production-hosted
adapter for the parent-owned local journey contract in
`scripts/core-qa/run-local-runtime.mjs` and does not replace that file.

## Scope

- Hosted entrypoint: `scripts/core-qa-hosted/run-hosted-runtime.mjs`
- Hosted adapter library: `scripts/core-qa-hosted/adapter.mjs`
- Hosted helper tests: `scripts/core-qa-hosted/adapter.test.mjs`
- Parent dependency: exported `runJourney({ worker, secrets, proof })` from
  `scripts/core-qa/run-local-runtime.mjs`

## Boundaries

- During development of this adapter, no remote requests or mutations were run.
- The adapter is fail-closed until the parent file exports `runJourney`.
- The runner never edits `HOME`, `CODEXHOME`, or the shared Wrangler config.
- OAuth token loading uses `python3` `tomllib` against the named config at
  `/Users/sheshnarayaniyer/Library/Preferences/.wrangler/config/tirak.toml`.
- The OAuth token is kept in process memory only and is never printed.
- Every outbound call is bounded to 30 seconds, the full run to 7 minutes, and
  total remote calls to 512.
- Redirects are never followed.
- Only the exact hosted QA Worker and exact Cloudflare account/resources are
  accepted.

## Exact pins

- Worker URL: `https://tirak-core-qa-20261005.tirak-court.workers.dev`
- Account: `2c0c96c68f0ee73b6d980054557bca5b`
- D1: `83574656-cd4b-4483-902c-06dfd9e77496`
- R2 bucket: `tirak-core-qa-20261005`
- KV `CACHE`: `20d12ac0b70749059926c2e30ad19b9b`

The runner reads `wrangler.core-qa.toml` through `tomllib` and aborts before any
write-capable step if any pin diverges.

## Hosted worker adapter

The adapter provides the subset of the local runtime interface that the parent
journey needs:

- `worker.dispatchFetch(input, init)` rewrites `http://local.test/...` to the
  exact hosted QA Worker URL, preserves path/query, forces `redirect: manual`,
  and injects the exact QA website or admin `Origin` when one is not supplied.
- Ticket-only WebSocket upgrades are supported only on the exact pinned QA chat
  path. The adapter opens a real `ws` client to the hosted Worker, returns a
  `101` response with a `webSocket` object exposing `accept()`,
  `addEventListener()`, and `close()`, forbids inherited `Authorization`, and
  returns sanitized unexpected-response details for replayed/denied tickets.
- `worker.getD1Database('DB')` exposes `prepare().bind().run()/first()/all()`
  through the official Cloudflare D1 REST query endpoint with bound params.
- `worker.getKVNamespace('CACHE')` exposes `list()` and `get()` for reset-token
  discovery in local memory only, plus `delete()` only for exact disposable
  `ratelimit:` fixture keys during the parent journey's rate-window reset.
- `worker.getR2Bucket('STORAGE')` exposes `list()` for evidence metadata counts.

## Preflight

Before any write-capable journey step, the runner requires:

- exact `wrangler.core-qa.toml` pins for Worker/account/D1/R2/KV,
- hosted `GET /health` success with `environment=core-qa`,
- protected `GET /api/companions?limit=1&page=1` rejection with QA response
  headers `X-Tirak-QA-Environment=core-qa` and `X-Tirak-QA-Mode=cohort`,
- pinned payment-disable config (`PAYMENT_MODE=disabled`,
  `PROMPTPAY_ENABLED=false`,
  `PAYMENT_PRODUCTION_POLICY_WRITES_ENABLED=false`),
- D1 table existence for `users`, `core_qa_accounts`,
  `supplier_onboarding_applications`, and `interests`,
- zero existing synthetic QA user/application/interest data.

If any synthetic footprint is already present, the run aborts without trying to
overwrite it.

## Secrets and proof

- Runtime passwords are generated with Node crypto.
- A private `operator-credentials.json` is written under a temp root with mode
  `600` and contains only synthetic operator login credentials for admin,
  traveler, and guide.
- The temp root is created with mode `700`.
- The public proof written to
  `scripts/core-qa-hosted/generated/core-qa-hosted-proof.json` is sanitized: no
  OAuth token, no raw auth tokens, no raw request/response dumps, and no PII.

## Run

Run only after the parent-owned runtime/schema/deploy gate is explicitly open
and after `scripts/core-qa/run-local-runtime.mjs` exports
`runJourney({ worker, secrets, proof })`:

```bash
node scripts/core-qa-hosted/run-hosted-runtime.mjs
```

## Current status

The hosted adapter now preserves the shared runtime budget contract instead of a
misread 40-call ceiling: `512` max network calls, `30s` per call, `7m` overall.

This worktree did not open the parent-owned hosted execution gate and did not
run remote execution. The hosted proof remains operationally unverified until
the parent owner opens that gate and executes the journey against the pinned QA
Worker.

## One-time empty QA initialization

`initialize-empty-d1.mjs --execute` first verifies the exact account/resource pins,
requires the successful actual local runtime proof including websocket101/replay401
and broadcast, then reads `sqlite_master` from the exact new D1. Any existing
application table aborts initialization. It imports only the frozen selected Core
schema into this empty QA database, records input/import hashes, and requires a
zero-row foreign-key check. It never runs blanket migrations against retained D1.
The QA secret and Worker/static frontend deployment remain separate operator steps.
