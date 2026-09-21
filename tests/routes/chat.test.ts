import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { chatRoutes } from '@/routes/chat';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestBooking, createTestEnv, createTestUser } from '@tests/setup';

describe('Chat Routes', () => {
  let app: Hono;
  let testEnv: any;
  let currentUser: any;
  let authHeader: string;
  let booking: any;
  let insertedParams: unknown[];

  const bookingId = '123e4567-e89b-12d3-a456-426614174000';
  const roomId = '223e4567-e89b-12d3-a456-426614174000';

  const statement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async () => {
        if (query.includes('FROM users WHERE id')) return currentUser;
        if (query.includes('FROM bookings')) return booking;
        if (query.includes('FROM booking_chat_rooms')) return null;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => {
        if (query.includes('INSERT INTO booking_chat_rooms')) insertedParams = params;
        return { success: true, meta: { changes: 1 } };
      },
    }),
  });

  beforeEach(async () => {
    app = new Hono();
    testEnv = createTestEnv();
    currentUser = createTestUser({ id: 'traveler-1' });
    authHeader = `Bearer ${await generateJWT(
      { sub: currentUser.id, email: currentUser.email, userType: currentUser.userType },
      testEnv.JWT_SECRET
    )}`;
    booking = createTestBooking({
      id: bookingId,
      customer_id: currentUser.id,
      supplier_id: 'guide-1',
      status: 'confirmed',
    });
    insertedParams = [];
    testEnv.DB.prepare = (query: string) => statement(query);
    app.route('/chat', chatRoutes);
  });

  const createRoom = (body: Record<string, unknown>) => app.request(createMockRequest(
    'http://localhost/chat/rooms',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    }
  ), undefined, testEnv);

  it('requires a booking identifier instead of allowing an arbitrary pre-booking room', async () => {
    const response = await createRoom({ companionId: 'guide-1' });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });

  it('rejects chat creation while the booking is still pending', async () => {
    booking.status = 'pending';

    const response = await createRoom({ bookingId, companionId: 'guide-1' });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it('rejects chat creation by a user outside the booking', async () => {
    booking.customer_id = 'another-traveler';
    booking.supplier_id = 'another-guide';

    const response = await createRoom({ bookingId, companionId: 'guide-1' });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it('derives the other chat participant from an eligible booking', async () => {
    const response = await createRoom({ bookingId, companionId: 'attacker-selected-user' });

    expect(response.status).toBe(201);
    expect(insertedParams).toContain(bookingId);
    expect(insertedParams).toContain('guide-1');
    expect(insertedParams).not.toContain('attacker-selected-user');
  });

  it('rejects URL bearer tokens on ordinary HTTP endpoints', async () => {
    const response = await app.request(`http://localhost/chat/rooms?token=${authHeader.slice(7)}`, {}, testEnv);
    expect(response.status).toBe(401);
  });

  it('returns the persisted room even when analytics is unavailable', async () => {
    testEnv.ANALYTICS_QUEUE.send = async () => { throw new Error('Local simulated outage'); };
    const response = await createRoom({ bookingId });
    expect(response.status).toBe(201);
    expect(insertedParams).toContain(bookingId);
  });

  it('authenticates a ticketed WebSocket upgrade and strips credentials before forwarding', async () => {
    let forwarded: URL | undefined;
    let forwardedHeaders: Headers | undefined;
    testEnv.DB.prepare = (query: string) => ({ bind: () => ({
      first: async () => query.includes('FROM users WHERE id') ? currentUser
        : query.includes('DELETE FROM chat_socket_tickets') ? { user_id: currentUser.id }
        : { id: roomId, booking_id: bookingId },
    }) });
    testEnv.CHAT_ROOM = { idFromName: (id: string) => id, get: () => ({
      fetch: async (url: string, init: RequestInit) => {
        forwarded = new URL(url); forwardedHeaders = new Headers(init.headers);
        return new Response('upgrade reached durable object');
      },
    }) };
    const response = await app.request(`http://localhost/chat/rooms/${roomId}/ws?ticket=single-use-ticket&userId=attacker`, {
      headers: { Upgrade: 'websocket' },
    }, testEnv);
    expect(response.status).toBe(200);
    expect(forwarded?.searchParams.get('token')).toBeNull();
    expect(forwarded?.searchParams.get('ticket')).toBeNull();
    expect(forwarded?.searchParams.get('userId')).toBe(currentUser.id);
    expect(forwardedHeaders?.has('Authorization')).toBe(false);
  });

  it('refuses WebSocket access when no eligible owned booking room exists', async () => {
    const response = await app.request(`http://localhost/chat/rooms/${roomId}/ws`, {
      headers: { Upgrade: 'websocket', Authorization: authHeader },
    }, testEnv);
    expect(response.status).toBe(404);
  });

  it('rejects long-lived bearer tokens in WebSocket URLs', async () => {
    const response = await app.request(`http://localhost/chat/rooms/${roomId}/ws?token=${authHeader.slice(7)}`, {
      headers: { Upgrade: 'websocket' },
    }, testEnv);
    expect(response.status).toBe(401);
  });
});
