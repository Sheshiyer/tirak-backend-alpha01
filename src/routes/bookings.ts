import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { enhancedBookingSchema } from '../utils/validation';
import type { Env, Variables } from '../index';

const bookings = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
bookings.use('*', authMiddleware);
bookings.use('*', createRateLimit('booking'));

// Original booking creation schema (for backward compatibility)
const createBookingSchema = z.object({
  companionId: z.string().uuid('Invalid companion ID'),
  serviceId: z.string().uuid('Invalid service ID').optional(),
  experienceId: z.string().uuid('Invalid experience ID').optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be in HH:MM format'),
  duration: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  location: z.string().max(500, 'Location too long').optional(),
  specialRequests: z.string().max(1000, 'Special requests too long').optional()
});

// Booking status update schema
const updateBookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed'], {
    errorMap: () => ({ message: 'Status must be confirmed, cancelled, or completed' })
  }),
  reason: z.string().max(500, 'Reason too long').optional()
});

/**
 * Create new booking with enhanced customer preferences
 */
bookings.post('/', zValidator('json', enhancedBookingSchema), async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const bookingData = c.req.valid('json');
  
  try {
    // Only customers can create bookings
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only customers can create bookings', 403);
    }

    // Calculate endTime if not provided
    let endTime: string = bookingData.endTime || '';
    if (!endTime) {
      // Parse startTime and add duration in minutes
      const timeParts = bookingData.startTime.split(':');
      if (timeParts.length === 2) {
        const hours = parseInt(timeParts[0] || '0', 10);
        const minutes = parseInt(timeParts[1] || '0', 10);
        
        if (!isNaN(hours) && !isNaN(minutes)) {
          const totalStartMinutes = hours * 60 + minutes;
          const totalEndMinutes = totalStartMinutes + bookingData.duration;

          const endHours = Math.floor(totalEndMinutes / 60) % 24; // Wraps around midnight
          const endMinutes = totalEndMinutes % 60;
          
          endTime = `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
        } else {
          return jsonError(c, 'Invalid time format', 'Start time must be in HH:MM format', 400);
        }
      } else {
        return jsonError(c, 'Invalid time format', 'Start time must be in HH:MM format', 400);
      }
    }

    // Validate companion exists and is available
    const companion = await c.env.DB.prepare(`
      SELECT cp.user_id, cp.display_name,
             u.status as user_status, u.user_type
      FROM companion_profiles cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.user_id = ? AND u.status = 'active'
        AND u.user_type IN ('supplier', 'companion')
    `).bind(bookingData.companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The selected companion is not available', 404);
    }

    // Validate service/experience if provided (for companions)
    let service = null;
    if (bookingData.serviceId) {
      service = await c.env.DB.prepare(`
        SELECT id, title, price as price_min, price as price_max, currency, duration_minutes as duration_hours
        FROM companion_experiences
        WHERE id = ? AND companion_id = ? AND is_active = TRUE
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
        AND ? < end_time AND ? > start_time
    `).bind(
      bookingData.companionId,
      bookingData.date,
      bookingData.startTime,
      endTime
    ).first();

    if (conflictCheck) {
      return jsonError(c, 'Time slot unavailable', 'The selected time slot is already booked', 409);
    }

    // Calculate pricing
    let basePrice = 0;
    if (service) {
      basePrice = Number(service.price_min) || 0;
    } else {
      basePrice = 1000; // Default rate
    }

    const serviceFee = Math.round(basePrice * 0.1); // 10% platform fee
    const totalAmount = basePrice + serviceFee;

    // Create booking
    const bookingId = crypto.randomUUID();
    const now = new Date().toISOString();
    const scheduledAt = new Date(`${bookingData.date}T${bookingData.startTime}`).toISOString();

    await c.env.DB.prepare(`
      INSERT INTO bookings (
        id, customer_id, supplier_id, companion_id, service_id, experience_id, date, start_time, end_time,
        duration, location, special_requests, meeting_point, template, preferred_languages,
        dietary_restrictions, accessibility_needs, status, total_amount, service_fee,
        payment_status, scheduled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      bookingId, userId, bookingData.companionId, bookingData.companionId, bookingData.serviceId,
      bookingData.date, bookingData.startTime, endTime,
      bookingData.duration, bookingData.location || null, bookingData.specialRequests || null,
      bookingData.meetingPoint || null, bookingData.template || null, 
      JSON.stringify(bookingData.preferredLanguages || null), 
      JSON.stringify(bookingData.dietaryRestrictions || null), 
      JSON.stringify(bookingData.accessibilityNeeds || null),
      'pending', totalAmount, serviceFee,
      'pending', scheduledAt, now, now
    ).run();

    // Create booking timeline entry
    await c.env.DB.prepare(`
      INSERT INTO booking_timeline (booking_id, status, timestamp, note)
      VALUES (?, ?, ?, ?)
    `).bind(bookingId, 'pending', now, 'Booking created').run();

    // Track booking creation event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'booking_created',
        userId,
        properties: {
          bookingId,
          companionId: bookingData.companionId,
          serviceId: bookingData.serviceId,
          totalAmount,
          duration: bookingData.duration,
          hasSpecialRequests: !!bookingData.specialRequests
        },
        timestamp: now
      });
    }

    // Send notification to companion
    if (c.env.NOTIFICATION_QUEUE && typeof c.env.NOTIFICATION_QUEUE.send === 'function') {
      await c.env.NOTIFICATION_QUEUE.send({
        type: 'booking_request',
        userId: bookingData.companionId,
        title: 'New Booking Request',
        message: `You have a new booking request for ${bookingData.date}`,
        data: { bookingId },
        timestamp: now
      });
    }

    // Get created booking with details
    const createdBooking = await c.env.DB.prepare(`
      SELECT 
        b.*,
        cp.display_name as companion_name,
        cp.profile_photo as companion_profile_image,
        service_exp.title as service_name,
        service_exp.price as service_price,
        exp.title as experience_name,
        exp.price as experience_price
      FROM bookings b
      JOIN companion_profiles cp ON b.companion_id = cp.user_id
      LEFT JOIN companion_experiences service_exp ON b.service_id = service_exp.id
      LEFT JOIN companion_experiences exp ON b.experience_id = exp.id
      WHERE b.id = ?
    `).bind(bookingId).first();

    if (!createdBooking) {
      return jsonError(c, 'Booking creation failed', 'Failed to retrieve created booking', 500);
    }

    const companionProfileImage = createdBooking.companion_profile_image || null;

    return jsonSuccess(c, {
      booking: {
        id: createdBooking.id,
        companionId: createdBooking.companion_id,
        companion: {
          id: createdBooking.companion_id,
          name: createdBooking.companion_name,
          profileImage: companionProfileImage
        },
        customerId: createdBooking.customer_id,
        serviceId: createdBooking.service_id,
        service: createdBooking.service_id ? {
          id: createdBooking.service_id,
          name: createdBooking.service_name,
          price: createdBooking.service_price
        } : null,
        experienceId: createdBooking.experience_id,
        experience: createdBooking.experience_id ? {
          id: createdBooking.experience_id,
          name: createdBooking.experience_name,
          price: createdBooking.experience_price
        } : null,
        date: createdBooking.date,
        startTime: createdBooking.start_time,
        endTime: createdBooking.end_time,
        duration: createdBooking.duration,
        location: createdBooking.location,
        specialRequests: createdBooking.special_requests,
        meetingPoint: createdBooking.meeting_point,
        template: createdBooking.template,
        preferredLanguages: (() => {
          try {
            return createdBooking.preferred_languages ? JSON.parse(createdBooking.preferred_languages as string) : [];
          } catch {
            return [];
          }
        })(),
        dietaryRestrictions: (() => {
          try {
            return createdBooking.dietary_restrictions ? JSON.parse(createdBooking.dietary_restrictions as string) : [];
          } catch {
            return [];
          }
        })(),
        accessibilityNeeds: (() => {
          try {
            return createdBooking.accessibility_needs ? JSON.parse(createdBooking.accessibility_needs as string) : [];
          } catch {
            return [];
          }
        })(),
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
 * Create booking with backward compatibility (original schema)
 */
bookings.post('/simple', zValidator('json', createBookingSchema), async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const bookingData = c.req.valid('json');
  
  try {
    // Only customers can create bookings
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only customers can create bookings', 403);
    }

    // Transform to enhanced booking format
    const enhancedData = {
      ...bookingData,
      customerPreferences: undefined,
      preferredLanguage: undefined,
      groupComposition: undefined,
      dietaryRequirements: undefined
    };

    // Reuse the main booking creation logic
    return await bookings.fetch(
      new Request(c.req.url.replace('/simple', ''), {
        method: 'POST',
        headers: c.req.raw.headers,
        body: JSON.stringify(enhancedData)
      }),
      c.env
    );

  } catch (error) {
    console.error('Create simple booking error:', error);
    return jsonError(c, 'Booking failed', 'An error occurred while creating the booking', 500);
  }
});

/**
 * Get booking summary with all details
 */
bookings.get('/:id/summary', validateUUID('id'), async (c) => {
  const bookingId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const booking = await c.env.DB.prepare(`
      SELECT
        b.*,
        cp.display_name as companion_name,
        cp.profile_photo as companion_profile_image,
        cp.user_id as companion_user_id,
        cu.phone as companion_phone,
        0 as companion_rating,
        cust.display_name as customer_name,
        cust.profile_images as customer_images,
        cust.user_id as customer_user_id,
        custu.phone as customer_phone,
        service_exp.title as service_name,
        service_exp.description as service_description,
        service_exp.price as service_price,
        exp.title as experience_name,
        exp.description as experience_description,
        exp.price as experience_price,
        exp.duration_minutes as experience_duration
      FROM bookings b
      JOIN companion_profiles cp ON b.companion_id = cp.user_id
      JOIN users cu ON cp.user_id = cu.id
      JOIN customer_profiles cust ON b.customer_id = cust.user_id
      JOIN users custu ON cust.user_id = custu.id
      LEFT JOIN companion_experiences service_exp ON b.service_id = service_exp.id
      LEFT JOIN companion_experiences exp ON b.experience_id = exp.id
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

    const companionImage = booking.companion_profile_image || null;
    const customerImages = booking.customer_images ? 
      JSON.parse(booking.customer_images as string) : [];
    const customerPrefs = booking.customer_preferences ? 
      JSON.parse(booking.customer_preferences as string) : {};

    const bookingSummary = {
      id: booking.id,
      companion: {
        id: booking.companion_user_id,
        name: booking.companion_name,
        profileImage: companionImage,
        phone: booking.companion_phone,
        rating: booking.companion_rating
      },
      customer: {
        id: booking.customer_user_id,
        name: booking.customer_name,
        profileImage: Array.isArray(customerImages) ? customerImages[0] || null : null,
        phone: booking.customer_phone
      },
      service: booking.service_id ? {
        id: booking.service_id,
        name: booking.service_name,
        description: booking.service_description,
        price: booking.service_price
      } : null,
      experience: booking.experience_id ? {
        id: booking.experience_id,
        name: booking.experience_name,
        description: booking.experience_description,
        price: booking.experience_price,
        durationMinutes: booking.experience_duration
      } : null,
      date: booking.date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      duration: booking.duration,
      location: booking.location,
      specialRequests: booking.special_requests,
      customerPreferences: customerPrefs,
      preferredLanguage: booking.preferred_language,
      groupComposition: booking.group_composition,
      dietaryRequirements: booking.dietary_requirements,
      meetingPoint: booking.meeting_point,
      template: booking.template,
      preferredLanguages: (() => {
        try {
          return booking.preferred_languages ? JSON.parse(booking.preferred_languages as string) : [];
        } catch {
          return [];
        }
      })(),
      dietaryRestrictions: (() => {
        try {
          return booking.dietary_restrictions ? JSON.parse(booking.dietary_restrictions as string) : [];
        } catch {
          return [];
        }
      })(),
      accessibilityNeeds: (() => {
        try {
          return booking.accessibility_needs ? JSON.parse(booking.accessibility_needs as string) : [];
        } catch {
          return [];
        }
      })(),
      status: booking.status,
      totalAmount: booking.total_amount,
      serviceFee: booking.service_fee,
      paymentStatus: booking.payment_status,
      paymentMethod,
      timeline: timeline.results,
      createdAt: booking.created_at,
      updatedAt: booking.updated_at
    };

    return jsonSuccess(c, { booking: bookingSummary }, 'Booking summary retrieved successfully');

  } catch (error) {
    console.error('Get booking summary error:', error);
    return jsonError(c, 'Failed to retrieve booking summary', 'An error occurred while fetching booking summary', 500);
  }
});

/**
 * Get user bookings
 */
bookings.get('/', async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const pagination = c.get('pagination');
  const { page, limit } = pagination || { page: 1, limit: 20 };
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
          WHEN ? = 'customer' THEN cp.profile_photo
          ELSE cust.profile_images
        END as other_party_image,
        CASE 
          WHEN ? = 'customer' THEN b.companion_id
          ELSE b.customer_id
        END as other_party_id,
        0 as companion_rating,
        service_exp.title as service_name,
        service_exp.price as service_price,
        exp.title as experience_name,
        exp.price as experience_price
      FROM bookings b
      LEFT JOIN companion_profiles cp ON b.companion_id = cp.user_id
      LEFT JOIN customer_profiles cust ON b.customer_id = cust.user_id
      LEFT JOIN companion_experiences service_exp ON b.service_id = service_exp.id
      LEFT JOIN companion_experiences exp ON b.experience_id = exp.id
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
        profileImage: userType === 'customer' ? booking.other_party_image : (JSON.parse(booking.other_party_image || '[]')[0] || null),
        rating: userType === 'customer' ? booking.companion_rating : null
      },
      service: booking.service_id ? {
        id: booking.service_id,
        name: booking.service_name,
        price: booking.service_price
      } : null,
      experience: booking.experience_id ? {
        id: booking.experience_id,
        name: booking.experience_name,
        price: booking.experience_price
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
        cp.profile_photo as companion_profile_image,
        cp.user_id as companion_user_id,
        cu.phone as companion_phone,
        0 as companion_rating,
        cust.display_name as customer_name,
        cust.profile_images as customer_images,
        cust.user_id as customer_user_id,
        custu.phone as customer_phone,
        service_exp.title as service_name,
        service_exp.description as service_description,
        service_exp.price as service_price,
        exp.title as experience_name,
        exp.description as experience_description,
        exp.price as experience_price
      FROM bookings b
      JOIN companion_profiles cp ON b.companion_id = cp.user_id
      JOIN users cu ON cp.user_id = cu.id
      JOIN customer_profiles cust ON b.customer_id = cust.user_id
      JOIN users custu ON cust.user_id = custu.id
      LEFT JOIN companion_experiences service_exp ON b.service_id = service_exp.id
      LEFT JOIN companion_experiences exp ON b.experience_id = exp.id
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
          profileImage: booking.companion_profile_image || null,
          phone: booking.companion_phone,
          rating: booking.companion_rating
        },
        customer: {
          id: booking.customer_user_id,
          name: booking.customer_name,
          profileImage: (() => {
            try {
              const images = booking.customer_images ? JSON.parse(booking.customer_images as string) : [];
              return Array.isArray(images) ? images[0] || null : null;
            } catch {
              return null;
            }
          })(),
          phone: booking.customer_phone
        },
        service: booking.service_id ? {
          id: booking.service_id,
          name: booking.service_name,
          description: booking.service_description,
          price: booking.service_price
        } : null,
        experience: booking.experience_id ? {
          id: booking.experience_id,
          name: booking.experience_name,
          description: booking.experience_description,
          price: booking.experience_price
        } : null,
        date: booking.date,
        startTime: booking.start_time,
        endTime: booking.end_time,
        duration: booking.duration,
        location: booking.location,
        specialRequests: booking.special_requests,
        customerPreferences: (() => {
          try {
            return booking.customer_preferences ? JSON.parse(booking.customer_preferences as string) : {};
          } catch {
            return {};
          }
        })(),
        preferredLanguage: booking.preferred_language,
        groupComposition: booking.group_composition,
        dietaryRequirements: booking.dietary_requirements,
        meetingPoint: booking.meeting_point,
        template: booking.template,
        preferredLanguages: (() => {
          try {
            return booking.preferred_languages ? JSON.parse(booking.preferred_languages as string) : [];
          } catch {
            return [];
          }
        })(),
        dietaryRestrictions: (() => {
          try {
            return booking.dietary_restrictions ? JSON.parse(booking.dietary_restrictions as string) : [];
          } catch {
            return [];
          }
        })(),
        accessibilityNeeds: (() => {
          try {
            return booking.accessibility_needs ? JSON.parse(booking.accessibility_needs as string) : [];
          } catch {
            return [];
          }
        })(),
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

    if (!validTransitions[currentStatus as string]?.includes(status)) {
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
    if (c.env.NOTIFICATION_QUEUE && typeof c.env.NOTIFICATION_QUEUE.send === 'function') {
      await c.env.NOTIFICATION_QUEUE.send({
        type: 'booking_status_update',
        userId: otherUserId,
        title: 'Booking Status Updated',
        message: `Your booking status has been changed to ${status}`,
        data: { bookingId, status, reason },
        timestamp: now
      });
    }

    // Track status change event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
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
    }

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
