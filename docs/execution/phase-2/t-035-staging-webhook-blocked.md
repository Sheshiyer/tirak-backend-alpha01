# T-035 — Staging webhook registration blocked evidence

Captured: `2026-08-01T10:57:55Z`

## Status

**BLOCKED — no safe public staging endpoint exists yet.**

Authenticated Cloudflare read-back for `tirak-backend-staging` reports:

- workers.dev: disabled
- preview URLs: disabled
- custom Worker routes in the `tirak.app` zone: none
- active deployment: secret-only version `d51b0c58-9718-4125-ba35-c76d5dcd6815`

Authenticated Omise test-account read-back reports `webhook_uri=null`.

Registering an invented URL would fail T-035 acceptance because the endpoint and webhook-secret environment would not be demonstrably matched. Resume T-035 after T-036 or a separately authorized route task exposes the real HTTPS staging Worker route; then set the test account `webhook_uri` through `PATCH /account`, read it back, and capture one signed delivery probe.

Current Omise documentation defines an environment-specific webhook secret managed in Dashboard Webhooks Settings. Omise signs `<timestamp>.<raw-body>` with HMAC-SHA256 and sends `Omise-Signature` plus `Omise-Signature-Timestamp`; the Base64-decoded test secret must verify the raw body. This confirms `OMISE_WEBHOOK_SECRET` is a real provider credential rather than an application-invented header.

## Required T-036 entry gates

Before `PAYMENT_MODE` or `PROMPTPAY_ENABLED` leaves its disabled state:

1. The first authenticated invocation from the deployed staging Worker must call Omise `GET /account` and assert `livemode=false` plus account ID `account_test_68eo43cd94bxdop0zl3`.
2. The exact public HTTPS webhook route must be read back from Cloudflare and return a non-success response for a request missing the two Omise signature headers.
3. The Omise test account `webhook_uri` must be set to that exact route and read back before any signed delivery probe.
4. A test-mode signed delivery must validate the raw-body HMAC and independently retrieve provider state before processing the event.

No live webhook, production setting, or payment mode was changed.
