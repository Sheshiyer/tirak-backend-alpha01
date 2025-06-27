// API request/response type definitions

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationResponse {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SearchParams extends PaginationParams {
  query?: string;
  region?: string;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  language?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Auth API types
export interface RegisterRequest {
  email: string;
  phone: string;
  password: string;
  userType: 'customer' | 'supplier' | 'companion';
  preferredLanguage?: 'en' | 'th';
}

export interface LoginRequest {
  identifier: string; // email or phone
  password: string;
  deviceId?: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    phone: string;
    userType: string;
    status: string;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// User API types
export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string;
  preferredLanguage?: 'en' | 'th';
  profileImage?: string;
}

// Supplier API types
export interface SupplierSearchResponse {
  suppliers: SupplierListItem[];
  pagination: PaginationResponse;
}

export interface SupplierListItem {
  id: string;
  displayName: string;
  bio: string;
  profileImages: string[];
  categories: string[];
  regions: string[];
  spokenLanguages: string[];
  rating: {
    average: number;
    count: number;
  };
  verificationStatus: string;
}

export interface SupplierDetailResponse {
  id: string;
  displayName: string;
  bio: string;
  profileImages: string[];
  categories: string[];
  regions: string[];
  spokenLanguages: string[];
  rating: {
    average: number;
    count: number;
  };
  verificationStatus: string;
  subscriptionStatus: string;
  services: ServiceItem[];
  availability: AvailabilityItem[];
  memberSince: string;
}

export interface ServiceItem {
  id: string;
  title: string;
  description: string;
  priceMin: number;
  priceMax: number;
  currency: string;
  durationHours: number;
}

export interface AvailabilityItem {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

// Companion API types
export interface ExperienceItem {
  id: string;
  title: string;
  description?: string;
  durationMinutes: number;
  keywords?: string[];
  price: number;
  currency: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocationItem {
  id: string;
  city: string;
  region: string;
  isPopular: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionDetailResponse extends SupplierDetailResponse {
  experiences: ExperienceItem[];
  locations: LocationItem[];
}

export interface CreateExperienceRequest {
  title: string;
  description?: string;
  durationMinutes: number;
  keywords?: string[];
  price: number;
  currency?: string;
}

export interface CreateLocationRequest {
  city: string;
  region: string;
  isPopular?: boolean;
  description?: string;
}

// Enhanced booking types
export interface CustomerPreferences {
  title?: string;
  description?: string;
}

export interface EnhancedBookingRequest {
  companionId: string;
  experienceId?: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  location?: string;
  customerPreferences?: CustomerPreferences;
  specialRequests?: string;
  preferredLanguage?: string;
  groupComposition?: string;
  dietaryRequirements?: string;
  paymentMethodId: string;
}

export interface BookingSummaryResponse {
  id: string;
  companion: {
    id: string;
    name: string;
    profileImage?: string;
  };
  customer: {
    id: string;
    name: string;
  };
  experience?: {
    id: string;
    title: string;
    description?: string;
    price: number;
  };
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  location?: string;
  customerPreferences?: CustomerPreferences;
  specialRequests?: string;
  preferredLanguage?: string;
  groupComposition?: string;
  dietaryRequirements?: string;
  status: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
}

// Chat API types
export interface SendMessageRequest {
  roomId: string;
  messageType: 'text' | 'image';
  content?: string;
  imageUrl?: string;
}

export interface ChatMessageResponse {
  id: string;
  roomId: string;
  senderId: string;
  messageType: string;
  content?: string;
  imageUrl?: string;
  createdAt: string;
}

// Upload API types
export interface UploadResponse {
  url: string;
  key: string;
  size: number;
  contentType: string;
}
