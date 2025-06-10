/**
 * R2 Storage utilities for file upload and management
 */

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

export interface ImageProcessingOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  format?: 'jpeg' | 'png' | 'webp';
}

/**
 * Upload file to R2 storage
 */
export async function uploadFile(
  storage: R2Bucket,
  file: File | ArrayBuffer,
  key: string,
  contentType: string,
  metadata?: Record<string, string>
): Promise<UploadResult> {
  const uploadMetadata = {
    contentType,
    uploadedAt: new Date().toISOString(),
    ...metadata
  };

  await storage.put(key, file, {
    httpMetadata: {
      contentType,
    },
    customMetadata: uploadMetadata
  });

  const size = file instanceof File ? file.size : file.byteLength;

  return {
    key,
    url: `https://storage.tirak.app/${key}`, // This would be your R2 custom domain
    size,
    contentType
  };
}

/**
 * Generate a unique file key
 */
export function generateFileKey(userId: string, originalName: string, prefix?: string): string {
  const timestamp = Date.now();
  const randomId = crypto.randomUUID().substring(0, 8);
  const extension = originalName.split('.').pop() || '';
  const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  const keyPrefix = prefix ? `${prefix}/` : '';
  return `${keyPrefix}${userId}/${timestamp}_${randomId}_${sanitizedName}`;
}

/**
 * Validate file type and size
 */
export function validateFile(file: File, options: {
  allowedTypes?: string[];
  maxSize?: number; // in bytes
  minSize?: number; // in bytes
}): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check file size
  if (options.maxSize && file.size > options.maxSize) {
    errors.push(`File size exceeds maximum allowed size of ${formatFileSize(options.maxSize)}`);
  }
  
  if (options.minSize && file.size < options.minSize) {
    errors.push(`File size is below minimum required size of ${formatFileSize(options.minSize)}`);
  }
  
  // Check file type
  if (options.allowedTypes && !options.allowedTypes.includes(file.type)) {
    errors.push(`File type ${file.type} is not allowed. Allowed types: ${options.allowedTypes.join(', ')}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Format file size in human readable format
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Get file from R2 storage
 */
export async function getFile(storage: R2Bucket, key: string): Promise<R2Object | null> {
  return await storage.get(key);
}

/**
 * Delete file from R2 storage
 */
export async function deleteFile(storage: R2Bucket, key: string): Promise<void> {
  await storage.delete(key);
}

/**
 * Generate presigned URL for direct upload
 */
export async function generatePresignedUploadUrl(
  storage: R2Bucket,
  key: string,
  expiresIn: number = 3600 // 1 hour
): Promise<string> {
  // Note: R2 presigned URLs would be implemented here
  // This is a placeholder implementation
  return `https://upload.tirak.app/presigned/${key}?expires=${Date.now() + expiresIn * 1000}`;
}

/**
 * List files in a directory
 */
export async function listFiles(
  storage: R2Bucket,
  prefix?: string,
  limit?: number
): Promise<{ files: R2Object[]; truncated: boolean }> {
  const result = await storage.list({
    prefix,
    limit
  });

  return {
    files: result.objects,
    truncated: result.truncated
  };
}

/**
 * Copy file within R2 storage
 */
export async function copyFile(
  storage: R2Bucket,
  sourceKey: string,
  destinationKey: string
): Promise<void> {
  const sourceObject = await storage.get(sourceKey);
  if (!sourceObject) {
    throw new Error('Source file not found');
  }

  await storage.put(destinationKey, sourceObject.body, {
    httpMetadata: sourceObject.httpMetadata,
    customMetadata: sourceObject.customMetadata
  });
}

/**
 * Get file metadata
 */
export async function getFileMetadata(storage: R2Bucket, key: string): Promise<Record<string, string> | null> {
  const object = await storage.head(key);
  return object?.customMetadata || null;
}

/**
 * Update file metadata
 */
export async function updateFileMetadata(
  storage: R2Bucket,
  key: string,
  metadata: Record<string, string>
): Promise<void> {
  const object = await storage.get(key);
  if (!object) {
    throw new Error('File not found');
  }

  await storage.put(key, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: {
      ...object.customMetadata,
      ...metadata
    }
  });
}

/**
 * Validate image file specifically
 */
export function validateImageFile(file: File): { isValid: boolean; errors: string[] } {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const maxSize = 10 * 1024 * 1024; // 10MB
  
  return validateFile(file, {
    allowedTypes,
    maxSize
  });
}

/**
 * Generate thumbnail key from original image key
 */
export function generateThumbnailKey(originalKey: string, size: string = 'thumb'): string {
  const parts = originalKey.split('/');
  const filename = parts.pop() || '';
  const directory = parts.join('/');
  
  const [name, extension] = filename.split('.');
  return `${directory}/thumbnails/${name}_${size}.${extension}`;
}

/**
 * Clean up old files (for maintenance)
 */
export async function cleanupOldFiles(
  storage: R2Bucket,
  prefix: string,
  olderThanDays: number
): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  
  const { files } = await listFiles(storage, prefix);
  let deletedCount = 0;
  
  for (const file of files) {
    if (file.uploaded && file.uploaded < cutoffDate) {
      await deleteFile(storage, file.key);
      deletedCount++;
    }
  }
  
  return deletedCount;
}

/**
 * Calculate storage usage for a user
 */
export async function calculateUserStorageUsage(
  storage: R2Bucket,
  userId: string
): Promise<{ totalSize: number; fileCount: number }> {
  const { files } = await listFiles(storage, `${userId}/`);
  
  let totalSize = 0;
  let fileCount = 0;
  
  for (const file of files) {
    totalSize += file.size;
    fileCount++;
  }
  
  return { totalSize, fileCount };
}

/**
 * Generate secure download URL with expiration
 */
export async function generateSecureDownloadUrl(
  storage: R2Bucket,
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  // This would generate a signed URL for secure downloads
  // Placeholder implementation
  const token = crypto.randomUUID();
  return `https://secure.tirak.app/download/${key}?token=${token}&expires=${Date.now() + expiresIn * 1000}`;
}
