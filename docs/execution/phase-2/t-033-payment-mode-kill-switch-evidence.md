# T-033 — Payment environment-mode and kill-switch guard — evidence

Date: 2026-07-24 · Branch: `codex/tirak-omise/w2.2/t-033-payment-mode-kill-switch` · Contract: `tirak-payments-v1` (untouched)

## Deliverable mapping (issue Sheshiyer/tirak-mobile-app-v2#33)

> "Fail-closed disabled/test/live handling, audited operator toggle, and in-flight settlement behavior"

- **Fail-closed disabled/test/live handling** — the existing `paymentRuntimePolicy()` ladder is unchanged; a new async `resolvePaymentRuntimePolicy(env)` in `src/contracts/payment.ts` layers the audited KV override on top of the static `[vars]` floor and reuses the identical ladder on the effective values. Missing/unbound KV → static floor, no override. Malformed JSON, non-object JSON, wrong-typed fields, invalid mode values, or an unreadable bound namespace → creation closed with the new reason code `invalid_mode_override`. A `live` override outside production is closed by the unchanged ladder (`live_mode_forbidden_outside_production`). Key/mode secret-prefix coherence is enforced against the override mode.
- **Audited operator toggle** — `scripts/payments/set-payment-mode.mjs`, runnable only by the named human release owner (`--operator "human release owner"` enforced exactly), requires `--reason`, exactly one of `--mode`/`--promptpay`, refuses `live` outside production, refuses to run without `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` from the process environment (never flags, never echoed), writes `PAYMENT_MODE_OVERRIDE`, and appends an immutable `PAYMENT_MODE_AUDIT:<ISO8601>` entry with operator, reason, previous/next state, and a stale-attempt ownership snapshot. `--dry-run` prints the intended change and snapshot with zero writes. The script is delivered, not executed.
- **In-flight settlement behavior** — webhook (`/webhooks/omise`), recover (`/charges/recover`), and status (`/charges/:chargeId`) never consult the creation gate; only `POST /charges` (src/routes/payments.ts:311) awaits the async resolver. The toggle snapshots `payment_attempts` rows `WHERE status IN ('creating','indeterminate','pending')` from the target D1 into every audit entry, proving in-flight ownership is preserved across a disable; a create authorized before a disable settles normally (race test), and no charge is created after the disable.

## Acceptance mapping

> "Missing or mismatched mode cannot create a charge; disabling creation preserves webhook, status, reconciliation, and stale-attempt ownership"

- Missing mode / mismatched secret prefix / invalid override → 503 `PAYMENT_CREATION_DISABLED` (route tests) and `createEnabled: false` (unit matrix).
- Route tests prove webhook (valid HMAC fixture), GET status, and POST recover all reconcile in-flight attempts while the override disables creation.

## Validation mapping

> "Unit, route, config, concurrent-request, and operator-toggle tests"

- Unit: `tests/contracts/payment-mode-override.test.ts` — 23 tests (override absent/malformed/wrong-type/invalid → `invalid_mode_override`; mode×env cross-product; key/mode coherence vs override; settlement preserved; partial override inheritance; sync resolver unchanged).
- Route: `tests/routes/payments.kill-switch.test.ts` — 11 tests (static disabled, `PROMPTPAY_ENABLED=false`, invalid override ×3, unreadable namespace, webhook/status/recover available under disable, audited reopen over disabled floor).
- Concurrent-request: race test in the route suite — an in-flight create racing a toggle-to-disabled settles exactly one decision atomically (one provider call total; 201 for the pre-disable attempt, 503 after; no false success).
- Operator-toggle: `tests/scripts/set-payment-mode.test.ts` — 12 tests (operator string enforced, reason required, exactly-one-flag, live refused outside production, credentials-from-env required, dry-run writes nothing, audit entry shape with snapshot, previous-override chaining, D1 snapshot precedes writes, snapshot failure aborts, token/account never printed).
- Config: `wrangler.toml` gains a `PAYMENT_CONFIG_KV` binding in all three environments (all-zero inert stand-in ids + TODO; no real namespace exists anywhere yet — the T-025 ledger records only CACHE/SESSIONS). Deploy-time guards still pass: `validate-target.mjs` (via release gate) and `staging:verify:fixtures` are green.

## File list

Modified:
- `src/contracts/payment.ts` — `PAYMENT_MODE_OVERRIDE_KEY`, `PaymentModeOverride`, `resolvePaymentRuntimePolicy()` (fail-closed async resolver; sync `paymentRuntimePolicy` untouched).
- `src/routes/payments.ts` — charge route awaits the async resolver (2-line conformance edit).
- `src/index.ts` — `PAYMENT_CONFIG_KV?: KVNamespace` binding type.
- `wrangler.toml` — `PAYMENT_CONFIG_KV` binding (inert stand-in id) in development/staging/production.

Created:
- `scripts/payments/set-payment-mode.mjs` — audited operator toggle CLI (injectable exec; no network in tests).
- `tests/contracts/payment-mode-override.test.ts` — 23 tests.
- `tests/routes/payments.kill-switch.test.ts` — 11 tests.
- `tests/scripts/set-payment-mode.test.ts` — 12 tests.
- `docs/execution/phase-2/t-033-payment-mode-kill-switch-evidence.md` — this file.

## Test counts

- New: 46 tests across 3 new files.
- Baseline on main (0ec6368): 226 tests / 18 files.
- Total after: **272 tests / 21 files — all passing**.
- `npm run release:verify` (typecheck + test:run + verify-release-gate): **PASS** (negative matrix, placeholder staging refusal, production static validation all PASS).
- `npm run staging:verify:fixtures`: **PASS** (30 strict acceptance refusals retained).

## Design decisions

1. **Fail-closed on unreadable override store.** A bound-but-unreadable namespace cannot prove the kill-switch state, so creation closes with `invalid_mode_override` rather than silently using the floor.
2. **Override composes, then the unchanged ladder decides.** The resolver substitutes override values into the same input shape and calls the frozen `paymentRuntimePolicy()` — no second policy implementation to drift.
3. **Only the charge route resolves policy.** Settlement routes deliberately keep their pre-T-033 behavior so a disable never strands in-flight attempts.
4. **Audit entries are immutable append-only keys** (`PAYMENT_MODE_AUDIT:<ISO8601>`), separate from the mutable override key, and carry the stale-attempt snapshot so every toggle is self-evidencing.
5. **The toggle refuses to toggle without proof of in-flight ownership** — if the D1 snapshot query fails, nothing is written.

## Scope limits (explicit)

- No KV writes executed; the toggle script was delivered but never run (all its tests use injected fakes; zero network).
- No wrangler deploy/secret/KV/D1 remote mutations of any kind.
- No contract JSON edits (`contracts/tirak-payments-v1/*` untouched); no `migrations/` or frozen lineage changes.
- The `PAYMENT_CONFIG_KV` namespace ids in wrangler.toml are all-zero inert stand-ins: no namespace is provisioned anywhere. Provisioning one, and amending the T-025 staging ledger's exact CACHE/SESSIONS KV-topology assertion (staging-ledger-lib.mjs), is a follow-up human release-owner action; until then `staging:discover` would correctly refuse the new staging KV topology as an unconfirmed drift.
- `.env*` files were never read or printed.
