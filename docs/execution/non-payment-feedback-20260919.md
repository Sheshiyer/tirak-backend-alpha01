# Court feedback — non-payment implementation checkpoint

Status: implemented locally; release held. Date: 2026-09-19.

This checkpoint spans `tirak-backend-alpha01`, `tirak-mobile-app-v2` and
`tirak-admin-command-center`. It does not authorize a deployment, remote
migration, provider setup, payment change or production account mutation.

## Changes

| Feedback | Implemented locally | Boundary / remaining dependency |
| --- | --- | --- |
| Messaging | Profile chat resolves a confirmed/in-progress booking; mobile parses backend events, retains failed drafts, refreshes the inbox and handles reconnects. Backend now uses the approved booking-chat tables, persists before success, updates room activity, scopes receipts to the opposite participant and issues short-lived single-use WebSocket tickets. | Existing booking-only product rule retained. No unrestricted pre-booking DMs. Old chat tables and history are untouched; there is no invented mapping of old conversations to bookings. |
| Fake/test profiles | Ordinary mobile sessions cannot use demo fallback. Public backend discovery, counts, profile details, services and availability exclude exact known review identities. Unmeasured response time and completion rate are null. | Review accounts are retained for login/admin; no accounts were deleted. Genuine vendor inventory and any other manually created test accounts require business review. |
| Confirmation email | New accounts are unverified. Password login does not verify them. Authenticated code request/confirmation includes hashing, expiry, cooldown, attempt limit and replay prevention. Mobile supports resend, failure and later verification. SendGrid now performs a real provider request; unsupported SES no longer reports simulated success. | A configured, approved sender/provider and a controlled real-inbox test are still required. Provider acceptance is not proof of inbox delivery. Historical verification flags were not mass-reset. |
| Email collection | Admin displays real paginated account contacts and explicit marketing/analytics consent. CSV exports displayed/selected records with formula-injection protection. Missing consent is false. | This is a contact register/export, not an inbound support mailbox or campaign delivery system. Mailbox/provider ownership and campaigns remain separate setup decisions. |
| Agreements | Public legal links work before login. Signup requires acceptance of the existing terms/privacy copy and records versions/timestamp; optional choices remain separate. Cold signup/legal/reset routes no longer redirect to onboarding. | This implements acceptance plumbing, not legal approval or GDPR certification. Client-approved privacy/terms and any distinct vendor/sales agreement must be supplied and versioned before release. |
| Analytics | Optional mobile analytics requires affirmative server-persisted consent; withdrawal disables collection locally. Removed personal identity/reset-token logging and URL query tracking. Admin uses real account/booking/chat aggregates, including current and legacy chat records, with honest errors and no fabricated infrastructure metrics. | Operational aggregates are not advertising attribution. Campaign destinations, attribution design and consent basis remain business decisions. |

Existing payment and iOS work was preserved. No provider policy, charge flow,
payment schema, pricing or settlement behavior was intentionally changed.
Existing Sentry error monitoring remains; default personal-data collection and
session replay are disabled. Optional usage analytics is a separate consent-gated
path, not a claim that every infrastructure/error log has been removed.

## Local verification

- Backend: `bun run test:run` — 407 tests across 34 files pass, including
  payment regressions and new SQLite public-discovery/ChatRoom tests.
- Backend: `bun run typecheck` passes.
- Backend: `bun run tests/local/verify-account-trust.ts` passes. It executes real
  Hono routes and SQLite transactions for registration, verification, cooldown,
  expiry, lockout, replay, consent rollback, chat persistence, ticket binding/
  replay/expiry, cancellation authorization, admin contacts/detail and analytics.
- Mobile: 86 Jest tests across 10 suites pass; full TypeScript and diff checks
  pass. Android production Hermes export succeeds. This is bundle compilation,
  not a signed APK, installation, device test or store submission.
  The local mobile bundle contained 3,898 modules (9.82 MB); generated artifacts
  are excluded from the source release.
- Admin: `bun test tests/admin-feedback.test.ts tests/payment-provider-policy.test.ts`
  — 19 tests pass; `bunx tsc --noEmit -p tsconfig.app.json` and `bun run build`
  pass. Build emits non-blocking bundle-size and stale Browserslist warnings.
- Supplemental in-app browser: cold signup stays on signup, optional opt-ins
  render off, the terms link opens without login, an isolated QA account can
  request a fake-adapter email code and complete verification, and admin contacts
  render database values. Export click displays the CSV-started confirmation;
  CSV generation/download mechanics are separately unit-tested.
- Admin rendered the fixture's four accounts, one booking and one persisted
  message. An expired session produced an explicit analytics error; switching
  to Plus showed that separate reporting is not connected, not made-up figures.
- Browser reproduction found cold `/settings` selecting the grouped supplier
  screen. Both supplier settings now expose verification/consent/legal controls
  and delegate customer users to customer settings after hydration. Regression
  tests cover all three surfaces. A browser preference save survived reload and
  appeared as the corresponding opt-in in the admin contact register.

### Verification limitations

- The required Interceptor browser gate is **not passed**: the CLI reports
  `no extensions connected`. In-app browser checks are supplemental, not a
  substitute for that gate or Android device testing.
- The existing admin `bun run test` command invokes a separate onboarding E2E
  suite pointed at port 8080. Both cases stop at connection-refused because
  that target is not running. They were not rerun against production or counted
  among the 19 passing unit tests.
- The local fixture API is in-memory, uses synthetic accounts and fake mail,
  and exposes only routes relevant to this checkpoint. Its missing unrelated
  dashboard/notification routes are not production failure evidence.
- No real email, real conversation, production database, external campaign,
  physical Android device or released client build was used in these tests.

## Release gates

1. Select the intended backend/database and capture a backup plus schema/migration
   ledger. Do not replay the entire migration directory: it includes quarantined
   historical migrations. Leave the separate payment rehearsal/next wave alone.
2. Confirm approved `010_booking_chat_expansion.sql` tables exist. Apply the new
   additive `015_account_trust.sql` through the approved release procedure before
   enabling the new account, consent, contact or socket-ticket routes.
3. Inspect `PRAGMA table_info(customer_profiles)`. The frozen baseline lacks
   `date_of_birth` and `gender`, while current registration writes both. An
   isolated candidate is provided at
   `tests/fixtures/016_customer_registration_fields.sql`.
   Apply only missing column statements after target review; a target already
   carrying these fields must not blindly reapply them. The local integration
   probe rehearses this candidate instead of hiding the gap in fixture-only SQL.
   The frozen baseline and quarantined historical migrations are unchanged.
4. Confirm the selected mail adapter/binding, sender authorization and domain
   configuration. Run one approved registration/inbox/resend/verification test;
   do not equate the configuration readiness flag with successful delivery.
5. Approve legal copy, genuine vendor inventory and inbound support/mailbox
   ownership. No marketing opt-in is inferred from account creation.
6. Build and install the updated Android release against the intended backend.
   Verify registration, cold deep links, consent save/reload/withdrawal, real
   profile discovery, eligible-booking two-user chat/reconnect and failed sends.
   Confirm ordinary production builds do not enable the explicit demo-mode flag.
7. Reconnect Interceptor and repeat rendered mobile-web/admin journeys, including
   CSV download and Plus-mode honest empty/unavailable states. Reconcile the
   separate onboarding E2E environment before claiming that suite passes.

These gates distinguish local implementation from what Court can currently
observe on an installed app. Do not message the client that production is fixed
until the release and device checks have actually been completed.
