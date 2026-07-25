import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySql, createDb, fullSchemaDump } from './helpers/sqlite';

const migrationPath = resolve(import.meta.dirname, '../../migrations/012_supplier_onboarding.sql');

function loadSql(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('012_supplier_onboarding migration', () => {
  it('creates the supplier_onboarding_applications table with the contract columns', () => {
    const db = createDb();
    applySql(db, loadSql(), '012_supplier_onboarding.sql');

    const table = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'supplier_onboarding_applications'")
      .get() as { sql: string } | undefined;

    expect(table).toBeDefined();
    for (const column of [
      'id',
      'business_name',
      'contact_name',
      'email',
      'phone',
      'location',
      'bio',
      'brochure_urls',
      'categories',
      'mode',
      'status',
      'created_at',
      'updated_at',
      'reviewed_user_id',
    ]) {
      expect(table!.sql).toContain(column);
    }
  });

  it('is idempotent — applying twice is a no-op', () => {
    const db = createDb();
    const sql = loadSql();
    applySql(db, sql, '012_supplier_onboarding.sql');
    const first = fullSchemaDump(db);
    expect(() => applySql(db, sql, '012_supplier_onboarding.sql')).not.toThrow();
    expect(fullSchemaDump(db)).toEqual(first);
  });
});
