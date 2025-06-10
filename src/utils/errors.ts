import type { Context } from 'hono';

/**
 * Custom error classes for the application
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  public readonly details: any;

  constructor(message: string, details?: any) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND_ERROR');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT_ERROR');
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_ERROR');
    this.retryAfter = retryAfter;
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed') {
    super(message, 500, 'DATABASE_ERROR', false);
  }
}

export class ExternalServiceError extends AppError {
  public readonly service: string;

  constructor(service: string, message = 'External service error') {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR', false);
    this.service = service;
  }
}

/**
 * Error handling utilities
 */

export function handleError(error: Error, c: Context): Response {
  // Log the error
  console.error('Error occurred:', {
    message: error.message,
    stack: error.stack,
    url: c.req.url,
    method: c.req.method,
    timestamp: new Date().toISOString()
  });

  // Handle known application errors
  if (error instanceof AppError) {
    const response = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && { details: error.details }),
        ...(error instanceof RateLimitError && { retryAfter: error.retryAfter })
      }
    };

    return c.json(response, error.statusCode);
  }

  // Handle Zod validation errors
  if (error.name === 'ZodError') {
    const zodError = error as any;
    const response = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: zodError.errors
      }
    };

    return c.json(response, 400);
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    const response = {
      success: false,
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Invalid or expired token'
      }
    };

    return c.json(response, 401);
  }

  // Handle unknown errors
  const response = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  };

  return c.json(response, 500);
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(fn: Function) {
  return (c: Context, next?: Function) => {
    return Promise.resolve(fn(c, next)).catch((error) => {
      return handleError(error, c);
    });
  };
}

/**
 * Create standardized error responses
 */
export function createErrorResponse(
  code: string,
  message: string,
  statusCode: number,
  details?: any
) {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details })
    }
  };
}

/**
 * Log error with context
 */
export function logError(error: Error, context: {
  userId?: string;
  action?: string;
  resource?: string;
  metadata?: any;
}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: 'error',
    message: error.message,
    stack: error.stack,
    context,
    ...(error instanceof AppError && {
      errorCode: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational
    })
  };

  console.error(JSON.stringify(logEntry));
}

/**
 * Validate and throw appropriate errors
 */
export function validateAndThrow(condition: boolean, error: AppError) {
  if (!condition) {
    throw error;
  }
}

/**
 * Assert user permissions
 */
export function assertPermission(hasPermission: boolean, resource?: string) {
  if (!hasPermission) {
    throw new AuthorizationError(
      resource ? `Insufficient permissions for ${resource}` : undefined
    );
  }
}

/**
 * Assert resource exists
 */
export function assertExists<T>(resource: T | null | undefined, name = 'Resource'): T {
  if (!resource) {
    throw new NotFoundError(name);
  }
  return resource;
}

/**
 * Assert user authentication
 */
export function assertAuthenticated(user: any) {
  if (!user) {
    throw new AuthenticationError();
  }
}

/**
 * Handle database errors
 */
export function handleDatabaseError(error: any): never {
  console.error('Database error:', error);
  
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    throw new ConflictError('Resource already exists');
  }
  
  if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    throw new ValidationError('Invalid reference to related resource');
  }
  
  throw new DatabaseError('Database operation failed');
}

/**
 * Handle external service errors
 */
export function handleExternalServiceError(service: string, error: any): never {
  console.error(`External service error (${service}):`, error);
  
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    throw new ExternalServiceError(service, `${service} is currently unavailable`);
  }
  
  if (error.response?.status === 429) {
    throw new RateLimitError(60); // Retry after 60 seconds
  }
  
  throw new ExternalServiceError(service);
}

/**
 * Sanitize error for client response
 */
export function sanitizeError(error: any): any {
  // Remove sensitive information from error responses
  const sanitized = { ...error };
  
  // Remove stack traces in production
  if (process.env.NODE_ENV === 'production') {
    delete sanitized.stack;
  }
  
  // Remove internal error details
  delete sanitized.sql;
  delete sanitized.query;
  delete sanitized.parameters;
  
  return sanitized;
}

/**
 * Error monitoring and alerting
 */
export function shouldAlert(error: Error): boolean {
  // Don't alert for operational errors (user errors)
  if (error instanceof AppError && error.isOperational) {
    return false;
  }
  
  // Alert for all system errors
  return true;
}

/**
 * Get error severity level
 */
export function getErrorSeverity(error: Error): 'low' | 'medium' | 'high' | 'critical' {
  if (error instanceof AppError) {
    if (error.statusCode >= 500) return 'high';
    if (error.statusCode >= 400) return 'medium';
    return 'low';
  }
  
  // Unknown errors are critical
  return 'critical';
}

/**
 * Format error for logging
 */
export function formatErrorForLogging(error: Error, context?: any): string {
  const errorInfo = {
    message: error.message,
    name: error.name,
    stack: error.stack,
    ...(error instanceof AppError && {
      code: error.code,
      statusCode: error.statusCode,
      isOperational: error.isOperational
    }),
    ...(context && { context })
  };
  
  return JSON.stringify(errorInfo, null, 2);
}
