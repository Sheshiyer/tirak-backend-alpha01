import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { firstProfileImage } from '../utils/profileImages';
import type { Env, Variables } from '../index';
import { createNotification } from './notifications';

const bookings = new Hono<{ Bindings: Env; Variables: Variables }>();

bookings.use('*', authMiddleware);
bookings.use('*', createRateLimit('booking'));

const createBookingSchema = z.object({
  companionId: z.string().uuid('Invalid companion ID'),
  serviceId: z.string().min(1, 'Invalid service ID').optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be in HH:MM format').optional(),
  duration: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  location: z.string().max(500, 'Location too long').optional(),
  meetingPoint: z.string().max(500, 'Meeting point too long').optional(),
  specialRequests: z.string().max(1000, 'Special requests too long').optional(),
  template: z.string().max(200, 'Template too long').optional(),
  preferredLanguages: z.array(z.string()).optional(),
  dietaryRestrictions: z.array(z.string()).optional(),
  accessibilityNeeds: z.array(z.string()).optional(),
  paymentMethodId: z.string().optional()
});

const updateBookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed'], {
    errorMap: () => ({ message: 'Status must be confirmed, cancelled, or completed' })
  }),
  reason: z.string().max(500, 'Reason too long').optional()
});

type BookingData = z.infer<typeof createBookingSchema>;

const timeToMinutes = (value: string): number => {
  const [hours = 0, minutes = 0] = value.split(':').map(Number);
  return (hours * 60) + minutes;
};

const minutesToTime = (value: number): string => {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60).toString().padStart(2, '0');
  const minutes = (normalized % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

const toScheduledAt = (date: string, startTime: string): string => `${date} ${startTime}:00`;

const getEndTime = (startTime: string, duration: number): string => minutesToTime(timeToMinutes(startTime) + duration);

const getBookingDate = (scheduledAt: unknown): string => String(scheduledAt || '').split(/[ T]/)[0] || '';

const getBookingStartTime = (scheduledAt: unknown): string => {
  const parts = String(scheduledAt || '').split(/[ T]/);
  return (parts[1] || '00:00').slice(0, 5);
};

const stringifyOptional = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const getLocation = (booking: any): string | undefined => {
  return booking.location || booking.notes || booking.meeting_point || undefined;
};

const formatBooking = (booking: any, userType?: string) => {
  const date = getBookingDate(booking.scheduled_at);
  const startTime = getBookingStartTime(booking.scheduled_at);
  const duration = Number(booking.duration || 0);
  const endTime = getEndTime(startTime, duration);
  const otherPartyKey = userType === 'supplier' || userType === 'companion' ? 'customer' : 'companion';
  const otherParty = {
    id: booking.other_party_id,
    name: booking.other_party_name,
    profileImage: firstProfileImage(booking.other_party_image),
    phone: booking.other_party_phone || '',
    rating: Number(booking.other_party_rating || 0)
  };

  return {
    id: booking.id,
    companionId: booking.supplier_id,
    customerId: booking.customer_id,
    [otherPartyKey]: otherParty,
    serviceId: booking.service_id,
    service: booking.service_id ? {
      id: booking.service_id,
      name: booking.service_name,
      description: booking.service_description,
      price: Number(booking.service_price || booking.total_amount || 0)
    } : null,
    date,
    startTime,
    endTime,
    duration,
    location: getLocation(booking),
    meetingPoint: getLocation(booking) || '',
    specialRequests: booking.special_requests || '',
    preferredLanguages: booking.preferred_language ? String(booking.preferred_language).split(',').map((item) => item.trim()).filter(Boolean) : [],
    dietaryRestrictions: booking.dietary_requirements ? String(booking.dietary_requirements).split(',').map((item) => item.trim()).filter(Boolean) : [],
    status: booking.status,
    totalAmount: Number(booking.total_amount || 0),
    serviceFee: 0,
    paymentStatus: booking.status === 'cancelled' ? 'refunded' : 'pending',
    createdAt: booking.created_at,
    updatedAt: booking.updated_at
  };
};

const getReminderTimestamp = (scheduledAt: string): string | null => {
  const startsAt = new Date(scheduledAt.includes('T') ? scheduledAt : scheduledAt.replace(' ', 'T'));
  if (Number.isNaN(startsAt.getTime())) return null;

  const reminderAt = new Date(startsAt.getTime() - 3 * 60 * 60 * 1000);
  return reminderAt > new Date() ? reminderAt.toISOString() : null;
};

const queueThreeHourBookingReminders = async (
  c: any,
  booking: {
    id: string;
    customer_id: string;
    supplier_id: string;
    scheduled_at: string;
  }
) => {
  const scheduledFor = getReminderTimestamp(booking.scheduled_at);
  if (!scheduledFor) return;

  const startTime = getBookingStartTime(booking.scheduled_at);

  await Promise.all([
    c.env.NOTIFICATION_QUEUE.send({
      id: crypto.randomUUID(),
      type: 'push',
      userId: booking.customer_id,
      title: 'Your Tirak experience starts in 3 hours',
      message: `Your local experience starts today at ${startTime}.`,
      data: { bookingId: booking.id, type: 'booking_reminder' },
      priority: 'high',
      channels: ['push', 'email', 'in_app'],
      scheduledFor,
      retryCount: 0,
      maxRetries: 3,
    }),
    c.env.NOTIFICATION_QUEUE.send({
      id: crypto.randomUUID(),
      type: 'push',
      userId: booking.supplier_id,
      title: 'Your Tirak booking starts in 3 hours',
      message: `Your traveler booking starts today at ${startTime}.`,
      data: { bookingId: booking.id, type: 'booking_reminder' },
      priority: 'high',
      channels: ['push', 'email', 'in_app'],
      scheduledFor,
      retryCount: 0,
      maxRetries: 3,
    }),
  ]);
};

bookings.post('/', zValidator('json', createBookingSchema), async (c) => {
  const userId = c.get('userId') as string;
  const userType = c.get('userType');
  const bookingData: BookingData = c.req.valid('json');

  try {
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only customers can create bookings', 403);
    }

    const companion = await c.env.DB.prepare(`
      SELECT sp.user_id, sp.display_name, sp.verification_status, sp.subscription_status,
             u.status as user_status
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
        AND COALESCE(sp.verification_status, 'pending') != 'rejected'
        AND COALESCE(sp.subscription_status, 'active') = 'active'
        AND u.status = 'active'
    `).bind(bookingData.companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The selected companion is not available', 404);
    }

    let service: any = null;
    if (bookingData.serviceId) {
      service = await c.env.DB.prepare(`
        SELECT id, title, description, price_min, price_max, currency, duration_hours
        FROM supplier_services
        WHERE id = ? AND supplier_id = ? AND is_active = TRUE
      `).bind(bookingData.serviceId, bookingData.companionId).first();

      if (!service) {
        return jsonError(c, 'Service not found', 'The selected service is not available', 404);
      }
    } else {
      service = await c.env.DB.prepare(`
        SELECT id, title, description, price_min, price_max, currency, duration_hours
        FROM supplier_services
        WHERE supplier_id = ? AND is_active = TRUE
        ORDER BY price_min ASC
        LIMIT 1
      `).bind(bookingData.companionId).first();
    }

    const scheduledAt = toScheduledAt(bookingData.date, bookingData.startTime);
    const duration = bookingData.duration || Math.max(30, Math.round(Number(service?.duration_hours || 1) * 60));
    const endTime = bookingData.endTime || getEndTime(bookingData.startTime, duration);
    const endAt = toScheduledAt(bookingData.date, endTime);

    const conflictCheck = await c.env.DB.prepare(`
      SELECT id FROM bookings
      WHERE supplier_id = ?
        AND status IN ('pending', 'confirmed', 'in_progress')
        AND datetime(scheduled_at) < datetime(?)
        AND datetime(scheduled_at, '+' || duration || ' minutes') > datetime(?)
      LIMIT 1
    `).bind(bookingData.companionId, endAt, scheduledAt).first();

    if (conflictCheck) {
      return jsonError(c, 'Time slot unavailable', 'The selected time slot is already booked', 409);
    }

    const basePrice = Number(service?.price_min || 1000);
    const totalAmount = basePrice;
    const bookingId = crypto.randomUUID();
    const now = new Date().toISOString();
    const location = bookingData.meetingPoint || bookingData.location || null;
    const preferredLanguage = bookingData.preferredLanguages?.join(', ') || null;
    const dietaryRequirements = bookingData.dietaryRestrictions?.join(', ') || null;

    await c.env.DB.prepare(`
      INSERT INTO bookings (
        id, customer_id, supplier_id, service_id, status, scheduled_at, duration,
        total_amount, currency, notes, created_at, updated_at, customer_preferences,
        special_requests, preferred_language, group_composition, dietary_requirements,
        experience_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      bookingId,
      userId,
      bookingData.companionId,
      service?.id || bookingData.serviceId || null,
      'pending',
      scheduledAt,
      duration,
      totalAmount,
      service?.currency || 'THB',
      location,
      now,
      now,
      stringifyOptional({ template: bookingData.template, accessibilityNeeds: bookingData.accessibilityNeeds }),
      bookingData.specialRequests || null,
      preferredLanguage,
      null,
      dietaryRequirements,
      service?.id || bookingData.serviceId || null
    ).run();

    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'booking_created',
      userId,
      properties: {
        bookingId,
        companionId: bookingData.companionId,
        serviceId: service?.id || bookingData.serviceId,
        totalAmount,
        duration
      },
      timestamp: now
    });

    await Promise.all([
      createNotification(
        c.env.DB,
        c.env.NOTIFICATION_QUEUE,
        bookingData.companionId,
        'booking_request',
        'New Booking Request',
        `You have a new booking request for ${bookingData.date} at ${bookingData.startTime}.`,
        { bookingId, date: bookingData.date, startTime: bookingData.startTime },
        { channels: ['push', 'email', 'in_app'], priority: 'high' }
      ),
      createNotification(
        c.env.DB,
        c.env.NOTIFICATION_QUEUE,
        userId,
        'booking_created',
        'Booking Submitted',
        `Your booking request for ${bookingData.date} at ${bookingData.startTime} has been submitted.`,
        { bookingId, companionId: bookingData.companionId, date: bookingData.date, startTime: bookingData.startTime },
        { channels: ['push', 'email', 'in_app'], priority: 'medium' }
      ),
    ]);

    await queueThreeHourBookingReminders(c, {
      id: bookingId,
      customer_id: userId,
      supplier_id: bookingData.companionId,
      scheduled_at: scheduledAt,
    });

    const createdBooking = await c.env.DB.prepare(`
      SELECT
        b.*,
        cp.display_name as companion_name,
        cp.profile_images as companion_profile_image,
        cp.rating_average as companion_rating,
        s.title as service_name,
        s.description as service_description,
        s.price_min as service_price
      FROM bookings b
      JOIN supplier_profiles cp ON b.supplier_id = cp.user_id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.id = ?
    `).bind(bookingId).first();

    if (!createdBooking) {
      return jsonError(c, 'Booking failed', 'Created booking could not be loaded', 500);
    }

    const created = createdBooking as any;
    const formatted = formatBooking({
      ...created,
      other_party_id: created.supplier_id,
      other_party_name: created.companion_name,
      other_party_image: created.companion_profile_image,
      other_party_rating: created.companion_rating
    }, 'customer');

    return jsonSuccess(c, {
      booking: {
        ...formatted,
        companion: {
          id: created.supplier_id,
          name: created.companion_name,
          profileImage: firstProfileImage(created.companion_profile_image),
          rating: Number(created.companion_rating || 0)
        },
        timeline: [
          { status: 'pending', timestamp: created.created_at, note: 'Booking submitted' }
        ],
        paymentStatus: 'pending'
      }
    }, 'Booking created successfully', 201);

  } catch (error) {
    console.error('Create booking error:', error);
    return jsonError(c, 'Booking failed', 'An error occurred while creating the booking', 500);
  }
});

bookings.get('/', validatePagination(), async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');

  try {
    const where = status
      ? `WHERE (b.customer_id = ? OR b.supplier_id = ?) AND b.status = ?`
      : `WHERE (b.customer_id = ? OR b.supplier_id = ?)`;
    const whereParams = status ? [userId, userId, status] : [userId, userId];

    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total
      FROM bookings b
      ${where}
    `).bind(...whereParams).first();
    const total = Number((countResult as any)?.total || 0);

    const offset = (page - 1) * limit;
    const result = await c.env.DB.prepare(`
      SELECT
        b.*,
        CASE WHEN ? = 'customer' THEN cp.display_name ELSE cust.display_name END as other_party_name,
        CASE WHEN ? = 'customer' THEN cp.profile_images ELSE cust.profile_image END as other_party_image,
        CASE WHEN ? = 'customer' THEN sp_user.phone ELSE cust_user.phone END as other_party_phone,
        CASE WHEN ? = 'customer' THEN cp.rating_average ELSE 0 END as other_party_rating,
        CASE WHEN ? = 'customer' THEN b.supplier_id ELSE b.customer_id END as other_party_id,
        s.title as service_name,
        s.description as service_description,
        s.price_min as service_price
      FROM bookings b
      LEFT JOIN supplier_profiles cp ON b.supplier_id = cp.user_id
      LEFT JOIN users sp_user ON b.supplier_id = sp_user.id
      LEFT JOIN customer_profiles cust ON b.customer_id = cust.user_id
      LEFT JOIN users cust_user ON b.customer_id = cust_user.id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(userType, userType, userType, userType, userType, ...whereParams, limit, offset).all();

    const items = result.results.map((booking: any) => formatBooking(booking, String(userType)));

    return jsonPaginated(c, items, createPagination(page, limit, total));

  } catch (error) {
    console.error('Get bookings error:', error);
    return jsonError(c, 'Failed to retrieve bookings', 'An error occurred while fetching bookings', 500);
  }
});

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
        cust.profile_image as customer_image,
        cust.user_id as customer_user_id,
        custu.phone as customer_phone,
        s.title as service_name,
        s.description as service_description,
        s.price_min as service_price
      FROM bookings b
      JOIN supplier_profiles cp ON b.supplier_id = cp.user_id
      JOIN users cu ON cp.user_id = cu.id
      JOIN customer_profiles cust ON b.customer_id = cust.user_id
      JOIN users custu ON cust.user_id = custu.id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
    `).bind(bookingId, userId, userId).first();

    if (!booking) {
      return jsonError(c, 'Booking not found', 'The requested booking does not exist or you do not have access', 404);
    }

    const row = booking as any;
    const formatted = formatBooking(row, 'customer');

    return jsonSuccess(c, {
      booking: {
        ...formatted,
        companion: {
          id: row.companion_user_id,
          name: row.companion_name,
          profileImage: firstProfileImage(row.companion_images),
          phone: row.companion_phone,
          rating: Number(row.companion_rating || 0)
        },
        customer: {
          id: row.customer_user_id,
          name: row.customer_name,
          profileImage: firstProfileImage(row.customer_image),
          phone: row.customer_phone,
          rating: 0
        },
        paymentMethod: null,
        timeline: [
          { status: 'pending', timestamp: row.created_at, note: 'Booking submitted' },
          ...(row.status !== 'pending' ? [{ status: row.status, timestamp: row.updated_at, note: `Booking ${row.status}` }] : [])
        ]
      }
    }, 'Booking details retrieved successfully');

  } catch (error) {
    console.error('Get booking details error:', error);
    return jsonError(c, 'Failed to retrieve booking', 'An error occurred while fetching booking details', 500);
  }
});

bookings.put('/:id/status', validateUUID('id'), zValidator('json', updateBookingStatusSchema), async (c) => {
  const bookingId = c.req.param('id');
  const userId = c.get('userId') as string;
  const { status, reason } = c.req.valid('json');

  try {
    const booking = await c.env.DB.prepare(`
      SELECT * FROM bookings
      WHERE id = ? AND (customer_id = ? OR supplier_id = ?)
    `).bind(bookingId, userId, userId).first();

    if (!booking) {
      return jsonError(c, 'Booking not found', 'The requested booking does not exist or you do not have access', 404);
    }

    const row = booking as any;
    const currentStatus = String(row.status);
    const validTransitions: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['cancelled', 'completed'],
      in_progress: ['completed', 'cancelled'],
      completed: [],
      cancelled: []
    };

    if (!validTransitions[currentStatus]?.includes(status)) {
      return jsonError(c, 'Invalid status transition', `Cannot change status from ${currentStatus} to ${status}`, 400);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      UPDATE bookings
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).bind(status, now, bookingId).run();

    const otherUserId = String(row.customer_id === userId ? row.supplier_id : row.customer_id);
    await createNotification(
      c.env.DB,
      c.env.NOTIFICATION_QUEUE,
      otherUserId,
      status === 'confirmed' ? 'booking_confirmed' : status === 'cancelled' ? 'booking_cancelled' : 'booking_status_update',
      status === 'confirmed' ? 'Booking Confirmed' : 'Booking Status Updated',
      reason || `Your booking status has been changed to ${status}.`,
      { bookingId, status, reason },
      { channels: ['push', 'email', 'in_app'], priority: status === 'confirmed' ? 'high' : 'medium' }
    );

    if (status === 'confirmed') {
      await queueThreeHourBookingReminders(c, {
        id: row.id,
        customer_id: row.customer_id,
        supplier_id: row.supplier_id,
        scheduled_at: row.scheduled_at
      });
    }

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
