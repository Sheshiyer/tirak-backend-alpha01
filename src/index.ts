import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { supplierRoutes } from './routes/suppliers';
import { customerRoutes } from './routes/customers';
import { uploadRoutes } from './routes/uploads';
import { publicRoutes } from './routes/public';
import { chatRoutes } from './routes/chat';
import { adminRoutes } from './routes/admin';
import { bookingRoutes } from './routes/bookings';
import { reviewRoutes } from './routes/reviews';
import { paymentRoutes } from './routes/payments';
import { notificationRoutes } from './routes/notifications';
import { companionRoutes } from './routes/companions';
import { conversationRoutes } from './routes/conversations';
import { searchRoutes } from './routes/search';
import { WebSocketService } from './services/websocket';

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;
  MODERATION_QUEUE: Queue;
  ANALYTICS_QUEUE: Queue;
  NOTIFICATION_QUEUE: Queue;
  CHAT_ROOM: DurableObjectNamespace;
  NOTIFICATION_SERVICE: DurableObjectNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  FRONTEND_URLS: string;
}

export interface Variables {
  user?: any;
  userId?: string;
  userType?: string;
  requestId?: string;
  supplierProfile?: any;
  customerProfile?: any;
  validatedJson?: any;
  validatedQuery?: any;
  validatedParam?: any;
  validatedHeaders?: any;
  uploadedFiles?: File[];
  sanitizedBody?: any;
  pagination?: { page: number; limit: number };
  webSocketService?: any;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// WebSocket service instance
let webSocketService: WebSocketService;

// Global middleware
app.use('*', cors({
  origin: (origin, c) => {
    const allowedOrigins = c.env.FRONTEND_URLS?.split(',') || [];
    if (allowedOrigins.includes(origin) || origin?.startsWith('tirak://')) {
      return origin;
    }
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Initialize WebSocket service
app.use('*', async (c, next) => {
  if (!webSocketService) {
    webSocketService = new WebSocketService(c.env);
  }
  c.set('webSocketService', webSocketService);
  await next();
});

// WebSocket endpoint for mobile app
app.get('/ws', async (c) => {
  if (!webSocketService) {
    webSocketService = new WebSocketService(c.env);
  }

  const upgradeHeader = c.req.header('upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426);
  }

  return await webSocketService.handleUpgrade(c.req.raw);
});

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    websocket: {
      connected: webSocketService?.getConnectedUsersCount() || 0
    }
  });
});

// Auth routes (no JWT required)
app.route('/api/auth', authRoutes);

// Public routes (no authentication required)
app.route('/api/public', publicRoutes);

// Protected routes (JWT required)
app.route('/api/users', userRoutes);
app.route('/api/suppliers', supplierRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api/chat', chatRoutes);

// Mobile app API routes
app.route('/api/bookings', bookingRoutes);
app.route('/api/reviews', reviewRoutes);
app.route('/api/payments', paymentRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/companions', companionRoutes);
app.route('/api/conversations', conversationRoutes);
app.route('/api/search', searchRoutes);

// Admin routes (admin authentication required)
app.route('/api/admin', adminRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;

// Export Durable Objects
export { ChatRoom } from './durable-objects/ChatRoom';
export { NotificationService } from './durable-objects/NotificationService';

// Export queue consumers
export { handleModerationQueue } from './background/moderation';
export { handleAnalyticsQueue } from './background/analytics';
export { handleNotificationQueue } from './background/notifications';
