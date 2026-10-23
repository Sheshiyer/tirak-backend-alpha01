# Core email, password recovery and push repairs — local candidate

Scope: Tirak Core backend only, based on `5435f0d`. No live sends, provider
activation, credential edits, deployment, remote migration, account reset, or
payment changes were made by this work.

## Email and recovery

Cloudflare's structured `EMAIL.send` contract remains unchanged. Provider
acceptance is recorded as accepted, never as inbox delivery. Sanitized internal
receipts contain purpose, generated request correlation, provider, outcome and
allowlisted provider code/request ID. Recipients, tokens, codes, message content
and raw provider exception text are excluded. The known Cloudflare sender/domain
and suppression errors are preserved. Binding waits are bounded to ten seconds;
because the binding cannot be cancelled, timeout outcome is unknown and its
expiring recovery token is retained in case acceptance occurs later.

Forgot-password inspects adapter delivery status while retaining a uniform public
response for existing/missing accounts and internal failures. Existing auth rate
limits remain. A definite rejected send removes its token. Email verification
keeps its cooldown, attempt and expiry rules; failed delivery is unavailable.
A timed-out challenge stays pending: public status is unavailable, but possession
of a correct code can complete verification within the same expiry/attempt caps.
Definite failures cannot verify. A late send outcome cannot revive consumed codes.

Reset mail contains the native link and a visible browser alternative on the
selected Core API host. Plain-text mail retains both URLs. The URL host is pinned
and cannot be selected through incoming Host headers. The browser alternative
uses a fragment token, removes it from the address bar, and posts same-origin.
Its page must ship with this backend release. Marketing hosting is not a
supported recovery destination.

Additive migration **019_password_reset_consumptions.sql** is required before
this handler is deployed. Existing KV reset tokens with a provable expiry remain compatible. Newly issued
admin invitations now include their 24-hour expiry and use the supported Core
reset page. Older invitation records omit expiry and are intentionally rejected;
their owners can request a fresh forgot-password link. No unbounded legacy expiry
is inferred. The reset transaction conditionally updates the password and
inserts the SHA-256 token digest in D1; stale KV reads and concurrent consumers
cannot reset twice. Pending invitations activate in the same update; other
statuses are preserved. Queue or KV cleanup failures cannot turn an already
completed reset into a reported failure. Consumption records are retained;
future maintenance must never remove an unexpired record. Migration is local
only and must be selected explicitly for the retained Core D1.

## Push

Authenticated registration atomically removes a token from existing JSON device
arrays and assigns it to the caller. Other installations are preserved. Owner
logout removal is idempotent and cannot revoke another account's token.
Existing `user_devices` storage is retained without a push migration. Expo token
shape and length are validated. Mobile must unregister before session clearing.

The existing Expo transport now checks every ticket and rejects incomplete
responses instead of fabricating acceptance. `DeviceNotRegistered` tokens are
removed only from the account associated with the send, so a later account
switch is not revoked by an old response. Token lists are deduplicated. Expo
acceptance still does not prove device delivery; asynchronous delivery receipt
polling, native entitlement signing, and physical device tests remain separate.

## Verification

- Frozen existing `bun.lock` installed without source or lock changes.
- TypeScript passed.
- All 458 tests in 42 files passed, including actual SQLite execution of the
  production atomic reset/push SQL, concurrent consumers, stale KV replay,
  rollback, ownership switching, provider rejection/timeout, verification
  cooldown/single use, and browser recovery tests.
- `git diff --check` passed.
- Local reset browser UI checked by parent coordinator with synthetic values.

The initial noesis-execute attempt returned prose only with no tool work. The
allowlisted antigravity Claude fallback hit its 180-second bound without source
changes. Neither provided usable attribution. Repairs were completed through the
permitted in-session fallback; no cross-provider validation is claimed.

No live email acceptance, inbox delivery, reset completion, push delivery, or
canonical admin operation is established by these local tests.
