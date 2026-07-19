# D1 Baseline, Repair, and Additive Chat Strategy

Status: approved design only; implementation and D1 execution remain gated by T-024 and T-025+

## Decision

Migration applicability is selected from the target database's schema plus `d1_migrations` ledger, never by replaying every repository SQL file. The current `004_mobile_app_features.sql` and `009_booking_scoped_chat.sql` are quarantined from release tooling.

## Why legacy 004 cannot be replayed

The fresh historical probe records seven deterministic failures because `004_mobile_app_features.sql` assumes companion-era booking/review columns absent from `001_initial_schema.sql`, then re-adds supplier rating columns and a service category column that already exist. Raw directory replay is therefore neither a fresh-install baseline nor an existing-target repair strategy.

## Target selection

1. Capture exact target identity, schema, `d1_migrations`, table row counts, and a recoverable Time Travel bookmark/export.
2. Compare the target against named precondition fingerprints.
3. Select exactly one reviewed path:
   - **empty/fresh target:** generate and apply a canonical baseline containing the current non-legacy schema, then record it once;
   - **recognized existing target:** apply a narrowly scoped, idempotent repair that checks every column/index before changing it;
   - **unknown target:** refuse execution and escalate. There is no best-effort path.
4. Apply payment, additive chat, and restitution migrations only through Wrangler's migration ledger after disposable rehearsal.

## Chat expand/contract design

The existing `009_booking_scoped_chat.sql` renames active legacy tables and would break the old Worker immediately. It is forbidden.

The approved expansion creates `booking_chat_rooms` and `booking_chat_messages` alongside legacy pair-scoped `chat_rooms` and `chat_messages`:

1. New tables derive both participants from a unique booking.
2. No legacy conversation is copied because it cannot be attributed safely to one booking.
3. The new Worker reads and writes only booking chat; the old Worker can continue using legacy tables during the compatibility window.
4. Verification proves old and new Worker behavior before traffic changes.
5. Legacy table retirement or renaming is outside this release and requires a separate contract migration after the old Worker is unavailable.

## Dependency graph

```text
target identity + ledger + recovery point
                 |
                 v
        baseline OR known repair
                 |
                 v
     payment attempts + webhook ledger
                 |
          +------+------+
          |             |
          v             v
 additive booking   restitution ledger
      chat              contract
          |             |
          +------+------+
                 v
   old/new Worker compatibility proof
                 |
                 v
          staged traffic rehearsal
```

## Forbidden execution patterns

- raw `for file in migrations/*.sql` replay;
- applying either legacy `004` or destructive `009` to any release target;
- trusting a migration filename without checking `d1_migrations` and schema;
- testing restore by overwriting active staging or production;
- renaming/dropping legacy chat tables during this release;
- continuing after an unrecognized precondition or partial failure.
