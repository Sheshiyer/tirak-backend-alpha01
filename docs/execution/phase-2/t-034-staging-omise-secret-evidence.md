# T-034 — Staging Omise secret provisioning evidence

Captured: `2026-08-01T10:57:55Z`

Authority: the human release owner supplied Omise test credentials and a Cloudflare token for account `2c0c96c68f0ee73b6d980054557bca5b`. Live probes proved that token could access the pinned account and perform the required staging Worker secret operation; broader token scope was not inferred because token introspection was unavailable. This task remained bounded to Cloudflare staging secret provisioning. It did not enable payments, deploy application code, mutate production, create a live charge, or register an unresolvable webhook.

## Acceptance result

**PASS.** `tirak-backend-staging` now exposes exactly these secret names:

- `OMISE_SECRET_KEY`
- `OMISE_WEBHOOK_SECRET`

No secret values are stored in this artifact. The Omise secret authenticated `GET /account` as test account `account_test_68eo43cd94bxdop0zl3`, with `livemode=false`, country `TH`, currency `THB`, and API version `2019-05-29`.

## Before and after

| Probe | Before | After |
| --- | --- | --- |
| Staging secret names | empty | `OMISE_SECRET_KEY`, `OMISE_WEBHOOK_SECRET` |
| Production secret names | `JWT_SECRET` | `JWT_SECRET` |
| Staging deployment | `aeb25acc-ec33-4909-8dcc-bdb582c2c2f9` | `4eb22d13-358f-4cd9-80c5-fea0f863d6e4` |
| Active staging version | `83af4a2f-a9a4-40ca-a1c8-8f40b51e8caa` | `d51b0c58-9718-4125-ba35-c76d5dcd6815` |
| Production mutations | zero | zero |

Cloudflare documents that Worker secret mutation creates and deploys a new Worker version. The version transition above is therefore the expected T-034 control-plane effect, not a T-036 application-code deployment.

## Handoff hygiene

The supplied values arrived in the mobile repository's ignored `.env`. Preflight proved the file was untracked and no Expo configuration or tracked source referenced the server-only variable names. After remote read-back succeeded, `OMISE_SECRET_KEY`, `OMISE_WEBHOOK_SECRET`, and `CLOUDFLARE_API_KEY` were removed from the file; the remaining file is mode `0600`.

`git log --all -- .env` is empty, so the handoff file has never appeared in repository history. No credential-shaped match exists under local `.wrangler` state, and no `[vars]` block in `wrangler.toml` can shadow either secret binding with plaintext.

## Corrective rollback

An initial command combined `--env staging` with an already environment-suffixed `--name`, causing Wrangler to create `tirak-backend-staging-staging`. Inspection proved that new Worker contained exactly the two attempted secrets, had workers.dev and previews disabled, and had zero routes. It was deleted immediately. Final settings read-back returned HTTP `404` with Cloudflare code `10007`, proving absence. The intended Worker was unchanged before the corrected upload.

Machine-readable evidence: `docs/execution/phase-2/t-034-secret-inventory.json`.

## Local regression verification

- `npm run typecheck`: pass
- focused Vitest payment/Omise/mode suites: 5 files, 96 tests, all pass
- `git diff --check`: pass
- evidence JSON parse and credential-value scan: pass

The 96 tests use synthetic local bindings and are regression evidence for payment contracts, signature checks, mode gating, and the kill switch; they are not presented as a live Cloudflare secret-store probe. Live provisioning evidence is the authenticated pre/post Cloudflare secret-name inventory, paired with authenticated Omise test-account validation before upload.

The upload did not pass either value through argv. The ignored handoff file was parsed into key/value records and serialized as JSON to Wrangler's bulk-secret stdin, so line terminators from the `.env` record syntax were not included in the binding values. Wrangler's authenticated name-only read-back cannot reveal or independently re-test secret bytes; the first T-036 runtime probe therefore remains a required value-fidelity gate before payment mode can change.

## Binding and client-boundary audit

The uploaded binding names exactly match the Worker environment contract in `src/index.ts` and `src/contracts/payment.ts`, and the runtime reads in `src/routes/payments.ts` use `c.env.OMISE_SECRET_KEY` and `c.env.OMISE_WEBHOOK_SECRET`.

The mobile repository's tracked files contain no credential-shaped Omise key value. Its only tracked matches for the server-only variable names are architectural/planning documentation; `app.config.js`, `app.json`, and `src/` contain no reference to either Omise secret or the Cloudflare token. The ignored local `.env` contains no `skey_test`, `skey_live`, or server-only handoff variable after sanitization.

The machine-readable inventory binds this evidence to backend commit `8d8148d9af19c7a477795b212ddb667a5bac9ab1` and SHA-256 hashes for `wrangler.toml`, the environment contract, the payment contract, and the payment route without hashing or recording credential values.
