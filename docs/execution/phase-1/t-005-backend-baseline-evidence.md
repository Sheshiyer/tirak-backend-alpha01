# T-005 Backend Baseline and Known-Failures Evidence

Status: automated application and staged secret probes passed; historical migration and release-safety probes intentionally red
Parent SHA: `9ea989b3e0d53661ab371de8825dd961cc11176d`

## Green exact-tree probes

| Probe | Result |
| --- | --- |
| `npm test` | PASS — 9/9 test files, 157/157 tests |
| `npm run typecheck` | PASS — exit 0; inherited parent `astro/tsconfigs/strict` warning remains non-fatal |
| `git diff --check` | PASS — no whitespace errors |
| staged secret-signature scan | PASS — no Omise key, bearer token, Sentry DSN, PostHog key, or Cloudflare token signature in 18 staged files |

The focused Omise suite passes 26 tests, including server-owned amount, 1,000 THB to 100,000 satang, booking ownership, creation idempotency, indeterminate recovery, raw-body HMAC, replay control, independent provider retrieval, and failed-event reclaim.

## Reproduced historical migration failure

Applying every `migrations/*.sql` file in filename order to a fresh SQLite database fails in `004_mobile_app_features.sql` after `001_initial_schema.sql` established incompatible earlier shapes:

1. `bookings.companion_id` missing.
2. `bookings.date` missing.
3. `reviews.companion_id` missing.
4. `reviews.customer_id` missing.
5. duplicate `supplier_profiles.rating_average`.
6. duplicate `supplier_profiles.rating_count`.
7. `supplier_services.category_id` missing.

The focused `001 + 008 + 009` probe is useful fixture evidence but is not proof that the production migration ledger can replay. Current `009_booking_scoped_chat.sql` is destructive and remains quarantined from deployment until `T-012` and `T-028` replace it with an additive strategy.

## Expected-red release blockers

| Probe | Evidence | Required causal task |
| --- | --- | --- |
| Seed ingestion | `scripts/seed-data.sql` contains active “Companion Services” and “Dining Companion” rows | T-015/T-059 cleanse sources, persisted rows, and caches |
| Deploy script | calls nonexistent `type-check` and `test:ci`, loops raw migrations, and targets stale `tirak-db` | T-021 replaces fail-open tooling and proves deliberate failures |
| Backup script | targets stale `tirak-db` and lacks a proven restoration path | T-021/T-026 establish local and staging recovery proof |
| Cancellation | confirmed bookings may transition directly to cancelled while a QR remains payable | T-010/T-043 enforce the joint state machine |
| Refund serialization | `bookings.ts` maps any cancelled booking to `refunded` | T-010/T-043 require financial restitution evidence |

## Full-chain reproduction

```sh
migration_probe_dir=$(mktemp -d)
migration_probe_db="$migration_probe_dir/full-chain.sqlite"
for migration_file in migrations/*.sql; do
  sqlite3 "$migration_probe_db" < "$migration_file" || break
done
```

## Baseline meaning

The backend baseline is a no-deploy recovery checkpoint. Green application tests do not clear the expected-red migration, seed, delivery-tooling, environment-identity, cancellation, or restitution gates.
