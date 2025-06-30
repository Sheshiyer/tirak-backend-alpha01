import type { User, SupplierProfile, CustomerProfile } from '../types/database';

/**
 * Create a new user in the database
 */
export async function createUser(userData: {
  id: string;
  email: string;
  phone: string;
  passwordHash: string;
  userType: 'customer' | 'supplier' | 'admin' | 'companion';
  preferredLanguage?: string;
  status?: 'active' | 'suspended' | 'pending';
  phoneVerified?: boolean;
  emailVerified?: boolean;
}, db: D1Database): Promise<User> {
  const user = {
    id: userData.id,
    email: userData.email,
    phone: userData.phone,
    passwordHash: userData.passwordHash,
    userType: userData.userType,
    status: userData.status || 'pending' as const,
    emailVerified: userData.emailVerified || false,
    phoneVerified: userData.phoneVerified || false,
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
    userType: result.user_type as 'customer' | 'supplier' | 'admin' | 'companion',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
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
    userType: result.user_type as 'customer' | 'supplier' | 'admin' | 'companion',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
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
    userType: result.user_type as 'customer' | 'supplier' | 'admin' | 'companion',
    status: result.status as 'active' | 'suspended' | 'pending',
    emailVerified: Boolean(result.email_verified),
    phoneVerified: Boolean(result.phone_verified),
    preferredLanguage: result.preferred_language as 'en' | 'th',
    createdAt: result.created_at as string,
    updatedAt: result.updated_at as string,
    lastLoginAt: result.last_login_at as string | undefined,
  };
}

/**
 * Update user profile
 */
export async function updateUser(id: string, updates: Partial<User>, db: D1Database): Promise<void> {
  const setClause = Object.keys(updates)
    .filter(key => key !== 'id')
    .map(key => `${key} = ?`)
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
  bio?: string;
  categories?: string[];
  regions?: string[];
  spokenLanguages?: string[];
}, db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT INTO supplier_profiles (
      user_id, display_name, bio, categories, regions, spoken_languages,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    profileData.userId,
    profileData.displayName,
    profileData.bio || null,
    JSON.stringify(profileData.categories || []),
    JSON.stringify(profileData.regions || []),
    JSON.stringify(profileData.spokenLanguages || []),
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
  profileImage?: string;
  preferences?: Record<string, any>;
}, db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT INTO customer_profiles (
      user_id, display_name, profile_image, preferences,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    profileData.userId,
    profileData.displayName,
    profileData.profileImage || null,
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
    displayName: result.display_name as string,
    bio: result.bio as string | undefined,
    profileImages: JSON.parse(result.profile_images as string || '[]'),
    categories: JSON.parse(result.categories as string || '[]'),
    regions: JSON.parse(result.regions as string || '[]'),
    spokenLanguages: JSON.parse(result.spoken_languages as string || '[]'),
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
    profileImage: result.profile_image as string | undefined,
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
  operations: ((db: D1Database) => Promise<T>)[]
): Promise<T[]> {
  // Note: D1 doesn't support transactions yet, so we'll execute sequentially
  // In a real implementation, you'd want to implement rollback logic
  const results: T[] = [];
  
  for (const operation of operations) {
    const result = await operation(db);
    results.push(result);
  }
  
  return results;
}

/**
 * Build dynamic WHERE clause for search queries
 */
export function buildWhereClause(filters: Record<string, any>): { clause: string; bindings: any[] } {
  const conditions: string[] = [];
  const bindings: any[] = [];

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(',');
        conditions.push(`${key} IN (${placeholders})`);
        bindings.push(...value);
      } else if (typeof value === 'string' && value.includes('%')) {
        conditions.push(`${key} LIKE ?`);
        bindings.push(value);
      } else {
        conditions.push(`${key} = ?`);
        bindings.push(value);
      }
    }
  });

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    bindings
  };
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

/**
 * Check if required database tables exist and run missing migrations if needed
 * This helps prevent "no such table" errors in production
 */
export async function checkRequiredTablesAndMigrate(env: any): Promise<boolean> {
  try {
    // Check if companion_experiences table exists
    const tableCheck = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='companion_experiences'"
    ).first();
    
    if (!tableCheck?.name) {
      console.log('Missing required table: companion_experiences');
      console.log('Attempting to run migration 009_add_companion_features...');
      
      // Apply the missing migration
      try {
        // Read the migration from the KV store or embedded in the code
        const migration = `
        -- Create table for companion experiences
        CREATE TABLE companion_experiences (
            id TEXT PRIMARY KEY,
            companion_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT,
            duration_minutes INTEGER NOT NULL,
            keywords TEXT, -- JSON array of keywords
            price REAL NOT NULL,
            currency TEXT DEFAULT 'THB',
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Create table for companion locations
        CREATE TABLE companion_locations (
            id TEXT PRIMARY KEY,
            companion_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            city TEXT NOT NULL,
            region TEXT NOT NULL,
            is_popular BOOLEAN DEFAULT FALSE,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Add new columns to bookings table for enhanced customer preferences
        ALTER TABLE bookings ADD COLUMN customer_preferences TEXT;
        ALTER TABLE bookings ADD COLUMN special_requests TEXT;
        ALTER TABLE bookings ADD COLUMN preferred_language TEXT;
        ALTER TABLE bookings ADD COLUMN group_composition TEXT;
        ALTER TABLE bookings ADD COLUMN dietary_requirements TEXT;

        -- Create indexes for better query performance
        CREATE INDEX idx_companion_exp_companion_id ON companion_experiences(companion_id);
        CREATE INDEX idx_companion_loc_companion_id ON companion_locations(companion_id);
        CREATE INDEX idx_companion_loc_city ON companion_locations(city);
        CREATE INDEX idx_companion_loc_region ON companion_locations(region);

        -- Log the migration
        INSERT INTO _migrations (name, applied_at) 
        VALUES ('009_add_companion_features', CURRENT_TIMESTAMP);
        `;
        
        // Execute the migration
        await env.DB.exec(migration);
        console.log('Successfully applied migration 009_add_companion_features');
        return true;
      } catch (migrationError) {
        console.error('Failed to apply migration:', migrationError);
        return false;
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error checking database tables:', error);
    return false;
  }
}
