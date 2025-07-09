// Database type definitions for Tirak platform

export interface User {
  id: string;
  email: string;
  phone: string;
  passwordHash: string;
  userType: 'customer' | 'supplier' | 'admin' | 'companion';
  status: 'active' | 'suspended' | 'pending';
  emailVerified: boolean;
  phoneVerified: boolean;
  preferredLanguage: 'en' | 'th';
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  profile_image_url?: string;
  notificationPreferences?: string;
}

export interface SupplierProfile {
  userId: string;
  displayName: string;
  bio?: string;
  profileImages: string[];
  categories: string[];
  regions: string[];
  spokenLanguages: string[];
  ratingAverage: number;
  ratingCount: number;
  verificationStatus: 'pending' | 'verified' | 'rejected';
  subscriptionStatus: 'active' | 'inactive' | 'expired';
  subscriptionTier: 'basic' | 'premium' | 'enterprise';
  createdAt: string;
  updatedAt: string;
}

export interface CustomerProfile {
  userId: string;
  displayName: string;
  profileImage?: string;
  preferences: Record<string, any>;
  loyaltyPoints: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRoom {
  id: string;
  customerId: string;
  supplierId: string;
  status: 'active' | 'closed' | 'archived';
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  messageType: 'text' | 'image' | 'system';
  content?: string;
  imageUrl?: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface Service {
  id: string;
  supplierId: string;
  title: string;
  description: string;
  priceMin: number;
  priceMax: number;
  currency: string;
  durationHours: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Booking {
  id: string;
  customerId: string;
  supplierId: string;
  serviceId: string;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  scheduledAt: string;
  duration: number;
  totalAmount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  id: string;
  bookingId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment?: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}
