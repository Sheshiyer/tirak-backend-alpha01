# Retained Core release preparation

The default Worker configuration is the retained Core service. Its resource
names include development, while its runtime is production-facing. The named
production environment is a separate release contract. Keep the existing
staging/production scripts and their identities intact.

Use `npm run release:prepare:core` for the retained service. This command only
validates a private contract and optionally creates a local Wrangler dry-run
artifact. It contains no deployment, migration, trigger or account mutation.

```sh
npm run release:prepare:core -- --contract "$TIRAK_CORE_PRIVATE_CONTRACT"
npm run release:prepare:core -- --contract "$TIRAK_CORE_PRIVATE_CONTRACT" \
  --bundle --out "$TIRAK_CORE_PRIVATE_ARTIFACT"
```

The private JSON contract uses schema `tirak.retained-core-preparation.v1`.
It pins the complete default configuration (all top-level TOML except named
`env` sections), the full live binding list and its canonical digest, a
timestamped serving version/module fingerprint and runtime fields, and the
read-only schema prerequisites. Keep provider/account identities and snapshots
outside public Git history. A trusted operator assembles this evidence from
the existing authorized read-only profile; the contract is evidence input,
not a credential or an approval token.

QA email has no checked-in personal recipient. The optional private
`CORE_QA_EMAIL_RECIPIENT` must be explicitly owner configured; missing or
malformed configuration blocks QA delivery. Configuring it remains a separate
provider decision. Non-QA provider behavior is unchanged.

Validation checks the default Worker and D1 names first, then complete
configuration and resource binding identities, secret names/types, runtime,
Durable Object migration tag, disabled controls and schema prerequisites.
Wrong Worker, DB or resource identities fail before invoking a subprocess or
creating artifact output. The generated receipt binds the artifact hash to a
clean tracked Git HEAD and private-contract digest. Preserve prior output by
selecting a new private artifact directory.

The observed five-minute provider trigger is independent of the candidate's
empty cron declaration. Preparation records
`triggerDisposition: preserve-existing-disabled-held`. The scheduled handler
must stay disabled and skip D1. A later owner-approved promotion must use an
explicit procedure that preserves the existing trigger, or obtain a separate
decision to remove it. Do not use a blanket deploy command that silently
reconciles this mismatch. No trigger change is authorized by preparation.

Migrations 027–030 and the non-null unique booking-room booking key are
read-only prerequisites. Their presence does not authorize applying the
migration directory. Preserve the existing signing secret, receipts and
histories. Produce exact-module replay evidence with disposable state:

```sh
node scripts/core-qa/replay-release-artifacts.mjs \
  --candidate "$TIRAK_CORE_CANDIDATE_MODULE" \
  --rollback "$TIRAK_CORE_ROLLBACK_MODULE" \
  --out "$TIRAK_CORE_PRIVATE_REPLAY"
```

This checks both module transition directions, original receipt/status
capability recovery, changed-payload conflicts, canonical-origin preflights,
and absence of new campaign conversions. It uses synthetic secrets and local
resources. Refresh serving identities, schema and recovery evidence before
any later promotion. Replacement local-job proof and installed-client/live-role
acceptance remain separate gates. `PREPARED_HELD` never means released.

The canonical `/api/supplier-onboarding` intake accepts Core mode (including
the historical omitted default). Explicit Plus mode returns 400
`UNSUPPORTED_APPLICATION_MODE` before persistence instead of creating a Core
record. The active shared admin caller receives a truthful failure and keeps
its form. The separate `/api/public/vendor-application` legacy route retains
its shared Plus contract; only a later Core-specific retirement may change
its Core behavior after the published redirect and caller inventory. Canonical
intake, evidence and private status/recovery routes remain available.
