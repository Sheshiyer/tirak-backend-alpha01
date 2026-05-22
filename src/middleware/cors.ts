import type { Context, Next } from 'hono';
import type { Env, Variables } from '../index';

/**
 * CORS middleware configuration
 */
interface CorsOptions {
  origin?: string | string[] | ((origin: string, c: Context) => string | null);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

/**
 * Default CORS configuration
 */
const defaultCorsOptions: CorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-API-Key',
    'X-Session-ID',
    'X-Request-ID'
  ],
  exposedHeaders: [
    'X-Total-Count',
    'X-Page-Count',
    'X-Rate-Limit-Limit',
    'X-Rate-Limit-Remaining',
    'X-Rate-Limit-Reset',
    'X-Request-ID'
  ],
  credentials: true,
  maxAge: 86400, // 24 hours
  optionsSuccessStatus: 204
};

/**
 * Create CORS middleware with custom options
 */
export function cors(options: CorsOptions = {}) {
  const config = { ...defaultCorsOptions, ...options };

  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const origin = c.req.header('Origin');
    const method = c.req.method;

    // Handle preflight requests
    if (method === 'OPTIONS') {
      return handlePreflight(c, config, origin);
    }

    // Handle actual requests
    await handleActualRequest(c, config, origin);
    return await next();
  };
}

/**
 * Handle CORS preflight requests
 */
function handlePreflight(c: Context, config: CorsOptions, origin?: string): Response {
  const headers = new Headers();

  // Set Access-Control-Allow-Origin
  const allowedOrigin = getAllowedOrigin(config.origin, origin, c);
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
  }

  // Set Access-Control-Allow-Methods
  if (config.methods) {
    headers.set('Access-Control-Allow-Methods', config.methods.join(', '));
  }

  // Set Access-Control-Allow-Headers
  const requestedHeaders = c.req.header('Access-Control-Request-Headers');
  if (requestedHeaders && config.allowedHeaders) {
    const allowedHeaders = config.allowedHeaders.filter(header =>
      requestedHeaders.toLowerCase().includes(header.toLowerCase())
    );
    if (allowedHeaders.length > 0) {
      headers.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    }
  } else if (config.allowedHeaders) {
    headers.set('Access-Control-Allow-Headers', config.allowedHeaders.join(', '));
  }

  // Set Access-Control-Allow-Credentials
  if (config.credentials) {
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  // Set Access-Control-Max-Age
  if (config.maxAge) {
    headers.set('Access-Control-Max-Age', config.maxAge.toString());
  }

  return new Response(null, {
    status: config.optionsSuccessStatus || 204,
    headers
  });
}

/**
 * Handle actual CORS requests
 */
async function handleActualRequest(c: Context, config: CorsOptions, origin?: string) {
  // Set Access-Control-Allow-Origin
  const allowedOrigin = getAllowedOrigin(config.origin, origin, c);
  if (allowedOrigin) {
    c.header('Access-Control-Allow-Origin', allowedOrigin);
  }

  // Set Access-Control-Expose-Headers
  if (config.exposedHeaders) {
    c.header('Access-Control-Expose-Headers', config.exposedHeaders.join(', '));
  }

  // Set Access-Control-Allow-Credentials
  if (config.credentials) {
    c.header('Access-Control-Allow-Credentials', 'true');
  }
}

/**
 * Determine the allowed origin
 */
function getAllowedOrigin(
  configOrigin: string | string[] | ((origin: string, c: Context) => string | null) | undefined,
  requestOrigin: string | undefined,
  c: Context
): string | null {
  if (!configOrigin) {
    return null;
  }

  if (configOrigin === '*') {
    return '*';
  }

  if (typeof configOrigin === 'string') {
    return configOrigin === requestOrigin ? requestOrigin : null;
  }

  if (Array.isArray(configOrigin)) {
    return configOrigin.includes(requestOrigin || '') ? requestOrigin || null : null;
  }

  if (typeof configOrigin === 'function' && requestOrigin) {
    return configOrigin(requestOrigin, c);
  }

  return null;
}

/**
 * Tirak-specific CORS middleware
 */
export function tirakCors() {
  return cors({
    origin: (origin: string, c: Context<{ Bindings: Env; Variables: Variables }>) => {
      // Get allowed origins from environment
      const allowedOrigins = c.env.FRONTEND_URLS?.split(',') || [];
      
      // Allow localhost for development
      const localhostPattern = /^https?:\/\/localhost(:\d+)?$/;
      const tirakAppPattern = /^https?:\/\/.*\.tirak\.app$/;
      
      // Check if origin is allowed
      if (allowedOrigins.includes(origin) || 
          localhostPattern.test(origin) || 
          tirakAppPattern.test(origin) ||
          origin?.startsWith('tirak://')) {
        return origin;
      }
      
      return null;
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-API-Key',
      'X-Session-ID',
      'X-Request-ID',
      'X-Device-ID',
      'X-App-Version'
    ],
    exposedHeaders: [
      'X-Total-Count',
      'X-Page-Count',
      'X-Rate-Limit-Limit',
      'X-Rate-Limit-Remaining',
      'X-Rate-Limit-Reset',
      'X-Request-ID',
      'X-Response-Time'
    ],
    credentials: true,
    maxAge: 86400 // 24 hours
  });
}

/**
 * Strict CORS middleware for admin endpoints
 */
export function adminCors() {
  return cors({
    origin: (origin: string, c: Context<{ Bindings: Env; Variables: Variables }>) => {
      // Only allow admin dashboard origins
      const adminOrigins = [
        'https://admin.tirak.app',
        'https://admin-staging.tirak.app'
      ];
      
      // Allow localhost for development
      if (c.env.ENVIRONMENT === 'development' && origin?.includes('localhost')) {
        return origin;
      }
      
      return adminOrigins.includes(origin) ? origin : null;
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Admin-Token'
    ],
    credentials: true,
    maxAge: 3600 // 1 hour
  });
}

/**
 * API-only CORS middleware (no credentials)
 */
export function apiCors() {
  return cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'X-API-Key',
      'X-Requested-With'
    ],
    credentials: false,
    maxAge: 86400
  });
}

/**
 * WebSocket CORS middleware
 */
export function websocketCors() {
  return cors({
    origin: (origin: string, c: Context<{ Bindings: Env; Variables: Variables }>) => {
      const allowedOrigins = c.env.FRONTEND_URLS?.split(',') || [];
      
      if (allowedOrigins.includes(origin) || 
          origin?.includes('localhost') ||
          origin?.startsWith('tirak://')) {
        return origin;
      }
      
      return null;
    },
    methods: ['GET'],
    allowedHeaders: [
      'Authorization',
      'Sec-WebSocket-Protocol',
      'Sec-WebSocket-Extensions'
    ],
    credentials: true
  });
}

/**
 * Development CORS middleware (permissive)
 */
export function devCors() {
  return cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['*'],
    exposedHeaders: ['*'],
    credentials: true,
    maxAge: 86400
  });
}

/**
 * Production CORS middleware (restrictive)
 */
export function prodCors() {
  return cors({
    origin: (origin: string, c: Context<{ Bindings: Env; Variables: Variables }>) => {
      const allowedOrigins = c.env.FRONTEND_URLS?.split(',') || [];
      return allowedOrigins.includes(origin) ? origin : null;
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With'
    ],
    exposedHeaders: [
      'X-Rate-Limit-Limit',
      'X-Rate-Limit-Remaining',
      'X-Rate-Limit-Reset'
    ],
    credentials: true,
    maxAge: 86400
  });
}

/**
 * Environment-aware CORS middleware
 */
export function environmentCors() {
  return (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const environment = c.env.ENVIRONMENT;
    
    switch (environment) {
      case 'development':
        return devCors()(c, next);
      case 'staging':
        return tirakCors()(c, next);
      case 'production':
        return prodCors()(c, next);
      default:
        return tirakCors()(c, next);
    }
  };
}
