import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bookingRoutes } from '@/routes/bookings';
import { chatRoutes } from '@/routes/chat';
import { paymentRoutes } from '@/routes/payments';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestEnv } from '@tests/setup';

/**
 * T-062 adversarial suite — cross-user ownership attacks.
 *
 * Cast: CUSTOMER_A owns booking BOOKING with SUPPLIER_S. CUSTOMER_B is the
 * attacker: a fully authenticated, active user who must never be able to
 * read, transition, chat about, pay for, or recover another user's booking.
 *
 * DB stubs are bind-aware: every ownership-scoped query honors its bound
 * user id exactly like D1 would, so a missing ownership predicate in the SQL
 * would make these tests fail (the stub would return the victim's row).
 */
describe('T-062 adversarial: cross-user ownership attacks', () => {
  const CUSTOMER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CUSTOMER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const SUPPLIER_S = 'ssssssss-ssss-4sss-8sss-ssssssssssss';
  const BOOKING = '123e4567-e89b-12d3-a456-426614174000';
  const ROOM = '223e4567-e89b-12d3-a456-426614174000';

  let app: Hono;
  let env: any;

  const users: Record<string, any> = {
    [CUSTOMER_A]: { id: CUSTOMER_A, email: 'a@example.com', userType: 'customer', status: 'active' },
    [CUSTOMER_B]: { id: CUSTOMER_B, email: 'b@example.com', userType: 'customer', status: 'active' },
    [SUPPLIER_S]: { id: SUPPLIER_S, email: 's@example.com', userType: 'supplier', status: 'active' },
  };

  const bookingRow = {
    id: BOOKING,
    customer_id: CUSTOMER_A,
    supplier_id: SUPPLIER_S,
    service_id: 'svc-1',
    status: 'pending',
    total_amount: 1000,
    currency: 'THB',
    scheduled_at: '2026-08-10T09:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
  };

  const tokenFor = async (id: string) =>
    `Bearer ${await generateJWT(
      { sub: id, email: users[id].email, userType: users[id].userType },
      env.JWT_SECRET,
    )}`;

  const jsonHeaders = (auth: string) => ({
    Authorization: auth,
    'Content-Type': 'application/json',
  });

  /** Bind-aware fake D1: ownership predicates see only the bound caller's rows. */
  const installDb = () => {
    env.DB.prepare = (query: string) => ({
      bind: (...params: any[]) => ({
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
        first: async () => {
          if (query.includes('FROM users WHERE id')) {
            return users[params[0]] ?? null;
          }
          if (query.includes('FROM bookings')) {
            // Ownership-bound reads bind (bookingId, userId, userId).
            const isOwnershipQuery = query.includes('customer_id = ?') || query.includes('customer_id = ? OR');
            if (isOwnershipQuery) {
              const boundUser = params.find((p) => users[p]);
              if (boundUser && (bookingRow.customer_id === boundUser || bookingRow.supplier_id === boundUser)) {
                return bookingRow;
              }
              return null;
            }
            // Unscoped lookup by id only (chat create-room path).
            return bookingRow;
          }
          return null;
        },
      }),
    });
  };

  beforeEach(() => {
    app = new Hono();
    env = createTestEnv();
    env.OMISE_SECRET_KEY = 'skey_test_server_only';
    env.OMISE_WEBHOOK_SECRET = btoa('webhook_test_secret');
    installDb();
    app.route('/bookings', bookingRoutes);
    app.route('/chat', chatRoutes);
    app.route('/payments', paymentRoutes);
  });

  describe('booking retrieval', () => {
    it('attacker cannot read the victim booking (404, no existence leak)', async () => {
      const response = await app.request(
        createMockRequest(`http://localhost/bookings/${BOOKING}`, {
          method: 'GET',
          headers: { Authorization: await tokenFor(CUSTOMER_B) },
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });

    it('control: the owning traveler can read their booking', async () => {
      const response = await app.request(
        createMockRequest(`http://localhost/bookings/${BOOKING}`, {
          method: 'GET',
          headers: { Authorization: await tokenFor(CUSTOMER_A) },
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(200);
    });
  });

  describe('booking transitions', () => {
    const transition = (auth: string, status: string) =>
      app.request(
        createMockRequest(`http://localhost/bookings/${BOOKING}/status`, {
          method: 'PUT',
          headers: jsonHeaders(auth),
          body: JSON.stringify({ status }),
        }),
        undefined,
        env,
      );

    it('attacker cannot transition the victim booking', async () => {
      const response = await transition(await tokenFor(CUSTOMER_B), 'cancelled');
      expect(response.status).toBe(404);
    });

    it('traveler cannot confirm their own pending booking (guide-only transition)', async () => {
      const response = await transition(await tokenFor(CUSTOMER_A), 'confirmed');
      const data = await response.json();
      expect(response.status).toBe(403);
      expect(data.error).toBe('Invalid booking transition');
    });

    it('traveler cannot mark a pending booking completed (skips guide confirmation)', async () => {
      const response = await transition(await tokenFor(CUSTOMER_A), 'completed');
      expect(response.status).toBe(403);
    });

    it('traveler cannot resurrect a cancelled booking (schema rejects non-target statuses)', async () => {
      const response = await app.request(
        createMockRequest(`http://localhost/bookings/${BOOKING}/status`, {
          method: 'PUT',
          headers: jsonHeaders(await tokenFor(CUSTOMER_A)),
          body: JSON.stringify({ status: 'pending' }),
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(400);
    });

    it('control: the assigned guide can confirm a pending booking', async () => {
      const response = await transition(await tokenFor(SUPPLIER_S), 'confirmed');
      expect(response.status).toBe(200);
    });
  });

  describe('booking creation', () => {
    it('a guide cannot create bookings (traveler-only action)', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/bookings', {
          method: 'POST',
          headers: jsonHeaders(await tokenFor(SUPPLIER_S)),
          body: JSON.stringify({
            companionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            serviceId: 'svc-1',
            date: '2026-08-10',
            startTime: '09:00',
            duration: 120,
          }),
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('chat access', () => {
    it('attacker cannot open a chat room for the victim booking', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/chat/rooms', {
          method: 'POST',
          headers: jsonHeaders(await tokenFor(CUSTOMER_B)),
          body: JSON.stringify({ bookingId: BOOKING }),
        }),
        undefined,
        env,
      );
      const data = await response.json();
      expect(response.status).toBe(403);
      expect(data.error).toBe('Booking access denied');
    });

    it('attacker cannot send messages into the victim room', async () => {
      const response = await app.request(
        createMockRequest(`http://localhost/chat/rooms/${ROOM}/messages`, {
          method: 'POST',
          headers: jsonHeaders(await tokenFor(CUSTOMER_B)),
          body: JSON.stringify({ roomId: ROOM, messageType: 'text', content: 'intrusion attempt' }),
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });

    it('attacker cannot read the victim room history', async () => {
      const response = await app.request(
        createMockRequest(`http://localhost/chat/rooms/${ROOM}`, {
          method: 'GET',
          headers: { Authorization: await tokenFor(CUSTOMER_B) },
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('payment access', () => {
    it('attacker cannot read the victim charge status', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/payments/charges/chrg_victim123', {
          method: 'GET',
          headers: { Authorization: await tokenFor(CUSTOMER_B) },
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });

    it('attacker cannot create a charge against the victim booking', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/payments/charges', {
          method: 'POST',
          headers: jsonHeaders(await tokenFor(CUSTOMER_B)),
          body: JSON.stringify({ bookingId: BOOKING, method: 'promptpay' }),
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });

    it('attacker cannot bind a recovery charge to the victim booking', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/payments/charges/recover', {
          method: 'POST',
          headers: jsonHeaders(await tokenFor(CUSTOMER_B)),
          body: JSON.stringify({ bookingId: BOOKING, chargeId: 'chrg_attacker_owned' }),
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    });

    it('attacker cannot probe charge existence with a malformed charge id', async () => {
      const response = await app.request(
        createMockRequest('http://localhost/payments/charges/not-a-charge-id', {
          method: 'GET',
          headers: { Authorization: await tokenFor(CUSTOMER_B) },
        }),
        undefined,
        env,
      );
      expect(response.status).toBe(400);
    });
  });
});
