// Authentication and authorization type definitions

export interface JWTPayload {
  sub: string; // user ID
  email: string;
  userType: 'customer' | 'supplier' | 'admin' | 'companion';
  iat: number;
  exp: number;
  jti?: string; // JWT ID for token tracking
}

export interface RefreshTokenPayload {
  sub: string;
  tokenId: string;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionData {
  userId: string;
  userType: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface AuthContext {
  user: {
    id: string;
    email: string;
    userType: 'customer' | 'supplier' | 'admin' | 'companion';
    status: string;
  };
  session: SessionData;
}

export interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

export interface Role {
  name: string;
  permissions: Permission[];
}

// Role definitions
export const ROLES: Record<string, Role> = {
  customer: {
    name: 'customer',
    permissions: [
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
      { resource: 'suppliers', action: 'search' },
      { resource: 'suppliers', action: 'view' },
      { resource: 'chat', action: 'create' },
      { resource: 'chat', action: 'participate' },
      { resource: 'bookings', action: 'create' },
      { resource: 'bookings', action: 'view' },
      { resource: 'reviews', action: 'create' },
    ]
  },
  supplier: {
    name: 'supplier',
    permissions: [
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
      { resource: 'services', action: 'create' },
      { resource: 'services', action: 'update' },
      { resource: 'services', action: 'delete' },
      { resource: 'chat', action: 'participate' },
      { resource: 'bookings', action: 'view' },
      { resource: 'bookings', action: 'update' },
      { resource: 'availability', action: 'manage' },
    ]
  },
  admin: {
    name: 'admin',
    permissions: [
      { resource: '*', action: '*' }, // Full access
    ]
  }
};

export interface OTPData {
  code: string;
  phone: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
}

export interface PasswordResetData {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}
