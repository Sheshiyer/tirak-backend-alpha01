import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyJWT, hasPermission } from '../utils/auth';
import { getUserById } from '../utils/database';
import { AuthenticationError, AuthorizationError } from '../utils/errors';
import { jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

/**
 * Authentication middleware - verifies JWT token
 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  try {
    const authHeader = c.req.header('Authorization');
    const cookieToken = getCookie(c, 'auth-token');
    
    const token = authHeader?.replace('Bearer ', '') || cookieToken;
    
    if (!token) {
      throw new AuthenticationError('No authentication token provided');
    }

    // Verify JWT token
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    
    // Get user from database to ensure they still exist and are active
    const user = await getUserById(payload.sub, c.env.DB);
    
    if (!user) {
      throw new AuthenticationError('User not found');
    }
    
    if (user.status !== 'active') {
      throw new AuthenticationError('Account is not active');
    }

    // Store user info in context
    c.set('user', user);
    c.set('userId', user.id);
    c.set('userType', user.userType);
    
    await next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return jsonError(c, error.message, 'Authentication failed', 401);
    }

    console.error('Auth middleware error:', error);
    return jsonError(c, 'Authentication failed', 'Invalid token', 401);
  }
}

/**
 * Optional authentication middleware - doesn't fail if no token
 */
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  try {
    const authHeader = c.req.header('Authorization');
    const cookieToken = getCookie(c, 'auth-token');
    
    const token = authHeader?.replace('Bearer ', '') || cookieToken;
    
    if (token) {
      const payload = await verifyJWT(token, c.env.JWT_SECRET);
      const user = await getUserById(payload.sub, c.env.DB);
      
      if (user && user.status === 'active') {
        c.set('user', user);
        c.set('userId', user.id);
        c.set('userType', user.userType);
      }
    }
    
    await next();
  } catch (error) {
    // Silently continue without authentication
    await next();
  }
}

/**
 * Role-based authorization middleware
 */
export function requireRole(...allowedRoles: string[]) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const userType = c.get('userType');
    
    if (!userType) {
      return jsonError(c, 'Authentication required', 'Please log in', 401);
    }
    
    if (!allowedRoles.includes(userType)) {
      return jsonError(c, 'Insufficient permissions', 'Access denied', 403);
    }
    
    await next();
  };
}

/**
 * Permission-based authorization middleware
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const userType = c.get('userType');
    
    if (!userType) {
      return jsonError(c, 'Authentication required', 'Please log in', 401);
    }
    
    if (!hasPermission(userType, resource, action)) {
      return jsonError(c, 'Insufficient permissions', `Cannot ${action} ${resource}`, 403);
    }
    
    await next();
  };
}

/**
 * Admin-only middleware
 */
export async function adminOnly(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const userType = c.get('userType');
  
  if (userType !== 'admin') {
    return jsonError(c, 'Admin access required', 'Access denied', 403);
  }
  
  await next();
}

/**
 * Supplier-only middleware
 */
export async function supplierOnly(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const userType = c.get('userType');

  if (userType !== 'supplier') {
    return jsonError(c, 'Supplier access required', 'Access denied', 403);
  }

  await next();
}

/**
 * Customer-only middleware
 */
export async function customerOnly(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const userType = c.get('userType');

  if (userType !== 'customer') {
    return jsonError(c, 'Customer access required', 'Access denied', 403);
  }

  await next();
}

/**
 * Resource ownership middleware - ensures user owns the resource
 */
export function requireOwnership(resourceIdParam = 'id') {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const userId = c.get('userId');
    const userType = c.get('userType');
    const resourceId = c.req.param(resourceIdParam);
    
    // Admin can access any resource
    if (userType === 'admin') {
      await next();
      return;
    }
    
    // For other users, check ownership
    if (userId !== resourceId) {
      return jsonError(c, 'Access denied', 'You can only access your own resources', 403);
    }
    
    await next();
  };
}

/**
 * Verified user middleware - requires phone/email verification
 */
export async function requireVerification(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const user = c.get('user');
  
  if (!user) {
    return jsonError(c, 'Authentication required', 'Please log in', 401);
  }
  
  if (!user.phoneVerified) {
    return jsonError(c, 'Phone verification required', 'Please verify your phone number', 403);
  }
  
  await next();
}

/**
 * Active subscription middleware for suppliers
 */
export async function requireActiveSubscription(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const userId = c.get('userId');
  const userType = c.get('userType');
  
  if (userType !== 'supplier') {
    await next();
    return;
  }
  
  // Check supplier subscription status
  const supplier = await c.env.DB.prepare(`
    SELECT subscription_status, subscription_expires_at 
    FROM supplier_profiles 
    WHERE user_id = ?
  `).bind(userId).first();
  
  if (!supplier) {
    return jsonError(c, 'Supplier profile not found', 'Please complete your profile', 404);
  }
  
  if (supplier.subscription_status !== 'active') {
    return jsonError(c, 'Active subscription required', 'Please upgrade your subscription', 403);
  }
  
  // Check if subscription has expired
  if (supplier.subscription_expires_at && new Date(supplier.subscription_expires_at) < new Date()) {
    return jsonError(c, 'Subscription expired', 'Please renew your subscription', 403);
  }
  
  await next();
}

/**
 * Session validation middleware
 */
export async function validateSession(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const userId = c.get('userId');
  
  if (!userId) {
    await next();
    return;
  }
  
  // Check if session exists and is valid
  const sessionId = c.req.header('X-Session-ID');
  
  if (sessionId) {
    const session = await c.env.SESSIONS.get(`session:${userId}:${sessionId}`);
    
    if (!session) {
      return jsonError(c, 'Invalid session', 'Please log in again', 401);
    }
    
    // Update last active time
    const sessionData = JSON.parse(session);
    sessionData.lastActiveAt = new Date().toISOString();
    
    await c.env.SESSIONS.put(
      `session:${userId}:${sessionId}`,
      JSON.stringify(sessionData),
      { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
    );
  }
  
  await next();
}

/**
 * API key authentication middleware (for external integrations)
 */
export async function apiKeyAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const apiKey = c.req.header('X-API-Key');
  
  if (!apiKey) {
    return jsonError(c, 'API key required', 'Please provide a valid API key', 401);
  }
  
  // Validate API key (this would check against a database of valid keys)
  const isValidKey = await validateApiKey(apiKey, c.env.DB);
  
  if (!isValidKey) {
    return jsonError(c, 'Invalid API key', 'The provided API key is not valid', 401);
  }
  
  await next();
}

/**
 * Helper function to validate API key
 */
async function validateApiKey(apiKey: string, db: D1Database): Promise<boolean> {
  // This would check against a database table of API keys
  // For now, return false as we haven't implemented API key management
  return false;
}

/**
 * Request ID middleware for tracing
 */
export async function requestIdMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
}

/**
 * User context enrichment middleware
 */
export async function enrichUserContext(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const user = c.get('user');
  
  if (user) {
    // Add additional user context based on user type
    if (user.userType === 'supplier') {
      const supplierProfile = await c.env.DB.prepare(`
        SELECT verification_status, subscription_status 
        FROM supplier_profiles 
        WHERE user_id = ?
      `).bind(user.id).first();
      
      c.set('supplierProfile', supplierProfile);
    } else if (user.userType === 'customer') {
      const customerProfile = await c.env.DB.prepare(`
        SELECT loyalty_points 
        FROM customer_profiles 
        WHERE user_id = ?
      `).bind(user.id).first();
      
      c.set('customerProfile', customerProfile);
    }
  }
  
  await next();
}


