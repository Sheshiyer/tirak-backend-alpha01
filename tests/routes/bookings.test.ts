import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { bookingRoutes } from '@/routes/bookings';
import { generateJWT } from '@/utils/auth';
import { createMockRequest, createTestBooking, createTestEnv, createTestUser } from '@tests/setup';

describe('Booking Routes', () => {
  let app: Hono;
  let testEnv: any;
  let mockUser: any;
  let authHeader: string;

  const bookingId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(async () => {
    app = new Hono();
    testEnv = createTestEnv();
    mockUser = createTestUser({ id: 'test-customer-id' });
    authHeader = `Bearer ${await generateJWT(
      { sub: mockUser.id, email: mockUser.email, userType: mockUser.userType },
      testEnv.JWT_SECRET
    )}`;
    app.route('/bookings', bookingRoutes);
  });

  const statement = (overrides: Record<string, unknown> = {}) => ({
    bind: () => ({
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
      ...overrides,
    }),
  });

  const installDb = (handler: (query: string) => ReturnType<typeof statement>) => {
    testEnv.DB.prepare = (query: string) => {
      if (query.includes('FROM users WHERE id')) {
        return statement({ first: async () => mockUser });
      }

      return handler(query);
    };
  };

  it('requires authentication before listing bookings', async () => {
    const request = createMockRequest('http://localhost/bookings', {
      method: 'GET',
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.error).toBe('No authentication token provided');
  });

  it('requires a concrete guided experience before creating a booking request', async () => {
    installDb(() => statement());

    const response = await app.request(createMockRequest('http://localhost/bookings', {
      method: 'POST',
      body: JSON.stringify({
        companionId: '223e4567-e89b-12d3-a456-426614174000',
        date: '2026-08-10',
        startTime: '09:00',
        duration: 120,
      }),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    }), undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });

  it('lists bookings with the current paginated response contract', async () => {
    const booking = createTestBooking({
      id: bookingId,
      customer_id: mockUser.id,
      other_party_id: 'supplier-1',
      other_party_name: 'Test Companion',
      service_name: 'Old Town Walk',
    });

    installDb((query) => {
      if (query.includes('COUNT(*)')) {
        return statement({ first: async () => ({ total: 1 }) });
      }

      return statement({ all: async () => ({ results: [booking] }) });
    });

    const request = createMockRequest('http://localhost/bookings?page=1&limit=10', {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.items).toHaveLength(1);
    expect(data.data.pagination.total).toBe(1);
    expect(data.data.items[0].id).toBe(bookingId);
  });

  it.each(['paid', 'completed'])('normalizes persisted %s payment status to the mobile paid contract', async (paymentStatus) => {
    const booking = createTestBooking({
      id: bookingId,
      customer_id: mockUser.id,
      supplier_id: 'supplier-1',
      payment_status: paymentStatus,
      service_name: 'Old Town Walk',
    });

    installDb((query) => {
      if (query.includes('COUNT(*)')) {
        return statement({ first: async () => ({ total: 1 }) });
      }

      return statement({ all: async () => ({ results: [booking] }) });
    });

    const response = await app.request(createMockRequest('http://localhost/bookings', {
      method: 'GET',
      headers: { Authorization: authHeader },
    }), undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.items[0].paymentStatus).toBe('paid');
  });

  it('never infers a refund from booking cancellation', async () => {
    const booking = createTestBooking({
      id: bookingId,
      customer_id: mockUser.id,
      supplier_id: 'supplier-1',
      status: 'cancelled',
      payment_status: 'pending',
      service_name: 'Old Town Walk',
    });

    installDb((query) => {
      if (query.includes('COUNT(*)')) {
        return statement({ first: async () => ({ total: 1 }) });
      }
      return statement({ all: async () => ({ results: [booking] }) });
    });

    const response = await app.request(createMockRequest('http://localhost/bookings', {
      method: 'GET',
      headers: { Authorization: authHeader },
    }), undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.items[0].paymentStatus).toBe('pending');
    expect(JSON.stringify(data.data.items[0])).not.toContain('refunded');
  });

  it('loads booking details for a booking participant', async () => {
    installDb(() => statement({
      first: async () => createTestBooking({
        id: bookingId,
        customer_id: mockUser.id,
        supplier_id: 'supplier-1',
        companion_user_id: 'supplier-1',
        companion_name: 'Test Companion',
        customer_user_id: mockUser.id,
        customer_name: 'Test Customer',
        service_name: 'Old Town Walk',
      }),
    }));

    const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.booking.id).toBe(bookingId);
    expect(data.data.booking.companion.name).toBe('Test Companion');
  });

  it('rejects a traveler confirming their own pending booking', async () => {
    let updated = false;
    installDb((query) => {
      if (query.includes('UPDATE bookings')) {
        return statement({
          run: async () => {
            updated = true;
            return { success: true, meta: { changes: 1 } };
          },
        });
      }

      if (query.includes('SELECT * FROM bookings') && query.includes('WHERE id = ?')) {
        return statement({
          first: async () => createTestBooking({
            id: bookingId,
            customer_id: mockUser.id,
            supplier_id: 'supplier-1',
            status: updated ? 'confirmed' : 'pending',
            scheduled_at: new Date(Date.now() + 86400000).toISOString(),
          }),
        });
      }

      return statement({
        first: async () => createTestBooking({
          id: bookingId,
          customer_id: mockUser.id,
          supplier_id: 'supplier-1',
          status: 'pending',
          scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        }),
      });
    });

    const request = createMockRequest(`http://localhost/bookings/${bookingId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'confirmed' }),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    });

    const response = await app.request(request, undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
    expect(updated).toBe(false);
  });

  it('allows the assigned guide to confirm a pending booking', async () => {
    const guide = createTestUser({
      id: 'supplier-1',
      email: 'guide@example.com',
      user_type: 'supplier',
      userType: 'supplier',
    });
    mockUser = guide;
    authHeader = `Bearer ${await generateJWT(
      { sub: guide.id, email: guide.email, userType: guide.userType },
      testEnv.JWT_SECRET
    )}`;

    let updated = false;
    installDb((query) => {
      if (query.includes('UPDATE bookings')) {
        return statement({
          run: async () => {
            updated = true;
            return { success: true, meta: { changes: 1 } };
          },
        });
      }

      if (query.includes('SELECT * FROM bookings') && query.includes('WHERE id = ?')) {
        return statement({
          first: async () => createTestBooking({
            id: bookingId,
            customer_id: 'test-customer-id',
            supplier_id: guide.id,
            status: updated ? 'confirmed' : 'pending',
            scheduled_at: new Date(Date.now() + 86400000).toISOString(),
          }),
        });
      }

      return statement({ first: async () => null });
    });

    const response = await app.request(createMockRequest(
      `http://localhost/bookings/${bookingId}/status`,
      {
        method: 'PUT',
        body: JSON.stringify({ status: 'confirmed' }),
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      }
    ), undefined, testEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(updated).toBe(true);
    expect(data.data.booking.status).toBe('confirmed');
  });

  it.each(['creating', 'indeterminate', 'pending', 'successful'])(
    'blocks ordinary cancellation while the latest PromptPay attempt is %s',
    async (paymentAttemptStatus) => {
      let updated = false;
      installDb((query) => {
        if (query.includes('FROM payment_attempts')) {
          return statement({ first: async () => ({ status: paymentAttemptStatus }) });
        }
        if (query.includes('UPDATE bookings')) {
          return statement({
            run: async () => {
              updated = true;
              return { success: true, meta: { changes: 1 } };
            },
          });
        }
        if (query.includes('SELECT * FROM bookings') && query.includes('WHERE id = ?')) {
          return statement({
            first: async () => createTestBooking({
              id: bookingId,
              customer_id: mockUser.id,
              supplier_id: 'supplier-1',
              status: 'confirmed',
            }),
          });
        }
        return statement({ first: async () => null });
      });

      const response = await app.request(createMockRequest(
        `http://localhost/bookings/${bookingId}/status`,
        {
          method: 'PUT',
          body: JSON.stringify({ status: 'cancelled' }),
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
        },
      ), undefined, testEnv);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error).toBe('PAYMENT_OUTCOME_UNRESOLVED');
      expect(updated).toBe(false);
    },
  );
});
