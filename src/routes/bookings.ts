import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const bookings = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
bookings.use('*', authMiddleware);
bookings.use('*', createRateLimit('booking'));

// Booking creation schema
const createBookingSchema = z.object({
  companionId: z.string().uuid('Invalid companion ID'),
  serviceId: z.string().uuid('Invalid service ID').optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be in HH:MM format'),
  duration: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  location: z.string().max(500, 'Location too long').optional(),
  specialRequests: z.string().max(1000, 'Special requests too long').optional(),
  paymentMethodId: z.string().uuid('Invalid payment method ID')
});

// Booking status update schema
const updateBookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed'], {
    errorMap: () => ({ message: 'Status must be confirmed, cancelled, or completed' })
  }),
  reason: z.string().max(500, 'Reason too long').optional()
});

/**
 * Create new booking
 */
bookings.post('/', zValidator('json', createBookingSchema), async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const bookingData = c.req.valid('json');
  
  try {
    // Only customers can create bookings
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only customers can create bookings', 403);
    }

    // Validate companion exists and is available
    const companion = await c.env.DB.prepare(`
      SELECT sp.user_id, sp.display_name, sp.verification_status, sp.subscription_status,
             u.status as user_status
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ? AND sp.verification_status = 'verified' 
        AND sp.subscription_status = 'active' AND u.status = 'active'
    `).bind(bookingData.companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The selected companion is not available', 404);
    }

    // Validate service if provided
    let service = null;
    if (bookingData.serviceId) {
      service = await c.env.DB.prepare(`
        SELECT id, title, price_min, price_max, currency, duration_hours
        FROM supplier_services
        WHERE id = ? AND supplier_id = ? AND is_active = TRUE
      `).bind(bookingData.serviceId, bookingData.companionId).first();

      if (!service) {
        return jsonError(c, 'Service not found', 'The selected service is not available', 404);
      }
    }

    // Check for booking conflicts
    const conflictCheck = await c.env.DB.prepare(`
      SELECT id FROM bookings
      WHERE companion_id = ? AND date = ? 
        AND status IN ('pending', 'confirmed', 'in_progress')
        AND (
          (start_time <= ? AND end_time > ?) OR
          (start_time < ? AND end_time >= ?) OR
          (start_time >= ? AND end_time <= ?)
        )
    `).bind(
      bookingData.companionId,
      bookingData.date,
      bookingData.startTime, bookingData.startTime,
      bookingData.endTime, bookingData.endTime,
      bookingData.startTime, bookingData.endTime
    ).first();

    if (conflictCheck) {
      return jsonError(c, 'Time slot unavailable', 'The selected time slot is already booked', 409);
    }

    // Calculate pricing
    const basePrice = service ? service.price_min : 1000; // Default rate if no service
    const serviceFee = Math.round(basePrice * 0.1); // 10% platform fee
    const totalAmount = basePrice + serviceFee;

    // Create booking
    const bookingId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO bookings (
        id, customer_id, companion_id, service_id, date, start_time, end_time,
        duration, location, special_requests, status, total_amount, service_fee,
        payment_method_id, payment_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      bookingId, userId, bookingData.companionId, bookingData.serviceId,
      bookingData.date, bookingData.startTime, bookingData.endTime,
      bookingData.duration, bookingData.location, bookingData.specialRequests,
      'pending', totalAmount, serviceFee, bookingData.paymentMethodId,
      'pending', now, now
    ).run();

    // Create booking timeline entry
    await c.env.DB.prepare(`
      INSERT INTO booking_timeline (booking_id, status, timestamp, note)
      VALUES (?, ?, ?, ?)
    `).bind(bookingId, 'pending', now, 'Booking created').run();

    // Track booking creation event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'booking_created',
      userId,
      properties: {
        bookingId,
        companionId: bookingData.companionId,
        serviceId: bookingData.serviceId,
        totalAmount,
        duration: bookingData.duration
      },
      timestamp: now
    });

    // Send notification to companion
    await c.env.NOTIFICATION_QUEUE.send({
      type: 'booking_request',
      userId: bookingData.companionId,
      title: 'New Booking Request',
      message: `You have a new booking request for ${bookingData.date}`,
      data: { bookingId },
      timestamp: now
    });

    // Get created booking with details
    const createdBooking = await c.env.DB.prepare(`
      SELECT 
        b.*,
        cp.display_name as companion_name,
        cp.profile_images as companion_profile_image,
        s.title as service_name,
        s.price_min as service_price
      FROM bookings b
      JOIN supplier_profiles cp ON b.companion_id = cp.user_id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.id = ?
    `).bind(bookingId).first();

    return jsonSuccess(c, {
      booking: {
        id: createdBooking.id,
        companionId: createdBooking.companion_id,
        companion: {
          id: createdBooking.companion_id,
          name: createdBooking.companion_name,
          profileImage: JSON.parse(createdBooking.companion_profile_image || '[]')[0] || null
        },
        customerId: createdBooking.customer_id,
        serviceId: createdBooking.service_id,
        service: createdBooking.service_id ? {
          id: createdBooking.service_id,
          name: createdBooking.service_name,
          price: createdBooking.service_price
        } : null,
        date: createdBooking.date,
        startTime: createdBooking.start_time,
        endTime: createdBooking.end_time,
        duration: createdBooking.duration,
        location: createdBooking.location,
        specialRequests: createdBooking.special_requests,
        status: createdBooking.status,
        totalAmount: createdBooking.total_amount,
        serviceFee: createdBooking.service_fee,
        paymentStatus: createdBooking.payment_status,
        createdAt: createdBooking.created_at,
        updatedAt: createdBooking.updated_at
      }
    }, 'Booking created successfully', 201);

  } catch (error) {
    console.error('Create booking error:', error);
    return jsonError(c, 'Booking failed', 'An error occurred while creating the booking', 500);
  }
});

/**
 * Get user bookings
 */
bookings.get('/', validatePagination, async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const { page, limit } = c.get('pagination');
  const status = c.req.query('status');
  
  try {
    let query = `
      SELECT 
        b.*,
        CASE 
          WHEN ? = 'customer' THEN cp.display_name
          ELSE cust.display_name
        END as other_party_name,
        CASE 
          WHEN ? = 'customer' THEN cp.profile_images
          ELSE cust.profile_images
        END as other_party_image,
        CASE 
          WHEN ? = 'customer' THEN b.companion_id
          ELSE b.customer_id
        END as other_party_id,
        s.title as service_name,
        s.price_min as service_price
      FROM bookings b
      LEFT JOIN supplier_profiles cp ON b.companion_id = cp.user_id
      LEFT JOIN customer_profiles cust ON b.customer_id = cust.user_id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE (b.customer_id = ? OR b.companion_id = ?)
    `;

    const queryParams = [userType, userType, userType, userId, userId];

    if (status) {
      query += ` AND b.status = ?`;
      queryParams.push(status);
    }

    query += ` ORDER BY b.created_at DESC`;

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Get paginated results
    const offset = (page - 1) * limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const bookingsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, limit, offset).all();

    const bookings = bookingsResult.results.map((booking: any) => ({
      id: booking.id,
      [userType === 'customer' ? 'companion' : 'customer']: {
        id: booking.other_party_id,
        name: booking.other_party_name,
        profileImage: JSON.parse(booking.other_party_image || '[]')[0] || null,
        rating: userType === 'customer' ? booking.companion_rating : null
      },
      service: booking.service_id ? {
        id: booking.service_id,
        name: booking.service_name,
        price: booking.service_price
      } : null,
      date: booking.date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      duration: booking.duration,
      location: booking.location,
      status: booking.status,
      totalAmount: booking.total_amount,
      paymentStatus: booking.payment_status,
      createdAt: booking.created_at
    }));

    return jsonPaginated(c, bookings, createPagination(page, limit, total));

  } catch (error) {
    console.error('Get bookings error:', error);
    return jsonError(c, 'Failed to retrieve bookings', 'An error occurred while fetching bookings', 500);
  }
});

/**
 * Get booking details
 */
bookings.get('/:id', validateUUID('id'), async (c) => {
  const bookingId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const booking = await c.env.DB.prepare(`
      SELECT
        b.*,
        cp.display_name as companion_name,
        cp.profile_images as companion_images,
        cp.user_id as companion_user_id,
        cu.phone as companion_phone,
        cp.rating_average as companion_rating,
        cust.display_name as customer_name,
        cust.profile_images as customer_images,
        cust.user_id as customer_user_id,
        custu.phone as customer_phone,
        s.title as service_name,
        s.description as service_description,
        s.price_min as service_price
      FROM bookings b
      JOIN supplier_profiles cp ON b.companion_id = cp.user_id
      JOIN users cu ON cp.user_id = cu.id
      JOIN customer_profiles cust ON b.customer_id = cust.user_id
      JOIN users custu ON cust.user_id = custu.id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.id = ? AND (b.customer_id = ? OR b.companion_id = ?)
    `).bind(bookingId, userId, userId).first();

    if (!booking) {
      return jsonError(c, 'Booking not found', 'The requested booking does not exist or you do not have access', 404);
    }

    // Get booking timeline
    const timeline = await c.env.DB.prepare(`
      SELECT status, timestamp, note
      FROM booking_timeline
      WHERE booking_id = ?
      ORDER BY timestamp ASC
    `).bind(bookingId).all();

    // Get payment method details
    let paymentMethod = null;
    if (booking.payment_method_id) {
      const pm = await c.env.DB.prepare(`
        SELECT type, last4 FROM payment_methods WHERE id = ?
      `).bind(booking.payment_method_id).first();

      if (pm) {
        paymentMethod = {
          id: booking.payment_method_id,
          type: pm.type,
          last4: pm.last4
        };
      }
    }

    return jsonSuccess(c, {
      booking: {
        id: booking.id,
        companion: {
          id: booking.companion_user_id,
          name: booking.companion_name,
          profileImage: JSON.parse(booking.companion_images || '[]')[0] || null,
          phone: booking.companion_phone,
          rating: booking.companion_rating
        },
        customer: {
          id: booking.customer_user_id,
          name: booking.customer_name,
          profileImage: JSON.parse(booking.customer_images || '[]')[0] || null,
          phone: booking.customer_phone
        },
        service: booking.service_id ? {
          id: booking.service_id,
          name: booking.service_name,
          description: booking.service_description,
          price: booking.service_price
        } : null,
        date: booking.date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        duration: booking.duration,
        location: booking.location,
        specialRequests: booking.special_requests,
        status: booking.status,
        totalAmount: booking.total_amount,
        serviceFee: booking.service_fee,
        paymentStatus: booking.payment_status,
        paymentMethod,
        timeline: timeline.results,
        createdAt: booking.created_at,
        updatedAt: booking.updated_at
      }
    }, 'Booking details retrieved successfully');

  } catch (error) {
    console.error('Get booking details error:', error);
    return jsonError(c, 'Failed to retrieve booking', 'An error occurred while fetching booking details', 500);
  }
});

/**
 * Update booking status
 */
bookings.put('/:id/status', validateUUID('id'), zValidator('json', updateBookingStatusSchema), async (c) => {
  const bookingId = c.req.param('id');
  const userId = c.get('userId');
  const { status, reason } = c.req.valid('json');

  try {
    // Get current booking
    const booking = await c.env.DB.prepare(`
      SELECT * FROM bookings
      WHERE id = ? AND (customer_id = ? OR companion_id = ?)
    `).bind(bookingId, userId, userId).first();

    if (!booking) {
      return jsonError(c, 'Booking not found', 'The requested booking does not exist or you do not have access', 404);
    }

    // Validate status transition
    const currentStatus = booking.status;
    const validTransitions: Record<string, string[]> = {
      'pending': ['confirmed', 'cancelled'],
      'confirmed': ['in_progress', 'cancelled', 'completed'],
      'in_progress': ['completed', 'cancelled'],
      'completed': [],
      'cancelled': []
    };

    if (!validTransitions[currentStatus]?.includes(status)) {
      return jsonError(c, 'Invalid status transition', `Cannot change status from ${currentStatus} to ${status}`, 400);
    }

    // Update booking
    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      UPDATE bookings
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).bind(status, now, bookingId).run();

    // Add timeline entry
    await c.env.DB.prepare(`
      INSERT INTO booking_timeline (booking_id, status, timestamp, note)
      VALUES (?, ?, ?, ?)
    `).bind(bookingId, status, now, reason || `Status changed to ${status}`).run();

    // Send notifications
    const otherUserId = booking.customer_id === userId ? booking.companion_id : booking.customer_id;
    await c.env.NOTIFICATION_QUEUE.send({
      type: 'booking_status_update',
      userId: otherUserId,
      title: 'Booking Status Updated',
      message: `Your booking status has been changed to ${status}`,
      data: { bookingId, status, reason },
      timestamp: now
    });

    // Track status change event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'booking_status_changed',
      userId,
      properties: {
        bookingId,
        oldStatus: currentStatus,
        newStatus: status,
        reason
      },
      timestamp: now
    });

    // Get updated booking
    const updatedBooking = await c.env.DB.prepare(`
      SELECT * FROM bookings WHERE id = ?
    `).bind(bookingId).first();

    return jsonSuccess(c, {
      booking: updatedBooking
    }, 'Booking status updated successfully');

  } catch (error) {
    console.error('Update booking status error:', error);
    return jsonError(c, 'Failed to update booking', 'An error occurred while updating booking status', 500);
  }
});

export { bookings as bookingRoutes };
