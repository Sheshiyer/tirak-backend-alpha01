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
          return jsonError(c, 'Validation failed', 'Invalid request body', 400);
        }
        c.set('validatedJson', result.data);
      }

      // Validate query parameters
      if (schema.query) {
        const query = c.req.query();
        const result = schema.query.safeParse(query);
        if (!result.success) {
          return jsonError(c, 'Validation failed', 'Invalid query parameters', 400);
        }
        c.set('validatedQuery', result.data);
      }

      // Validate path parameters
      if (schema.param) {
        const params = c.req.param();
        const result = schema.param.safeParse(params);
        if (!result.success) {
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
          return jsonError(c, 'Validation failed', 'Invalid headers', 400);
        }
        c.set('validatedHeaders', result.data);
      }

      return await next();
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
        return await next();
      }

      // Parse form data
      const formData = await c.req.formData();
      const files: File[] = [];
      
      for (const [key, value] of formData.entries()) {
        if (typeof value === 'object' && value !== null && 'size' in value && 'type' in value) {
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
      return await next();
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
    pageSize: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
    sort: z.string().optional(),
    order: z.enum(['asc', 'desc']).optional().default('desc')
  }).transform(data => ({
    ...data,
    limit: data.pageSize ?? data.limit
  })).refine(data => data.page > 0, {
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
    startDate: z.string().optional(),
    endDate: z.string().optional()
  }).transform(data => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      startDate: data.startDate || thirtyDaysAgo.toISOString(),
      endDate: data.endDate || now.toISOString()
    };
  }).refine(data => {
    const start = new Date(data.startDate);
    const end = new Date(data.endDate);
    return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start;
  }, {
    message: 'Date range is invalid',
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
      return await next();
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

    const baseType = contentType.split(';')[0]?.trim() || '';
    
    if (!allowedTypes.includes(baseType)) {
      return jsonError(c, 'Invalid Content-Type', `Allowed types: ${allowedTypes.join(', ')}`, 400);
    }

    return await next();
  };
}

/**
 * Validate request size
 */
export function validateRequestSize(maxSize: number) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const contentLength = c.req.header('Content-Length');
    
    if (contentLength && parseInt(contentLength, 10) > maxSize) {
      return jsonError(c, 'Request too large', `Maximum size: ${maxSize} bytes`, 413);
    }

    return await next();
  };
}

/**
 * Validate user agent
 */
export function validateUserAgent() {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const userAgent = c.req.header('User-Agent');
    
    if (!userAgent) {
      return jsonError(c, 'User-Agent header required', 'Missing User-Agent', 400);
    }

    // Block known bad user agents
    const blockedAgents = ['bot', 'crawler', 'spider'];
    const lowerUA = userAgent.toLowerCase();
    
    if (blockedAgents.some(agent => lowerUA.includes(agent))) {
      return jsonError(c, 'Access denied', 'Automated requests not allowed', 403);
    }

    return await next();
  };
}

/**
 * Validate webhook signature
 */
export function validateWebhookSignature(secret: string) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const signature = c.req.header('X-Webhook-Signature');
    const timestamp = c.req.header('X-Webhook-Timestamp');
    
    if (!signature || !timestamp) {
      return jsonError(c, 'Invalid webhook', 'Missing signature or timestamp', 401);
    }

    // Verify timestamp is recent (within 5 minutes)
    const now = Date.now();
    const webhookTime = parseInt(timestamp, 10) * 1000;
    
    if (Math.abs(now - webhookTime) > 5 * 60 * 1000) {
      return jsonError(c, 'Invalid webhook', 'Timestamp too old', 401);
    }

    // Verify signature
    const body = await c.req.text();
    const expectedSignature = await generateWebhookSignature(body, timestamp, secret);
    
    if (signature !== expectedSignature) {
      return jsonError(c, 'Invalid webhook', 'Invalid signature', 401);
    }

    return await next();
  };
}

/**
 * Generate webhook signature
 */
async function generateWebhookSignature(body: string, timestamp: string, secret: string): Promise<string> {
  const payload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
