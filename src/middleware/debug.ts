import type { Context, Next } from 'hono';
import type { Env, Variables } from '../index';

/**
 * Debug middleware to log request and response details
 */
export function debugLogger() {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    // Store request start time
    const start = Date.now();
    
    // Generate a unique request ID
    const requestId = crypto.randomUUID().substring(0, 8);
    
    // Log request details
    const { method, url } = c.req;
    const headers = Object.fromEntries(
      [...c.req.raw.headers.entries()]
        .filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase()))
    );
    
    console.log(`[DEBUG ${requestId}] Request: ${method} ${url}`);
    console.log(`[DEBUG ${requestId}] Request Headers:`, headers);
    
    try {
      // Check if request has a body and log it
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        try {
          const clone = c.req.raw.clone();
          const bodyText = await clone.text();
          try {
            const bodyJson = JSON.parse(bodyText);
            console.log(`[DEBUG ${requestId}] Request Body (JSON):`, bodyJson);
          } catch {
            console.log(`[DEBUG ${requestId}] Request Body (Text):`, bodyText);
          }
        } catch (err) {
          console.log(`[DEBUG ${requestId}] Unable to read request body: ${err}`);
        }
      }
      
      // Continue with request processing
      await next();
      
      // Log response time
      const ms = Date.now() - start;
      console.log(`[DEBUG ${requestId}] Response Status: ${c.res.status}`);
      console.log(`[DEBUG ${requestId}] Response Time: ${ms}ms`);
      
      // Log response headers
      const responseHeaders = Object.fromEntries(c.res.headers.entries());
      console.log(`[DEBUG ${requestId}] Response Headers:`, responseHeaders);
      
      // Attempt to log response body for JSON responses
      if (c.res.headers.get('content-type')?.includes('application/json')) {
        try {
          // Clone the response to avoid consuming it
          const resClone = c.res.clone();
          const responseText = await resClone.text();
          try {
            const responseJson = JSON.parse(responseText);
            console.log(`[DEBUG ${requestId}] Response Body:`, responseJson);
          } catch {
            console.log(`[DEBUG ${requestId}] Response Body (Text):`, responseText);
          }
        } catch (err) {
          console.log(`[DEBUG ${requestId}] Unable to read response body: ${err}`);
        }
      }
      
    } catch (error) {
      // Log any errors
      console.error(`[DEBUG ${requestId}] Error:`, error);
      throw error;
    }
  };
}
