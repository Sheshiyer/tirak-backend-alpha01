# T-062 — Cross-User Adversarial Attack Report

Task: **T-062** (P4 / W4.1 / security) — *Adversarially test auth, ownership, and rate limits.*
Frozen acceptance: **"Unauthorized creation, retrieval, recovery, chat, and transitions fail safely."**
Frozen validation: **"API adversarial suite and logs."**
Dependencies T-044 / T-050 waived by owner-signed `payment-park-and-resequencing-record.md` §5.1; results re-confirm at the T-066 signoff gate.

Date: 2026-07-26
Suite: `tests/security/` — 30 tests across 3 files, all green (vitest, zero network, zero Cloudflare access).

---

## 1. Attack matrix

### 1.1 Authentication attacks (`auth.attacks.test.ts` — 9 tests)

Protected surface: `authMiddleware` (all routes mount it; bookings list used as representative).

| # | Attack | Expected | Actual | Verdict |
|---|--------|----------|--------|---------|
| A1 | No token | 401 | 401 | SAFE |
| A2 | Malformed bearer string | 401 | 401 | SAFE |
| A3 | Token signed with attacker secret | 401 | 401 | SAFE |
| A4 | Expired token | 401 | 401 | SAFE |
| A5 | Tampered payload segment (forged `sub`/`userType: admin`) | 401 | 401 | SAFE |
| A6 | Valid token, user deleted from D1 | 401 `User not found` | 401 | SAFE |
| A7 | Valid token, account suspended | 401 `Account is not active` | 401 | SAFE |
| A8 | Control: valid token, active user | reaches handler (200) | 200 | PASS |
| A9 | Control: valid `auth-token` cookie | reaches handler (200) | 200 | PASS |

### 1.2 Cross-user ownership attacks (`ownership.attacks.test.ts` — 15 tests)

Cast: CUSTOMER_A owns booking (with SUPPLIER_S); CUSTOMER_B is the authenticated attacker. DB stubs are **bind-aware**, so a missing ownership predicate in any SQL would return the victim row and fail the test.

| # | Attack | Expected | Actual | Verdict |
|---|--------|----------|--------|---------|
| O1 | B reads A's booking | 404 (no existence leak) | 404 | SAFE |
| O2 | Control: A reads own booking | 200 | 200 | PASS |
| O3 | B transitions A's booking | 404 | 404 | SAFE |
| O4 | A confirms own pending booking (guide-only) | 403 | 403 | SAFE |
| O5 | A marks pending booking completed (skips guide) | 403 | 403 | SAFE |
| O6 | A targets `pending` (resurrect backwards) | 400 (schema rejects non-target statuses) | 400 | SAFE |
| O7 | Control: guide confirms pending booking | 200 | 200 | PASS |
| O8 | Guide creates a booking (traveler-only action) | 403 | 403 | SAFE |
| O9 | B opens chat room for A's booking | 403 `Booking access denied` | 403 | SAFE |
| O10 | B sends message into victim room | 404 | 404 | SAFE |
| O11 | B reads victim room history | 404 | 404 | SAFE |
| O12 | B reads A's charge status | 404 | 404 | SAFE |
| O13 | B creates charge against A's booking | 404 | 404 | SAFE |
| O14 | B binds recovery charge to A's booking | 404 | 404 | SAFE |
| O15 | B probes charge existence with malformed id | 400 | 400 | SAFE |

### 1.3 Rate-limit attacks (`ratelimit.attacks.test.ts` — 6 tests)

| # | Attack | Expected | Actual | Verdict |
|---|--------|----------|--------|---------|
| R1 | Boundary: N requests pass, N+1 rejected | 429 | 429 | SAFE |
| R2 | Exhaust user A's bucket, fire as user B | B unaffected | 200 for B | SAFE |
| R3 | Rotate `X-Forwarded-For` per request against deployed limiter | still 429 (keys on user id / `CF-Connecting-IP` only) | 429 | SAFE |
| R4 | Headerless unauthenticated clients | shared `ip:unknown` bucket, still 429 | 429 | SAFE (availability note, §2 F-4) |
| R5 | `CACHE` namespace throws on every call | **requests pass (fail-open)** | 200 × N+2 | **FINDING F-1** |
| R6 | Rotate `X-Forwarded-For` against plain `rateLimit()` helper | **limit bypassed** | 200 after rotation | **FINDING F-2** |

## 2. Findings

### F-1 — Rate limiter fails open on KV errors (MEDIUM, behavior pinned, fix deferred)

`src/middleware/rateLimit.ts` catches any `CACHE` error and continues without limiting. During a KV outage (or binding misconfiguration), every endpoint loses rate protection precisely when the system may already be degraded. Pinned by R5.
**Recommendation:** fail closed for the `auth`, `passwordReset`, `otpVerification`, and `payment` classes (attacker-sensitive); fail open only for low-risk classes. Decide at T-066; changing default behavior now would alter production semantics mid-park without a gate.

### F-2 — Unused `rateLimit()` / `ipRateLimit()` helpers are XFF-spoofable (LOW, latent)

The deployed limiter (`createRateLimit` → `userRateLimit`) keys on user id with `CF-Connecting-IP`-only fallback (R3 proves XFF rotation does **not** bypass it). However, the module also ships `rateLimit()` and `ipRateLimit()` whose default key trusts client-supplied `X-Forwarded-For` / `X-Real-IP`. They are mounted **nowhere** in `src/` today; R6 pins the spoof so any future mount trips the test in review.
**Recommendation:** delete the unused helpers or route their fallback through `CF-Connecting-IP` only.

### F-3 — KV sliding-window check-then-act is non-atomic (LOW, architectural)

Concurrent requests can both read below the limit and both pass (classic KV race). Impact is bounded: limits are anti-abuse guardrails, not financial invariants (payment creation is separately protected by the T-033 policy ladder and the idempotent-attempt contract). No code change proposed; noted for T-040 dashboard thresholds.

### F-4 — Headerless unauthenticated clients share the `ip:unknown` bucket (INFORMATIONAL)

Off-Cloudflare contexts without `CF-Connecting-IP` collapse into one bucket: attackers cannot bypass limits, but one abusive client can exhaust the shared bucket for others (availability, not confidentiality). On Cloudflare this key is always populated; noted for completeness.

## 3. Acceptance statement

Every unauthorized creation, retrieval, recovery, chat, and transition attempt in the matrix **fails safely** (401/403/404/400 as designed, with no cross-user existence leak: 404 is returned where the route must not confirm a resource exists). Two rate-limiter findings (F-1, F-2) are pinned as tests and deferred to the T-066 security/financial signoff gate, which remains fully gated under the payment-park record.

## 4. Re-confirmation hook

Per the re-sequencing record §5.1, this suite re-runs at T-066 against the post-redesign payment surface; any new route that mounts authentication or rate limiting must extend this matrix.
