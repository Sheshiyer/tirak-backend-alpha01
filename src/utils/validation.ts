import { z } from 'zod';
import { jsonError } from './response';
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../index';

/**
 * Common validation schemas
 */

// User registration schema
export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  phone: z.string().min(10, 'Phone number must be at least 10 digits'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  userType: z.enum(['customer', 'supplier', 'admin', 'companion'], {
    errorMap: () => ({ message: 'User type must be either customer, supplier, admin or companion' })
  }),
  preferredLanguage: z.enum(['en', 'th']).default('en')
});

// User login schema
export const loginSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required'),
  password: z.string().min(1, 'Password is required'),
  deviceId: z.string().optional()
});

// Phone verification schema
export const phoneVerificationSchema = z.object({
  phone: z.string().min(10, 'Valid phone number required'),
  otp: z.string().length(6, 'OTP must be 6 digits')
});

// Password reset request schema
export const passwordResetRequestSchema = z.object({
  identifier: z.string().min(1, 'Email or phone is required')
});

// Password reset schema
export const passwordResetSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters')
});

// Profile update schema
export const profileUpdateSchema = z.object({
  displayName: z.string().min(1, 'Display name is required').max(100, 'Display name too long').optional(),
  bio: z.string().max(500, 'Bio too long').optional(),
  preferredLanguage: z.enum(['en', 'th']).optional(),
  profileImage: z.string().url('Invalid image URL').optional()
});

// Supplier profile schema
export const supplierProfileSchema = z.object({
  displayName: z.string().min(1, 'Display name is required').max(100, 'Display name too long'),
  bio: z.string().max(1000, 'Bio too long').optional(),
  categories: z.array(z.string()).min(1, 'At least one category is required').max(10, 'Too many categories'),
  regions: z.array(z.string()).min(1, 'At least one region is required').max(20, 'Too many regions'),
  spokenLanguages: z.array(z.string()).min(1, 'At least one language is required').max(10, 'Too many languages'),
  profileImages: z.array(z.string().url()).max(10, 'Too many images').optional(),
  supplierType: z.enum(['standard', 'companion']).default('standard')
});

// Service creation schema
export const serviceSchema = z.object({
  title: z.string().min(1, 'Service title is required').max(200, 'Title too long'),
  description: z.string().max(2000, 'Description too long').optional(),
  priceMin: z.number().min(0, 'Price must be positive'),
  priceMax: z.number().min(0, 'Price must be positive'),
  currency: z.string().length(3, 'Currency must be 3 characters').default('THB'),
  durationHours: z.number().min(0.5, 'Duration must be at least 30 minutes').max(24, 'Duration cannot exceed 24 hours')
}).refine(data => data.priceMax >= data.priceMin, {
  message: 'Maximum price must be greater than or equal to minimum price',
  path: ['priceMax']
});

// Companion experience schema
export const experienceSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters').max(255, 'Title too long'),
  description: z.string().min(10, 'Description must be at least 10 characters').max(2000, 'Description too long').optional(),
  durationMinutes: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  keywords: z.array(z.string()).max(20, 'Too many keywords').optional(),
  price: z.number().min(0, 'Price cannot be negative'),
  currency: z.enum(['THB', 'USD', 'EUR']).default('THB'),
  is_active: z.boolean().optional()
});

// Companion location schema
export const locationSchema = z.object({
  city: z.string().min(3, 'City must be at least 3 characters').max(100, 'City name too long'),
  region: z.string().min(3, 'Region must be at least 3 characters').max(100, 'Region name too long'),
  isPopular: z.boolean().default(false),
  description: z.string().max(500, 'Description too long').optional()
});

// Companion availability schema
export const availabilitySchema = z.object({
  dayOfWeek: z.number().min(0, 'Day must be between 0 and 6').max(6, 'Day must be between 0 and 6'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be in HH:MM format'),
  isAvailable: z.boolean()
});

// Enhanced booking schema with customer preferences
export const enhancedBookingSchema = z.object({
  companionId: z.string().uuid('Invalid companion ID'),
  serviceId: z.string().uuid('Invalid service ID').optional(),
  experienceId: z.string().uuid('Invalid experience ID').optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Start time must be in HH:MM format'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'End time must be in HH:MM format'),
  duration: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  location: z.string().max(500, 'Location too long').optional(),
  customerPreferences: z.object({
    title: z.string().max(255, 'Title too long').optional(),
    description: z.string().max(1000, 'Description too long').optional()
  }).optional(),
  specialRequests: z.string().max(1000, 'Special requests too long').optional(),
  preferredLanguage: z.string().max(50, 'Language name too long').optional(),
  groupComposition: z.string().max(255, 'Group composition too long').optional(),
  dietaryRequirements: z.string().max(500, 'Dietary requirements too long').optional(),
  paymentMethodId: z.string().uuid('Invalid payment method ID')
});

// Supplier search schema
export const supplierSearchSchema = z.object({
  region: z.string().optional(),
  category: z.string().optional(),
  priceMin: z.number().min(0).optional(),
  priceMax: z.number().min(0).optional(),
  language: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
  sortBy: z.enum(['rating', 'price', 'distance', 'created']).default('rating'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// Chat message schema
export const chatMessageSchema = z.object({
  roomId: z.string().uuid('Invalid room ID'),
  messageType: z.enum(['text', 'image'], {
    errorMap: () => ({ message: 'Message type must be text or image' })
  }),
  content: z.string().max(2000, 'Message too long').optional(),
  imageUrl: z.string().url('Invalid image URL').optional()
}).refine(data => {
  if (data.messageType === 'text' && !data.content) {
    return false;
  }
  if (data.messageType === 'image' && !data.imageUrl) {
    return false;
  }
  return true;
}, {
  message: 'Text messages must have content, image messages must have imageUrl'
});

// Booking creation schema
export const bookingSchema = z.object({
  serviceId: z.string().uuid('Invalid service ID'),
  scheduledAt: z.string().datetime('Invalid date format'),
  duration: z.number().min(30, 'Minimum duration is 30 minutes').max(1440, 'Maximum duration is 24 hours'),
  notes: z.string().max(500, 'Notes too long').optional()
});

// Review schema
export const reviewSchema = z.object({
  bookingId: z.string().uuid('Invalid booking ID'),
  rating: z.number().min(1, 'Rating must be at least 1').max(5, 'Rating cannot exceed 5'),
  comment: z.string().max(1000, 'Comment too long').optional(),
  isPublic: z.boolean().default(true)
});

// File upload schema
export const fileUploadSchema = z.object({
  fileName: z.string().min(1, 'File name is required'),
  fileSize: z.number().min(1, 'File size must be positive').max(10 * 1024 * 1024, 'File too large (max 10MB)'),
  contentType: z.string().min(1, 'Content type is required'),
  category: z.enum(['profile', 'service', 'chat', 'document']).default('profile')
});

// Pagination schema
export const paginationSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20)
});

// ID parameter schema
export const idParamSchema = z.object({
  id: z.string().uuid('Invalid ID format')
});

// Note: validateUUID and validatePagination are now exported from ../middleware/validation

/**
 * Validate file uploads
 * @deprecated Use the validateFileUpload middleware from ../middleware/validation instead
 */
export function validateFileUpload(options: {
  maxSize?: number;
  allowedTypes?: string[];
  required?: boolean;
  maxFiles?: number;
}) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    try {
      const contentType = c.req.header('Content-Type');

      if (!contentType?.includes('multipart/form-data')) {
        if (options.required) {
          return jsonError(c, 'File upload required', 'No file provided', 400);
        }
        return await next();
      }

      // Parse form data
      const formData = await c.req.formData();
      const files: any[] = [];

      for (const [key, value] of formData.entries()) {
        if (typeof value === 'object' && 'arrayBuffer' in value && 'type' in value) {
          files.push(value);
        }
      }

      if (options.required && files.length === 0) {
        return jsonError(c, 'File upload required', 'No file provided', 400);
      }

      if (options.maxFiles && files.length > options.maxFiles) {
        return jsonError(c, 'Too many files', `Maximum ${options.maxFiles} files allowed`, 400);
      }

      // Validate each file
      for (const file of files) {
        // Check file size
        if (options.maxSize && file.size > options.maxSize) {
          return jsonError(c, 'File too large', `File size exceeds ${options.maxSize} bytes`, 400);
        }

        // Check file type
        if (options.allowedTypes && !options.allowedTypes.includes(file.type)) {
          return jsonError(c, 'Invalid file type', `Allowed types: ${options.allowedTypes.join(', ')}`, 400);
        }
      }

      c.set('uploadedFiles', files);
      return await next();
    } catch (error) {
      console.error('File validation error:', error);
      return jsonError(c, 'File validation failed', 'Invalid file upload', 400);
    }
  };
}

// Analytics event schema
export const analyticsEventSchema = z.object({
  eventType: z.string().min(1, 'Event type is required'),
  properties: z.record(z.any()).optional(),
  timestamp: z.string().datetime().optional()
});

/**
 * Custom validation functions
 */

/**
 * Validate Thai phone number
 */
export function validateThaiPhone(phone: string): boolean {
  const thaiPhoneRegex = /^(\+66|0)[0-9]{8,9}$/;
  return thaiPhoneRegex.test(phone);
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): { isValid: boolean; score: number; feedback: string[] } {
  const feedback: string[] = [];
  let score = 0;

  // Length check
  if (password.length >= 8) score += 1;
  else feedback.push('Use at least 8 characters');

  if (password.length >= 12) score += 1;

  // Character variety checks
  if (/[a-z]/.test(password)) score += 1;
  else feedback.push('Include lowercase letters');

  if (/[A-Z]/.test(password)) score += 1;
  else feedback.push('Include uppercase letters');

  if (/[0-9]/.test(password)) score += 1;
  else feedback.push('Include numbers');

  if (/[^a-zA-Z0-9]/.test(password)) score += 1;
  else feedback.push('Include special characters');

  // Common patterns check
  if (!/(.)\1{2,}/.test(password)) score += 1;
  else feedback.push('Avoid repeated characters');

  return {
    isValid: score >= 4,
    score,
    feedback
  };
}

/**
 * Sanitize HTML content
 * @deprecated Use the sanitizeHtml function from ../middleware/validation instead
 * @param input The HTML string to sanitize
 * @returns The sanitized HTML string
 */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Validate and normalize email
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Validate file extension
 * @param fileName The name of the file to validate
 * @param allowedExtensions Array of allowed file extensions without the dot (e.g., ['jpg', 'png'])
 * @returns Whether the file extension is allowed
 */
export function validateFileExtension(fileName: string, allowedExtensions: string[]): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension ? allowedExtensions.includes(extension) : false;
}

/**
 * Validate image dimensions (would need actual image processing)
 */
export function validateImageDimensions(
  width: number,
  height: number,
  constraints: { maxWidth?: number; maxHeight?: number; minWidth?: number; minHeight?: number }
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (constraints.maxWidth && width > constraints.maxWidth) {
    errors.push(`Image width ${width}px exceeds maximum ${constraints.maxWidth}px`);
  }

  if (constraints.maxHeight && height > constraints.maxHeight) {
    errors.push(`Image height ${height}px exceeds maximum ${constraints.maxHeight}px`);
  }

  if (constraints.minWidth && width < constraints.minWidth) {
    errors.push(`Image width ${width}px is below minimum ${constraints.minWidth}px`);
  }

  if (constraints.minHeight && height < constraints.minHeight) {
    errors.push(`Image height ${height}px is below minimum ${constraints.minHeight}px`);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate coordinate bounds (for location-based features)
 */
export function validateCoordinates(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Note: validateDateRange is now exported from ../middleware/validation

/**
 * Validate date range helper function
 */
export function isValidDateRange(startDate: string, endDate: string): boolean {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return start <= end && !isNaN(start.getTime()) && !isNaN(end.getTime());
}

/**
 * Rate limiting validation
 * @param requests The number of requests made in the current window
 * @param windowMs The time window in milliseconds
 * @param limit The maximum number of requests allowed in the window
 * @returns Object with allowed status and reset time
 */
export function validateRateLimit(
  requests: number,
  windowMs: number,
  limit: number
): { allowed: boolean; resetTime: number } {
  const now = Date.now();
  const resetTime = now + windowMs;
  
  return {
    allowed: requests < limit,
    resetTime
  };
}
