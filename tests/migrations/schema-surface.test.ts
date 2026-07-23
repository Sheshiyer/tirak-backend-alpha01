import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrationChain } from './helpers/artifacts';
import {
  buildContractDb,
  buildMigrationDb,
  diffTable,
  tableSnapshot,
} from './helpers/sqlite';

/**
 * T-028 requirement (1): applying baseline + corrected 008 + 010 + 011 to a
 * fresh SQLite database must reproduce the tirak-payments-v1 target schema
 * exactly for the payments, webhook, chat, and restitutions domains.
 */
describe('T-028 schema surface vs tirak-payments-v1 contract', () => {
  let contractDb: DatabaseSync;
  let migrationDb: DatabaseSync;
  let domainTables: string[];

  beforeAll(() => {
    ({ db: contractDb, domainTables } = buildContractDb());
    migrationDb = buildMigrationDb();
  });

  it('declares the five contract domain tables', () => {
    expect([...domainTables].sort()).toEqual(
      [
        'booking_chat_messages',
        'booking_chat_rooms',
        'payment_attempts',
        'payment_restitutions',
        'payment_webhook_events',
      ].sort(),
    );
  });

  it('creates every contract domain table in the migrated database', () => {
    for (const table of domainTables) {
      expect(
        tableSnapshot(migrationDb, table),
        `domain table ${table} must exist after the migration chain`,
      ).not.toBeNull();
    }
  });

  it.each([
    'payment_attempts',
    'payment_webhook_events',
    'payment_restitutions',
    'booking_chat_rooms',
    'booking_chat_messages',
  ])('table %s matches the contract exactly (columns, FKs, CHECKs, indexes)', (table) => {
    const expected = tableSnapshot(contractDb, table);
    const actual = tableSnapshot(migrationDb, table);
    expect(diffTable(table, expected, actual)).toEqual([]);
  });

  it('adds no extra objects on contract domain tables beyond the contract', () => {
    // diffTable already compares the full index/trigger sets per table, so any
    // extra index (e.g. the pre-correction idx_payment_attempts_booking) or
    // trigger attached to a domain table fails the per-table assertions above.
    // This guard additionally fails if a *contract* table silently went missing
    // from the contract parse (guard against an empty domain).
    expect(domainTables.length).toBeGreaterThanOrEqual(5);
  });

  it('the migration chain applies in the coordinator-fixed order', () => {
    const chain = loadMigrationChain();
    expect(chain.map((a) => a.name)).toEqual([
      'migrations/baseline/canonical-baseline.sql',
      'migrations/008_omise_promptpay_payments.sql',
      'migrations/010_booking_chat_expansion.sql',
      'migrations/011_payment_restitutions.sql',
    ]);
  });
});
