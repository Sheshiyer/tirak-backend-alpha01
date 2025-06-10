import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';

// Global test environment setup
declare global {
  var testWorker: UnstableDevWorker;
  var testEnv: any;
}

// Mock environment for testing
export const createTestEnv = () => ({
  DB: {
    prepare: (query: string) => ({
      bind: (...params: any[]) => ({
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => ({}),
        all: async () => ({ results: [] }),
      }),
    }),
    exec: async (query: string) => ({ success: true }),
    batch: async (statements: any[]) => [{ success: true }],
  },
  STORAGE: {
    put: async (key: string, value: any) => ({ success: true }),
    get: async (key: string) => null,
    delete: async (key: string) => ({ success: true }),
    list: async () => ({ objects: [] }),
  },
  CACHE: {
    get: async (key: string) => null,
    put: async (key: string, value: string) => undefined,
    delete: async (key: string) => undefined,
  },
  SESSIONS: {
    get: async (key: string) => null,
    put: async (key: string, value: string) => undefined,
    delete: async (key: string) => undefined,
  },
  MODERATION_QUEUE: {
    send: async (message: any) => ({ success: true }),
    sendBatch: async (messages: any[]) => ({ success: true }),
  },
  ANALYTICS_QUEUE: {
    send: async (message: any) => ({ success: true }),
    sendBatch: async (messages: any[]) => ({ success: true }),
  },
  NOTIFICATION_QUEUE: {
    send: async (message: any) => ({ success: true }),
    sendBatch: async (messages: any[]) => ({ success: true }),
  },
  CHAT_ROOM: {
    get: (id: any) => ({
      fetch: async (request: Request) => new Response('OK'),
    }),
  },
  NOTIFICATION_SERVICE: {
    get: (id: any) => ({
      fetch: async (request: Request) => new Response('OK'),
    }),
  },
  JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
  ENVIRONMENT: 'test',
  FRONTEND_URLS: 'http://localhost:3000,http://localhost:3001',
});

// Test database setup
export const setupTestDatabase = async () => {
  const testEnv = createTestEnv();
  
  // Create test tables (simplified for testing)
  const createTables = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      user_type TEXT NOT NULL,
      email_verified BOOLEAN DEFAULT FALSE,
      phone_verified BOOLEAN DEFAULT FALSE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      avatar_url TEXT,
      bio TEXT,
      location TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      service_id TEXT,
      status TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      total_amount REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      reviewee_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      read BOOLEAN DEFAULT FALSE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ];

  for (const sql of createTables) {
    await testEnv.DB.exec(sql);
  }

  return testEnv;
};

// Test data factories
export const createTestUser = (overrides: any = {}) => ({
  id: 'test-user-id',
  email: 'test@example.com',
  phone: '+66812345678',
  password_hash: '$2a$10$test.hash.for.testing.only',
  user_type: 'customer',
  email_verified: true,
  phone_verified: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

export const createTestProfile = (overrides: any = {}) => ({
  id: 'test-profile-id',
  user_id: 'test-user-id',
  first_name: 'Test',
  last_name: 'User',
  avatar_url: null,
  bio: 'Test user bio',
  location: 'Bangkok, Thailand',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

export const createTestBooking = (overrides: any = {}) => ({
  id: 'test-booking-id',
  customer_id: 'test-customer-id',
  supplier_id: 'test-supplier-id',
  service_id: 'test-service-id',
  status: 'pending',
  start_time: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
  end_time: new Date(Date.now() + 90000000).toISOString(), // Tomorrow + 1 hour
  total_amount: 1000.00,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

export const createTestReview = (overrides: any = {}) => ({
  id: 'test-review-id',
  booking_id: 'test-booking-id',
  reviewer_id: 'test-customer-id',
  reviewee_id: 'test-supplier-id',
  rating: 5,
  comment: 'Excellent service!',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

export const createTestNotification = (overrides: any = {}) => ({
  id: 'test-notification-id',
  user_id: 'test-user-id',
  type: 'booking_confirmed',
  title: 'Booking Confirmed',
  message: 'Your booking has been confirmed',
  data: JSON.stringify({ booking_id: 'test-booking-id' }),
  read: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// Mock request helper
export const createMockRequest = (
  url: string,
  options: RequestInit = {}
): Request => {
  return new Request(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
};

// Mock context helper
export const createMockContext = (env: any = createTestEnv()) => ({
  env,
  req: createMockRequest('http://localhost:8787/test'),
  json: (data: any, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }),
  text: (text: string, status = 200) => new Response(text, { status }),
  get: (key: string) => undefined,
  set: (key: string, value: any) => undefined,
  var: {},
});

// Global setup and teardown
beforeAll(async () => {
  // Set up test environment
  globalThis.testEnv = await setupTestDatabase();
});

afterAll(async () => {
  // Clean up test environment
  if (globalThis.testWorker) {
    await globalThis.testWorker.stop();
  }
});

beforeEach(async () => {
  // Reset test data before each test
  // This would typically clear test database tables
});

afterEach(async () => {
  // Clean up after each test
  // This would typically clean up any test data
});
