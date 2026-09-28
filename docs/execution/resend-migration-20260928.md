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
