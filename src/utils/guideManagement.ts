import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../index';
import { authMiddleware, requireRole } from '../middleware/auth';
import { validateUUID } from '../middleware/validation';
import { jsonError, jsonSuccess, createPagination } from './response';
import { hasGuideProfile, isPublicGuide } from './guideVisibility';
import { availabilitySaveSchema, clockTime, dateRange, GUIDE_TIME_ZONE, loadGuideSchedule, minutes, scheduleForDate, settingsSchema } from './guideAvailability';

type GuideApp = Hono<{ Bindings: Env; Variables: Variables }>;
const experienceSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(5000).optional(),
  durationMinutes: z.number().int().min(30).max(1440),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20),
  price: z.number().finite().min(0).max(1000000), currency: z.literal('THB'), is_active: z.boolean(),
});
const pagingSchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) });
const owner = async (c: any, next: any) => {
  try {
  const id = c.req.param('id');
  if (c.get('userId') !== id) return jsonError(c, 'Access denied', 'You can only manage your own guide profile', 403);
  if (!await hasGuideProfile(c.env.DB, id)) return jsonError(c, 'Guide profile not found', 'Complete your guide profile first', 404);
  return await next();
  } catch { return jsonError(c, 'Guide management unavailable', 'Unable to load the guide profile', 500); }
};
const ownerRole = requireRole('supplier', 'companion');
const toExperience = (row: any) => ({
  id: row.id, title: row.title, description: row.description || '', durationMinutes: Math.round(Number(row.duration_hours) * 60),
  keywords: JSON.parse(row.keywords || '[]'), price: Number(row.price_min), currency: row.currency,
  isActive: Boolean(row.is_active), createdAt: row.created_at, updatedAt: row.updated_at,
});

export function registerGuideManagement(app: GuideApp) {
  app.get('/:id/experiences', validateUUID('id'), zValidator('query', pagingSchema), async c => {
    try {
      const id = c.req.param('id');
      const own = c.get('userId') === id && ['supplier', 'companion'].includes(String(c.get('userType')));
      if (!(own ? await hasGuideProfile(c.env.DB, id) : await isPublicGuide(c.env.DB, id))) {
        return jsonError(c, 'Guide not found', 'The requested guide is unavailable', 404);
      }
      const { page, limit } = c.req.valid('query');
      const predicate = `supplier_id = ? AND archived_at IS NULL ${own ? '' : 'AND is_active = TRUE'}`;
      const total = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM supplier_services WHERE ${predicate}`).bind(id).first<{ total: number }>();
      const rows = await c.env.DB.prepare(`SELECT * FROM supplier_services WHERE ${predicate} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(id, limit, (page - 1) * limit).all();
      return jsonSuccess(c, { items: rows.results.map(toExperience), pagination: createPagination(page, limit, Number(total?.total || 0)) }, 'Experiences retrieved');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.post('/:id/experiences', validateUUID('id'), authMiddleware, ownerRole, owner, zValidator('json', experienceSchema), async c => {
    try {
      const data = c.req.valid('json');
      const id = c.req.param('id'), experienceId = crypto.randomUUID(), now = new Date().toISOString();
      await c.env.DB.prepare(`INSERT INTO supplier_services
        (id,supplier_id,title,description,price_min,price_max,currency,duration_hours,is_active,keywords,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(experienceId, id, data.title, data.description || '', data.price, data.price, data.currency,
          data.durationMinutes / 60, Number(data.is_active), JSON.stringify(data.keywords), now, now).run();
      return jsonSuccess(c, { experienceId, created: true }, 'Experience created', 201);
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.put('/:id/experiences/:experienceId', validateUUID('id'), authMiddleware, ownerRole, owner, zValidator('json', experienceSchema), async c => {
    try {
      const data = c.req.valid('json');
      const experienceId = c.req.param('experienceId');
      const result = await c.env.DB.prepare(`UPDATE supplier_services SET title=?,description=?,price_min=?,price_max=?,currency=?,duration_hours=?,is_active=?,keywords=?,updated_at=?
        WHERE id=? AND supplier_id=? AND archived_at IS NULL`).bind(data.title, data.description || '', data.price, data.price, data.currency,
          data.durationMinutes / 60, Number(data.is_active), JSON.stringify(data.keywords), new Date().toISOString(), experienceId, c.req.param('id')).run();
      if (!result.meta.changes) return jsonError(c, 'Experience not found', 'No editable experience belongs to this guide', 404);
      return jsonSuccess(c, { experienceId, created: false }, 'Experience updated');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.delete('/:id/experiences/:experienceId', validateUUID('id'), authMiddleware, ownerRole, owner, async c => {
    try {
      const id = c.req.param('id'), experienceId = c.req.param('experienceId');
      const existing = await c.env.DB.prepare('SELECT id FROM supplier_services WHERE id=? AND supplier_id=?').bind(experienceId, id).first();
      if (!existing) return jsonError(c, 'Experience not found', 'No experience belongs to this guide', 404);
      await c.env.DB.prepare('UPDATE supplier_services SET is_active=FALSE,archived_at=COALESCE(archived_at,?),updated_at=? WHERE id=? AND supplier_id=?')
        .bind(new Date().toISOString(), new Date().toISOString(), experienceId, id).run();
      return jsonSuccess(c, { experienceId, archived: true }, 'Experience archived; booking history retained');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.get('/:id/availability/settings', validateUUID('id'), authMiddleware, ownerRole, owner, async c => {
    try {
      const rows = await c.env.DB.prepare('SELECT day_of_week,start_time,end_time,is_available FROM supplier_availability WHERE supplier_id=? ORDER BY day_of_week').bind(c.req.param('id')).all();
      return jsonSuccess(c, { timeZone: GUIDE_TIME_ZONE, days: rows.results.map((row: any) => ({ dayOfWeek: row.day_of_week, startTime: row.start_time, endTime: row.end_time, isAvailable: Boolean(row.is_available) })) });
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.put('/:id/availability/settings', validateUUID('id'), authMiddleware, ownerRole, owner, zValidator('json', settingsSchema), async c => {
    try {
      const id = c.req.param('id'), data = c.req.valid('json'), now = new Date().toISOString();
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM supplier_availability WHERE supplier_id=?').bind(id),
        ...data.days.map(day => c.env.DB.prepare(`INSERT INTO supplier_availability (id,supplier_id,day_of_week,start_time,end_time,is_available,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(crypto.randomUUID(), id, day.dayOfWeek, day.startTime, day.endTime, Number(day.isAvailable), now, now)),
      ]);
      return jsonSuccess(c, data, 'Weekly schedule saved');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.get('/:id/availability', validateUUID('id'), async c => {
    try {
      const id = c.req.param('id') as string, start = c.req.query('startDate') || '', end = c.req.query('endDate') || '';
      const dates = dateRange(start, end);
      if (!dates) return jsonError(c, 'Invalid date range', 'Provide valid dates spanning no more than 90 days', 400);
      const own = c.get('userId') === id && ['supplier', 'companion'].includes(String(c.get('userType')));
      if (!(own ? await hasGuideProfile(c.env.DB, id) : await isPublicGuide(c.env.DB, id))) return jsonError(c, 'Companion not found', 'The requested guide is unavailable', 404);
      const { weekly, overrides } = await loadGuideSchedule(c.env.DB, id, start, end);
      // Stored scheduled_at is a Bangkok wall-clock value, matching booking date/startTime.
      const reserved = await c.env.DB.prepare(`SELECT scheduled_at,duration FROM bookings WHERE supplier_id=? AND status IN ('pending','confirmed','in_progress')
        AND datetime(scheduled_at) < datetime(?, '+1 day') AND datetime(scheduled_at, '+' || duration || ' minutes') > datetime(?)`).bind(id, end, start).all<any>();
      const availability = dates.map(date => {
        const schedule = scheduleForDate(date, weekly, overrides);
        const timeSlots: Array<{ start: string; end: string; available: boolean }> = [];
        if (schedule?.is_available) {
          for (let minute = minutes(schedule.start_time); minute < minutes(schedule.end_time); minute += 30) {
            const finish = Math.min(minute + 30, minutes(schedule.end_time));
            const slotStart = Date.parse(`${date}T${clockTime(minute)}:00Z`), slotEnd = Date.parse(`${date}T${clockTime(finish)}:00Z`);
            const booked = reserved.results.some(row => {
              const bookedStart = Date.parse(String(row.scheduled_at).replace(' ', 'T').replace(/Z$/, '') + 'Z');
              return bookedStart < slotEnd && bookedStart + Number(row.duration) * 60000 > slotStart;
            });
            timeSlots.push({ start: clockTime(minute), end: clockTime(finish), available: !booked });
          }
        }
        return { date, available: timeSlots.some(slot => slot.available), timeSlots };
      });
      return jsonSuccess(c, { availability, timeZone: GUIDE_TIME_ZONE }, 'Availability retrieved');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
  app.post('/:id/availability', validateUUID('id'), authMiddleware, ownerRole, owner, zValidator('json', availabilitySaveSchema), async c => {
    try {
      const id = c.req.param('id'), ranges = c.req.valid('json'), now = new Date().toISOString();
      const days = ranges.flatMap(range => dateRange(range.startDate, range.endDate)!.map(date => ({ date, ...range })));
      await c.env.DB.batch(days.map(day => c.env.DB.prepare(`INSERT INTO supplier_availability_overrides (supplier_id,date,start_time,end_time,is_available,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(supplier_id,date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,is_available=excluded.is_available,updated_at=excluded.updated_at`)
        .bind(id, day.date, day.startTime, day.endTime, Number(day.isAvailable), now)));
      return jsonSuccess(c, { availability: days.map(day => ({ date: day.date, available: day.isAvailable, slots: [{ start: day.startTime, end: day.endTime, available: day.isAvailable }] })) }, 'Date overrides saved');
    } catch { return jsonError(c, 'Guide management unavailable', 'Unable to complete this request; please retry', 500); }
  });
}
