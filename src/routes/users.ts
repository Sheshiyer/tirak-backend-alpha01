import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { profileUpdateSchema, validateFileUpload } from '../utils/validation';
import { validateUUID } from '../middleware/validation';
import { authMiddleware, requireOwnership } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import {
  getUserById,
  updateUser,
  getSupplierProfile,
  getCustomerProfile
} from '../utils/database';
import { uploadFile, generateFileKey, validateImageFile } from '../utils/storage';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const users = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
users.use('*', authMiddleware);

// Apply rate limiting
users.use('*', createRateLimit('general'));

const parseJsonObject = (value: unknown, fallback: Record<string, any> = {}) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value as Record<string, any>;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const getProfileImage = (userType: string, profile: any): string | null => {
  if (!profile) return null;
  if (userType === 'supplier') {
    return Array.isArray(profile.profileImages) ? profile.profileImages[0] || null : null;
  }
  return profile.profileImage || null;
};

const companionProfileUpdateSchema = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  display_name: z.string().min(1).max(100).optional(),
  bio: z.string().max(1000).optional(),
  social_links: z.record(z.any()).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  cover_photo: z.string().optional(),
  profile_photo: z.string().optional(),
  location: z.string().max(200).optional(),
  languages: z.array(z.string()).optional(),
  specialization: z.array(z.string()).optional(),
  certifications: z.array(z.string()).optional(),
});

const formatCompanionProfile = (userId: string, profile: any) => {
  const profileImages = Array.isArray(profile?.profileImages) ? profile.profileImages : [];
  return {
    id: userId,
    userId,
    firstName: profile?.firstName || '',
    first_name: profile?.firstName || '',
    lastName: profile?.lastName || '',
    last_name: profile?.lastName || '',
    displayName: profile?.displayName || '',
    display_name: profile?.displayName || '',
    coverPhoto: profile?.coverPhoto || '',
    cover_photo: profile?.coverPhoto || '',
    profilePhoto: profileImages[0] || '',
    profile_photo: profileImages[0] || '',
    bio: profile?.bio || '',
    socialLinks: profile?.socialLinks || {},
    social_links: profile?.socialLinks || {},
    dateOfBirth: profile?.dateOfBirth || '',
    gender: profile?.gender || '',
    location: profile?.location || '',
    languages: profile?.spokenLanguages || [],
    specialization: profile?.categories || [],
    certifications: profile?.certifications || [],
    experienceStats: profile?.experienceStats || {
      yearsOfExperience: 0,
      totalGuests: 0,
      averageRating: profile?.ratingAverage || 0,
      responseTime: 'Not set',
    },
    createdAt: profile?.createdAt,
    updatedAt: profile?.updatedAt,
  };
};

/**
 * Get user profile (mobile app format)
 */
users.get('/profile', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Get profile based on user type
    let profile = null;
    if (user.userType === 'supplier') {
      profile = await getSupplierProfile(userId, c.env.DB);
    } else if (user.userType === 'customer') {
      profile = await getCustomerProfile(userId, c.env.DB);
    }

    // Get user preferences
    const preferences = JSON.parse(user.notificationPreferences || '{}');
    const defaultPreferences = {
      language: user.preferredLanguage || 'en',
      currency: 'THB',
      notifications: {
        push: preferences.push !== false,
        email: preferences.email !== false,
        sms: preferences.sms !== false
      }
    };

    // Format response for mobile app
    const profileData = {
      id: user.id,
      name: profile?.displayName || user.email.split('@')[0],
      email: user.email,
      bio: profile?.bio || null,
      role: user.userType === 'supplier' ? 'companion' : 'customer',
      verified: user.emailVerified && user.phoneVerified,
      profileImage: getProfileImage(user.userType, profile),
      phone: user.phone,
      dateOfBirth: profile?.dateOfBirth || null,
      gender: profile?.gender || null,
      preferences: defaultPreferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return jsonSuccess(c, profileData, 'Profile retrieved successfully');

  } catch (error) {
    console.error('Get profile error:', error);
    return jsonError(c, 'Failed to retrieve profile', 'An error occurred while fetching the profile', 500);
  }
});

/**
 * Get the authenticated local-guide profile in the mobile companion format.
 */
users.get('/companion/profile', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }
    if (user.userType !== 'supplier') {
      return jsonError(c, 'Access denied', 'Only local guides can access this profile', 403);
    }

    const profile = await getSupplierProfile(userId, c.env.DB);
    if (!profile) {
      return jsonError(c, 'Profile not found', 'Local guide profile does not exist', 404);
    }

    return jsonSuccess(c, formatCompanionProfile(userId, profile), 'Companion profile retrieved successfully');
  } catch (error) {
    console.error('Get companion profile error:', error);
    return jsonError(c, 'Failed to retrieve profile', 'An error occurred while fetching the companion profile', 500);
  }
});

/**
 * Update the authenticated local-guide profile in the mobile companion format.
 */
users.put('/companion/profile', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }
    if (user.userType !== 'supplier') {
      return jsonError(c, 'Access denied', 'Only local guides can update this profile', 403);
    }

    let rawPayload: any = {};
    let uploadedProfilePhoto: string | undefined;
    let uploadedCoverPhoto: string | undefined;
    const contentType = c.req.header('Content-Type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      const data = formData.get('data');
      rawPayload = typeof data === 'string' ? JSON.parse(data) : {};

      const profileFile = formData.get('profilePhoto');
      if (profileFile && typeof profileFile === 'object' && 'name' in profileFile) {
        const file = profileFile as File;
        const validation = validateImageFile(file);
        if (!validation.isValid) {
          return jsonError(c, 'Invalid profile photo', validation.errors.join(', '), 400);
        }
        const upload = await uploadFile(
          c.env.STORAGE,
          file,
          generateFileKey(userId, file.name || 'profile.jpg', 'avatars'),
          file.type || 'image/jpeg',
          { userId, purpose: 'companion-profile-photo' }
        );
        uploadedProfilePhoto = upload.url;
      }

      const coverFile = formData.get('coverPhoto');
      if (coverFile && typeof coverFile === 'object' && 'name' in coverFile) {
        const file = coverFile as File;
        const validation = validateImageFile(file);
        if (!validation.isValid) {
          return jsonError(c, 'Invalid cover photo', validation.errors.join(', '), 400);
        }
        const upload = await uploadFile(
          c.env.STORAGE,
          file,
          generateFileKey(userId, file.name || 'cover.jpg', 'covers'),
          file.type || 'image/jpeg',
          { userId, purpose: 'companion-cover-photo' }
        );
        uploadedCoverPhoto = upload.url;
      }
    } else {
      rawPayload = await c.req.json();
    }

    const payload = companionProfileUpdateSchema.parse(rawPayload);
    const existing = await getSupplierProfile(userId, c.env.DB);
    if (!existing) {
      return jsonError(c, 'Profile not found', 'Local guide profile does not exist', 404);
    }

    const profilePhoto = uploadedProfilePhoto || payload.profile_photo;
    const profileImages = profilePhoto
      ? [profilePhoto, ...(existing.profileImages || []).filter(image => image !== profilePhoto).slice(0, 9)]
      : existing.profileImages || [];

    const coverPhoto = uploadedCoverPhoto || payload.cover_photo || existing.coverPhoto || null;
    const displayName = payload.display_name || existing.displayName;

    await c.env.DB.prepare(`
      UPDATE supplier_profiles
      SET first_name = ?, last_name = ?, display_name = ?, bio = ?, location = ?,
          social_links = ?, date_of_birth = ?, gender = ?, cover_photo = ?,
          profile_images = ?, categories = ?, regions = ?, spoken_languages = ?,
          certifications = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(
      payload.first_name ?? existing.firstName ?? null,
      payload.last_name ?? existing.lastName ?? null,
      displayName,
      payload.bio ?? existing.bio ?? null,
      payload.location ?? existing.location ?? null,
      JSON.stringify(payload.social_links ?? existing.socialLinks ?? {}),
      payload.dateOfBirth ?? existing.dateOfBirth ?? null,
      payload.gender ?? existing.gender ?? null,
      coverPhoto,
      JSON.stringify(profileImages),
      JSON.stringify(payload.specialization ?? existing.categories ?? []),
      JSON.stringify(existing.regions ?? []),
      JSON.stringify(payload.languages ?? existing.spokenLanguages ?? []),
      JSON.stringify(payload.certifications ?? existing.certifications ?? []),
      new Date().toISOString(),
      userId
    ).run();

    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'companion_profile_update',
      userId,
      properties: { updatedFields: Object.keys(rawPayload) },
      timestamp: new Date().toISOString()
    });

    const updatedProfile = await getSupplierProfile(userId, c.env.DB);
    return jsonSuccess(c, formatCompanionProfile(userId, updatedProfile), 'Companion profile updated successfully');
  } catch (error) {
    console.error('Update companion profile error:', error);
    if (error instanceof z.ZodError) {
      return jsonError(c, 'Invalid profile data', error.errors[0]?.message || 'Invalid companion profile payload', 400);
    }
    return jsonError(c, 'Failed to update profile', 'An error occurred while updating the companion profile', 500);
  }
});

/**
 * Get user profile by ID (legacy endpoint)
 */
users.get('/:id', validateUUID('id'), requireOwnership('id'), async (c) => {
  const userId = c.req.param('id') as string;

  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Get profile based on user type
    let profile = null;
    if (user.userType === 'supplier') {
      profile = await getSupplierProfile(userId, c.env.DB);
    } else if (user.userType === 'customer') {
      profile = await getCustomerProfile(userId, c.env.DB);
    }

    // Remove sensitive information
    const { passwordHash, ...safeUser } = user;

    return jsonSuccess(c, {
      user: safeUser,
      profile
    }, 'Profile retrieved successfully');

  } catch (error) {
    console.error('Get profile error:', error);
    return jsonError(c, 'Failed to retrieve profile', 'An error occurred while fetching the profile', 500);
  }
});

// Mobile app profile update schema
const updateMobileProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name too long').optional(),
  bio: z.string().max(500, 'Bio too long').optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  profileImage: z.string().min(1, 'Invalid image reference').optional(),
  preferences: z.object({
    language: z.enum(['en', 'th']).optional(),
    currency: z.enum(['THB', 'USD']).optional(),
    notifications: z.object({
      push: z.boolean().optional(),
      email: z.boolean().optional(),
      sms: z.boolean().optional()
    }).optional()
  }).optional()
});

/**
 * Update user profile (mobile app format)
 */
users.put('/profile', zValidator('json', updateMobileProfileSchema), async (c) => {
  const userId = c.get('userId') as string;
  const updates = c.req.valid('json');

  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Update user table
    const userUpdates: any = {};
    if (updates.preferences?.language) {
      userUpdates.preferredLanguage = updates.preferences.language;
    }

    // Update notification preferences
    if (updates.preferences?.notifications) {
      const currentPrefs = JSON.parse(user.notificationPreferences || '{}');
      const updatedPrefs = { ...currentPrefs, ...updates.preferences.notifications };
      userUpdates.notificationPreferences = JSON.stringify(updatedPrefs);
    }

    if (Object.keys(userUpdates).length > 0) {
      await updateUser(userId, userUpdates, c.env.DB);
    }

    // Update profile table based on user type
    if (user.userType === 'supplier') {
      const profileUpdates: string[] = [];
      const values: any[] = [];

      if (updates.name) {
        profileUpdates.push('display_name = ?');
        values.push(updates.name);
      }
      if (updates.dateOfBirth) {
        profileUpdates.push('date_of_birth = ?');
        values.push(updates.dateOfBirth);
      }
      if (updates.bio) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }
      if (updates.gender) {
        profileUpdates.push('gender = ?');
        values.push(updates.gender);
      }
      if (updates.profileImage) {
        // Add to profile_images array
        const profile = await getSupplierProfile(userId, c.env.DB);
        const currentImages = profile?.profileImages || [];
        const updatedImages = [updates.profileImage, ...currentImages.filter(img => img !== updates.profileImage).slice(0, 9)];
        profileUpdates.push('profile_images = ?');
        values.push(JSON.stringify(updatedImages));
      }

      if (profileUpdates.length > 0) {
        profileUpdates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(userId);

        await c.env.DB.prepare(`
          UPDATE supplier_profiles
          SET ${profileUpdates.join(', ')}
          WHERE user_id = ?
        `).bind(...values).run();
      }
    } else if (user.userType === 'customer') {
      const profileUpdates: string[] = [];
      const values: any[] = [];

      if (updates.name) {
        profileUpdates.push('display_name = ?');
        values.push(updates.name);
      }
      if (updates.dateOfBirth) {
        profileUpdates.push('date_of_birth = ?');
        values.push(updates.dateOfBirth);
      }
      if (updates.bio) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }
      if (updates.gender) {
        profileUpdates.push('gender = ?');
        values.push(updates.gender);
      }
      if (updates.profileImage) {
        profileUpdates.push('profile_image = ?');
        values.push(updates.profileImage);
      }

      // Update preferences
      if (updates.preferences) {
        const currentProfile = await getCustomerProfile(userId, c.env.DB);
        const currentPrefs = parseJsonObject(currentProfile?.preferences);
        const updatedPrefs = { ...currentPrefs, ...updates.preferences };
        profileUpdates.push('preferences = ?');
        values.push(JSON.stringify(updatedPrefs));
      }

      if (profileUpdates.length > 0) {
        profileUpdates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(userId);

        await c.env.DB.prepare(`
          UPDATE customer_profiles
          SET ${profileUpdates.join(', ')}
          WHERE user_id = ?
        `).bind(...values).run();
      }
    }

    // Track profile update event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'profile_update_mobile',
      userId,
      properties: {
        updatedFields: Object.keys(updates),
        userType: user.userType
      },
      timestamp: new Date().toISOString()
    });

    // Get updated profile
    let profile = null;
    if (user.userType === 'supplier') {
      profile = await getSupplierProfile(userId, c.env.DB);
    } else if (user.userType === 'customer') {
      profile = await getCustomerProfile(userId, c.env.DB);
    }

    const updatedUser = await getUserById(userId, c.env.DB);
    if (!updatedUser) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }
    const preferences = JSON.parse(updatedUser.notificationPreferences || '{}');
    const defaultPreferences = {
      language: updatedUser.preferredLanguage || 'en',
      currency: 'THB',
      notifications: {
        push: preferences.push !== false,
        email: preferences.email !== false,
        sms: preferences.sms !== false
      }
    };

    const profileData = {
      id: updatedUser.id,
      name: profile?.displayName || updatedUser.email.split('@')[0],
      email: updatedUser.email,
      bio: profile?.bio || null,
      role: updatedUser.userType === 'supplier' ? 'companion' : 'customer',
      verified: updatedUser.emailVerified && updatedUser.phoneVerified,
      profileImage: getProfileImage(updatedUser.userType, profile),
      phone: updatedUser.phone,
      dateOfBirth: profile?.dateOfBirth || null,
      gender: profile?.gender || null,
      preferences: defaultPreferences,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    return jsonSuccess(c, profileData, 'Profile updated successfully');

  } catch (error) {
    console.error('Update mobile profile error:', error);
    return jsonError(c, 'Failed to update profile', 'An error occurred while updating the profile', 500);
  }
});

/**
 * Update user profile (legacy endpoint)
 */
users.put('/:id', validateUUID('id'), requireOwnership('id'), zValidator('json', profileUpdateSchema), async (c) => {
  const userId = c.req.param('id') as string;
  const updates = c.req.valid('json');
  
  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Update user table
    const userUpdates: any = {};
    if (updates.preferredLanguage) {
      userUpdates.preferredLanguage = updates.preferredLanguage;
    }

    if (Object.keys(userUpdates).length > 0) {
      await updateUser(userId, userUpdates, c.env.DB);
    }

    // Update profile table based on user type
    if (user.userType === 'supplier' && (updates.displayName || updates.bio)) {
      const profileUpdates: string[] = [];
      const values: any[] = [];

      if (updates.displayName) {
        profileUpdates.push('display_name = ?');
        values.push(updates.displayName);
      }
      if (updates.bio) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }

      if (profileUpdates.length > 0) {
        profileUpdates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(userId);

        await c.env.DB.prepare(`
          UPDATE supplier_profiles 
          SET ${profileUpdates.join(', ')} 
          WHERE user_id = ?
        `).bind(...values).run();
      }
    } else if (user.userType === 'customer' && (updates.displayName || updates.profileImage)) {
      const profileUpdates: string[] = [];
      const values: any[] = [];

      if (updates.displayName) {
        profileUpdates.push('display_name = ?');
        values.push(updates.displayName);
      }
      if (updates.profileImage) {
        profileUpdates.push('profile_image = ?');
        values.push(updates.profileImage);
      }

      if (profileUpdates.length > 0) {
        profileUpdates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(userId);

        await c.env.DB.prepare(`
          UPDATE customer_profiles 
          SET ${profileUpdates.join(', ')} 
          WHERE user_id = ?
        `).bind(...values).run();
      }
    }

    // Track profile update event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'profile_update',
      userId,
      properties: { 
        updatedFields: Object.keys(updates),
        userType: user.userType 
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { updated: true }, 'Profile updated successfully');

  } catch (error) {
    console.error('Update profile error:', error);
    return jsonError(c, 'Failed to update profile', 'An error occurred while updating the profile', 500);
  }
});

/**
 * Upload profile image
 */
users.post('/:id/avatar', 
  validateUUID('id'), 
  requireOwnership('id'),
  validateFileUpload({
    maxSize: 5 * 1024 * 1024, // 5MB
    allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
    required: true,
    maxFiles: 1
  }),
  async (c) => {
    const userId = c.req.param('id') as string;
    const files = c.get('uploadedFiles') as File[];
    
    if (!files || files.length === 0) {
      return jsonError(c, 'No file provided', 'Please select an image to upload', 400);
    }

    const file = files[0]!;
    
    try {
      // Validate image file
      const validation = validateImageFile(file);
      if (!validation.isValid) {
        return jsonError(c, 'Invalid image', validation.errors.join(', '), 400);
      }

      // Generate unique file key
      const fileKey = generateFileKey(userId, file.name, 'avatars');
      
      // Upload to R2
      const uploadResult = await uploadFile(
        c.env.STORAGE,
        file,
        fileKey,
        file.type,
        {
          userId,
          purpose: 'avatar',
          originalName: file.name
        }
      );

      // Update user profile with new image URL
      const user = await getUserById(userId, c.env.DB);
      if (!user) {
        return jsonError(c, 'User not found', 'The requested user does not exist', 404);
      }

      if (user.userType === 'customer') {
        await c.env.DB.prepare(`
          UPDATE customer_profiles 
          SET profile_image = ?, updated_at = ? 
          WHERE user_id = ?
        `).bind(uploadResult.url, new Date().toISOString(), userId).run();
      } else if (user.userType === 'supplier') {
        // For suppliers, add to profile_images array
        const profile = await getSupplierProfile(userId, c.env.DB);
        const currentImages = profile?.profileImages || [];
        const updatedImages = [uploadResult.url, ...currentImages.slice(0, 9)]; // Keep max 10 images

        await c.env.DB.prepare(`
          UPDATE supplier_profiles 
          SET profile_images = ?, updated_at = ? 
          WHERE user_id = ?
        `).bind(JSON.stringify(updatedImages), new Date().toISOString(), userId).run();
      }

      // Track image upload event
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'avatar_upload',
        userId,
        properties: { 
          fileSize: file.size,
          fileType: file.type,
          userType: user.userType
        },
        timestamp: new Date().toISOString()
      });

      return jsonSuccess(c, {
        imageUrl: uploadResult.url,
        fileKey: uploadResult.key,
        size: uploadResult.size
      }, 'Profile image uploaded successfully', 201);

    } catch (error) {
      console.error('Avatar upload error:', error);
      return jsonError(c, 'Upload failed', 'An error occurred while uploading the image', 500);
    }
  }
);

/**
 * Get user settings
 */
users.get('/:id/settings', validateUUID('id'), requireOwnership('id'), async (c) => {
  const userId = c.req.param('id') as string;
  
  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Get user preferences from profile
    let preferences = {};
    if (user.userType === 'customer') {
      const profile = await getCustomerProfile(userId, c.env.DB);
      preferences = profile?.preferences || {};
    }

    const settings = {
      notifications: {
        email: true, // Default settings
        push: true,
        sms: false
      },
      privacy: {
        profileVisible: true,
        showOnlineStatus: true,
        allowDirectMessages: true
      },
      preferences,
      language: user.preferredLanguage
    };

    return jsonSuccess(c, settings, 'Settings retrieved successfully');

  } catch (error) {
    console.error('Get settings error:', error);
    return jsonError(c, 'Failed to retrieve settings', 'An error occurred while fetching settings', 500);
  }
});

/**
 * Update user settings
 */
users.put('/:id/settings', validateUUID('id'), requireOwnership('id'), async (c) => {
  const userId = c.req.param('id') as string;
  
  try {
    const body = await c.req.json();
    const { notifications, privacy, preferences, language } = body;

    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Update language preference in users table
    if (language && ['en', 'th'].includes(language)) {
      await updateUser(userId, { preferredLanguage: language }, c.env.DB);
    }

    // Update preferences in profile table
    if (preferences && user.userType === 'customer') {
      const currentProfile = await getCustomerProfile(userId, c.env.DB);
      const updatedPreferences = { 
        ...currentProfile?.preferences, 
        ...preferences,
        notifications,
        privacy
      };

      await c.env.DB.prepare(`
        UPDATE customer_profiles 
        SET preferences = ?, updated_at = ? 
        WHERE user_id = ?
      `).bind(JSON.stringify(updatedPreferences), new Date().toISOString(), userId).run();
    }

    // Track settings update event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'settings_update',
      userId,
      properties: { 
        updatedSettings: Object.keys(body),
        userType: user.userType 
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { updated: true }, 'Settings updated successfully');

  } catch (error) {
    console.error('Update settings error:', error);
    return jsonError(c, 'Failed to update settings', 'An error occurred while updating settings', 500);
  }
});

/**
 * Delete user account
 */
users.delete('/:id', validateUUID('id'), requireOwnership('id'), async (c) => {
  const userId = c.req.param('id') as string;
  
  try {
    const user = await getUserById(userId, c.env.DB);
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Soft delete - mark as deleted instead of removing data
    await updateUser(userId, { 
      status: 'suspended',
      email: `deleted_${Date.now()}_${user.email}`,
      phone: `deleted_${Date.now()}_${user.phone}`
    }, c.env.DB);

    // Track account deletion event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'account_deletion',
      userId,
      properties: { 
        userType: user.userType,
        accountAge: new Date().getTime() - new Date(user.createdAt).getTime()
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { deleted: true }, 'Account deleted successfully');

  } catch (error) {
    console.error('Delete account error:', error);
    return jsonError(c, 'Failed to delete account', 'An error occurred while deleting the account', 500);
  }
});

export { users as userRoutes };
