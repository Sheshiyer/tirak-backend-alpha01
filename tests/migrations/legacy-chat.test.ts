import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { buildMigrationDb, seedStubRow } from './helpers/sqlite';

/**
 * T-028 requirement (4): legacy preservation / dual-Worker compatibility
 * probe. The additive chat expansion (010) must leave the legacy pair-scoped
 * `chat_rooms` / `chat_messages` tables (from the baseline) present and
 * writable, so the old Worker keeps working during the compatibility window.
 * Renaming or dropping legacy chat tables is forbidden this release.
 */
describe('T-028 legacy chat preservation (dual-Worker compatibility)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = buildMigrationDb();
    db.exec('PRAGMA foreign_keys = OFF;');
    seedStubRow(db, 'users', { id: 'u_customer' });
    seedStubRow(db, 'users', { id: 'u_supplier' });
    seedStubRow(db, 'bookings', {
      id: 'b1',
      customer_id: 'u_customer',
      supplier_id: 'u_supplier',
    });
  });

  it('keeps legacy chat_rooms and chat_messages after the full chain applies', () => {
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toContain('chat_rooms');
    expect(tables).toContain('chat_messages');
    expect(tables).toContain('booking_chat_rooms');
    expect(tables).toContain('booking_chat_messages');
  });

  it('legacy chat tables remain writable (old Worker probe)', () => {
    db.prepare(
      `INSERT INTO chat_rooms (id, customer_id, supplier_id) VALUES ('legacy_room_1', 'u_customer', 'u_supplier')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, room_id, sender_id, message_type, content)
       VALUES ('legacy_msg_1', 'legacy_room_1', 'u_customer', 'text', 'hello from old worker')`,
    ).run();

    const room = db
      .prepare(`SELECT * FROM chat_rooms WHERE id = 'legacy_room_1'`)
      .get() as Record<string, unknown>;
    expect(room.customer_id).toBe('u_customer');
    expect(room.supplier_id).toBe('u_supplier');
    expect(room.status).toBe('active');

    const message = db
      .prepare(`SELECT * FROM chat_messages WHERE id = 'legacy_msg_1'`)
      .get() as Record<string, unknown>;
    expect(message.room_id).toBe('legacy_room_1');
    expect(message.content).toBe('hello from old worker');
  });

  it('booking chat tables are writable alongside legacy chat (new Worker probe)', () => {
    db.prepare(
      `INSERT INTO booking_chat_rooms (id, booking_id, customer_id, supplier_id)
       VALUES ('broom_1', 'b1', 'u_customer', 'u_supplier')`,
    ).run();
    db.prepare(
      `INSERT INTO booking_chat_messages (id, room_id, sender_id, message_type, content)
       VALUES ('bmsg_1', 'broom_1', 'u_supplier', 'text', 'hello from new worker')`,
    ).run();

    const room = db
      .prepare(`SELECT * FROM booking_chat_rooms WHERE id = 'broom_1'`)
      .get() as Record<string, unknown>;
    expect(room.booking_id).toBe('b1');

    const message = db
      .prepare(`SELECT * FROM booking_chat_messages WHERE id = 'bmsg_1'`)
      .get() as Record<string, unknown>;
    expect(message.room_id).toBe('broom_1');

    // The legacy pair must be untouched by booking-chat writes.
    const legacyCount = db
      .prepare(`SELECT COUNT(*) AS n FROM chat_rooms`)
      .get() as { n: number };
    expect(legacyCount.n).toBe(0);
  });

  it('rejects a second booking chat room for the same booking', () => {
    db.prepare(
      `INSERT INTO booking_chat_rooms (id, booking_id, customer_id, supplier_id)
       VALUES ('broom_1', 'b1', 'u_customer', 'u_supplier')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO booking_chat_rooms (id, booking_id, customer_id, supplier_id)
           VALUES ('broom_2', 'b1', 'u_customer', 'u_supplier')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
