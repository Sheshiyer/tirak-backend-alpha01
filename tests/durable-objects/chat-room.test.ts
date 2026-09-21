import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ChatRoom } from '@/durable-objects/ChatRoom';
import type { Env } from '@/index';

type Event = { type: string; data: { messageId?: string; status?: string; message?: string } };
type Internals = {
  sessions: Map<string, WebSocket>;
  handleWebSocketMessage(userId: string, data: unknown): Promise<void>;
};

describe('ChatRoom committed sends and receipt authorization', () => {
  let db: DatabaseSync;
  let room: ChatRoom;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE booking_chat_rooms (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, supplier_id TEXT NOT NULL,
        last_message_at TEXT, updated_at TEXT
      );
      CREATE TABLE booking_chat_messages (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT,
        message_type TEXT, image_url TEXT, metadata TEXT, reply_to_id TEXT,
        created_at TEXT, delivered_at TEXT, read_at TEXT
      );
      INSERT INTO booking_chat_rooms (id, customer_id, supplier_id) VALUES
        ('room-1', 'alice', 'bob'), ('room-2', 'alice', 'carol');
    `);
    const database = {
      prepare(sql: string) {
        const statement = (params: unknown[] = []): any => ({
          bind: (...values: unknown[]) => statement(values),
          execute: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params as never[]).changes) } }),
          run: async () => statement(params).execute(),
        });
        return statement();
      },
      async batch(statements: Array<{ execute(): unknown }>) {
        db.exec('BEGIN');
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    room = new ChatRoom({ id: { toString: () => 'opaque-durable-object-id' } } as never, { DB: database } as unknown as Env);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  const send = (roomId = 'room-1') => room.fetch(new Request('http://internal/send-message', {
    method: 'POST', body: JSON.stringify({ roomId, senderId: 'alice', recipientId: 'bob', messageType: 'text', content: 'Test message' }),
  }));
  const receipt = (messageId: string, userId: string, extra: Record<string, unknown> = {}) => room.fetch(new Request('http://internal/message-status', {
    method: 'POST', body: JSON.stringify({ messageId, userId, status: 'read', ...extra }),
  }));
  const connect = (userId: string) => {
    const events: Event[] = [];
    (room as unknown as Internals).sessions.set(userId, { send: (value: string) => events.push(JSON.parse(value)) } as WebSocket);
    return events;
  };
  const messageRow = (id: string) => db.prepare('SELECT * FROM booking_chat_messages WHERE id = ?').get(id);

  it('returns a committed sent message when delivery receipt persistence fails', async () => {
    const senderEvents = connect('alice');
    const recipientEvents = connect('bob');
    db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF delivered_at ON booking_chat_messages BEGIN SELECT RAISE(ABORT, 'simulated receipt outage'); END;");
    const response = await send();
    const payload = await response.json() as { success: boolean; message: { id: string; status: string } };
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.message.status).toBe('sent');
    expect(messageRow(payload.message.id)?.delivered_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM booking_chat_messages').get()?.count).toBe(1);
    expect(db.prepare("SELECT last_message_at FROM booking_chat_rooms WHERE id = 'room-1'").get()?.last_message_at).toBeTruthy();
    expect(recipientEvents.filter((event) => event.type === 'message_received')).toHaveLength(1);
    expect(senderEvents.some((event) => event.type === 'message_status_update')).toBe(false);
  });

  it('marks delivered only after its scoped receipt write succeeds', async () => {
    const senderEvents = connect('alice');
    connect('bob');
    const response = await send();
    const payload = await response.json() as { message: { id: string; status: string } };
    expect(payload.message.status).toBe('delivered');
    expect(messageRow(payload.message.id)?.delivered_at).toBeTruthy();
    expect(senderEvents.find((event) => event.type === 'message_status_update')?.data.status).toBe('delivered');
  });

  it('fails a send only when the message itself could not commit', async () => {
    const events = connect('bob');
    db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON booking_chat_messages BEGIN SELECT RAISE(ABORT, 'simulated storage outage'); END;");
    expect((await send()).status).toBe(500);
    expect(db.prepare('SELECT COUNT(*) AS count FROM booking_chat_messages').get()?.count).toBe(0);
    expect(events).toEqual([]);
  });

  it('binds the logical room on first HTTP send and does not use the opaque DO id', async () => {
    const payload = await (await send()).json() as { message: { id: string; roomId: string } };
    expect(payload.message.roomId).toBe('room-1');
    expect((await receipt(payload.message.id, 'bob')).status).toBe(200);
    expect(messageRow(payload.message.id)?.read_at).toBeTruthy();
    expect((await send('room-2')).status).toBe(409);
    expect((await room.fetch(new Request('http://internal/websocket?userId=alice&roomId=room-2', { headers: { Upgrade: 'websocket' } }))).status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM booking_chat_messages').get()?.count).toBe(1);
  });

  it('requires a logical room and authenticated forwarding parameters', async () => {
    expect((await send('')).status).toBe(400);
    expect((await receipt('unknown', 'bob')).status).toBe(400);
    expect((await room.fetch(new Request('http://internal/websocket?roomId=room-1', { headers: { Upgrade: 'websocket' } }))).status).toBe(401);
  });

  it('rejects HTTP receipts for own messages, third parties and another room', async () => {
    const payload = await (await send()).json() as { message: { id: string } };
    db.prepare("INSERT INTO booking_chat_messages (id, room_id, sender_id, message_type) VALUES ('foreign', 'room-2', 'carol', 'text')").run();
    expect((await receipt(payload.message.id, 'alice')).status).toBe(404);
    expect((await receipt(payload.message.id, 'carol')).status).toBe(404);
    expect((await receipt('foreign', 'alice')).status).toBe(404);
    expect((await receipt('foreign', 'alice', { roomId: 'room-2' })).status).toBe(409);
    expect(messageRow(payload.message.id)?.read_at).toBeNull();
    expect(messageRow('foreign')?.read_at).toBeNull();
  });

  it('rejects forged WebSocket receipt identities and cross-room targets without broadcasting success', async () => {
    const payload = await (await send()).json() as { message: { id: string } };
    db.prepare("INSERT INTO booking_chat_messages (id, room_id, sender_id, message_type) VALUES ('foreign', 'room-2', 'carol', 'text')").run();
    const aliceEvents = connect('alice');
    const bobEvents = connect('bob');
    const internal = room as unknown as Internals;
    await internal.handleWebSocketMessage('alice', { type: 'message_read', messageId: payload.message.id, userId: 'bob' });
    await internal.handleWebSocketMessage('alice', { type: 'message_read', messageId: 'foreign', roomId: 'room-2' });
    expect(messageRow(payload.message.id)?.read_at).toBeNull();
    expect(messageRow('foreign')?.read_at).toBeNull();
    expect(aliceEvents.filter((event) => event.type === 'error')).toHaveLength(2);
    expect(bobEvents).toEqual([]);

    await internal.handleWebSocketMessage('bob', { type: 'message_read', messageId: payload.message.id });
    expect(messageRow(payload.message.id)?.read_at).toBeTruthy();
    expect(aliceEvents.find((event) => event.type === 'message_status_update')?.data.status).toBe('read');
  });

  it('preserves the first receipt timestamp and rejects unsupported statuses', async () => {
    const payload = await (await send()).json() as { message: { id: string } };
    db.prepare('UPDATE booking_chat_messages SET read_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', payload.message.id);
    expect((await receipt(payload.message.id, 'bob')).status).toBe(200);
    expect(messageRow(payload.message.id)?.read_at).toBe('2026-01-01T00:00:00Z');
    expect((await receipt(payload.message.id, 'bob', { status: 'something-else' })).status).toBe(400);
  });
});
