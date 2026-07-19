# Tirak Payments v1 Contract

Status: frozen for local integration validation; no deployment authority

Contract identifier: `tirak-payments-v1`

## Product boundary

The purchasable object is one named, bounded guided travel experience attached to a persisted booking and service. Payment never purchases a person's company, a date, a gift, a tip, unrestricted time, or private access.

## Primary-source constraints

- Omise PromptPay is an offline/asynchronous QR flow. The provider amount is an integer currency subunit, the currency is THB, and successful completion must be independently retrieved after the webhook: <https://docs.omise.co/promptpay>.
- PromptPay charges cannot be voided or refunded through Omise. Tirak therefore records any external customer resolution in `payment_restitutions` without rewriting provider truth: <https://docs.omise.co/promptpay#voids-and-refunds>.
- Omise signs `<timestamp>.<raw body>` with HMAC-SHA256 using a Base64-decoded environment-specific webhook secret; rotation can send two signatures: <https://docs.omise.co/api-webhooks>.
- Cloudflare bindings, variables, and secrets are environment-specific and non-inheritable; the release configuration must name each target explicitly: <https://developers.cloudflare.com/workers/wrangler/environments/>.
- D1 migrations are recorded in `d1_migrations`; target ledger and schema inspection decide applicability: <https://developers.cloudflare.com/d1/reference/migrations/>.

## Frozen artifacts

| Task | Artifact | Boundary |
| --- | --- | --- |
| T-009 | `contracts/tirak-payments-v1/payment-api.json` | four allowed payment routes, explicit satang/THB fields, auth, errors, and blocked legacy routes |
| T-010 | `contracts/tirak-payments-v1/state-matrix.json` and `src/contracts/payment.ts` | provider, attempt, cancellation, restitution, and public/mobile truth |
| T-011 | `contracts/tirak-payments-v1/target-schema.sql` and `permission-matrix.md` | attempts, webhooks, restitution, booking chat, constraints, indexes, and role boundaries |
| T-012 | `migration-strategy.md` | target-ledger decision, legacy `004` repair, and additive booking-chat expansion |
| T-013 | `contracts/tirak-payments-v1/environment-matrix.json` | environment, resource, API, secret, mode, kill-switch, and operator boundary |

## HTTP response contract

Successful charge responses contain:

- `contractVersion: "tirak-payments-v1"`
- `chargeId`
- `paymentStatus`
- `attemptStatus`
- `qrCodeUrl`
- `amountSatang` as a positive safe integer
- `displayTotalThb` as the server-derived display amount
- `currency: "THB"`
- optional `expiresAt`

There is no ambiguous `amount` field. Validation rejects extra client fields, including amount, currency, cards, gifts, tips, subscriptions, and beneficiaries.

## Error and authorization contract

Errors retain the shared `{ success: false, error, message? }` envelope. Payment-specific configuration and race errors use stable labels such as `PAYMENT_CREATION_DISABLED` and `PAYMENT_OUTCOME_UNRESOLVED`. Customer routes require a bearer JWT plus booking ownership. The webhook route is public only at the network layer and requires an authentic raw-body signature, replay control, and independent provider retrieval.

Saved payment-method/contact routes and legacy payment history are absent from the mounted release surface. PromptPay QR creation is booking-bound and stateless from the mobile client's perspective.

## Rollout modes

`PAYMENT_MODE` is `disabled`, `test`, or `live`; `PROMPTPAY_ENABLED` must be the literal string `true` to request creation. Invalid environment, invalid mode, missing secrets, key/mode mismatch, live outside production, or test mode in production closes creation. Disabling creation does not disable webhook or status processing for existing attempts.

No artifact in this packet authorizes a Worker deployment, D1 mutation, GitHub publication, worktree fanout, or Omise dashboard change.
