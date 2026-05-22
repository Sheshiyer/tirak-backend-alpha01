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
import { referralRoutes } from './routes/referrals';
import { WebSocketService } from './services/websocket';
import { handleModerationQueue } from './background/moderation';
import { handleAnalyticsQueue } from './background/analytics';
import { handleNotificationQueue } from './background/notifications';

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
  EMAIL?: {
    send(message: {
      to: string | string[];
      from: string | { email: string; name?: string };
      replyTo?: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<{ messageId?: string }>;
  };
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_REPLY_TO?: string;
  MAILCHANNELS_API_KEY?: string;
  MAILCHANNELS_FROM_EMAIL?: string;
  MAILCHANNELS_FROM_NAME?: string;
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM_EMAIL?: string;
  SENDGRID_FROM_NAME?: string;
  CF_ANALYTICS_API_TOKEN?: string;
  CF_ZONE_TAG?: string;
  GA_PROPERTY_ID?: string;
  GA_DATA_API_ACCESS_TOKEN?: string;
  UPTIMEROBOT_API_KEY?: string;
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG_SLUG?: string;
  SENTRY_PROJECT_ID?: string;
  SENTRY_API_BASE_URL?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  POSTHOG_HOST?: string;
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
app.route('/api/referrals', referralRoutes);

// Admin routes (admin authentication required)
app.route('/api/admin', adminRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    const queueName = batch.queue;
    if (queueName.includes('moderation')) {
      return handleModerationQueue(batch, env);
    }
    if (queueName.includes('analytics')) {
      return handleAnalyticsQueue(batch, env);
    }
    if (queueName.includes('notification')) {
      return handleNotificationQueue(batch, env);
    }
    throw new Error(`Unhandled queue: ${queueName}`);
  },
};

// Export Durable Objects
export { ChatRoom } from './durable-objects/ChatRoom';
export { NotificationService } from './durable-objects/NotificationService';
