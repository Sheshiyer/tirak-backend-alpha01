# T-026 Staging Recovery Point Evidence

Status: **PASS — recovery point captured, restore proven on disposable rehearsal DB, rehearsal deleted, staging fingerprint unchanged**

Executed: 2026-07-23 (capture `2026-07-23T18:12:04Z`)
Task: `Sheshiyer/tirak-mobile-app-v2#26`
Contract: `tirak-payments-v1`
Branch: `codex/tirak-omise/w2.1/t-026-staging-recovery-point`
Authority: T-024 read-only staging evidence plus two explicit human gates executed during this task (GATE 1: rehearsal-DB creation; GATE 2: rehearsal-DB deletion). Production mutation, live Omise charging, App Store submission, and staging application-schema migration were never attempted.

## Acceptance mapping (issue #26)

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Time Travel bookmark or complete export with corrected target | Both captured against `tirak-staging` (uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`, pinned account) | bookmark `00000004-00000000-000050b1-8a569dc1ed6892b99a7f807910fd90a9`; export `tirak-staging-20260723T181204Z.sql` sha256 `309d1516…7398` |
| Recovery artifact is timestamped | Capture timestamp `20260723T181204Z` embedded in artifact name and ledger | `evidence/t026/t-026-recovery-ledger.json` |
| Restoration proven on disposable rehearsal DB | Export restored into `tirak-t026-rehearsal` (uuid `15469a54-cd99-4ae2-9d84-c8a1dfae59ed`, APAC); post-restore schema probe byte-identical to capture probe (`[]` = `[]`); row-count manifest identically empty | `rehearsal-restore.json`, `rehearsal-schema-probe.json`, `schema-probe.json` |
| Active staging never overwritten for proof | Transcript audit: zero write/restore commands targeted `tirak-staging`; pre- and post-task fingerprints identical | Stage A + post-teardown discovery ledgers |
| `d1 info`, Time Travel/export, disposable restore, checksums, row-count evidence | All present | `d1-info.json`, `time-travel-bookmark.json`, `checksums.sha256`, ledger `rowCountManifest` |
| Executable restore instructions | Runbook stages B→C are the exact executed command sequence | `docs/execution/phase-2/t-026-staging-recovery-point-runbook.md` (mobile workspace draft; canonical copy below) |

## Execution summary

1. **Stage A (read-only):** token preflight PASS (`write-capable-or-broad`, pinned account verified, 4 requests); discovery PASS — fingerprint `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10` identical to T-025 (zero drift), 16 requests, 0 mutations.
2. **Stage B (read-only capture):** `tirak-staging` reported `num_tables: 0`, APAC, read-replication disabled, zero queries 24h. Export is 32 bytes (`PRAGMA defer_foreign_keys=TRUE;` only), consistent with the T-025 pristine-empty invariant. Schema probe (`sqlite_schema` minus `sqlite_%`, `_cf_%`, `d1_migrations`) returned `[]`.
3. **GATE 1:** human release owner approved creation of exactly one disposable rehearsal D1 (statement recorded in ledger).
4. **Stage C (rehearsal only):** `tirak-t026-rehearsal` created in APAC; export restored successfully (final bookmark `00000000-0000000a-000050b1-dd9bb0948b2e4a2e83ebc46339eee9e3`); restored schema/row-counts proven identical to capture.
5. **GATE 2:** human release owner approved Option A (delete). Rehearsal DB deleted; `wrangler d1 list` verified absence with `tirak-staging` intact.
6. **Post-teardown verification:** discovery re-run — fingerprint unchanged, 0 production commands, 0 remote mutations, 0 secrets captured.

Total remote mutations in this task: exactly 2 (create + delete of the disposable rehearsal DB). Staging, production, secrets, Worker, and schema surfaces: 0 mutations.

## Notes and residuals

- The credential used was the full-scope `court.tirak` account token, materialized into owner-only `.env.tirak-staging` (0600, git-ignored, untracked). Per T-025, rotation of this broad token requires separate secret-mutation authority and remains pending.
- The one-hour signed export URL in the Wrangler transcript was redacted from `export.stdout` before evidence capture; token material is never serialized.
- The pristine-empty staging DB makes this recovery point trivially small; the drill nonetheless proved the full capture → export → disposable-restore → verify → teardown chain end to end. **T-029 (rehearse migration 008) is unblocked** and will exercise this chain with real schema.
- Local artifact bundle: `evidence/t026/` (checksums in `checksums.sha256`). Canonical ledger: `docs/execution/phase-2/t-026-recovery-ledger.json`.

## Reproduction commands

```bash
npm run staging:preflight && npm run staging:discover
export CLOUDFLARE_ACCOUNT_ID=<from .env.tirak-staging> CLOUDFLARE_API_TOKEN=<from .env.tirak-staging>
npx wrangler d1 info tirak-staging --json
npx wrangler d1 time-travel info tirak-staging --json
npx wrangler d1 export tirak-staging --remote --output <ts>.sql
# rehearsal (gated): d1 create → d1 execute --file → probe → d1 delete → d1 list verify
sha256sum -c evidence/t026/checksums.sha256
```
