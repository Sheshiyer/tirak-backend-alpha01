/**
 * Core onboarding lifecycle helpers.
 * Pure functions — no DB or env access.
 */

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

/** Lowercase + trim. Unicode-safe; no punycode. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex of the idempotency key alone.
 * This is the UNIQUE constraint value — one key maps to exactly one application.
 */
export async function computeIdempotencyKeyHash(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hashBuffer);
}

/**
 * SHA-256 hex of the recursively sorted canonical payload.
 * Stored separately from the key hash for conflict detection:
 * same key + different payload → 409.
 */
export async function computePayloadDigest(
  payload: Record<string, unknown>,
): Promise<string> {
  const canonical = JSON.stringify(payload, canonicalReplacer);
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hashBuffer);
}

/**
 * Recursive sort replacer for JSON.stringify.
 * Object keys are sorted at every nesting level so identical payloads
 * with different key order produce the same digest.
 */
function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((sorted: Record<string, unknown>, k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
        return sorted;
      }, {});
  }
  return value;
}

// ---------------------------------------------------------------------------
// Status token
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic status token using HMAC-SHA256.
 * Context: JWT_SECRET + applicationId + idempotencyKey.
 * This allows replay recovery: same key + same payload always produces
 * the same token, so a lost first response can be recovered.
 * Only the SHA-256 hash of the token is stored; the token itself is
 * returned to the client once and never persisted or logged.
 */
export async function deriveStatusToken(
  jwtSecret: string,
  applicationId: string,
  idempotencyKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = new TextEncoder().encode(`${applicationId}:${idempotencyKey}`);
  const sig = await crypto.subtle.sign('HMAC', key, payload);
  return bufferToHex(sig);
}

/**
 * Generate a high-entropy private status token (48 bytes → 96 hex chars).
 * Used only for applications submitted without an Idempotency-Key (legacy).
 * Returned to the applicant once; only the SHA-256 hash is persisted.
 */
export function generateStatusToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer);
}

/** SHA-256 hex of the status token for storage/comparison. */
export async function hashStatusToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hashBuffer);
}

// ---------------------------------------------------------------------------
// Application data validation
// ---------------------------------------------------------------------------

export interface ApplicationData {
  firstName?: string;
  lastName?: string;
  bio?: string;
  location?: string;
  languages?: string[];
  interests?: string[];
  serviceDrafts?: Array<{
    title: string;
    description?: string;
    price: number;
    currency: 'THB';
    durationMinutes: number;
  }>;
  schedule?: {
    timeZone: 'Asia/Bangkok';
    days: Array<{
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      isAvailable: boolean;
    }>;
  };
}

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;
const MAX_SERVICE_DRAFTS = 10;
const MAX_SCHEDULE_DAYS = 7;
const VALID_LANGUAGES = new Set([
  'en', 'th', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'ar', 'pt', 'it',
]);

/** Disallow local file URIs, data URIs, and other dangerous schemes in string fields. */
const FORBIDDEN_URI_RE = /^(file|data|javascript|vbscript):/i;

export class ApplicationDataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationDataValidationError';
  }
}

/**
 * Validate and bound structured application data.
 * Returns the cleaned object or throws ApplicationDataValidationError.
 *
 * Canonical contract: unknown structured keys are rejected (not silently dropped).
 * serviceDrafts require currency:"THB", schedule requires timeZone:"Asia/Bangkok",
 * exactly seven explicit weekdays covering 0..6, one interval per weekday,
 * integer dayOfWeek, finite price.
 */
export function validateApplicationData(
  raw: unknown,
): ApplicationData | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApplicationDataValidationError('applicationData must be an object');
  }
  const input = raw as Record<string, unknown>;
  const out: ApplicationData = {};

  // Reject unknown top-level structured keys
  const allowedKeys = new Set([
    'firstName', 'lastName', 'bio', 'location', 'languages', 'interests',
    'serviceDrafts', 'schedule',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ApplicationDataValidationError(`applicationData contains unknown key: ${key}`);
    }
  }

  if (input.firstName !== undefined) {
    out.firstName = boundedString(input.firstName, 'firstName', MAX_STRING_LENGTH);
  }
  if (input.lastName !== undefined) {
    out.lastName = boundedString(input.lastName, 'lastName', MAX_STRING_LENGTH);
  }
  if (input.bio !== undefined) {
    out.bio = boundedString(input.bio, 'bio', MAX_STRING_LENGTH);
  }
  if (input.location !== undefined) {
    out.location = boundedString(input.location, 'location', MAX_STRING_LENGTH);
  }
  if (input.languages !== undefined) {
    const arr = boundedArray(input.languages, 'languages', MAX_ARRAY_LENGTH);
    for (const lang of arr) {
      if (!VALID_LANGUAGES.has(lang)) {
        throw new ApplicationDataValidationError(`languages contains unsupported code: ${lang}`);
      }
    }
    out.languages = arr;
  }
  if (input.interests !== undefined) {
    out.interests = boundedArray(input.interests, 'interests', MAX_ARRAY_LENGTH);
  }
  if (input.serviceDrafts !== undefined) {
    if (!Array.isArray(input.serviceDrafts)) {
      throw new ApplicationDataValidationError('serviceDrafts must be an array');
    }
    if (input.serviceDrafts.length > MAX_SERVICE_DRAFTS) {
      throw new ApplicationDataValidationError(
        `serviceDrafts exceeds maximum of ${MAX_SERVICE_DRAFTS}`,
      );
    }
    out.serviceDrafts = input.serviceDrafts.map((draft: unknown, i: number) => {
      if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}] must be an object`);
      }
      const d = draft as Record<string, unknown>;

      // Reject unknown keys in service draft
      const allowedDraftKeys = new Set(['title', 'description', 'price', 'currency', 'durationMinutes']);
      for (const dk of Object.keys(d)) {
        if (!allowedDraftKeys.has(dk)) {
          throw new ApplicationDataValidationError(`serviceDrafts[${i}] contains unknown key: ${dk}`);
        }
      }

      const title = boundedString(d.title, `serviceDrafts[${i}].title`, MAX_STRING_LENGTH);

      // price is required and must be finite, non-negative
      if (d.price === undefined || d.price === null) {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}].price is required`);
      }
      if (typeof d.price !== 'number' || !Number.isFinite(d.price) || d.price < 0 || d.price > 1_000_000) {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}].price must be a finite non-negative number (0–1000000)`);
      }

      // currency must be THB
      if (d.currency !== 'THB') {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}].currency must be "THB"`);
      }

      // durationMinutes is required and must be integer 30–1439.
      // Core guide booking does not support overnight or sub-30-minute slots.
      if (d.durationMinutes === undefined || d.durationMinutes === null) {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}].durationMinutes is required`);
      }
      if (typeof d.durationMinutes !== 'number' || !Number.isInteger(d.durationMinutes) || d.durationMinutes < 30 || d.durationMinutes > 1439) {
        throw new ApplicationDataValidationError(`serviceDrafts[${i}].durationMinutes must be an integer 30–1439`);
      }

      const result: ApplicationData['serviceDrafts'] extends (infer U)[] | undefined ? U : never = {
        title,
        price: d.price,
        currency: 'THB',
        durationMinutes: d.durationMinutes,
      } as any;
      if (d.description !== undefined) {
        (result as any).description = boundedString(d.description, `serviceDrafts[${i}].description`, MAX_STRING_LENGTH);
      }
      return result;
    });
  }
  if (input.schedule !== undefined) {
    if (typeof input.schedule !== 'object' || input.schedule === null || Array.isArray(input.schedule)) {
      throw new ApplicationDataValidationError('schedule must be an object');
    }
    const sched = input.schedule as Record<string, unknown>;

    // Reject unknown keys in schedule
    const allowedSchedKeys = new Set(['timeZone', 'days']);
    for (const sk of Object.keys(sched)) {
      if (!allowedSchedKeys.has(sk)) {
        throw new ApplicationDataValidationError(`schedule contains unknown key: ${sk}`);
      }
    }

    // timeZone must be Asia/Bangkok
    if (sched.timeZone !== 'Asia/Bangkok') {
      throw new ApplicationDataValidationError('schedule.timeZone must be "Asia/Bangkok"');
    }

    if (sched.days === undefined) {
      throw new ApplicationDataValidationError('schedule.days is required');
    }
    if (!Array.isArray(sched.days)) {
      throw new ApplicationDataValidationError('schedule.days must be an array');
    }
    if (sched.days.length !== MAX_SCHEDULE_DAYS) {
      throw new ApplicationDataValidationError(
        `schedule.days must contain exactly ${MAX_SCHEDULE_DAYS} entries covering days 0-6`,
      );
    }

    const seenDays = new Set<number>();
    const days = sched.days.map((day: unknown, i: number) => {
      if (typeof day !== 'object' || day === null || Array.isArray(day)) {
        throw new ApplicationDataValidationError(`schedule.days[${i}] must be an object`);
      }
      const d = day as Record<string, unknown>;

      // Reject unknown keys in day
      const allowedDayKeys = new Set(['dayOfWeek', 'startTime', 'endTime', 'isAvailable']);
      for (const dk of Object.keys(d)) {
        if (!allowedDayKeys.has(dk)) {
          throw new ApplicationDataValidationError(`schedule.days[${i}] contains unknown key: ${dk}`);
        }
      }

      if (typeof d.dayOfWeek !== 'number' || !Number.isInteger(d.dayOfWeek) || d.dayOfWeek < 0 || d.dayOfWeek > 6) {
        throw new ApplicationDataValidationError(`schedule.days[${i}].dayOfWeek must be integer 0–6`);
      }
      if (seenDays.has(d.dayOfWeek)) {
        throw new ApplicationDataValidationError(`schedule.days[${i}].dayOfWeek ${d.dayOfWeek} is duplicated`);
      }
      seenDays.add(d.dayOfWeek);

      const startTime = boundedString(d.startTime, `schedule.days[${i}].startTime`, 10);
      const endTime = boundedString(d.endTime, `schedule.days[${i}].endTime`, 10);
      if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) {
        throw new ApplicationDataValidationError(`schedule.days[${i}] times must be HH:mm format`);
      }
      const isAvailable = d.isAvailable !== false;
      return { dayOfWeek: d.dayOfWeek, startTime, endTime, isAvailable };
    });

    for (let dayOfWeek = 0; dayOfWeek < MAX_SCHEDULE_DAYS; dayOfWeek += 1) {
      if (!seenDays.has(dayOfWeek)) {
        throw new ApplicationDataValidationError(
          `schedule.days must include explicit dayOfWeek ${dayOfWeek}`,
        );
      }
    }

    out.schedule = { timeZone: 'Asia/Bangkok', days };
  }

  return out;
}

/** HH:mm time format validator. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ApplicationDataValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApplicationDataValidationError(`${field} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new ApplicationDataValidationError(`${field} exceeds maximum length of ${max}`);
  }
  if (FORBIDDEN_URI_RE.test(trimmed)) {
    throw new ApplicationDataValidationError(`${field} must not contain local file or data URIs`);
  }
  return trimmed;
}

function boundedArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) {
    throw new ApplicationDataValidationError(`${field} must be an array`);
  }
  if (value.length > max) {
    throw new ApplicationDataValidationError(`${field} exceeds maximum of ${max}`);
  }
  return value.map((item: unknown, i: number) => {
    if (typeof item !== 'string') {
      throw new ApplicationDataValidationError(`${field}[${i}] must be a string`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new ApplicationDataValidationError(`${field}[${i}] must not be empty`);
    }
    if (FORBIDDEN_URI_RE.test(trimmed)) {
      throw new ApplicationDataValidationError(`${field}[${i}] must not contain local file or data URIs`);
    }
    return trimmed;
  });
}
