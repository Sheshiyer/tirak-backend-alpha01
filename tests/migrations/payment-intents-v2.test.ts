import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadMigrationChain, repoRoot } from './helpers/artifacts';
import {
  applySql,
  createDb,
  fullSchemaDump,
  stripSqlComments,
  tableSnapshot,
} from './helpers/sqlite';

const candidatePath = join(
  repoRoot,
  'tests/fixtures/014_payment_intents_v2.sql',
);

const V1_TABLES = [
  'payment_attempts',
  'payment_webhook_events',
  'payment_restitutions',
] as const;

function v1Surface(db: DatabaseSync) {
  return V1_TABLES.map((table) => ({ table, snapshot: tableSnapshot(db, table) }));
}

describe('payment-intents V2 additive migration candidate', () => {
  let db: DatabaseSync;
  let candidateSql: string;

  beforeAll(() => {
    db = createDb();
    for (const artifact of loadMigrationChain()) applySql(db, artifact.sql, artifact.name);
    candidateSql = readFileSync(candidatePath, 'utf8');
  });

  it('is explicitly confined to additive V2 tables and indexes', () => {
    const executable = stripSqlComments(candidateSql);
    expect(executable).not.toMatch(/\b(?:DROP|ALTER|RENAME|INSERT|UPDATE|DELETE|REPLACE)\b/i);
    expect(executable).not.toMatch(/\b(?:payment_attempts|payment_webhook_events|payment_restitutions)\b/i);
    expect(executable).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_intents_v2/i);
    expect(executable).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_provider_events_v2/i);
  });

  it('leaves the complete V1 payment surface byte-for-byte structurally unchanged', () => {
    const before = v1Surface(db);
    applySql(db, candidateSql, '014_payment_intents_v2.sql');
    expect(v1Surface(db)).toEqual(before);
  });

  it('creates provider-neutral intent/event tables with the expected safety indexes', () => {
    const intent = tableSnapshot(db, 'payment_intents_v2');
    const event = tableSnapshot(db, 'payment_provider_events_v2');
    expect(intent?.columns.map((column) => column.name)).toEqual([
      'id', 'booking_id', 'customer_id', 'provider', 'provider_intent_reference',
      'amount_minor', 'currency', 'status', 'created_at', 'updated_at',
    ]);
    expect(event?.columns.map((column) => column.name)).toEqual([
      'id', 'payment_intent_id', 'provider', 'provider_event_reference', 'kind', 'occurred_at', 'received_at',
    ]);
    expect(intent?.fks).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'booking_id', refTable: 'bookings', to: 'id' }),
      expect.objectContaining({ from: 'customer_id', refTable: 'users', to: 'id' }),
    ]));
    expect(event?.fks).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'payment_intent_id', refTable: 'payment_intents_v2', to: 'id' }),
    ]));
    expect(intent?.indexes.map((index) => index.key)).toContain('uq_payment_intents_v2_provider_reference');
    expect(event?.indexes.map((index) => index.key)).toContain('uq_payment_provider_events_v2_provider_reference');
  });

  it('is safe to replay locally without a second schema change', () => {
    const firstPass = fullSchemaDump(db);
    applySql(db, candidateSql, '014_payment_intents_v2.sql (second pass)');
    expect(fullSchemaDump(db)).toEqual(firstPass);
  });
});
