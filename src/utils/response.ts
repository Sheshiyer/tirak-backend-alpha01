import type { Context } from 'hono';
import type { ApiResponse, PaginationResponse } from '../types/api';

/**
 * Standardized response formatting utilities
 */

/**
 * Create a successful response
 */
export function successResponse<T>(data: T, message?: string): ApiResponse<T> {
  return {
    success: true,
    data,
    ...(message && { message })
  };
}

/**
 * Create an error response
 */
export function errorResponse(error: string, message?: string): ApiResponse {
  return {
    success: false,
    error,
    ...(message && { message })
  };
}

/**
 * Create a paginated response
 */
export function paginatedResponse<T>(
  data: T[],
  pagination: PaginationResponse,
  message?: string
): ApiResponse<{ items: T[]; pagination: PaginationResponse }> {
  return {
    success: true,
    data: {
      items: data,
      pagination
    },
    ...(message && { message })
  };
}

/**
 * Send JSON response with proper headers
 */
export function jsonResponse(c: Context, data: any, status: number = 200): Response {
  return c.json(data, status as any, {
    'Content-Type': 'application/json',
    'X-Response-Time': Date.now().toString(),
    'X-API-Version': '1.0'
  });
}

/**
 * Send successful JSON response
 */
export function jsonSuccess<T>(c: Context, data: T, message?: string, status = 200): Response {
  return jsonResponse(c, successResponse(data, message), status);
}

/**
 * Send error JSON response
 */
export function jsonError(c: Context, error: string, message?: string, status = 400): Response {
  return jsonResponse(c, errorResponse(error, message), status);
}

/**
 * Send paginated JSON response
 */
export function jsonPaginated<T>(
  c: Context,
  data: T[],
  pagination: PaginationResponse,
  message?: string,
  status = 200
): Response {
  return jsonResponse(c, paginatedResponse(data, pagination, message), status);
}

/**
 * Create pagination metadata
 */
export function createPagination(
  page: number,
  limit: number,
  total: number
): PaginationResponse {
  const totalPages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    totalPages
  };
}

/**
 * Calculate pagination offset
 */
export function calculateOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * Validate pagination parameters
 */
export function validatePagination(page: number, limit: number): { page: number; limit: number } {
  const validatedPage = Math.max(1, Math.floor(page));
  const validatedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  
  return {
    page: validatedPage,
    limit: validatedLimit
  };
}

/**
 * Create response with cache headers
 */
export function cachedResponse(
  c: Context,
  data: any,
  maxAge: number,
  status: number = 200
): Response {
  return c.json(data, status as any, {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Response-Time': Date.now().toString()
  });
}

/**
 * Create response with no-cache headers
 */
export function noCacheResponse(c: Context, data: any, status: number = 200): Response {
  return c.json(data, status as any, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Response-Time': Date.now().toString()
  });
}

/**
 * Create response for file downloads
 */
export function fileResponse(
  c: Context,
  fileData: ArrayBuffer | Uint8Array,
  fileName: string,
  contentType: string
): Response {
  return new Response(fileData, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': fileData.byteLength.toString()
    }
  });
}

/**
 * Create response for streaming data
 */
export function streamResponse(
  c: Context,
  stream: ReadableStream,
  contentType = 'application/octet-stream'
): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked'
    }
  });
}

/**
 * Create redirect response
 */
export function redirectResponse(c: Context, url: string, permanent = false): Response {
  return c.redirect(url, permanent ? 301 : 302);
}

/**
 * Create response with custom headers
 */
export function customResponse(
  c: Context,
  data: any,
  headers: Record<string, string>,
  status: number = 200
): Response {
  return c.json(data, status as any, {
    'Content-Type': 'application/json',
    ...headers
  });
}

/**
 * Format validation errors for response
 */
export function formatValidationErrors(errors: any[]): any {
  return errors.map(error => ({
    field: error.path?.join('.') || 'unknown',
    message: error.message,
    code: error.code
  }));
}

/**
 * Create health check response
 */
export function healthResponse(c: Context, checks: Record<string, boolean>): Response {
  const allHealthy = Object.values(checks).every(Boolean);
  const status = allHealthy ? 200 : 503;
  
  return jsonResponse(c, {
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks
  }, status);
}

/**
 * Create API documentation response
 */
export function apiDocsResponse(c: Context, docs: any): Response {
  return jsonResponse(c, {
    name: 'Tirak API',
    version: '1.0.0',
    description: 'Tirak companion booking platform API',
    documentation: docs,
    timestamp: new Date().toISOString()
  });
}

/**
 * Create rate limit response
 */
export function rateLimitResponse(
  c: Context,
  limit: number,
  remaining: number,
  resetTime: number
): Response {
  return c.json(
    errorResponse('Rate limit exceeded', 'Too many requests'),
    429,
    {
      'X-RateLimit-Limit': limit.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': resetTime.toString(),
      'Retry-After': Math.ceil((resetTime - Date.now()) / 1000).toString()
    }
  );
}

/**
 * Create WebSocket upgrade response
 */
export function websocketResponse(websocket: WebSocket): Response {
  return new Response(null, {
    status: 101,
    webSocket: websocket
  });
}

/**
 * Create CORS preflight response
 */
export function corsPreflightResponse(c: Context): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

/**
 * Add security headers to response
 */
export function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-XSS-Protection', '1; mode=block');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy', "default-src 'self'");
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Create response with request ID for tracing
 */
export function tracedResponse(c: Context, data: any, status = 200): Response {
  const requestId = c.get('requestId') || crypto.randomUUID();
  
  return c.json(data, status, {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    'X-Response-Time': Date.now().toString()
  });
}

/**
 * Create response for bulk operations
 */
export function bulkResponse<T>(
  c: Context,
  results: Array<{ success: boolean; data?: T; error?: string }>,
  message?: string
): Response {
  const successCount = results.filter(r => r.success).length;
  const errorCount = results.length - successCount;
  
  return jsonResponse(c, {
    success: errorCount === 0,
    summary: {
      total: results.length,
      successful: successCount,
      failed: errorCount
    },
    results,
    ...(message && { message })
  });
}

/**
 * Create response for async operations
 */
export function asyncOperationResponse(
  c: Context,
  operationId: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  result?: any
): Response {
  return jsonResponse(c, {
    operationId,
    status,
    timestamp: new Date().toISOString(),
    ...(result && { result })
  }, status === 'pending' ? 202 : 200);
}
