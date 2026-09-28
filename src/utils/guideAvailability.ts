import { z } from 'zod';

export const GUIDE_TIME_ZONE = 'Asia/Bangkok' as const;
export const validDate = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
export const dateSchema = z.string().refine(validDate, 'Invalid calendar date');
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Invalid time');
export const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const clockTime = (value: number): string => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

const interval = { startTime: timeSchema, endTime: timeSchema, isAvailable: z.boolean() };
export const settingsSchema = z.object({
  timeZone: z.literal(GUIDE_TIME_ZONE),
  days: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), ...interval })
    .refine(day => day.startTime < day.endTime, 'End time must follow start time')).max(7)
    .refine(days => new Set(days.map(day => day.dayOfWeek)).size === days.length, 'Duplicate weekday'),
});
export const availabilitySaveSchema = z.array(z.object({ startDate: dateSchema, endDate: dateSchema, ...interval })
  .refine(range => range.startTime < range.endTime, 'End time must follow start time')
  .refine(range => range.startDate <= range.endDate, 'End date must follow start date'))
  .min(1).max(90).superRefine((ranges, ctx) => {
    const seen = new Set<string>();
    for (const range of ranges) {
      const dates = dateRange(range.startDate, range.endDate);
      if (!dates) { ctx.addIssue({ code: 'custom', message: 'Maximum range is 90 days' }); return; }
      for (const date of dates) {
        if (seen.has(date)) { ctx.addIssue({ code: 'custom', message: 'Overlapping date ranges' }); return; }
        seen.add(date);
      }
    }
    if (seen.size > 90) ctx.addIssue({ code: 'custom', message: 'Maximum 90 dates per save' });
  });

export function dateRange(start: string, end: string): string[] | null {
  if (!validDate(start) || !validDate(end) || start > end) return null;
  const count = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (count > 90) return null;
  return Array.from({ length: count }, (_, n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10));
}

export type ScheduleRow = { day_of_week?: number; date?: string; start_time: string; end_time: string; is_available: number | boolean };
export function scheduleForDate(date: string, weekly: ScheduleRow[], overrides: ScheduleRow[]): ScheduleRow | undefined {
  return overrides.find(row => row.date === date)
    ?? weekly.find(row => Number(row.day_of_week) === new Date(`${date}T00:00:00Z`).getUTCDay());
}
export async function loadGuideSchedule(db: D1Database, id: string, start: string, end: string) {
  const [weekly, overrides] = await Promise.all([
    db.prepare('SELECT day_of_week, start_time, end_time, is_available FROM supplier_availability WHERE supplier_id = ?').bind(id).all<ScheduleRow>(),
    db.prepare('SELECT date, start_time, end_time, is_available FROM supplier_availability_overrides WHERE supplier_id = ? AND date BETWEEN ? AND ?').bind(id, start, end).all<ScheduleRow>(),
  ]);
  return { weekly: weekly.results, overrides: overrides.results };
}
export async function scheduleAllows(db: D1Database, id: string, date: string, startTime: string, duration: number): Promise<boolean> {
  const { weekly, overrides } = await loadGuideSchedule(db, id, date, date);
  const row = scheduleForDate(date, weekly, overrides);
  return Boolean(row?.is_available && minutes(startTime) >= minutes(row.start_time)
    && minutes(startTime) + duration <= minutes(row.end_time));
}
