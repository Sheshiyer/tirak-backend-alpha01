import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { bookingRoutes } from '@/routes/bookings';
import { createTestEnv, createMockRequest, createTestBooking, createTestUser } from '@tests/setup';

describe('Booking Routes', () => {
  let app: Hono;
  let testEnv: any;
  let mockUser: any;

  beforeEach(() => {
    app = new Hono();
    testEnv = createTestEnv();
    mockUser = createTestUser();
    app.route('/bookings', bookingRoutes);
  });

  describe('POST /bookings', () => {
    it('should create a new booking successfully', async () => {
      const bookingData = {
        companionId: '123e4567-e89b-12d3-a456-426614174000',
        serviceId: '123e4567-e89b-12d3-a456-426614174001',
        startTime: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        endTime: new Date(Date.now() + 90000000).toISOString(), // Tomorrow + 1 hour
        location: 'Bangkok, Thailand',
        notes: 'Special requirements',
        paymentMethodId: 'pm_test123'
      };

      const request = createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify(bookingData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      // Mock successful booking creation
      testEnv.DB.prepare = () => ({
        bind: () => ({
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null // No conflicts
        })
      });

      // Mock authenticated user context
      const mockContext = {
        env: testEnv,
        req: request,
        get: (key: string) => key === 'user' ? mockUser : undefined,
        json: (data: any, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' }
        })
      };

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.booking.companionId).toBe(bookingData.companionId);
      expect(data.data.booking.status).toBe('pending');
    });

    it('should reject booking with time conflict', async () => {
      const bookingData = {
        companionId: '123e4567-e89b-12d3-a456-426614174000',
        startTime: new Date(Date.now() + 86400000).toISOString(),
        endTime: new Date(Date.now() + 90000000).toISOString(),
        location: 'Bangkok, Thailand'
      };

      const request = createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify(bookingData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      // Mock existing conflicting booking
      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => ({ id: 'existing-booking-id' }) // Conflict found
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('TIME_CONFLICT');
    });

    it('should reject booking with invalid data', async () => {
      const invalidData = {
        companionId: 'invalid-uuid',
        startTime: 'invalid-date',
        location: ''
      };

      const request = createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify(invalidData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject booking without authentication', async () => {
      const bookingData = {
        companionId: '123e4567-e89b-12d3-a456-426614174000',
        startTime: new Date(Date.now() + 86400000).toISOString(),
        endTime: new Date(Date.now() + 90000000).toISOString(),
        location: 'Bangkok, Thailand'
      };

      const request = createMockRequest('http://localhost/bookings', {
        method: 'POST',
        body: JSON.stringify(bookingData),
        headers: { 'Content-Type': 'application/json' }
        // No Authorization header
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /bookings', () => {
    it('should get user bookings with pagination', async () => {
      const request = createMockRequest('http://localhost/bookings?page=1&limit=10', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      // Mock bookings data
      const mockBookings = [
        createTestBooking({ id: 'booking-1' }),
        createTestBooking({ id: 'booking-2' })
      ];

      testEnv.DB.prepare = () => ({
        bind: () => ({
          all: async () => ({ results: mockBookings }),
          first: async () => ({ count: 2 })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.bookings).toHaveLength(2);
      expect(data.data.pagination.total).toBe(2);
      expect(data.data.pagination.page).toBe(1);
      expect(data.data.pagination.limit).toBe(10);
    });

    it('should filter bookings by status', async () => {
      const request = createMockRequest('http://localhost/bookings?status=confirmed', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      const mockBookings = [
        createTestBooking({ id: 'booking-1', status: 'confirmed' })
      ];

      testEnv.DB.prepare = () => ({
        bind: () => ({
          all: async () => ({ results: mockBookings }),
          first: async () => ({ count: 1 })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.bookings).toHaveLength(1);
      expect(data.data.bookings[0].status).toBe('confirmed');
    });

    it('should handle empty booking list', async () => {
      const request = createMockRequest('http://localhost/bookings', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => ({ count: 0 })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.bookings).toHaveLength(0);
      expect(data.data.pagination.total).toBe(0);
    });
  });

  describe('GET /bookings/:id', () => {
    it('should get booking details successfully', async () => {
      const bookingId = 'test-booking-id';
      const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      const mockBooking = createTestBooking({ id: bookingId });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.booking.id).toBe(bookingId);
    });

    it('should return 404 for non-existent booking', async () => {
      const bookingId = 'non-existent-id';
      const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => null
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('BOOKING_NOT_FOUND');
    });

    it('should reject access to other user\'s booking', async () => {
      const bookingId = 'other-user-booking';
      const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      // Mock booking belonging to different user
      const otherUserBooking = createTestBooking({ 
        id: bookingId, 
        customer_id: 'other-user-id' 
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => otherUserBooking
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });
  });

  describe('PUT /bookings/:id/status', () => {
    it('should update booking status successfully', async () => {
      const bookingId = 'test-booking-id';
      const statusData = { status: 'confirmed' };

      const request = createMockRequest(`http://localhost/bookings/${bookingId}/status`, {
        method: 'PUT',
        body: JSON.stringify(statusData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      const mockBooking = createTestBooking({ 
        id: bookingId,
        supplier_id: mockUser.id // User is the supplier
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking,
          run: async () => ({ success: true, meta: { changes: 1 } })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.booking.status).toBe('confirmed');
    });

    it('should reject invalid status transitions', async () => {
      const bookingId = 'test-booking-id';
      const statusData = { status: 'completed' }; // Invalid transition

      const request = createMockRequest(`http://localhost/bookings/${bookingId}/status`, {
        method: 'PUT',
        body: JSON.stringify(statusData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      const mockBooking = createTestBooking({ 
        id: bookingId,
        status: 'pending' // Can't go directly to completed
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('should reject unauthorized status updates', async () => {
      const bookingId = 'test-booking-id';
      const statusData = { status: 'confirmed' };

      const request = createMockRequest(`http://localhost/bookings/${bookingId}/status`, {
        method: 'PUT',
        body: JSON.stringify(statusData),
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-jwt-token'
        }
      });

      // Mock booking where user is neither customer nor supplier
      const mockBooking = createTestBooking({ 
        id: bookingId,
        customer_id: 'other-user-1',
        supplier_id: 'other-user-2'
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /bookings/:id', () => {
    it('should cancel booking successfully', async () => {
      const bookingId = 'test-booking-id';
      const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      const mockBooking = createTestBooking({ 
        id: bookingId,
        customer_id: mockUser.id,
        status: 'pending'
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking,
          run: async () => ({ success: true, meta: { changes: 1 } })
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('cancelled');
    });

    it('should reject cancellation of non-cancellable booking', async () => {
      const bookingId = 'test-booking-id';
      const request = createMockRequest(`http://localhost/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer valid-jwt-token' }
      });

      const mockBooking = createTestBooking({ 
        id: bookingId,
        customer_id: mockUser.id,
        status: 'completed' // Cannot cancel completed booking
      });

      testEnv.DB.prepare = () => ({
        bind: () => ({
          first: async () => mockBooking
        })
      });

      const response = await app.request(request, testEnv);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CANNOT_CANCEL');
    });
  });
});
