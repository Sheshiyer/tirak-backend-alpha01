import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core customer registration fields on the canonical baseline', () => {
  it('preserves existing customers and accepts current optional profile fields', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync(resolve(import.meta.dirname, '../../migrations/baseline/canonical-baseline.sql'), 'utf8'));
      db.exec("INSERT INTO users(id,email,phone,password_hash,user_type) VALUES ('qa-customer','customer@qa.invalid','+66900000000','fixture-only','customer')");
      db.exec("INSERT INTO customer_profiles(user_id,display_name) VALUES ('qa-customer','QA customer')");
      db.exec(readFileSync(resolve(import.meta.dirname, '../../migrations/023_core_customer_registration_fields.sql'), 'utf8'));
      expect(db.prepare('SELECT date_of_birth,gender FROM customer_profiles').get()).toMatchObject({date_of_birth:null,gender:null});
      db.prepare('UPDATE customer_profiles SET date_of_birth = ?, gender = ?').run('1990-01-01','other');
      expect(db.prepare('SELECT date_of_birth,gender FROM customer_profiles').get()).toMatchObject({date_of_birth:'1990-01-01',gender:'other'});
      expect(() => db.prepare('UPDATE customer_profiles SET gender = ?').run('unsupported')).toThrow(/CHECK constraint/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally { db.close(); }
  });
});
