import type { Context, Next } from 'hono';
import { rateLimitResponse } from '../utils/response';
import type { Env, Variables } from '../index';

/**
 * Rate limiting configuration
 */
interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  max: number; // Maximum requests per window
  keyGenerator?: (c: Context) => string; // Custom key generator
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean; // Don't count failed requests
  message?: string; // Custom error message
}

/**
 * Default rate limit configurations
 */
export const rateLimitConfigs = {
  // General API rate limiting
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per 15 minutes
  },
  
  // Authentication endpoints (stricter)
  auth: {
    windowMs: 60 * 1000, // 1 minute
    max: 60, // Preview/review login flow should not lock out test accounts
    message: 'Too many authentication attempts'
  },
  
  // Password reset (very strict)
  passwordReset: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 attempts per hour
    message: 'Too many password reset attempts'
  },
  
  // OTP verification (strict)
  otpVerification: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5, // 5 attempts per 5 minutes
    message: 'Too many OTP verification attempts'
  },
  
  // File uploads
  upload: {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 uploads per minute
    message: 'Too many file uploads'
  },
  
  // Search endpoints
  search: {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 searches per minute
  },
  
  // Chat messages
  chat: {
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 messages per minute
    message: 'Too many messages sent'
  },
  
  // Admin endpoints (more permissive)
  admin: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // 500 requests per 15 minutes
  },

  // Booking endpoints
  booking: {
    windowMs: 60 * 1000, // 1 minute
    max: 120, // Booking creation triggers several mobile list/detail refetches
    message: 'Too many booking requests'
  },

  // Review endpoints
  review: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5, // 5 reviews per 5 minutes
    message: 'Too many review submissions'
  },

  // Payment endpoints
  payment: {
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 payment actions per minute
    message: 'Too many payment requests'
  },

  // Notification endpoints
  notification: {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 notification actions per minute
  }
};

/**
 * Create rate limiting middleware
 */
export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const key = config.keyGenerator ? config.keyGenerator(c) : getDefaultKey(c);
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    try {
      // Get current request count from KV
      const rateLimitKey = `ratelimit:${key}`;
      const currentData = await c.env.CACHE.get(rateLimitKey);
      
      let requests: number[] = [];
      if (currentData) {
        const parsed = JSON.parse(currentData);
        requests = parsed.requests || [];
      }
      
      // Remove old requests outside the window
      requests = requests.filter(timestamp => timestamp > windowStart);
      
      // Check if limit exceeded
      if (requests.length >= config.max) {
        const oldestRequest = Math.min(...requests);
        const resetTime = oldestRequest + config.windowMs;
        const remaining = 0;
        
        return rateLimitResponse(c, config.max, remaining, resetTime);
      }
      
      // Add current request
      requests.push(now);
      
      // Store updated data
      await c.env.CACHE.put(
        rateLimitKey,
        JSON.stringify({ requests }),
        { expirationTtl: Math.ceil(config.windowMs / 1000) }
      );
      
      // Add rate limit headers
      const remaining = config.max - requests.length;
      const resetTime = now + config.windowMs;
      
      c.header('X-RateLimit-Limit', config.max.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', Math.ceil(resetTime / 1000).toString());
      
      return await next();
      
    } catch (error) {
      console.error('Rate limiting error:', error);
      // Continue without rate limiting if there's an error
      return await next();
    }
  };
}

/**
 * Generate default rate limit key
 */
function getDefaultKey(c: Context): string {
  // Try to get user ID first
  const userId = c.get('userId');
  if (userId) {
    return `user:${userId}`;
  }
  
  // Fall back to IP address
  const ip = c.req.header('CF-Connecting-IP') || 
             c.req.header('X-Forwarded-For') || 
             c.req.header('X-Real-IP') || 
             'unknown';
  
  return `ip:${ip}`;
}

/**
 * IP-based rate limiting
 */
export function ipRateLimit(config: RateLimitConfig) {
  return rateLimit({
    ...config,
    keyGenerator: (c: Context) => {
      const ip = c.req.header('CF-Connecting-IP') || 
                 c.req.header('X-Forwarded-For') || 
                 c.req.header('X-Real-IP') || 
                 'unknown';
      return `ip:${ip}`;
    }
  });
}

/**
 * User-based rate limiting
 */
export function userRateLimit(config: RateLimitConfig) {
  return rateLimit({
    ...config,
    keyGenerator: (c: Context) => {
      const userId = c.get('userId');
      if (!userId) {
        // Fall back to IP if no user
        const ip = c.req.header('CF-Connecting-IP') || 'unknown';
        return `ip:${ip}`;
      }
      return `user:${userId}`;
    }
  });
}

/**
 * Endpoint-specific rate limiting
 */
export function endpointRateLimit(endpoint: string, config: RateLimitConfig) {
  return rateLimit({
    ...config,
    keyGenerator: (c: Context) => {
      const userId = c.get('userId');
      const ip = c.req.header('CF-Connecting-IP') || 'unknown';
      const identifier = userId ? `user:${userId}` : `ip:${ip}`;
      return `${endpoint}:${identifier}`;
    }
  });
}

/**
 * Sliding window rate limiter (more accurate)
 */
export function slidingWindowRateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const key = config.keyGenerator ? config.keyGenerator(c) : getDefaultKey(c);
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    try {
      const rateLimitKey = `sliding:${key}`;
      
      // Use a more sophisticated sliding window algorithm
      const pipeline = [
        // Remove old entries
        ['ZREMRANGEBYSCORE', rateLimitKey, '-inf', windowStart.toString()],
        // Count current entries
        ['ZCARD', rateLimitKey],
        // Add current request
        ['ZADD', rateLimitKey, now.toString(), `${now}-${Math.random()}`],
        // Set expiration
        ['EXPIRE', rateLimitKey, Math.ceil(config.windowMs / 1000)]
      ];
      
      // Since we're using KV, we'll simulate this with a simpler approach
      const currentData = await c.env.CACHE.get(rateLimitKey);
      let count = 0;
      
      if (currentData) {
        const requests = JSON.parse(currentData).requests || [];
        const validRequests = requests.filter((timestamp: number) => timestamp > windowStart);
        count = validRequests.length;
        
        if (count >= config.max) {
          const resetTime = Math.min(...validRequests) + config.windowMs;
          return rateLimitResponse(c, config.max, 0, resetTime);
        }
        
        validRequests.push(now);
        await c.env.CACHE.put(
          rateLimitKey,
          JSON.stringify({ requests: validRequests }),
          { expirationTtl: Math.ceil(config.windowMs / 1000) }
        );
      } else {
        await c.env.CACHE.put(
          rateLimitKey,
          JSON.stringify({ requests: [now] }),
          { expirationTtl: Math.ceil(config.windowMs / 1000) }
        );
      }
      
      const remaining = config.max - count - 1;
      c.header('X-RateLimit-Limit', config.max.toString());
      c.header('X-RateLimit-Remaining', Math.max(0, remaining).toString());
      c.header('X-RateLimit-Reset', Math.ceil((now + config.windowMs) / 1000).toString());
      
      return await next();
      
    } catch (error) {
      console.error('Sliding window rate limiting error:', error);
      return await next();
    }
  };
}

/**
 * Burst rate limiting (allows short bursts)
 */
export function burstRateLimit(burstConfig: RateLimitConfig, sustainedConfig: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    // Check burst limit first
    const burstKey = `burst:${getDefaultKey(c)}`;
    const sustainedKey = `sustained:${getDefaultKey(c)}`;
    
    try {
      // Check burst limit (short window)
      const burstData = await c.env.CACHE.get(burstKey);
      let burstCount = 0;
      
      if (burstData) {
        const parsed = JSON.parse(burstData);
        burstCount = parsed.count || 0;
        
        if (burstCount >= burstConfig.max) {
          return rateLimitResponse(c, burstConfig.max, 0, Date.now() + burstConfig.windowMs);
        }
      }
      
      // Check sustained limit (long window)
      const sustainedData = await c.env.CACHE.get(sustainedKey);
      let sustainedCount = 0;
      
      if (sustainedData) {
        const parsed = JSON.parse(sustainedData);
        sustainedCount = parsed.count || 0;
        
        if (sustainedCount >= sustainedConfig.max) {
          return rateLimitResponse(c, sustainedConfig.max, 0, Date.now() + sustainedConfig.windowMs);
        }
      }
      
      // Update counters
      await c.env.CACHE.put(
        burstKey,
        JSON.stringify({ count: burstCount + 1 }),
        { expirationTtl: Math.ceil(burstConfig.windowMs / 1000) }
      );
      
      await c.env.CACHE.put(
        sustainedKey,
        JSON.stringify({ count: sustainedCount + 1 }),
        { expirationTtl: Math.ceil(sustainedConfig.windowMs / 1000) }
      );
      
      // Set headers based on most restrictive limit
      const burstRemaining = burstConfig.max - burstCount - 1;
      const sustainedRemaining = sustainedConfig.max - sustainedCount - 1;
      const remaining = Math.min(burstRemaining, sustainedRemaining);
      
      c.header('X-RateLimit-Limit', Math.min(burstConfig.max, sustainedConfig.max).toString());
      c.header('X-RateLimit-Remaining', Math.max(0, remaining).toString());
      
      return await next();
      
    } catch (error) {
      console.error('Burst rate limiting error:', error);
      return await next();
    }
  };
}

/**
 * Adaptive rate limiting (adjusts based on server load)
 */
export function adaptiveRateLimit(baseConfig: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    // Get server load metrics (simplified)
    const loadFactor = await getServerLoadFactor(c);
    
    // Adjust rate limit based on load
    const adjustedMax = Math.floor(baseConfig.max * (1 - loadFactor));
    
    const adaptedConfig = {
      ...baseConfig,
      max: Math.max(1, adjustedMax) // Ensure at least 1 request is allowed
    };
    
    return rateLimit(adaptedConfig)(c, next);
  };
}

/**
 * Get server load factor (0 = no load, 1 = maximum load)
 */
async function getServerLoadFactor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<number> {
  // This would integrate with actual monitoring metrics
  // For now, return a static low load
  return 0.1;
}

/**
 * Rate limiting middleware factory
 */
export function createRateLimit(type: keyof typeof rateLimitConfigs) {
  const config = rateLimitConfigs[type];
  return userRateLimit(config);
}
