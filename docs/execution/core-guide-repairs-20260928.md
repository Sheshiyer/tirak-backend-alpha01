# Core guide management repairs — local candidate

Scope: Tirak Core only. No live deploy, migration, account approval, email, push, or payment change is performed by this patch.

## Contracts

- `GET /api/companions/:id/experiences`: owner supplier/companion can list non-archived rows before approval, including inactive drafts; public readers require the shared approved/active/non-review guide predicate and see only active, non-archived rows. Pagination defaults to 50, maximum 100. `data.items` uses the current mobile Experience shape.
- Authenticated owner POST/PUT use the current mobile payload. Price is THB, duration is integer minutes 30–1440, keywords persist. `data={experienceId,created}`. DELETE is idempotent for a row belonging to the owner and returns `{experienceId,archived:true}`. IDs/foreign keys remain; archived rows cannot be edited/reactivated through this contract.
- `GET/PUT /api/companions/:id/availability/settings`: authenticated owner, `{timeZone:'Asia/Bangkok',days:[{dayOfWeek,startTime,endTime,isAvailable}]}`. PUT atomically replaces the recurring week; missing weekdays and `days:[]` mean unavailable/unset. Only one interval per weekday is supported.
- Existing availability POST array now writes exact date overrides. One interval per date, closed overrides take precedence over weekly defaults. The entire input validates before one D1 batch. Valid calendar dates, real clock times, same-day intervals, maximum 90 distinct dates; overlapping submitted ranges are rejected rather than silently overwritten.
- Availability GET preserves date/time-slot response shape, returns Bangkok timezone and 30-minute slots with exact start-minute precision; no fabricated price. Pending, confirmed and in-progress bookings all reserve intersecting slots.
- New bookings require the public approved guide predicate, an active non-archived service, the service's canonical duration and an explicitly available full interval. Caller endTime must match duration. Cross-midnight bookings are rejected; the contract supports `00:00`–`23:59`, not `24:00`. A 24-hour service cannot be booked under these same-day schedule rules. Existing bookings retain participant-authorized status transitions after visibility/archive changes; changing a schedule does not cancel historical or pending bookings.
- Static authenticated `/api/suppliers/stats` precedes `/:id`. Full-dataset owner SQL aggregates use scheduled Bangkok wall-clock date, year-qualified month/week/quarter buckets (`%W`, not ISO weeks). Count includes cancelled; completed/cancelled counts separate. Unmeasured earnings, period ratings, response times/rates and views are null. `bookedValue` excludes cancelled and is not cash collected/provider revenue. Mixed currencies yield null value/currency. Average rating derives public reviews; no reviews gives null.
- All legacy public supplier aliases use the shared visibility predicate. Detail bypasses old KV content so approval/archive changes cannot leak stale public data. Public services and booking selection explicitly exclude archived rows even if a legacy caller reactivates `is_active`.
- New owner handlers sanitize database errors to HTTP 500 within the authentication boundary; they do not turn persistence failure into successful empty data or authentication failure.

## Selected migration and preflight

`017_core_guide_management.sql` is additive: service `keywords`, `archived_at`, date-override table, and overlap protection triggers for active reservations. It is not idempotent raw SQL: apply exactly once through the selected ledger after a restore-tested backup. Do not replay the migration directory.

Before any separately authorized live application, verify exact Worker/D1 bindings, ledger and column absence; count existing overlapping pending/confirmed/in-progress bookings. Existing overlaps are not deleted or repaired by this migration. A scoped SELECT on September 28 returned zero overlapping active pairs with zero writes; repeat immediately before application. Investigate any nonzero count before installing triggers because subsequent confirmation could otherwise be rejected. Existing pending-expiry policy is unchanged.

```sql
SELECT COUNT(*) AS overlapping_pairs
FROM bookings a JOIN bookings b ON a.id < b.id AND a.supplier_id=b.supplier_id
WHERE a.status IN ('pending','confirmed','in_progress')
  AND b.status IN ('pending','confirmed','in_progress')
  AND datetime(a.scheduled_at) < datetime(b.scheduled_at,'+' || b.duration || ' minutes')
  AND datetime(a.scheduled_at,'+' || a.duration || ' minutes') > datetime(b.scheduled_at);
PRAGMA table_info(bookings);
PRAGMA table_info(supplier_services);
PRAGMA foreign_key_check;
```

Live read-only preflight on September 28 verified six nullable legacy booking columns absent from the checked-in canonical baseline: `customer_preferences`, `special_requests`, `preferred_language`, `group_composition`, `dietary_requirements`, `experience_id`. This repair does not duplicate ALTERs on the retained live D1. The SQLite route harness explicitly models those observed columns; fresh deployments need their own reconciled baseline before this route is considered compatible. Notification transport is mocked in that harness and remains independently tested, not live-delivery proof.

New code requires migration 017 before deployment. Old Worker can read the additive schema, but overlap triggers continue enforcing reservations if rolling back Worker code. Preserve the trigger contract unless a separately reviewed rollback says otherwise; never delete archived services or historical bookings to roll back.

## Local evidence

The new SQLite route suite covers pending owner persistence, cross-account/anonymous denial, archival with booking FK preservation, all public aliases including stale cache, date exception precedence, full validation/no partial writes, rollback after a later statement fails, pending overlap and database concurrency guard, canonical duration, schedule enforcement, static stats auth/owner isolation, more than 20 bookings, year boundaries, mixed currencies and truthful null metrics. Ordinary transport/device acceptance remains separate.

Final candidate verification: TypeScript passed; 435 tests across 38 files passed, including 11 new SQLite route scenarios. `git diff --check` passed.
