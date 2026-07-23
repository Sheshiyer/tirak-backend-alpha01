# T-027 Lane C — Live Staging Schema Actuals (`tirak-staging`)

**Task:** T-027 (GitHub issue Sheshiyer/tirak-mobile-app-v2#27) — inspect staging booking, payment, and chat schema.
**Lane:** C — live staging D1 probes, Cloudflare read-only (SELECT-only; zero mutations performed).
**Date:** 2026-07-24 (local, APAC). Staging re-verified pristine-empty 2026-07-23 in T-026 (fingerprint `52431d704ca2ea3dbf208785ea6ea09f60c9629a00ea37544ad49b30d04c7f10`).

## Database identity (from `npx wrangler d1 info tirak-staging --json`)

| Field | Value |
|---|---|
| uuid | `5132c8cc-8f23-4dd2-94d1-9d53edb92888` |
| name | `tirak-staging` |
| created_at | `2026-07-21T08:31:52.401Z` |
| num_tables | **0** |
| running_in_region | APAC |
| read_replication | disabled |
| database_size | 12288 bytes |
| bookmark | **not exposed** — `d1 info --json` returns no bookmark field; per-query `meta.bookmark` was `null` on every execute call |

Evidence: `staging-d1-info.json`

## Probe results

| # | Probe | File | Result |
|---|-------|------|--------|
| 1 | Full `sqlite_schema` dump (all rows incl. system) | `staging-sqlite-schema.json` | **1 row only:** Cloudflare-internal `_cf_KV` (`key TEXT PRIMARY KEY, value BLOB`, WITHOUT ROWID). Zero user tables, zero indexes, zero triggers, zero views. |
| 2 | `PRAGMA table_list;` | `staging-table-list.json` | 3 rows: `_cf_KV` (internal), `sqlite_schema`, `sqlite_temp_schema`. **No user tables.** |
| 3 | Per-user-table `table_info` / `index_list` / `foreign_key_list` | `staging-user-tables.json` | **NOT_APPLICABLE** — empty user-table set, recorded as such. This empty set is the expected PASS evidence per T-025/T-026. |
| 4 | `d1_migrations` ledger existence + dump | `staging-migration-ledger.json` | **0 rows** — `d1_migrations` does **not** exist. No wrangler-managed migration has ever been applied to this database. |
| 5 | `PRAGMA user_version;` | `staging-user-version.json` (+`.stderr.txt`) | **REFUSED** — Cloudflare API error `not authorized: SQLITE_AUTH [code: 7500]`, same refusal class seen via REST in T-025. Refusal recorded as evidence; `user_version` is not readable on D1 via wrangler remote execute. |

All successful queries were served by `v3-prod` with `changes: 0`, `rows_written: 0` — confirming read-only execution.

## Actual vs. expectation

| Check | Expected | Actual | Verdict |
|---|---|---|---|
| User tables (booking/payment/chat or any other) | none (pristine-empty) | none | **PASS** |
| User indexes / foreign keys | none | none (no tables to hold them) | **PASS** |
| `d1_migrations` ledger | absent (no migrations applied yet) | absent | **PASS** |
| `user_version` ledger readable | known-unreadable since T-025 | SQLITE_AUTH 7500 refusal reproduced | **PASS (expected refusal)** |

Staging state on 2026-07-24 matches the pristine-empty expectation exactly and is consistent with the T-026 fingerprint re-verification. No drift detected.

## Implications for T-028 (migration lineage implementation)

1. **Migration ledger must be table-based.** `PRAGMA user_version` is refused (SQLITE_AUTH 7500) on both REST and wrangler paths — lineage tracking cannot rely on it. `wrangler d1 migrations apply` creates `d1_migrations`; since that table is currently absent, the first apply of the lineage (001–009) will create it fresh — a clean, unambiguous baseline.
2. **All preconditions that require prior-migration tables will FAIL on staging as-is** — intentionally. Migrations 008/009 assume artifacts of 001–007 (booking/payment/chat base tables). Staging has none, so the full lineage must be applied in order; 008/009 cannot be applied standalone.
3. **No bookmark-based consistency checks available.** Neither `d1 info` nor per-query `meta.bookmark` surfaced a bookmark; cross-lane fingerprinting (T-026 style hash of schema dump) remains the drift-detection mechanism.
4. **No cleanup needed before T-028.** `_cf_KV` is Cloudflare-internal and must be excluded from the T-011 (`tirak-payments-v1`) contract surface; it is not a user table and must not be migrated or dropped.

_Auth note: credentials loaded from `.env.tirak-staging` (mode 0600) via shell env; no tokens printed or persisted. No signed URLs appeared in any captured output; nothing required redaction._
