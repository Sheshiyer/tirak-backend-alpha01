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

  it('updates booking status through the shared booking mutation', async () => {
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

      if (query.includes('SELECT * FROM bookings WHERE id = ?')) {
        return statement({
          first: async () => createTestBooking({
            id: bookingId,
            customer_id: mockUser.id,
            supplier_id: 'supplier-1',
            status: 'confirmed',
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

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(updated).toBe(true);
    expect(data.data.booking.status).toBe('confirmed');
  });
});
