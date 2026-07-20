# T-021 Fail-Closed Backend Delivery Gate Evidence

Status: **PASS LOCALLY — NO EXTERNAL COMMANDS EXECUTED**

Generated: `2026-07-20`

Authority: local T-021 implementation only. This evidence does not authorize GitHub publication, staging access, secret configuration, D1 mutation, Worker deployment, production access, or App Store submission.

## Corrected delivery boundary

- `scripts/deploy.sh` requires an explicit `staging` or `production` target and uses `set -euo pipefail`.
- Staging requires `TIRAK_RELEASE_AUTHORIZATION=T-024_APPROVED`; production requires `TIRAK_RELEASE_AUTHORIZATION=T-072_APPROVED` plus a production change identifier.
- `scripts/validate-target.mjs` binds the Worker, D1 database, account, runtime environment, disabled payment mode, and disabled PromptPay creation to the selected target.
- Placeholder staging identities fail closed. They remain unresolved until T-025 and cannot be used for deployment.
- Migrations use Wrangler's D1 migration ledger with an explicit immutable database name, environment, and `--remote`; the legacy raw directory loop is removed.
- `scripts/backup.sh` uses `wrangler d1 export`, rejects an empty export, restores it into disposable SQLite, checks integrity and foreign keys, and writes a SHA-256 manifest.
- `scripts/verify-local-recovery.sh` independently proves the frozen payment/chat schema can be dumped and restored with payment and booking-message rows intact.
- Type, test, backup, restore, migration, deploy, and health failures propagate nonzero. Warning-only continuation is removed.

Cloudflare command choices follow the current official documentation for [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), and [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/).

## Verification result

`npm run release:verify`:

- TypeScript: PASS
- Vitest: 10/10 files, 186/186 tests
- Strict shell/static audit: PASS
- Stale `tirak-db` targets: zero
- Raw migration-directory loops: zero
- Disposable recovery: integrity `ok`, zero foreign-key violations, one payment attempt, one booking message
- Isolated positive pipeline: PASS
- Placeholder staging refusal: PASS
- Production target static validation: PASS
- External commands executed: zero

## Deliberate failure matrix

| Fixture | Expected result | Observed exit |
| --- | --- | ---: |
| wrong target | nonzero | 1 |
| typecheck failure | nonzero | 97 |
| test failure | nonzero | 97 |
| backup failure | nonzero | 97 |
| migration failure | nonzero | 97 |
| deploy failure | nonzero | 97 |
| health failure | nonzero | 97 |
| corrupted restore | nonzero | 1 |

## Known gated state

The staging D1, KV, and session namespace identifiers in `wrangler.toml` are still placeholders. That is intentional evidence of refusal, not readiness. T-025 must resolve and human-confirm actual staging identities after T-024 approval; until then the staging validator and deployment script exit nonzero before any Cloudflare mutation.
