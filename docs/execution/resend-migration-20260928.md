# Resend outbound email candidate — 2026-09-28

## Local implementation

The integrated Core repair candidate supports `EMAIL_PROVIDER=resend` through the shared communications adapter. Invitations, verification, recovery and background notifications retain their existing call sites. Native fetch uses Resend's HTTPS API; no new dependency is required.

Configuration requires `RESEND_API_KEY` and a valid explicit `EMAIL_FROM`; `EMAIL_FROM_NAME` and `EMAIL_REPLY_TO` use existing Tirak defaults. Confirm the reply mailbox before activation. No automatic provider fallback or retry is introduced.

Only HTTP 200 with a UUID message ID establishes provider acceptance. That ID reaches the sanitized operational receipt as `providerRequestId`. Acceptance is not inbox delivery. One ten-second deadline covers request and response-body reading, with timer cleanup and abort. Network errors and malformed success responses are uncertain. They use the existing `EMAIL_TIMEOUT` compatibility code so reset tokens and verification challenges retain their existing expiry, cooldown and single-use behavior. HTTP rejection remains definitive failure. Raw response bodies and exceptions are not exposed.

## Activation sequence

1. Identify the intended Resend workspace. Verify `tirak.app` there if preserving `noreply@tirak.app`; a dedicated sending subdomain is also supported but requires the matching sender address.
2. Read exact DKIM and return-path SPF/MX values from that workspace. Preserve existing Zoho root MX and SPF. Public DNS currently resolves root mail to `mx.zoho.in`, `mx2.zoho.in`, `mx3.zoho.in`, and SPF includes `zoho.in`. Do not enable Resend root inbound routing for this outbound migration.
3. Provision a sending-only domain-scoped key as the selected Worker's `RESEND_API_KEY` secret. Keep the value out of chat, source and command history.
4. Change only the intended default Core target's provider selection to `resend`, with verified sender and reply mailbox. The retained target is `tirak-backend` / `tirak-development`; named production resources differ. The approved default Core target now selects `resend`; named environments are unchanged.
5. Release the integrated repair candidate using exact target/schema checks and a restore-tested backup. The broader candidate requires migrations `017_core_guide_management.sql` and `019_password_reset_consumptions.sql`; preflight existing migration 015 verification tables. This adapter itself adds no migration. Do not blanket-apply payment migration 014 or enable payments.
6. Verify provider acceptance and inbox arrival separately, then exercise an actual authorized invitation, email verification and password reset. A missing-account recovery response is not evidence of delivery. The user enters their own password. Capture single-use and expiry behavior after completion.

Resend removes the dependency on enabling Cloudflare Email Sending. Retaining the Cloudflare adapter permits reverting configuration, but the documented disabled Cloudflare provider is not a working delivery fallback. Worker rollback does not reverse additive database migrations.

## Evidence and remaining limits

- Full local suite: 44 files / 504 tests passed; typecheck passed.
- Focused transport and real-consumer coverage includes payloads, privacy, provider ID, failure, total deadline, unknown acceptance, cooldown and one-time completion.
- Independent read-only review found no blocking issue after corrections. Its remaining display-name readiness inconsistency was corrected.
- Approved release dry-run bundled successfully with Resend selected and payment flags disabled.
- User screenshot confirms `tirak.app` verified in Resend; public and authoritative DNS match. The selected Worker has a `RESEND_API_KEY` secret binding; its value was not read.
- User authorized the integrated release and Resend cutover. A fresh remote D1 export was restored in memory; both selected migrations preserved all existing row/column snapshots across 52 tables with zero foreign-key violations. Migrations 017 and 019 are now applied and ledger-verified, with 32 users, 5 bookings and 2 services retained. Migration 014 remains excluded.
- Live Worker deployment, provider acceptance and inbox arrival are pending at this source checkpoint. No DNS, account role or payment changes were made.

## References

- [Workers integration](https://resend.com/docs/send-with-cloudflare-workers)
- [Send API](https://resend.com/docs/api-reference/emails/send-email)
- [Domain verification](https://resend.com/docs/dashboard/domains/introduction)
- [Cloudflare DNS setup](https://resend.com/docs/knowledge-base/cloudflare)
- [API key permissions](https://resend.com/docs/dashboard/api-keys/introduction)

## Authorized release and runtime correction

The owner approved deployment of the integrated candidate including selected migrations 017/019 and the Resend provider cutover. Commit `ecc0841` deployed as Worker version `86e500b7-f578-4ddc-91f1-71cc533b2c10`, deployment `e6b5064a-fbfb-454a-8894-1874e159404d` at 100%. Target remains `tirak-backend` with D1 `60443346-c480-4975-962e-bd4daf4a37a8`. Live readback retained both secrets and disabled payment flags. Health, reset HTML/CSS/JS returned 200; unauthenticated user/admin routes returned 401; admin-origin CORS preflight returned 204 with the correct origin.

One authorized QA send was attempted only to `mrhigh3r@gmail.com` through an ephemeral remote preview importing the shared adapter. The adapter reported unknown acceptance. Follow-up read-only runtime diagnostics isolated a TypeError for unsupported `redirect: error` under compatibility date 2024-09-23. The adapter now uses `manual`, returning redirects for explicit rejection without forwarding credentials. Expanded unit cases cover 301/302/307/308. Full suite: 44 files / 507 tests; typecheck and static release gate pass. A separate workerd runtime probe uses the real bundled adapter with all outbound traffic handled synthetically, verifying acceptance and redirect rejection under the retained compatibility date.

After the redirect correction in the read-only diagnostic preview, Resend GET /emails returned HTTP 400 `validation_error`, `API key is invalid`. The existing secret binding is present but its credential is rejected. No key value was retrieved or printed. The owner was asked to replace it securely through Wrangler. No additional message was sent, and provider acceptance/inbox delivery are not claimed. Missing-account forgot-password responses are not used as mail evidence. The diagnostic preview is not a production endpoint and is stopped when verification finishes.

Final corrected source `31e1cbf` deployed as version `ee8b5743-8907-4fd2-8a2e-67f0aed6344c`, deployment `2aa91839-8b48-4044-a0d6-5132d0529b78` at 100%. Final live smoke and binding checks pass. Resend credential remains invalid; owner secure replacement is pending. The diagnostic preview has been stopped. See outer workspace `.planning/reviews/2026-09-28-mobile-issues/RESEND-RELEASE.md` and `resend-release-evidence.json`.

## Credential resolution — 2026-09-28

Owner authorized the Tirak-labeled Resend key from the Claude environment. It was
installed securely as RESEND_API_KEY without printing its value. Secret update
activated version ec46c7ab-b96a-4ba2-a907-53849c0f50dc at 100%, retaining the same
source, D1, Resend configuration and disabled payments. The real shared adapter
with the inherited Worker secret sent one QA email to mrhigh3r@gmail.com. Resend
accepted message 01a0e97b-7c8f-7619-a59b-7d4019112a19 and its exact-message GET
returned last_event=delivered with the recipient verified. The preview was stopped.
The invalid-key blocker is resolved. Human inbox confirmation and real invitation/
password-reset completion remain separate from provider-reported delivery.
