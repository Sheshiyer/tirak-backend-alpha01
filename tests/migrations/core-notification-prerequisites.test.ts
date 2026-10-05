import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Core notifications on a fresh canonical baseline', () => {
  it('persists owner-linked notifications and default preferences with real foreign keys', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      for (const file of ['baseline/canonical-baseline.sql','026_core_notification_prerequisites.sql']) {
        db.exec(readFileSync(resolve(import.meta.dirname,'../../migrations',file),'utf8'));
      }
      db.exec("INSERT INTO users(id,email,phone,password_hash,user_type) VALUES ('qa-owner','owner@qa.invalid','+66900000001','fixture-only','customer')");
      const insert = db.prepare('INSERT INTO notifications(id,user_id,type,title,message) VALUES(?,?,?,?,?)');
      insert.run('qa-note','qa-owner','booking_created','QA request','Synthetic persisted notification');
      expect(db.prepare('SELECT notification_preferences FROM users WHERE id=?').get('qa-owner')).toMatchObject({notification_preferences:'{}'});
      expect(db.prepare('SELECT user_id,read FROM notifications WHERE id=?').get('qa-note')).toMatchObject({user_id:'qa-owner',read:0});
      expect(() => insert.run('orphan','missing-owner','booking_created','QA','QA')).toThrow(/FOREIGN KEY constraint/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally { db.close(); }
  });
});
