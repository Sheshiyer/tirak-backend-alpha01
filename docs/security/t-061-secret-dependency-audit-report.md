# T-061 — Secret & Dependency Audit Report (Partial Release)

Task: **T-061** (P4 / W4.1 / security) — *Run secret, dependency, and checkout-tracking audit.*
Scope per owner-signed `payment-park-and-resequencing-record.md` §5.2: **secret + dependency audit now; checkout-tracking audit deferred** (it audits the payment flow being redesigned). Full re-run at T-066.

Date: 2026-07-26
Auditor: agent session (read-only; zero writes, zero remote mutations)

---

## 1. Secret audit — CLEAN

| Surface | Method | Result |
|---|---|---|
| Backend git history (200 revs) | `git grep` over `rev-list` for `skey_live_/skey_test_/pkey_*` key bodies, PEM private-key markers | **0 hits** |
| Backend working tree | pattern scan for hardcoded `api_key/secret/password/token` assignments in `src/`, `scripts/` | 3 hits, all **explicit test fixtures** (`mock-token-never-log-this-value`, `offline-fixture-token-never-sent`, negative-test `cfk_not-a-bearer-token`) — benign |
| Backend tracked files | `git ls-files` for `.env`/secret/credential/PEM/key files | only `.env.example` (template, no values) |
| Mobile git history (100 revs) | same key-body and PEM patterns | **0 hits** |
| Mobile working tree | `skey/pkey` pattern scan across `app/`, `utils/`, `services/`, `constants/` | **0 hits** |
| Mobile `.env` | `git check-ignore` | **properly ignored** (`.gitignore:39`), untracked |

Omise credential handling stays compliant with the frozen contract: secrets live only in Cloudflare secret storage (T-034, parked), never in git. ISC-106 remains satisfied.

## 2. Dependency audit — backend (`tirak-backend-alpha01`)

`npm audit`: 3 critical / 9 high / 1 low (13 total). **Production dependency surface is small and mostly clean** (`hono`, `@hono/zod-validator`, `bcryptjs`, `jsonwebtoken`, `zod`).

### Production-relevant

| Severity | Package | Detail | Fix |
|---|---|---|---|
| HIGH | `hono` (^4.7.11, **direct production**) | IP-restriction bypass for non-canonical IPv6; Set-Cookie injection via unsanitized `sameSite`/`priority` in cookie helper | available (≥4.12.27 line) |

`jsonwebtoken`, `bcryptjs`, `zod`: **no findings**.

### Dev-toolchain only (no production exposure)

- CRITICAL `vitest` / `@vitest/coverage-v8` (Vitest-UI arbitrary file read — requires the dev UI server listening), CRITICAL `happy-dom` (VM escape — test environment only).
- HIGH chain via `wrangler`/`miniflare`: `sharp` (libvips CVEs), `undici` (TLS validation bypass), `ws` (memory disclosure/DoS), `vite`, `postcss`, `esbuild`, `brace-expansion`. **Verified: no `ws` import exists in `src/`** — runtime WebSockets use native Workers primitives.

All fixes available. Dev-chain risk is bounded to developer machines running the dev server.

## 3. Dependency audit — mobile (`tirak-mobile-app-v2`)

`npm audit`: 2 critical / 13 high / 19 moderate / 3 low (37 total).

### Production-relevant

| Severity | Package | Detail | Fix |
|---|---|---|---|
| HIGH | `axios` (**direct production**) | DoS via excessive recursion in `formDataToJSON`; Basic-auth injection via prototype pollution of auth subfields | available |

### Dev/build-toolchain

- CRITICAL `shell-quote` (newline escape + quadratic DoS) and CRITICAL `tar` (hardlink/symlink path traversal) — both via React Native / Expo build tooling, build-time only.
- HIGH `@xmldom/xmldom` (transitive), `brace-expansion`; 19 MODERATE mostly Expo CLI toolchain.

## 4. Recommendations (not applied — this is an audit, not a change)

1. **Bump `hono`** to the fixed line (≥4.12.27) — only production-relevant backend finding.
2. **Bump `axios`** to the fixed release in the mobile repo.
3. Schedule a dev-toolchain refresh (`vitest` 3.2.6+, `happy-dom` 20.11.1+, `wrangler` current) — no urgency, no production exposure.
4. At **T-066**: re-run this audit in full, including the deferred checkout-tracking portion against the redesigned payment flow, and re-audit after any dependency bumps land.

## 5. Evidence / commands

```
# secrets
git grep -nE "skey_(live|test)_[A-Za-z0-9]{16,}|pkey_(live|test)_[A-Za-z0-9]{16,}" $(git rev-list --all --max-count=200)
git grep -l "BEGIN.*PRIVATE KEY" $(git rev-list --all --max-count=200)
git ls-files | grep -iE "\.env|secret|credential|\.pem|\.key"
git check-ignore -v .env   # mobile

# dependencies
npm audit --json           # both repos
npm ls hono ws sharp undici
grep -rn "from 'ws'" src/  # no hits
```
