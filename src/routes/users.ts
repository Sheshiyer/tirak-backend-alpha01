import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateFileUpload } from '../utils/validation';

// Legacy profile update schema
const profileUpdateSchema = z.object({
  displayName: z.string().min(2).max(100).optional(),
  bio: z.string().max(500).optional(),
  socialLinks: z.object({
    instagram: z.string().url().optional(),
    facebook: z.string().url().optional(),
    twitter: z.string().url().optional(),
    tiktok: z.string().url().optional(),
    website: z.string().url().optional(),
    other: z.array(
      z.object({
        name: z.string(),
        url: z.string().url()
      })
    ).optional()
  }).optional(),
  preferredLanguage: z.enum(['en', 'th']).optional(),
  profileImage: z.string().url().optional()
});
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

/**
 * Get user profile (mobile app format)
 */
users.get('/profile', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const user = await getUserById(userId, c.env.DB) as any;
    if (!user) {
      return jsonError(c, 'User not found', 'The requested user does not exist', 404);
    }

    // Get profile based on user type
    let profile: any = null;
    if (user.userType === 'supplier') {
      profile = await getSupplierProfile(userId, c.env.DB);
    } else if (user.userType === 'customer') {
      profile = await getCustomerProfile(userId, c.env.DB);
    }

    // Get user preferences
    const preferences = user.notificationPreferences ? 
      JSON.parse(user.notificationPreferences) : {};
      
    const defaultPreferences = {
      language: user.preferredLanguage || 'en',
      currency: 'THB',
      notifications: {
        push: preferences.push !== false,
        email: preferences.email !== false,
        sms: preferences.sms !== false
      }
    };

    // Parse profile images based on what's available
    let profileImage = null;
    let profileImages: string[] = [];
    
    if (profile) {
      // For supplier profiles or updated customer profiles with profile_images
      if (profile.profileImages) {
        try {
          profileImages = JSON.parse(profile.profileImages);
          profileImage = profileImages[0] || null;
        } catch (e) {
          profileImages = [];
        }
      } 
      // For customer profiles with just profile_image
      else if (profile.profileImage) {
        profileImage = profile.profileImage;
        profileImages = [profileImage];
      }
    }

    // Get social links if they exist
    const socialLinks = profile?.socialLinks ? JSON.parse(profile.socialLinks) : {};

    // Format response for mobile app
    const profileData = {
      id: user.id,
      name: profile?.displayName || user.email.split('@')[0],
      displayName: profile?.displayName || user.email.split('@')[0],
      email: user.email,
      role: user.userType === 'supplier' ? 'companion' : 'customer',
      verified: user.emailVerified && user.phoneVerified,
      profileImage,
      profileImages: profileImages || [],
      phone: user.phone,
      bio: profile?.bio || '',
      socialLinks,
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
 * Get user profile by ID (legacy endpoint)
 */
users.get('/:id', validateUUID('id'), requireOwnership('id'), async (c) => {
  const userId = c.req.param('id');

  try {
    const user = await getUserById(userId, c.env.DB) as any;
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
  firstName: z.string().min(1, 'First name required').max(50, 'First name too long').optional(),
  lastName: z.string().min(1, 'Last name required').max(50, 'Last name too long').optional(),
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name too long').optional(),
  displayName: z.string().min(2, 'Display name must be at least 2 characters').max(100, 'Display name too long').optional(),
  bio: z.string().max(500, 'Bio must not exceed 500 characters').optional(),
  socialLinks: z.object({
    instagram: z.string().url('Invalid Instagram URL').optional(),
    facebook: z.string().url('Invalid Facebook URL').optional(),
    twitter: z.string().url('Invalid Twitter URL').optional(),
    tiktok: z.string().url('Invalid TikTok URL').optional(),
    website: z.string().url('Invalid Website URL').optional(),
    other: z.array(
      z.object({
        name: z.string(),
        url: z.string().url('Invalid URL')
      })
    ).optional()
  }).optional(),
  dateOfBirth: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  profileImage: z.string().url('Invalid image URL').optional(),
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
    const user = await getUserById(userId, c.env.DB) as any;
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

      if (updates.name || updates.displayName) {
        profileUpdates.push('display_name = ?');
        values.push(updates.displayName || updates.name);
      }
      if (updates.bio !== undefined) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }
      if (updates.dateOfBirth) {
        profileUpdates.push('date_of_birth = ?');
        values.push(updates.dateOfBirth);
      }
      if (updates.gender) {
        profileUpdates.push('gender = ?');
        values.push(updates.gender);
      }
      if (updates.socialLinks) {
        profileUpdates.push('social_links = ?');
        values.push(JSON.stringify(updates.socialLinks));
      }
      if (updates.profileImage) {
        // Add to profile_images array
        const profile = await getSupplierProfile(userId, c.env.DB) as any;
        const currentImages = profile?.profileImages ? JSON.parse(profile.profileImages) : [];
        const updatedImages = [updates.profileImage, ...currentImages.filter((img: string) => img !== updates.profileImage).slice(0, 9)];
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

      if (updates.name || updates.displayName) {
        profileUpdates.push('display_name = ?');
        values.push(updates.displayName || updates.name);
      }
      if (updates.bio !== undefined) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }
      if (updates.dateOfBirth) {
        profileUpdates.push('date_of_birth = ?');
        values.push(updates.dateOfBirth);
      }
      if (updates.gender) {
        profileUpdates.push('gender = ?');
        values.push(updates.gender);
      }
      if (updates.socialLinks) {
        profileUpdates.push('social_links = ?');
        values.push(JSON.stringify(updates.socialLinks));
      }
      if (updates.profileImage) {
        profileUpdates.push('profile_image = ?');
        values.push(updates.profileImage);
        
        // Also update profile_images array for consistency
        profileUpdates.push('profile_images = ?');
        const profileImagesArray = [updates.profileImage];
        values.push(JSON.stringify(profileImagesArray));
      }

      // Update preferences
      if (updates.preferences) {
        const currentProfile = await getCustomerProfile(userId, c.env.DB) as any;
        const currentPrefs = currentProfile?.preferences ? JSON.parse(currentProfile.preferences) : {};
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
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'profile_update_mobile',
        userId,
        properties: {
          updatedFields: Object.keys(updates),
          userType: user.userType
        },
        timestamp: new Date().toISOString()
      });
    }

    // Get updated profile
    let profile: any = null;
    if (user.userType === 'supplier') {
      profile = await getSupplierProfile(userId, c.env.DB);
    } else if (user.userType === 'customer') {
      profile = await getCustomerProfile(userId, c.env.DB);
    }

    const updatedUser = await getUserById(userId, c.env.DB) as any;
    if (!updatedUser) {
      return jsonError(c, 'User not found', 'The requested user does not exist after update', 500);
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

    // Parse profile images based on what's available
    let profileImage = null;
    let profileImages: string[] = [];
    
    if (profile) {
      // For supplier profiles or updated customer profiles with profile_images
      if (profile.profileImages) {
        try {
          profileImages = JSON.parse(profile.profileImages);
          profileImage = profileImages[0] || null;
        } catch (e) {
          profileImages = [];
        }
      } 
      // For customer profiles with just profile_image
      else if ('profileImage' in profile && profile.profileImage) {
        profileImage = profile.profileImage;
        profileImages = [profileImage];
      }
    }

    // Get social links
    const socialLinks = profile?.socialLinks ? JSON.parse(profile.socialLinks) : {};

    const profileData = {
      id: updatedUser.id,
      name: profile?.displayName || updatedUser.email.split('@')[0],
      displayName: profile?.displayName || updatedUser.email.split('@')[0],
      email: updatedUser.email,
      role: updatedUser.userType === 'supplier' ? 'companion' : 'customer',
      verified: updatedUser.emailVerified && updatedUser.phoneVerified,
      profileImage,
      phone: updatedUser.phone,
      bio: profile?.bio || null,
      socialLinks,
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
  const userId = c.req.param('id');
  const updates = c.req.valid('json');
  
  try {
    const user = await getUserById(userId, c.env.DB) as any;
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
    if (user.userType === 'supplier' && (updates.displayName || updates.bio || updates.socialLinks)) {
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
      if (updates.socialLinks) {
        profileUpdates.push('social_links = ?');
        values.push(JSON.stringify(updates.socialLinks));
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
    } else if (user.userType === 'customer' && (updates.displayName || updates.profileImage || updates.bio || updates.socialLinks)) {
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
      if (updates.bio) {
        profileUpdates.push('bio = ?');
        values.push(updates.bio);
      }
      if (updates.socialLinks) {
        profileUpdates.push('social_links = ?');
        values.push(JSON.stringify(updates.socialLinks));
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
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'profile_update',
        userId,
        properties: { 
          updatedFields: Object.keys(updates),
          userType: user.userType 
        },
        timestamp: new Date().toISOString()
      });
    }

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
    const userId = c.req.param('id');
    const files = c.get('uploadedFiles') as File[];
    
    if (!files || files.length === 0) {
      return jsonError(c, 'No file provided', 'Please select an image to upload', 400);
    }

    const file = files[0];
    if (!file) {
      return jsonError(c, 'Invalid file', 'The uploaded file is invalid', 400);
    }
    
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
        const profile = await getSupplierProfile(userId, c.env.DB) as any;
        const currentImages = profile?.profileImages || [];
        const updatedImages = [uploadResult.url, ...currentImages.slice(0, 9)]; // Keep max 10 images

        await c.env.DB.prepare(`
          UPDATE supplier_profiles 
          SET profile_images = ?, updated_at = ? 
          WHERE user_id = ?
        `).bind(JSON.stringify(updatedImages), new Date().toISOString(), userId).run();
      }

      // Track image upload event
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
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
      }

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
  const userId = c.req.param('id');
  
  try {
    const user = await getUserById(userId, c.env.DB) as any;
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
  const userId = c.req.param('id');
  
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
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'settings_update',
        userId,
        properties: { 
          updatedSettings: Object.keys(body),
          userType: user.userType 
        },
        timestamp: new Date().toISOString()
      });
    }

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
  const userId = c.req.param('id');
  
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
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'account_deletion',
        userId,
        properties: { 
          userType: user.userType,
          accountAge: new Date().getTime() - new Date(user.createdAt).getTime()
        },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, { deleted: true }, 'Account deleted successfully');

  } catch (error) {
    console.error('Delete account error:', error);
    return jsonError(c, 'Failed to delete account', 'An error occurred while deleting the account', 500);
  }
});

// Companion profile update route (multipart/form-data for images, JSON for other fields)
users.put('/companion/profile', async (c) => {
  const userId = c.get('userId') as string;
  const contentType = c.req.header('content-type') || '';
  let updates: any = {};
  let coverPhotoUrl: string | undefined;
  let profilePhotoUrl: string | undefined;

  try {
    // Parse form data for images
    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      if (formData.has('coverPhoto')) {
        const coverPhotoRaw = formData.get('coverPhoto');
        if (coverPhotoRaw && typeof coverPhotoRaw === 'object' && 'size' in coverPhotoRaw && (coverPhotoRaw as any).size > 0) {
          const file = coverPhotoRaw as any;
          const upload = await uploadFile(c.env.STORAGE, file, generateFileKey(userId, file.name, 'companion-covers'), file.type, { userId, purpose: 'coverPhoto' });
          coverPhotoUrl = upload.url;
        }
      }
      if (formData.has('profilePhoto')) {
        const profilePhotoRaw = formData.get('profilePhoto');
        if (profilePhotoRaw && typeof profilePhotoRaw === 'object' && 'size' in profilePhotoRaw && (profilePhotoRaw as any).size > 0) {
          const file = profilePhotoRaw as any;
          const upload = await uploadFile(c.env.STORAGE, file, generateFileKey(userId, file.name, 'companion-profiles'), file.type, { userId, purpose: 'profilePhoto' });
          profilePhotoUrl = upload.url;
        }
      }
      // Other fields as JSON
      if (formData.has('data')) {
        try {
          updates = JSON.parse(formData.get('data') as string);
        } catch (e) {
          return jsonError(c, 'Invalid data', 'Could not parse profile data', 400);
        }
      }
    } else {
      // JSON body
      updates = await c.req.json();
    }

    // Validate firstName/lastName
    if (updates.firstName && typeof updates.firstName !== 'string') {
      return jsonError(c, 'Invalid first name', 'First name must be a string', 400);
    }
    if (updates.lastName && typeof updates.lastName !== 'string') {
      return jsonError(c, 'Invalid last name', 'Last name must be a string', 400);
    }

    // Update companion_profiles table
    const profileUpdates: string[] = [];
    const values: any[] = [];
    if (updates.firstName) {
      profileUpdates.push('first_name = ?');
      values.push(updates.firstName);
    }
    if (updates.lastName) {
      profileUpdates.push('last_name = ?');
      values.push(updates.lastName);
    }
    if (coverPhotoUrl) {
      profileUpdates.push('cover_photo = ?');
      values.push(coverPhotoUrl);
    }
    if (profilePhotoUrl) {
      profileUpdates.push('profile_photo = ?');
      values.push(profilePhotoUrl);
    }
    if (updates.displayName) {
      profileUpdates.push('display_name = ?');
      values.push(updates.displayName);
    }
    if (updates.bio) {
      profileUpdates.push('bio = ?');
      values.push(updates.bio);
    }
    if (updates.socialLinks) {
      profileUpdates.push('social_links = ?');
      values.push(JSON.stringify(updates.socialLinks));
    }
    if (updates.dateOfBirth) {
      profileUpdates.push('date_of_birth = ?');
      values.push(updates.dateOfBirth);
    }
    if (updates.gender) {
      profileUpdates.push('gender = ?');
      values.push(updates.gender);
    }
    if (profileUpdates.length > 0) {
      profileUpdates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(userId);
      await c.env.DB.prepare(`
        UPDATE companion_profiles
        SET ${profileUpdates.join(', ')}
        WHERE user_id = ?
      `).bind(...values).run();
    }

    // Track profile update event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'companion_profile_update',
        userId,
        properties: {
          updatedFields: Object.keys(updates),
        },
        timestamp: new Date().toISOString()
      });
    }

    // Get updated profile directly
    const row = await c.env.DB.prepare('SELECT * FROM companion_profiles WHERE user_id = ?').bind(userId).first();
    const profile = row || {};
    return jsonSuccess(c, profile, 'Companion profile updated successfully');
  } catch (error) {
    console.error('Update companion profile error:', error);
    return jsonError(c, 'Failed to update companion profile', 'An error occurred while updating the companion profile', 500);
  }
});

// Get current user's companion profile
users.get('/companion/profile', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const row = await c.env.DB.prepare('SELECT * FROM companion_profiles WHERE user_id = ?').bind(userId).first();
    if (!row) {
      return jsonError(c, 'Not found', 'Companion profile does not exist', 404);
    }
    return jsonSuccess(c, row, 'Companion profile retrieved successfully');
  } catch (error) {
    console.error('Get companion profile error:', error);
    return jsonError(c, 'Failed to get companion profile', 'An error occurred while fetching the companion profile', 500);
  }
});

// Create a new companion profile for the current user
users.post('/companion/profile', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const body = await c.req.json();
    const {
      firstName,
      lastName,
      displayName,
      bio,
      socialLinks,
      dateOfBirth,
      gender,
      coverPhoto,
      profilePhoto
    } = body;

    // Insert new profile
    await c.env.DB.prepare(`
      INSERT INTO companion_profiles (
        user_id, first_name, last_name, display_name, bio, social_links, date_of_birth, gender, cover_photo, profile_photo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      firstName || null,
      lastName || null,
      displayName || null,
      bio || null,
      socialLinks ? JSON.stringify(socialLinks) : null,
      dateOfBirth || null,
      gender || null,
      coverPhoto || null,
      profilePhoto || null,
      new Date().toISOString(),
      new Date().toISOString()
    ).run();

    const row = await c.env.DB.prepare('SELECT * FROM companion_profiles WHERE user_id = ?').bind(userId).first();
    return jsonSuccess(c, row, 'Companion profile created successfully', 201);
  } catch (error) {
    console.error('Create companion profile error:', error);
    return jsonError(c, 'Failed to create companion profile', 'An error occurred while creating the companion profile', 500);
  }
});

export { users as userRoutes };
