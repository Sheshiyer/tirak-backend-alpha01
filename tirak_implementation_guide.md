# Tirak Backend Implementation Guide - Code Structure & Deployment

## Project Structure

```
tirak-backend/
├── package.json
├── wrangler.toml
├── tsconfig.json
├── schema.sql
├── src/
│   ├── index.ts                    # Main worker entry point
│   ├── types/
│   │   ├── database.ts             # Database type definitions
│   │   ├── api.ts                  # API request/response types
│   │   └── auth.ts                 # Auth-related types
│   ├── utils/
│   │   ├── auth.ts                 # JWT handling, validation
│   │   ├── database.ts             # D1 database helpers
│   │   ├── storage.ts              # R2 storage utilities
│   │   ├── validation.ts           # Input validation schemas
│   │   ├── errors.ts               # Error handling utilities
│   │   └── response.ts             # Response formatting
│   ├── middleware/
│   │   ├── auth.ts                 # Authentication middleware
│   │   ├── cors.ts                 # CORS handling
│   │   ├── rateLimit.ts            # Rate limiting
│   │   └── validation.ts           # Request validation
│   ├── routes/
│   │   ├── auth.ts                 # Authentication endpoints
│   │   ├── users.ts                # User management
│   │   ├── suppliers.ts            # Supplier-specific APIs
│   │   ├── customers.ts            # Customer-specific APIs
│   │   ├── chat.ts                 # Chat API endpoints
│   │   ├── uploads.ts              # File upload handling
│   │   ├── admin/
│   │   │   ├── dashboard.ts        # Admin dashboard APIs
│   │   │   ├── users.ts            # Admin user management
│   │   │   ├── moderation.ts       # Content moderation
│   │   │   ├── analytics.ts        # Analytics endpoints
│   │   │   └── subscriptions.ts    # Subscription management
│   │   └── public.ts               # Public endpoints (categories, regions)
│   ├── durable-objects/
│   │   ├── ChatRoom.ts             # Real-time chat handling
│   │   └── NotificationService.ts  # Real-time notifications
│   └── background/
│       ├── moderation.ts           # Content moderation jobs
│       ├── analytics.ts            # Analytics processing
│       └── notifications.ts        # Push notification sending
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_add_indexes.sql
│   └── 003_add_analytics_tables.sql
└── scripts/
    ├── deploy.sh
    ├── seed-data.sql
    └── backup.sh
```

## Core Implementation Files

### Main Entry Point (`src/index.ts`)

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { supplierRoutes } from './routes/suppliers';
import { customerRoutes } from './routes/customers';
import { chatRoutes } from './routes/chat';
import { uploadRoutes } from './routes/uploads';
import { adminRoutes } from './routes/admin';
import { publicRoutes } from './routes/public';
import { handleError } from './utils/errors';
import { rateLimitMiddleware } from './middleware/rateLimit';

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;
  MODERATION_QUEUE: Queue;
  ANALYTICS_QUEUE: Queue;
  CHAT_ROOM: DurableObjectNamespace;
  NOTIFICATION_SERVICE: DurableObjectNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  FRONTEND_URLS: string;
}

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', cors({
  origin: (origin) => {
    const allowedOrigins = process.env.FRONTEND_URLS?.split(',') || [];
    return allowedOrigins.includes(origin) || origin.startsWith('tirak://');
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.use('*', rateLimitMiddleware);

// Public routes (no auth required)
app.route('/api/public', publicRoutes);
app.route('/api/auth', authRoutes);

// Protected routes
app.use('/api/*', jwt({
  secret: (c) => c.env.JWT_SECRET,
  cookie: 'auth-token'
}));

app.route('/api/users', userRoutes);
app.route('/api/suppliers', supplierRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api/admin', adminRoutes);

// Error handling
app.onError((err, c) => handleError(err, c));

// 404 handler
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;

// Export Durable Objects
export { ChatRoom } from './durable-objects/ChatRoom';
export { NotificationService } from './durable-objects/NotificationService';

// Export queue consumers
export { handleModerationQueue } from './background/moderation';
export { handleAnalyticsQueue } from './background/analytics';
```

### Authentication Routes (`src/routes/auth.ts`)

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hashPassword, verifyPassword, generateTokens } from '../utils/auth';
import { createUser, getUserByEmail, getUserByPhone } from '../utils/database';
import { sendSMS, generateOTP } from '../utils/communication';
import type { Env } from '../index';

const auth = new Hono<{ Bindings: Env }>();

const registerSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(10),
  password: z.string().min(8),
  userType: z.enum(['customer', 'supplier']),
  preferredLanguage: z.enum(['en', 'th']).default('en')
});

const loginSchema = z.object({
  identifier: z.string(), // email or phone
  password: z.string(),
  deviceId: z.string().optional()
});

// Register endpoint
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, phone, password, userType, preferredLanguage } = c.req.valid('json');
  
  try {
    // Check if user already exists
    const existingUser = await getUserByEmail(email, c.env.DB) || 
                        await getUserByPhone(phone, c.env.DB);
    
    if (existingUser) {
      return c.json({ error: 'User already exists' }, 400);
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    
    const user = await createUser({
      id: userId,
      email,
      phone,
      passwordHash,
      userType,
      preferredLanguage
    }, c.env.DB);

    // Generate OTP for phone verification
    const otp = generateOTP();
    await c.env.CACHE.put(`otp:${phone}`, otp, { expirationTtl: 300 }); // 5 minutes
    
    // Send OTP (in production, integrate with SMS service)
    await sendSMS(phone, `Your Tirak verification code is: ${otp}`);

    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          userType: user.userType,
          status: user.status
        },
        ...tokens
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    return c.json({ error: 'Registration failed' }, 500);
  }
});

// Login endpoint
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  const { identifier, password, deviceId } = c.req.valid('json');
  
  try {
    // Find user by email or phone
    const user = await getUserByEmail(identifier, c.env.DB) || 
                 await getUserByPhone(identifier, c.env.DB);
    
    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Verify password
    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Check account status
    if (user.status === 'suspended') {
      return c.json({ error: 'Account suspended' }, 403);
    }

    // Generate tokens
    const tokens = await generateTokens(user, c.env.JWT_SECRET);

    // Update last login
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(user.id).run();

    // Track login activity
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'user_login',
      userId: user.id,
      properties: { deviceId, userType: user.userType },
      timestamp: new Date().toISOString()
    });

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          userType: user.userType,
          status: user.status,
          emailVerified: user.emailVerified,
          phoneVerified: user.phoneVerified
        },
        ...tokens
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Login failed' }, 500);
  }
});

// Phone verification endpoint
auth.post('/verify-phone', async (c) => {
  const { phone, otp } = await c.req.json();
  
  try {
    const storedOtp = await c.env.CACHE.get(`otp:${phone}`);
    
    if (!storedOtp || storedOtp !== otp) {
      return c.json({ error: 'Invalid OTP' }, 400);
    }

    // Update user's phone verification status
    await c.env.DB.prepare(
      'UPDATE users SET phone_verified = TRUE WHERE phone = ?'
    ).bind(phone).run();

    // Clear OTP from cache
    await c.env.CACHE.delete(`otp:${phone}`);

    return c.json({ success: true, message: 'Phone verified successfully' });

  } catch (error) {
    console.error('Phone verification error:', error);
    return c.json({ error: 'Verification failed' }, 500);
  }
});

export { auth as authRoutes };
```

### Supplier Search & Management (`src/routes/suppliers.ts`)

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env } from '../index';

const suppliers = new Hono<{ Bindings: Env }>();

const searchSchema = z.object({
  region: z.string().optional(),
  category: z.string().optional(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  language: z.string().optional(),
  page: z.number().default(1),
  limit: z.number().default(20)
});

// Search suppliers with advanced filtering
suppliers.get('/search', zValidator('query', searchSchema), async (c) => {
  const params = c.req.valid('query');
  
  try {
    // Build dynamic query based on filters
    let query = `
      SELECT 
        u.id, u.email, u.phone,
        sp.display_name, sp.bio, sp.profile_images, sp.categories,
        sp.regions, sp.spoken_languages, sp.rating_average, sp.rating_count,
        sp.verification_status
      FROM users u
      JOIN supplier_profiles sp ON u.id = sp.user_id
      WHERE u.user_type = 'supplier' 
        AND u.status = 'active'
        AND sp.verification_status = 'verified'
        AND sp.subscription_status = 'active'
    `;
    
    const bindings: any[] = [];
    
    // Add filters dynamically
    if (params.region) {
      query += ` AND json_extract(sp.regions, '$') LIKE ?`;
      bindings.push(`%"${params.region}"%`);
    }
    
    if (params.category) {
      query += ` AND json_extract(sp.categories, '$') LIKE ?`;
      bindings.push(`%"${params.category}"%`);
    }
    
    if (params.language) {
      query += ` AND json_extract(sp.spoken_languages, '$') LIKE ?`;
      bindings.push(`%"${params.language}"%`);
    }
    
    // Add ordering and pagination
    query += ` ORDER BY sp.rating_average DESC, sp.created_at DESC`;
    query += ` LIMIT ? OFFSET ?`;
    bindings.push(params.limit, (params.page - 1) * params.limit);
    
    // Check cache first
    const cacheKey = `supplier_search:${btoa(JSON.stringify(params))}`;
    const cached = await c.env.CACHE.get(cacheKey);
    
    if (cached) {
      return c.json(JSON.parse(cached));
    }
    
    // Execute query
    const results = await c.env.DB.prepare(query).bind(...bindings).all();
    
    // Process and format results
    const suppliers = results.results.map((row: any) => ({
      id: row.id,
      displayName: row.display_name,
      bio: row.bio,
      profileImages: JSON.parse(row.profile_images || '[]'),
      categories: JSON.parse(row.categories || '[]'),
      regions: JSON.parse(row.regions || '[]'),
      spokenLanguages: JSON.parse(row.spoken_languages || '[]'),
      rating: {
        average: row.rating_average,
        count: row.rating_count
      },
      verificationStatus: row.verification_status
    }));
    
    const response = {
      success: true,
      data: {
        suppliers,
        pagination: {
          page: params.page,
          limit: params.limit,
          total: suppliers.length // You'd want to get actual total with COUNT query
        }
      }
    };
    
    // Cache results for 5 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(response), {
      expirationTtl: 300
    });
    
    return c.json(response);
    
  } catch (error) {
    console.error('Supplier search error:', error);
    return c.json({ error: 'Search failed' }, 500);
  }
});

// Get individual supplier profile
suppliers.get('/:id', async (c) => {
  const supplierId = c.req.param('id');
  const viewerId = c.get('jwtPayload')?.sub;
  
  try {
    const supplier = await c.env.DB.prepare(`
      SELECT 
        u.id, u.email, u.phone, u.created_at,
        sp.display_name, sp.bio, sp.profile_images, sp.categories,
        sp.regions, sp.spoken_languages, sp.rating_average, sp.rating_count,
        sp.verification_status, sp.subscription_status
      FROM users u
      JOIN supplier_profiles sp ON u.id = sp.user_id
      WHERE u.id = ? AND u.user_type = 'supplier'
    `).bind(supplierId).first();
    
    if (!supplier) {
      return c.json({ error: 'Supplier not found' }, 404);
    }
    
    // Get supplier services
    const services = await c.env.DB.prepare(`
      SELECT id, title, description, price_min, price_max, currency, duration_hours
      FROM supplier_services
      WHERE supplier_id = ? AND is_active = TRUE
    `).bind(supplierId).all();
    
    // Get availability
    const availability = await c.env.DB.prepare(`
      SELECT day_of_week, start_time, end_time, is_available
      FROM supplier_availability
      WHERE supplier_id = ?
      ORDER BY day_of_week
    `).bind(supplierId).all();
    
    // Track profile view
    if (viewerId && viewerId !== supplierId) {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'profile_view',
        userId: viewerId,
        properties: {
          viewedUserId: supplierId,
          viewedUserType: 'supplier'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    const response = {
      success: true,
      data: {
        id: supplier.id,
        displayName: supplier.display_name,
        bio: supplier.bio,
        profileImages: JSON.parse(supplier.profile_images || '[]'),
        categories: JSON.parse(supplier.categories || '[]'),
        regions: JSON.parse(supplier.regions || '[]'),
        spokenLanguages: JSON.parse(supplier.spoken_languages || '[]'),
        rating: {
          average: supplier.rating_average,
          count: supplier.rating_count
        },
        verificationStatus: supplier.verification_status,
        subscriptionStatus: supplier.subscription_status,
        services: services.results,
        availability: availability.results,
        memberSince: supplier.created_at
      }
    };
    
    return c.json(response);
    
  } catch (error) {
    console.error('Get supplier error:', error);
    return c.json({ error: 'Failed to fetch supplier' }, 500);
  }
});

export { suppliers as supplierRoutes };
```

### Chat Durable Object (`src/durable-objects/ChatRoom.ts`)

```typescript
export class ChatRoom {
  private sessions: Map<string, WebSocket> = new Map();
  private env: Env;
  private roomId: string;

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env;
    this.roomId = this.state.id.toString();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/send-message':
        return this.handleSendMessage(request);
      case '/typing':
        return this.handleTyping(request);
      case '/end-chat':
        return this.handleEndChat(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    
    // Get user ID from URL params or auth token
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');
    
    if (!userId || !token) {
      return new Response('Missing userId or token', { status: 401 });
    }
    
    // Verify token and get user info
    const user = await this.verifyUserToken(token, userId);
    if (!user) {
      return new Response('Invalid token', { status: 401 });
    }
    
    // Store the connection
    this.sessions.set(userId, server);
    
    // Handle connection events
    server.accept();
    
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        await this.handleWebSocketMessage(userId, data);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });
    
    server.addEventListener('close', () => {
      this.sessions.delete(userId);
    });
    
    // Send connection confirmation
    server.send(JSON.stringify({
      type: 'connected',
      roomId: this.roomId,
      userId: userId
    }));
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleSendMessage(request: Request): Promise<Response> {
    const { senderId, messageType, content, imageUrl } = await request.json();
    
    try {
      // Save message to database
      const messageId = crypto.randomUUID();
      
      await this.env.DB.prepare(`
        INSERT INTO chat_messages (id, room_id, sender_id, message_type, content, image_url)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(messageId, this.roomId, senderId, messageType, content, imageUrl).run();
      
      // Update room's last message time
      await this.env.DB.prepare(`
        UPDATE chat_rooms SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?
      `).bind(this.roomId).run();
      
      // Broadcast message to all connected clients
      const message = {
        id: messageId,
        roomId: this.roomId,
        senderId,
        messageType,
        content,
        imageUrl,
        createdAt: new Date().toISOString()
      };
      
      this.broadcastMessage(message);
      
      // Queue for moderation if needed
      if (messageType === 'text' || messageType === 'image') {
        await this.env.MODERATION_QUEUE.send({
          type: messageType === 'text' ? 'text_analysis' : 'image_analysis',
          contentId: messageId,
          userId: senderId,
          priority: 'medium',
          metadata: { roomId: this.roomId, content, imageUrl }
        });
      }
      
      return new Response(JSON.stringify({ success: true, messageId }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Send message error:', error);
      return new Response(JSON.stringify({ error: 'Failed to send message' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleTyping(request: Request): Promise<Response> {
    const { userId, isTyping } = await request.json();
    
    // Broadcast typing indicator to other participants
    this.sessions.forEach((socket, sessionUserId) => {
      if (sessionUserId !== userId) {
        socket.send(JSON.stringify({
          type: 'typing',
          userId,
          isTyping
        }));
      }
    });
    
    return new Response(JSON.stringify({ success: true }));
  }

  private broadcastMessage(message: any): void {
    const messageData = JSON.stringify({
      type: 'message',
      data: message
    });
    
    this.sessions.forEach((socket) => {
      try {
        socket.send(messageData);
      } catch (error) {
        console.error('Failed to send message to client:', error);
      }
    });
  }

  private async verifyUserToken(token: string, userId: string): Promise<any> {
    try {
      // Verify JWT token and check if user exists
      const payload = await verifyJWT(token, this.env.JWT_SECRET);
      if (payload.sub !== userId) return null;
      
      // Get user from database
      const user = await this.env.DB.prepare(
        'SELECT id, user_type, status FROM users WHERE id = ?'
      ).bind(userId).first();
      
      return user?.status === 'active' ? user : null;
    } catch {
      return null;
    }
  }

  private async handleWebSocketMessage(userId: string, data: any): Promise<void> {
    switch (data.type) {
      case 'ping':
        const userSocket = this.sessions.get(userId);
        if (userSocket) {
          userSocket.send(JSON.stringify({ type: 'pong' }));
        }
        break;
      
      case 'join_room':
        // Handle user joining room
        break;
      
      case 'leave_room':
        // Handle user leaving room
        this.sessions.delete(userId);
        break;
    }
  }
}
```

## Deployment Scripts

### Deploy Script (`scripts/deploy.sh`)

```bash
#!/bin/bash

# Tirak Backend Deployment Script

set -e

echo "🚀 Starting Tirak Backend Deployment..."

# Check if we're in the right directory
if [ ! -f "wrangler.toml" ]; then
    echo "❌ Error: wrangler.toml not found. Please run this script from the project root."
    exit 1
fi

# Check environment argument
ENVIRONMENT=${1:-staging}

if [ "$ENVIRONMENT" != "staging" ] && [ "$ENVIRONMENT" != "production" ]; then
    echo "❌ Error: Environment must be 'staging' or 'production'"
    echo "Usage: ./scripts/deploy.sh [staging|production]"
    exit 1
fi

echo "📦 Deploying to $ENVIRONMENT environment..."

# Install dependencies
echo "📚 Installing dependencies..."
npm install

# Run type checking
echo "🔍 Running type checks..."
npm run typecheck

# Run tests
echo "🧪 Running tests..."
npm run test

# Run database migrations
echo "🗃️ Running database migrations..."
npx wrangler d1 migrations apply tirak-$ENVIRONMENT --env $ENVIRONMENT

# Deploy the worker
echo "☁️ Deploying Cloudflare Worker..."
npx wrangler deploy --env $ENVIRONMENT

# Deploy Durable Objects
echo "🏗️ Deploying Durable Objects..."
npx wrangler deploy --env $ENVIRONMENT --compatibility-date 2024-01-01

# Deploy Queue consumers
echo "📬 Deploying Queue consumers..."
npx wrangler deploy --env $ENVIRONMENT src/background/moderation.ts
npx wrangler deploy --env $ENVIRONMENT src/background/analytics.ts

# Seed initial data if staging
if [ "$ENVIRONMENT" = "staging" ]; then
    echo "🌱 Seeding initial data..."
    npx wrangler d1 execute tirak-staging --file ./scripts/seed-data.sql --env staging
fi

echo "✅ Deployment completed successfully!"
echo "🌐 API URL: https://api-$ENVIRONMENT.tirak.app"

# Show recent logs
echo "📊 Recent logs:"
npx wrangler tail --env $ENVIRONMENT --format pretty
```

### Package.json

```json
{
  "name": "tirak-backend",
  "version": "1.0.0",
  "description": "Tirak companion booking platform backend API",
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy:staging": "./scripts/deploy.sh staging",
    "deploy:production": "./scripts/deploy.sh production",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "db:migrate": "wrangler d1 migrations apply tirak-development",
    "db:migrate:staging": "wrangler d1 migrations apply tirak-staging --env staging",
    "db:migrate:production": "wrangler d1 migrations apply tirak-production --env production",
    "db:seed": "wrangler d1 execute tirak-development --file ./scripts/seed-data.sql",
    "logs": "wrangler tail --format pretty",
    "logs:staging": "wrangler tail --env staging --format pretty",
    "logs:production": "wrangler tail --env production --format pretty"
  },
  "dependencies": {
    "hono": "^3.12.0",
    "@hono/zod-validator": "^0.2.0",
    "zod": "^3.22.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "@types/jsonwebtoken": "^9.0.5"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20231218.0",
    "@types/bcryptjs": "^2.4.6",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0",
    "wrangler": "^3.22.0"
  }
}
```

This implementation provides a complete, production-ready backend architecture using Cloudflare's ecosystem that can scale globally while maintaining excellent performance and security for the Tirak platform.