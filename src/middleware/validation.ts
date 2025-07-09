import type { Context, Next } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ValidationError } from '../utils/errors';
import { jsonError, formatValidationErrors } from '../utils/response';
import type { Env, Variables } from '../index';

/**
 * Enhanced validation middleware with custom error handling
 */
export function validateRequest(schema: {
  json?: z.ZodSchema;
  query?: z.ZodSchema;
  param?: z.ZodSchema;
  header?: z.ZodSchema;
}) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    try {
      // Validate JSON body
      if (schema.json) {
        const body = await c.req.json().catch(() => ({}));
        const result = schema.json.safeParse(body);
        if (!result.success) {
          const errors = formatValidationErrors(result.error.errors);
          return jsonError(c, 'Validation failed', 'Invalid request body', 400);
        }
        c.set('validatedJson', result.data);
      }

      // Validate query parameters
      if (schema.query) {
        const query = c.req.query();
        const result = schema.query.safeParse(query);
        if (!result.success) {
          const errors = formatValidationErrors(result.error.errors);
          return jsonError(c, 'Validation failed', 'Invalid query parameters', 400);
        }
        c.set('validatedQuery', result.data);
      }

      // Validate path parameters
      if (schema.param) {
        const params = c.req.param();
        const result = schema.param.safeParse(params);
        if (!result.success) {
          const errors = formatValidationErrors(result.error.errors);
          return jsonError(c, 'Validation failed', 'Invalid path parameters', 400);
        }
        c.set('validatedParam', result.data);
      }

      // Validate headers
      if (schema.header) {
        const headers = Object.fromEntries(
          Array.from(c.req.raw.headers.entries())
        );
        const result = schema.header.safeParse(headers);
        if (!result.success) {
          const errors = formatValidationErrors(result.error.errors);
          return jsonError(c, 'Validation failed', 'Invalid headers', 400);
        }
        c.set('validatedHeaders', result.data);
      }

      await next();
    } catch (error) {
      console.error('Validation middleware error:', error);
      return jsonError(c, 'Validation error', 'Request validation failed', 400);
    }
  };
}

/**
 * Validate file uploads
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
        await next();
        return;
      }

      // Parse form data
      const formData = await c.req.formData();
      const files: File[] = [];
      
      for (const [key, value] of formData.entries()) {
        if (typeof File !== 'undefined' && typeof value !== 'string' && (value as any) instanceof File) {
          files.push(value as File);
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
      await next();
    } catch (error) {
      console.error('File validation error:', error);
      return jsonError(c, 'File validation failed', 'Invalid file upload', 400);
    }
  };
}

/**
 * Validate pagination parameters
 */
export function validatePagination() {
  const schema = z.object({
    page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
    limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 20),
    sort: z.string().optional(),
    order: z.enum(['asc', 'desc']).optional().default('desc')
  }).refine(data => data.page > 0, {
    message: 'Page must be greater than 0',
    path: ['page']
  }).refine(data => data.limit > 0 && data.limit <= 100, {
    message: 'Limit must be between 1 and 100',
    path: ['limit']
  });

  return validateRequest({ query: schema });
}

/**
 * Validate UUID parameters
 */
export function validateUUID(paramName = 'id') {
  const schema = z.object({
    [paramName]: z.string().uuid(`Invalid ${paramName} format`)
  });

  return validateRequest({ param: schema });
}

/**
 * Validate search parameters
 */
export function validateSearch() {
  const schema = z.object({
    q: z.string().min(1, 'Search query is required').max(100, 'Search query too long'),
    category: z.string().optional(),
    region: z.string().optional(),
    minPrice: z.string().optional().transform(val => val ? parseFloat(val) : undefined),
    maxPrice: z.string().optional().transform(val => val ? parseFloat(val) : undefined),
    language: z.string().optional(),
    page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
    limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 20)
  }).refine(data => {
    if (data.minPrice && data.maxPrice) {
      return data.maxPrice >= data.minPrice;
    }
    return true;
  }, {
    message: 'Maximum price must be greater than or equal to minimum price',
    path: ['maxPrice']
  });

  return validateRequest({ query: schema });
}

/**
 * Validate date range parameters
 */
export function validateDateRange() {
  const schema = z.object({
    startDate: z.string().datetime('Invalid start date format'),
    endDate: z.string().datetime('Invalid end date format')
  }).refine(data => {
    const start = new Date(data.startDate);
    const end = new Date(data.endDate);
    return end > start;
  }, {
    message: 'End date must be after start date',
    path: ['endDate']
  });

  return validateRequest({ query: schema });
}

/**
 * Validate coordinates (latitude, longitude)
 */
export function validateCoordinates() {
  const schema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius: z.number().min(0).max(100).optional() // km
  });

  return validateRequest({ query: schema });
}

/**
 * Sanitize and validate HTML content
 */
export function validateHtmlContent() {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    try {
      const body = await c.req.json();
      
      // Sanitize HTML fields
      const htmlFields = ['content', 'description', 'bio', 'comment'];
      
      for (const field of htmlFields) {
        if (body[field] && typeof body[field] === 'string') {
          // Basic HTML sanitization (remove script tags, etc.)
          body[field] = sanitizeHtml(body[field]);
        }
      }
      
      c.set('sanitizedBody', body);
      await next();
    } catch (error) {
      console.error('HTML validation error:', error);
      return jsonError(c, 'Content validation failed', 'Invalid content format', 400);
    }
  };
}

/**
 * Basic HTML sanitization
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

/**
 * Validate API version
 */
export function validateApiVersion() {
  const schema = z.object({
    'x-api-version': z.string().optional().default('1.0'),
    'accept': z.string().optional()
  });

  return validateRequest({ header: schema });
}

/**
 * Validate content type
 */
export function validateContentType(allowedTypes: string[]) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const contentType = c.req.header('Content-Type');
    
    if (!contentType) {
      return jsonError(c, 'Content-Type header required', 'Missing Content-Type', 400);
    }

    const baseType = contentType ? contentType.split(';')[0].trim() : '';
    const allowed = Array.isArray(allowedTypes) ? allowedTypes : [];
    if (!allowed.includes(baseType)) {
      return jsonError(c, 'Invalid Content-Type', `Allowed types: ${allowed.join(', ')}`, 400);
    }
  };
}
