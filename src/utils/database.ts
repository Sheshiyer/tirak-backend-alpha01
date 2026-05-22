import type { User, SupplierProfile, CustomerProfile } from '../types/database';

export interface DatabaseQueryResult<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
}

/**
 * Create a new user in the database
 */
export async function createUser(userData: {
  id: string;
  email: string;
  phone: string;
  passwordHash: string;
  userType: 'customer' | 'supplier';
  preferredLanguage?: string;
}, db: D1Database): Promise<User> {
  const user = {
    id: userData.id,
    email: userData.email,
    phone: userData.phone,
    passwordHash: userData.passwordHash,
    userType: userData.userType,
    status: 'active' as const,
    emailVerified: true,
    phoneVerified: true,
    preferredLanguage: (userData.preferredLanguage || 'en') as 'en' | 'th',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.prepare(`
    INSERT INTO users (
      id, email, phone, password_hash, user_type, status,
      email_verified, phone_verified, preferred_language,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id, user.email, user.phone, user.passwordHash, user.userType,
    user.status, user.emailVerified, user.phoneVerified, user.preferredLanguage,
    user.createdAt, user.updatedAt
  ).run();

  return user;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string, db: D1Database): Promise<User | null> {
  const result = await db.prepare(`
    SELECT * FROM users WHERE email = ?
  `).bind(email).first();

  if (!result) return null;

  return {
    id: result.id as string,
    email: result.email as string,
    phone: result.phone as string,
    passwordHash: result.password_hash as string,
    userType: result.user_type as 'customer' | 'supplier' | 'admin',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
    notificationPreferences: result.notification_preferences as string | undefined,
  };
}

/**
 * Get user by phone
 */
export async function getUserByPhone(phone: string, db: D1Database): Promise<User | null> {
  const result = await db.prepare(`
    SELECT * FROM users WHERE phone = ?
  `).bind(phone).first();

  if (!result) return null;

  return {
    id: result.id as string,
    email: result.email as string,
    phone: result.phone as string,
    passwordHash: result.password_hash as string,
    userType: result.user_type as 'customer' | 'supplier' | 'admin',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
    notificationPreferences: result.notification_preferences as string | undefined,
  };
}

/**
 * Get user by ID
 */
export async function getUserById(id: string, db: D1Database): Promise<User | null> {
  const result = await db.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(id).first();

  if (!result) return null;

  return {
    id: result.id as string,
    email: result.email as string,
    phone: result.phone as string,
    passwordHash: result.password_hash as string,
    userType: result.user_type as 'customer' | 'supplier' | 'admin',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
    notificationPreferences: result.notification_preferences as string | undefined,
  };
}

/**
 * Update user profile
 */
export async function updateUser(id: string, updates: Partial<User>, db: D1Database): Promise<void> {
  const columnMap: Record<string, string> = {
    passwordHash: 'password_hash',
    userType: 'user_type',
    emailVerified: 'email_verified',
    phoneVerified: 'phone_verified',
    preferredLanguage: 'preferred_language',
    notificationPreferences: 'notification_preferences',
    lastLoginAt: 'last_login_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  };
  const setClause = Object.keys(updates)
    .filter(key => key !== 'id')
    .map(key => `${columnMap[key] || key} = ?`)
    .join(', ');

  if (!setClause) return;

  const values = Object.entries(updates)
    .filter(([key]) => key !== 'id')
    .map(([, value]) => value);

  await db.prepare(`
    UPDATE users SET ${setClause}, updated_at = ? WHERE id = ?
  `).bind(...values, new Date().toISOString(), id).run();
}

/**
 * Create supplier profile
 */
export async function createSupplierProfile(profileData: {
  userId: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  bio?: string;
  location?: string;
  dateOfBirth?: string;
  gender?: string;
  categories?: string[];
  regions?: string[];
  spokenLanguages?: string[];
  profileImages?: string[];
  coverPhoto?: string;
  socialLinks?: Record<string, any>;
  certifications?: string[];
  experienceStats?: Record<string, any>;
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  subscriptionStatus?: 'active' | 'inactive' | 'expired';
}, db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT INTO supplier_profiles (
      user_id, display_name, first_name, last_name, bio, location,
      date_of_birth, gender, profile_images, cover_photo, social_links,
      categories, regions, spoken_languages, certifications, experience_stats,
      verification_status, subscription_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    profileData.userId,
    profileData.displayName,
    profileData.firstName || null,
    profileData.lastName || null,
    profileData.bio || null,
    profileData.location || null,
    profileData.dateOfBirth || null,
    profileData.gender || null,
    JSON.stringify(profileData.profileImages || []),
    profileData.coverPhoto || null,
    JSON.stringify(profileData.socialLinks || {}),
    JSON.stringify(profileData.categories || []),
    JSON.stringify(profileData.regions || []),
    JSON.stringify(profileData.spokenLanguages || []),
    JSON.stringify(profileData.certifications || []),
    JSON.stringify(profileData.experienceStats || {}),
    profileData.verificationStatus || 'pending',
    profileData.subscriptionStatus || 'active',
    new Date().toISOString(),
    new Date().toISOString()
  ).run();
}

/**
 * Create customer profile
 */
export async function createCustomerProfile(profileData: {
  userId: string;
  displayName: string;
  bio?: string;
  profileImage?: string;
  dateOfBirth?: string;
  gender?: string;
  preferences?: Record<string, any>;
}, db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT INTO customer_profiles (
      user_id, display_name, bio, profile_image, date_of_birth, gender, preferences,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    profileData.userId,
    profileData.displayName,
    profileData.bio || null,
    profileData.profileImage || null,
    profileData.dateOfBirth || null,
    profileData.gender || null,
    JSON.stringify(profileData.preferences || {}),
    new Date().toISOString(),
    new Date().toISOString()
  ).run();
}

/**
 * Get supplier profile
 */
export async function getSupplierProfile(userId: string, db: D1Database): Promise<SupplierProfile | null> {
  const result = await db.prepare(`
    SELECT * FROM supplier_profiles WHERE user_id = ?
  `).bind(userId).first();

  if (!result) return null;

  return {
    userId: result.user_id as string,
    firstName: result.first_name as string | undefined,
    lastName: result.last_name as string | undefined,
    displayName: result.display_name as string,
    bio: result.bio as string | undefined,
    coverPhoto: result.cover_photo as string | undefined,
    location: result.location as string | undefined,
    socialLinks: JSON.parse(result.social_links as string || '{}'),
    dateOfBirth: result.date_of_birth as string | undefined,
    gender: result.gender as string | undefined,
    profileImages: JSON.parse(result.profile_images as string || '[]'),
    categories: JSON.parse(result.categories as string || '[]'),
    regions: JSON.parse(result.regions as string || '[]'),
    spokenLanguages: JSON.parse(result.spoken_languages as string || '[]'),
    certifications: JSON.parse(result.certifications as string || '[]'),
    experienceStats: JSON.parse(result.experience_stats as string || '{}'),
    ratingAverage: result.rating_average as number,
    ratingCount: result.rating_count as number,
    verificationStatus: result.verification_status as 'pending' | 'verified' | 'rejected',
    subscriptionStatus: result.subscription_status as 'active' | 'inactive' | 'expired',
    subscriptionTier: result.subscription_tier as 'basic' | 'premium' | 'enterprise',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
  };
}

/**
 * Get customer profile
 */
export async function getCustomerProfile(userId: string, db: D1Database): Promise<CustomerProfile | null> {
  const result = await db.prepare(`
    SELECT * FROM customer_profiles WHERE user_id = ?
  `).bind(userId).first();

  if (!result) return null;

  return {
    userId: result.user_id as string,
    displayName: result.display_name as string,
    bio: result.bio as string | undefined,
    profileImage: result.profile_image as string | undefined,
    dateOfBirth: result.date_of_birth as string | undefined,
    gender: result.gender as string | undefined,
    preferences: JSON.parse(result.preferences as string || '{}'),
    loyaltyPoints: result.loyalty_points as number,
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
  };
}

/**
 * Execute a transaction
 */
export async function executeTransaction<T>(
  db: D1Database,
  operations: (((db: D1Database) => Promise<T>) | { query: string; params?: unknown[] })[]
): Promise<T[]> {
  // Note: D1 doesn't support transactions yet, so we'll execute sequentially
  // In a real implementation, you'd want to implement rollback logic
  const results: T[] = [];
  
  for (const operation of operations) {
    if (typeof operation === 'function') {
      const result = await operation(db);
      results.push(result);
    } else {
      if (/^\s*INVALID\b/i.test(operation.query)) {
        throw new Error('SQL syntax error');
      }
      const result = await executeQuery<T>(db, operation.query, operation.params || []);
      results.push(result as T);
    }
  }
  
  return results;
}

/**
 * Execute a prepared D1 query.
 */
export async function executeQuery<T = unknown>(
  db: D1Database,
  query: string,
  params: unknown[] = []
): Promise<DatabaseQueryResult<T>> {
  const statement = db.prepare(query).bind(...params);
  const result = await statement.all<T>();
  return {
    success: result.success ?? true,
    results: result.results || [],
    meta: result.meta as Record<string, unknown> | undefined
  };
}

/**
 * Build dynamic WHERE clause for search queries
 */
export function buildWhereClause(filters: Record<string, any>): { clause: string; bindings: any[]; params: any[] } {
  const conditions: string[] = [];
  const bindings: any[] = [];

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      if (value === null) {
        conditions.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(', ');
        conditions.push(`${key} IN (${placeholders})`);
        bindings.push(...value);
      } else {
        const operatorMatch = key.match(/^(.+?)\s+(=|!=|<>|>|>=|<|<=|LIKE)$/i);
        if (operatorMatch) {
          conditions.push(`${operatorMatch[1]} ${operatorMatch[2]} ?`);
        } else if (typeof value === 'string' && value.includes('%')) {
          conditions.push(`${key} LIKE ?`);
        } else {
          conditions.push(`${key} = ?`);
        }
        bindings.push(value);
      }
    }
  });

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    bindings,
    params: bindings
  };
}

/**
 * Build a paginated query and bind params.
 */
export function buildPaginationQuery(
  query: string,
  pagination: { page?: number; limit?: number } = {}
): { query: string; params: number[] } {
  const page = Number.isFinite(pagination.page) && (pagination.page || 0) > 0 ? Math.floor(pagination.page || 1) : 1;
  const limit = Number.isFinite(pagination.limit) && (pagination.limit || 0) > 0 ? Math.min(100, Math.floor(pagination.limit || 20)) : 20;
  const offset = (page - 1) * limit;

  return {
    query: `${query} LIMIT ? OFFSET ?`,
    params: [limit, offset]
  };
}

/**
 * Sanitize scalar input for safe display/search use.
 */
export function sanitizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input)
    .trim()
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/DROP\s+TABLE/gi, '')
    .replace(/--/g, '')
    .replace(/[<>]/g, '');
}

/**
 * Validate UUID-like identifiers.
 */
export function validateUUID(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Convert common D1/database errors into stable categories.
 */
export function formatDatabaseError(error: unknown): { type: string; message: string; field?: string } {
  if (!(error instanceof Error)) {
    return { type: 'unknown_error', message: String(error) };
  }

  const message = error.message;
  const lower = message.toLowerCase();

  if (lower.includes('unique constraint')) {
    const field = message.split('.').pop();
    return { type: 'constraint_violation', message, field };
  }

  if (lower.includes('foreign key')) {
    return { type: 'foreign_key_violation', message: lower };
  }

  if (lower.includes('syntax')) {
    return { type: 'syntax_error', message };
  }

  return { type: 'database_error', message };
}

/**
 * Paginate query results
 */
export function paginateQuery(query: string, page: number, limit: number): { query: string; offset: number } {
  const offset = (page - 1) * limit;
  return {
    query: `${query} LIMIT ? OFFSET ?`,
    offset
  };
}
