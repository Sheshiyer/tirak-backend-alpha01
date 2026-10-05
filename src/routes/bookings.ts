import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { firstProfileImage } from '../utils/profileImages';
import {
  cancellationBlockReason,
  publicBookingPaymentStatus,
  type PaymentAttemptStatus,
} from '../contracts/payment';
import type { Env, Variables } from '../index';
import { createNotification } from './notifications';
import { publicCompanionVisibility, publicIdentity } from '../utils/guideVisibility';
import {
  dateSchema, timeSchema, minutes, scheduleAllows,
  toBangkokIso, isFutureBangkok, BANGKOK_OFFSET,
} from '../utils/guideAvailability';

const bookings = new Hono<{ Bindings: Env; Variables: Variables }>();

bookings.use('*', authMiddleware);
bookings.use('*', createRateLimit('booking'));

/* ──────────────────────────── schemas ──────────────────────────── */

const createBookingSchema = z.object({
  companionId: z.string().uuid('Invalid guide ID'),
  serviceId: z.string().min(1, 'A guided experience is required'),
  date: dateSchema,
  startTime: timeSchema,
  endTime: timeSchema.optional(),
  duration: z.number().int('Duration must be a whole number of minutes')
    .min(30, 'Minimum duration is 30 minutes')
    .max(1440, 'Maximum duration is 24 hours'),
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
type RequestedBookingStatus = z.infer<typeof updateBookingStatusSchema>['status'];
type BookingActor = 'customer' | 'supplier';

const idempotencyKeySchema = z.string().uuid('Idempotency-Key must be a UUID');

const allowedBookingTransitions: Record<
  BookingActor,
  Record<string, readonly RequestedBookingStatus[]>
> = {
  customer: {
    pending: ['cancelled'],
    confirmed: ['cancelled'],
    in_progress: [],
    completed: [],
    cancelled: [],
  },
  supplier: {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['completed', 'cancelled'],
    in_progress: ['completed'],
    completed: [],
    cancelled: [],
  },
};

/* ──────────────────────────── helpers ──────────────────────────── */

const timeToMinutes = (value: string): number => {
  const [hours = 0, mins = 0] = value.split(':').map(Number);
  return (hours * 60) + mins;
};

const minutesToTime = (value: number): string => {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60).toString().padStart(2, '0');
  const mins = (normalized % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
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

const currentIso = (): string => new Date(Date.now()).toISOString();

const listField = (value: unknown): string[] => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const paymentTablesEnabled = (env: Env): boolean => env.PAYMENT_MODE !== 'disabled';

const replyPaymentStatus = (value: unknown, env: Env): ReturnType<typeof publicBookingPaymentStatus> => {
  if (!paymentTablesEnabled(env)) return 'pending';
  return publicBookingPaymentStatus(value);
};

const isSqliteConstraint = (error: unknown, fragment: string): boolean => {
  const message = String(error || '');
  return message.includes('constraint') && message.includes(fragment);
};

const bookingSelect = `
  SELECT
    b.*,
    cp.user_id as companion_user_id,
    cp.display_name as companion_name,
    cp.profile_images as companion_images,
    cp.rating_average as companion_rating,
    sp_user.phone as companion_phone,
    cust.display_name as customer_name,
    cust.profile_image as customer_image,
    cust_user.phone as customer_phone,
    cust_user.id as customer_user_id,
    s.title as service_name,
    s.description as service_description,
    s.price_min as service_price
  FROM bookings b
  LEFT JOIN supplier_profiles cp ON b.supplier_id = cp.user_id
  LEFT JOIN users sp_user ON b.supplier_id = sp_user.id
  LEFT JOIN customer_profiles cust ON b.customer_id = cust.user_id
  LEFT JOIN users cust_user ON b.customer_id = cust_user.id
  LEFT JOIN supplier_services s ON b.service_id = s.id
`;

const loadBookingById = async (db: D1Database, bookingId: string) => db.prepare(`
  ${bookingSelect}
  WHERE b.id = ?
`).bind(bookingId).first();

const loadParticipantBookingById = async (db: D1Database, bookingId: string, userId: string) => db.prepare(`
  ${bookingSelect}
  WHERE b.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
`).bind(bookingId, userId, userId).first();

/* ────────────────────────── idempotency ────────────────────────── */

/**
 * Stable canonical JSON: sorted keys, no whitespace. Deterministic across
 * identical payloads regardless of key insertion order.
 */
function canonicalPayload(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalPayload).join(',') + ']';
  return '{' + Object.keys(value as Record<string, unknown>).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalPayload((value as Record<string, unknown>)[k]))
    .join(',') + '}';
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

type IdempotencyRecord = {
  booking_id: string;
  payload: string;
  payload_digest: string;
  status: string;
};

async function loadIdempotencyRecord(
  db: D1Database,
  userId: string,
  keyHash: string,
): Promise<IdempotencyRecord | null> {
  return db.prepare(`
    SELECT booking_id, payload, payload_digest, status
    FROM booking_idempotency
    WHERE user_id = ? AND key_hash = ?
  `).bind(userId, keyHash).first() as Promise<IdempotencyRecord | null>;
}

async function replayExistingBooking(
  db: D1Database,
  bookingId: string,
  env: Env,
) {
  const replayed = await loadBookingById(db, bookingId);
  if (!replayed) return null;

  const formatted = formatBooking({
    ...(replayed as any),
    other_party_id: (replayed as any).supplier_id,
    other_party_name: (replayed as any).companion_name,
    other_party_image: (replayed as any).companion_images,
    other_party_rating: (replayed as any).companion_rating,
  }, 'customer', env);

  return {
    booking: { ...formatted, idempotent: true },
    idempotent: true,
  };
}

/* ──────────────────────────── formatting ──────────────────────────── */

const formatBooking = (booking: any, userType?: string, env?: Env) => {
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
      price: Number(booking.total_amount || 0)
    } : null,
    date,
    startTime,
    endTime,
    duration,
    location: getLocation(booking),
    meetingPoint: getLocation(booking) || '',
    specialRequests: booking.special_requests || '',
    preferredLanguages: booking.preferred_language ? String(booking.preferred_language).split(',').map((item: string) => item.trim()).filter(Boolean) : [],
    dietaryRestrictions: booking.dietary_requirements ? String(booking.dietary_requirements).split(',').map((item: string) => item.trim()).filter(Boolean) : [],
    status: booking.status,
    totalAmount: Number(booking.total_amount || 0),
    serviceFee: 0,
    paymentStatus: replyPaymentStatus(booking.payment_status, env || { PAYMENT_MODE: 'test' } as Env),
    createdAt: booking.created_at,
    updatedAt: booking.updated_at
  };
};

const formatBookingDetail = (booking: any, env: Env) => ({
  id: booking.id,
  companionId: booking.supplier_id,
  customerId: booking.customer_id,
  serviceId: booking.service_id,
  service: booking.service_id ? {
    id: booking.service_id,
    name: booking.service_name,
    description: booking.service_description,
    price: Number(booking.total_amount || 0)
  } : null,
  date: getBookingDate(booking.scheduled_at),
  startTime: getBookingStartTime(booking.scheduled_at),
  endTime: getEndTime(getBookingStartTime(booking.scheduled_at), Number(booking.duration || 0)),
  duration: Number(booking.duration || 0),
  location: getLocation(booking),
  meetingPoint: getLocation(booking) || '',
  specialRequests: booking.special_requests || '',
  preferredLanguages: listField(booking.preferred_language),
  dietaryRestrictions: listField(booking.dietary_requirements),
  status: booking.status,
  totalAmount: Number(booking.total_amount || 0),
  serviceFee: 0,
  paymentStatus: replyPaymentStatus(booking.payment_status, env),
  createdAt: booking.created_at,
  updatedAt: booking.updated_at,
  companion: {
    id: booking.companion_user_id,
    name: booking.companion_name,
    profileImage: firstProfileImage(booking.companion_images),
    phone: booking.companion_phone,
    rating: Number(booking.companion_rating || 0)
  },
  customer: {
    id: booking.customer_user_id,
    name: booking.customer_name,
    profileImage: firstProfileImage(booking.customer_image),
    phone: booking.customer_phone,
    rating: 0
  },
  paymentMethod: null,
  timeline: [
    { status: 'pending', timestamp: booking.created_at, note: 'Booking submitted' },
    ...(booking.status !== 'pending' ? [{ status: booking.status, timestamp: booking.updated_at, note: `Booking ${booking.status}` }] : [])
  ]
});

/* ──────────────────────────── reminders ──────────────────────────── */

/**
 * Compute reminder time using explicit Bangkok offset.
 * scheduled_at is stored as "YYYY-MM-DD HH:MM:00" in Bangkok-local semantics.
 * We reconstruct the explicit ISO with +07:00 to produce a correct UTC instant
 * for the 3-hour-before reminder.
 */
const getReminderTimestamp = (scheduledAt: string): string | null => {
  const parts = String(scheduledAt || '').split(/[ T]/);
  const date = parts[0] || '';
  const time = (parts[1] || '00:00').slice(0, 5);
  if (!date || !time) return null;

  const startsAt = new Date(toBangkokIso(date, time));
  if (Number.isNaN(startsAt.getTime())) return null;

  const reminderAt = new Date(startsAt.getTime() - 3 * 60 * 60 * 1000);
  return reminderAt.getTime() > Date.now() ? reminderAt.toISOString() : null;
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

/* ──────────────────────── POST / (create) ──────────────────────── */

bookings.post('/', zValidator('json', createBookingSchema), async (c) => {
  const userId = c.get('userId') as string;
  const userType = c.get('userType');
  const bookingData: BookingData = c.req.valid('json');

  try {
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only travelers can create experience bookings', 403);
    }

    const idempotencyKey = c.req.header('Idempotency-Key');
    let idemKeyHash: string | null = null;
    let payloadCanonical: string | null = null;
    let payloadDigest: string | null = null;

    if (idempotencyKey) {
      const parsed = idempotencyKeySchema.safeParse(idempotencyKey);
      if (!parsed.success) {
        return jsonError(c, 'Invalid Idempotency-Key', parsed.error.issues[0]?.message || 'Idempotency-Key must be a UUID', 400);
      }

      idemKeyHash = await sha256Hex(idempotencyKey);
      payloadCanonical = canonicalPayload(bookingData);
      payloadDigest = await sha256Hex(payloadCanonical);

      const existing = await loadIdempotencyRecord(c.env.DB, userId, idemKeyHash);

      if (existing) {
        if (existing.payload_digest !== payloadDigest) {
          return jsonError(c, 'Idempotency conflict', 'The Idempotency-Key was reused with a different payload', 409);
        }

        const replay = await replayExistingBooking(c.env.DB, existing.booking_id, c.env);
        if (replay) {
          return jsonSuccess(c, replay, 'Booking already created (idempotent replay)', 200);
        }
      }
    }

    /* ── guide eligibility ── */
    const companion = await c.env.DB.prepare(`
      SELECT sp.user_id, sp.display_name, sp.verification_status, sp.subscription_status,
             sp.subscription_expires_at, u.status as user_status
      FROM supplier_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
        AND ${publicCompanionVisibility}
    `).bind(bookingData.companionId, ...publicIdentity.parameters).first();

    if (!companion) {
      return jsonError(c, 'Guide not found', 'The selected guide is not available', 404);
    }

    /* ── service validation ── */
    const service: any = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, price_max, currency, duration_hours
      FROM supplier_services
      WHERE id = ? AND supplier_id = ? AND is_active = TRUE AND archived_at IS NULL
    `).bind(bookingData.serviceId, bookingData.companionId).first();

    if (!service) {
      return jsonError(c, 'Experience not found', 'The selected guided experience is not available', 404);
    }

    /* ── duration and interval validation ── */
    const scheduledAt = toScheduledAt(bookingData.date, bookingData.startTime);
    const duration = Math.round(Number(service.duration_hours) * 60);
    if (!Number.isFinite(duration) || duration < 30 || bookingData.duration !== duration) {
      return jsonError(c, 'Invalid experience duration', 'Booking duration must match the selected guided experience', 400);
    }
    if (minutes(bookingData.startTime) + duration >= 1440 || (bookingData.endTime && minutes(bookingData.endTime) !== minutes(bookingData.startTime) + duration)) {
      return jsonError(c, 'Invalid booking interval', 'The end time must match duration within the same Bangkok calendar day', 400);
    }

    /* ── timezone-correct future check using explicit +07:00 offset ── */
    if (!isFutureBangkok(bookingData.date, bookingData.startTime)) {
      return jsonError(c, 'Invalid booking time', `Booking must be in the future (Bangkok time, UTC${BANGKOK_OFFSET}). The requested time has already passed.`, 400);
    }

    /* ── schedule check ── */
    if (!await scheduleAllows(c.env.DB, bookingData.companionId, bookingData.date, bookingData.startTime, duration)) {
      return jsonError(c, 'Guide schedule unavailable', 'This time is outside the guide schedule or no schedule has been set', 409);
    }
    const endTime = getEndTime(bookingData.startTime, duration);
    const endAt = toScheduledAt(bookingData.date, endTime);

    /* ── overlap check (application-layer, complemented by SQL trigger) ── */
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

    const basePrice = Number(service.price_min);
    const totalAmount = basePrice;
    const bookingId = crypto.randomUUID();
    const now = currentIso();
    const location = bookingData.meetingPoint || bookingData.location || null;
    const preferredLanguage = bookingData.preferredLanguages?.join(', ') || null;
    const dietaryRequirements = bookingData.dietaryRestrictions?.join(', ') || null;

    let persistedBookingId = bookingId;
    let createdNewBooking = true;
    const idempotencyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    try {
      const statements = [] as ReturnType<Env['DB']['prepare']>[];

      statements.push(c.env.DB.prepare(`
        INSERT INTO bookings (
          id, customer_id, supplier_id, service_id, status, scheduled_at, duration,
          total_amount, currency, notes, created_at, updated_at, customer_preferences,
          special_requests, preferred_language, group_composition, dietary_requirements,
          experience_id, payment_status, location
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        bookingId,
        userId,
        bookingData.companionId,
        service.id,
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
        service.id,
        'pending',
        location,
      ));

      if (idemKeyHash && payloadCanonical && payloadDigest) {
        statements.push(c.env.DB.prepare(`
          INSERT INTO booking_idempotency (
            user_id, key_hash, booking_id, payload, payload_digest, status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 'committed', ?, ?)
        `).bind(userId, idemKeyHash, bookingId, payloadCanonical, payloadDigest, now, idempotencyExpiry));
      }

      await c.env.DB.batch(statements);
    } catch (error) {
      if (idemKeyHash && payloadDigest && (
        String(error).includes('core_booking_overlap')
        || isSqliteConstraint(error, 'booking_idempotency.user_id, booking_idempotency.key_hash')
      )) {
        const winner = await loadIdempotencyRecord(c.env.DB, userId, idemKeyHash);
        if (!winner) throw error;
        if (winner.payload_digest !== payloadDigest) {
          return jsonError(c, 'Idempotency conflict', 'The Idempotency-Key was reused with a different payload', 409);
        }
        const replay = await replayExistingBooking(c.env.DB, winner.booking_id, c.env);
        if (replay) {
          persistedBookingId = winner.booking_id;
          createdNewBooking = false;
        } else {
          throw error;
        }
      } else if (String(error).includes('core_booking_overlap')) {
        return jsonError(c, 'Time slot unavailable', 'The selected time slot was just reserved', 409);
      } else {
        throw error;
      }
    }

    /* ── durability: post-commit aux operations must never cause 500 ── */
    if (createdNewBooking) {
      try {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'booking_created',
          userId,
          properties: {
            bookingId: persistedBookingId,
            companionId: bookingData.companionId,
            serviceId: service.id,
            totalAmount,
            duration
          },
          timestamp: now
        });
      } catch {
        /* Analytics delivery failure is non-fatal. */
      }

      try {
        await Promise.all([
          createNotification(
            c.env.DB,
            c.env.NOTIFICATION_QUEUE,
            bookingData.companionId,
            'booking_request',
            'New Booking Request',
            `You have a new booking request for ${bookingData.date} at ${bookingData.startTime}.`,
            { bookingId: persistedBookingId, date: bookingData.date, startTime: bookingData.startTime },
            { channels: ['push', 'email', 'in_app'], priority: 'high' }
          ),
          createNotification(
            c.env.DB,
            c.env.NOTIFICATION_QUEUE,
            userId,
            'booking_created',
            'Booking Submitted',
            `Your booking request for ${bookingData.date} at ${bookingData.startTime} has been submitted.`,
            { bookingId: persistedBookingId, companionId: bookingData.companionId, date: bookingData.date, startTime: bookingData.startTime },
            { channels: ['push', 'email', 'in_app'], priority: 'medium' }
          ),
        ]);
      } catch {
        /* Notification delivery failure is non-fatal. */
      }

      try {
        await queueThreeHourBookingReminders(c, {
          id: persistedBookingId,
          customer_id: userId,
          supplier_id: bookingData.companionId,
          scheduled_at: scheduledAt,
        });
      } catch {
        /* Reminder queue failure is non-fatal. */
      }
    }

    /* ── load and return created booking ── */
    const createdBooking = await loadBookingById(c.env.DB, persistedBookingId);

    if (!createdBooking) {
      return jsonError(c, 'Booking failed', 'Created booking could not be loaded', 500);
    }

    const created = createdBooking as any;
    const formatted = formatBooking({
      ...created,
      other_party_id: created.supplier_id,
      other_party_name: created.companion_name,
      other_party_image: created.companion_images,
      other_party_rating: created.companion_rating
    }, 'customer', c.env);

    return jsonSuccess(c, {
      booking: {
        ...formatted,
        companion: {
          id: created.supplier_id,
          name: created.companion_name,
          profileImage: firstProfileImage(created.companion_images),
          rating: Number(created.companion_rating || 0)
        },
        timeline: [
          { status: 'pending', timestamp: created.created_at, note: 'Booking submitted' }
        ],
        paymentStatus: replyPaymentStatus(created.payment_status, c.env)
      }
    }, persistedBookingId === bookingId ? 'Booking created successfully' : 'Booking already created (idempotent replay)', persistedBookingId === bookingId ? 201 : 200);

  } catch (error) {
    if (String(error).includes('core_booking_overlap')) return jsonError(c, 'Time slot unavailable', 'The selected time slot was just reserved', 409);
    console.error('Create booking error:', error);
    return jsonError(c, 'Booking failed', 'An error occurred while creating the booking', 500);
  }
});

/* ──────────────────────── GET / (list) ──────────────────────── */

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

    const items = result.results.map((booking: any) => formatBooking(booking, String(userType), c.env));

    return jsonPaginated(c, items, createPagination(page, limit, total));

  } catch (error) {
    console.error('Get bookings error:', error);
    return jsonError(c, 'Failed to retrieve bookings', 'An error occurred while fetching bookings', 500);
  }
});

/* ──────────────────────── GET /:id (detail) ──────────────────────── */

bookings.get('/:id', validateUUID('id'), async (c) => {
  const bookingId = c.req.param('id') as string;
  const userId = c.get('userId') as string;

  try {
    const booking = await loadParticipantBookingById(c.env.DB, bookingId, userId);

    if (!booking) {
      return jsonError(c, 'Booking not found', 'The requested booking does not exist or you do not have access', 404);
    }

    return jsonSuccess(c, {
      booking: formatBookingDetail(booking, c.env)
    }, 'Booking details retrieved successfully');

  } catch (error) {
    console.error('Get booking details error:', error);
    return jsonError(c, 'Failed to retrieve booking', 'An error occurred while fetching booking details', 500);
  }
});

/* ──────────────────────── PUT /:id/status ──────────────────────── */

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
    const actor: BookingActor = row.supplier_id === userId ? 'supplier' : 'customer';
    const validTransitions = allowedBookingTransitions[actor][currentStatus] || [];

    if (!validTransitions.includes(status)) {
      const detail = currentStatus === 'pending' && status === 'confirmed' && actor === 'customer'
        ? 'Only the assigned guide can confirm a pending experience booking'
        : `This ${actor === 'supplier' ? 'guide' : 'traveler'} cannot change the experience booking from ${currentStatus} to ${status}`;
      return jsonError(c, 'Invalid booking transition', detail, 403);
    }

    if (status === 'cancelled' && paymentTablesEnabled(c.env)) {
      const paymentAttempt = await c.env.DB.prepare(`
        SELECT status
        FROM payment_attempts
        WHERE booking_id = ? AND provider = 'omise' AND payment_method = 'promptpay'
        ORDER BY attempt_number DESC
        LIMIT 1
      `).bind(bookingId).first<{ status: PaymentAttemptStatus }>();
      const blockReason = cancellationBlockReason(paymentAttempt?.status || null);
      if (blockReason) {
        return jsonError(c, 'PAYMENT_OUTCOME_UNRESOLVED', blockReason, 409);
      }
    }

    const now = currentIso();
    const updateResult = await c.env.DB.prepare(`
      UPDATE bookings
      SET status = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).bind(status, now, bookingId, currentStatus).run();

    if (Number(updateResult.meta?.changes || 0) !== 1) {
      return jsonError(
        c,
        'Booking changed',
        'The experience booking changed before this update could be applied',
        409
      );
    }

    /* ── durability: post-commit aux operations must not cause 500 ── */
    const otherUserId = String(row.customer_id === userId ? row.supplier_id : row.customer_id);

    try {
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
    } catch {
      /* Notification failure is non-fatal. */
    }

    if (status === 'confirmed') {
      try {
        await queueThreeHourBookingReminders(c, {
          id: row.id,
          customer_id: row.customer_id,
          supplier_id: row.supplier_id,
          scheduled_at: row.scheduled_at
        });
      } catch {
        /* Reminder failure is non-fatal. */
      }
    }

    try {
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
    } catch {
      /* Analytics failure is non-fatal. */
    }

    const updatedBooking = await loadParticipantBookingById(c.env.DB, bookingId, userId);

    return jsonSuccess(c, {
      booking: updatedBooking ? formatBookingDetail(updatedBooking, c.env) : null
    }, 'Booking status updated successfully');

  } catch (error) {
    if (String(error).includes('core_booking_overlap')) return jsonError(c, 'Time slot unavailable', 'Another booking reserves this time', 409);
    console.error('Update booking status error:', error);
    return jsonError(c, 'Failed to update booking', 'An error occurred while updating booking status', 500);
  }
});

export { bookings as bookingRoutes };
