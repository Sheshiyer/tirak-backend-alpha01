import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySql, createDb, tableSnapshot, stripSqlComments } from './helpers/sqlite';

const migration012Path = resolve(import.meta.dirname, '../../migrations/012_supplier_onboarding.sql');
const migration013Path = resolve(import.meta.dirname, '../../migrations/013_supplier_onboarding_review.sql');
const migration020Path = resolve(import.meta.dirname, '../../migrations/020_core_onboarding_lifecycle.sql');

function loadSql(path: string): string {
  return readFileSync(path, 'utf8');
}

function buildOnboardingDb() {
  const db = createDb();
  applySql(db, loadSql(migration012Path), '012_supplier_onboarding.sql');
  applySql(db, loadSql(migration013Path), '013_supplier_onboarding_review.sql');
  applySql(db, loadSql(migration020Path), '020_core_onboarding_lifecycle.sql');
  return db;
}

describe('020_core_onboarding_lifecycle migration', () => {
  it('adds idempotency_key_hash, status_token_hash, application_data, and email_normalized columns', () => {
    const db = buildOnboardingDb();

    const table = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'supplier_onboarding_applications'")
      .get() as { sql: string } | undefined;

    expect(table).toBeDefined();
    for (const column of [
      'idempotency_key_hash',
      'status_token_hash',
      'application_data',
      'email_normalized',
    ]) {
      expect(table!.sql).toContain(column);
    }
    db.close();
  });

  it('creates the idempotency unique index', () => {
    const db = buildOnboardingDb();

    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_supplier_onboarding_idempotency'")
      .all() as Array<{ name: string; sql: string }>;

    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.sql).toContain('UNIQUE');
    db.close();
  });

  it('creates indexes on email_normalized and status_token_hash', () => {
    const db = buildOnboardingDb();

    const emailIdx = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_supplier_onboarding_email_norm'")
      .all();
    expect(emailIdx).toHaveLength(1);

    const tokenIdx = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_supplier_onboarding_status_token'")
      .all();
    expect(tokenIdx).toHaveLength(1);
    db.close();
  });

  it('enforces unique idempotency_key_hash at the SQL level', () => {
    const db = buildOnboardingDb();

    db.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, mode, status,
        idempotency_key_hash, status_token_hash, email_normalized
      ) VALUES (?, ?, ?, ?, ?, ?, 'tirak', 'pending', ?, ?, ?)
    `).run('app-1', 'Business', 'Contact', 'test@example.com', '1234567890', 'Bangkok', 'hash-abc', 'token-hash-1', 'test@example.com');

    expect(() => {
      db.prepare(`
        INSERT INTO supplier_onboarding_applications (
          id, business_name, contact_name, email, phone, location, mode, status,
          idempotency_key_hash, status_token_hash, email_normalized
        ) VALUES (?, ?, ?, ?, ?, ?, 'tirak', 'pending', ?, ?, ?)
      `).run('app-2', 'Other', 'Other', 'other@example.com', '9876543210', 'Chiang Mai', 'hash-abc', 'token-hash-2', 'other@example.com');
    }).toThrow(/idempotency_key_hash/);
    db.close();
  });

  it('allows NULL idempotency_key_hash (legacy applications)', () => {
    const db = buildOnboardingDb();

    db.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, mode, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'tirak', 'pending')
    `).run('app-legacy', 'Legacy', 'Contact', 'legacy@example.com', '1234567890', 'Bangkok');

    const row = db.prepare('SELECT id, idempotency_key_hash FROM supplier_onboarding_applications WHERE id = ?').get('app-legacy') as { id: string; idempotency_key_hash: string | null };
    expect(row.id).toBe('app-legacy');
    expect(row.idempotency_key_hash).toBeNull();
    db.close();
  });

  it('second application of 020 throws duplicate column (expected for ALTER TABLE)', () => {
    const db = createDb();
    applySql(db, loadSql(migration012Path), '012_supplier_onboarding.sql');
    applySql(db, loadSql(migration013Path), '013_supplier_onboarding_review.sql');

    const sql = loadSql(migration020Path);
    applySql(db, sql, '020_core_onboarding_lifecycle.sql');
    // ALTER TABLE ADD COLUMN is not idempotent in SQLite; second application
    // throws "duplicate column name" which is expected. The Wrangler migration
    // ledger applies this exactly once.
    expect(() => applySql(db, sql, '020_core_onboarding_lifecycle.sql')).toThrow(/duplicate column/);
    db.close();
  });

  it('allows multiple applications with different idempotency hashes', () => {
    const db = buildOnboardingDb();

    db.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, mode, status,
        idempotency_key_hash, status_token_hash, email_normalized
      ) VALUES (?, ?, ?, ?, ?, ?, 'tirak', 'pending', ?, ?, ?)
    `).run('app-1', 'Business A', 'Contact A', 'a@example.com', '1111111111', 'Bangkok', 'hash-a', 'token-a', 'a@example.com');

    db.prepare(`
      INSERT INTO supplier_onboarding_applications (
        id, business_name, contact_name, email, phone, location, mode, status,
        idempotency_key_hash, status_token_hash, email_normalized
      ) VALUES (?, ?, ?, ?, ?, ?, 'tirak', 'pending', ?, ?, ?)
    `).run('app-2', 'Business B', 'Contact B', 'b@example.com', '2222222222', 'Chiang Mai', 'hash-b', 'token-b', 'b@example.com');

    const rows = db.prepare('SELECT id FROM supplier_onboarding_applications').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    db.close();
  });
});
