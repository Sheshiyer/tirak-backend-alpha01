import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { fileUploadSchema } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { 
  uploadFile, 
  generateFileKey, 
  validateImageFile, 
  deleteFile,
  generatePresignedUploadUrl,
  formatFileSize 
} from '../utils/storage';
import { jsonSuccess, jsonError } from '../utils/response';
import type { Env, Variables } from '../index';

const uploads = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
uploads.use('*', authMiddleware);

// Apply rate limiting for uploads
uploads.use('*', createRateLimit('upload'));

/**
 * Upload image file
 */
uploads.post('/image', async (c) => {
  const userId = c.get('userId');
  
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const category = formData.get('category') as string || 'general';
    
    if (!file) {
      return jsonError(c, 'No file provided', 'Please select a file to upload', 400);
    }

    // Validate file
    const validation = validateImageFile(file);
    if (!validation.isValid) {
      return jsonError(c, 'Invalid file', validation.errors.join(', '), 400);
    }

    // Check file size (max 10MB for images)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return jsonError(c, 'File too large', `Maximum file size is ${formatFileSize(maxSize)}`, 400);
    }

    // Generate unique file key
    const fileKey = generateFileKey(userId, file.name, `images/${category}`);
    
    // Upload to R2
    const uploadResult = await uploadFile(
      c.env.STORAGE,
      file,
      fileKey,
      file.type,
      {
        userId,
        category,
        originalName: file.name,
        uploadedAt: new Date().toISOString()
      }
    );

    // Track upload event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'image_upload',
      userId,
      properties: { 
        fileSize: file.size,
        fileType: file.type,
        category,
        fileName: file.name
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      url: uploadResult.url,
      key: uploadResult.key,
      size: uploadResult.size,
      contentType: uploadResult.contentType,
      category
    }, 'Image uploaded successfully', 201);

  } catch (error) {
    console.error('Image upload error:', error);
    return jsonError(c, 'Upload failed', 'An error occurred while uploading the image', 500);
  }
});

/**
 * Upload document file
 */
uploads.post('/document', async (c) => {
  const userId = c.get('userId');
  
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const category = formData.get('category') as string || 'general';
    
    if (!file) {
      return jsonError(c, 'No file provided', 'Please select a file to upload', 400);
    }

    // Validate document file types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];

    if (!allowedTypes.includes(file.type)) {
      return jsonError(c, 'Invalid file type', 'Only PDF, DOC, DOCX, and TXT files are allowed', 400);
    }

    // Check file size (max 25MB for documents)
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      return jsonError(c, 'File too large', `Maximum file size is ${formatFileSize(maxSize)}`, 400);
    }

    // Generate unique file key
    const fileKey = generateFileKey(userId, file.name, `documents/${category}`);
    
    // Upload to R2
    const uploadResult = await uploadFile(
      c.env.STORAGE,
      file,
      fileKey,
      file.type,
      {
        userId,
        category,
        originalName: file.name,
        uploadedAt: new Date().toISOString(),
        documentType: 'document'
      }
    );

    // Track upload event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'document_upload',
      userId,
      properties: { 
        fileSize: file.size,
        fileType: file.type,
        category,
        fileName: file.name
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      url: uploadResult.url,
      key: uploadResult.key,
      size: uploadResult.size,
      contentType: uploadResult.contentType,
      category
    }, 'Document uploaded successfully', 201);

  } catch (error) {
    console.error('Document upload error:', error);
    return jsonError(c, 'Upload failed', 'An error occurred while uploading the document', 500);
  }
});

/**
 * Generate presigned upload URL for direct client uploads
 */
uploads.post('/presigned-url', zValidator('json', fileUploadSchema), async (c) => {
  const userId = c.get('userId');
  const { fileName, fileSize, contentType, category } = c.req.valid('json');
  
  try {
    // Validate file size
    const maxSize = contentType.startsWith('image/') ? 10 * 1024 * 1024 : 25 * 1024 * 1024;
    if (fileSize > maxSize) {
      return jsonError(c, 'File too large', `Maximum file size is ${formatFileSize(maxSize)}`, 400);
    }

    // Validate content type
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const allowedDocTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];

    const isValidType = [...allowedImageTypes, ...allowedDocTypes].includes(contentType);
    if (!isValidType) {
      return jsonError(c, 'Invalid file type', 'File type not supported', 400);
    }

    // Generate unique file key
    const prefix = contentType.startsWith('image/') ? 'images' : 'documents';
    const fileKey = generateFileKey(userId, fileName, `${prefix}/${category}`);
    
    // Generate presigned URL (expires in 1 hour)
    const presignedUrl = await generatePresignedUploadUrl(c.env.STORAGE, fileKey, 3600);

    // Track presigned URL generation
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'presigned_url_generated',
      userId,
      properties: { 
        fileSize,
        contentType,
        category,
        fileName
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      uploadUrl: presignedUrl,
      fileKey,
      expiresIn: 3600,
      maxFileSize: maxSize
    }, 'Presigned URL generated successfully');

  } catch (error) {
    console.error('Presigned URL generation error:', error);
    return jsonError(c, 'Failed to generate upload URL', 'An error occurred while generating the upload URL', 500);
  }
});

/**
 * Delete uploaded file
 */
uploads.delete('/:fileKey', async (c) => {
  const fileKey = c.req.param('fileKey');
  const userId = c.get('userId');
  
  try {
    // Verify user owns the file (file key should contain user ID)
    if (!fileKey.includes(userId)) {
      return jsonError(c, 'Access denied', 'You can only delete your own files', 403);
    }

    // Delete from R2
    await deleteFile(c.env.STORAGE, fileKey);

    // Track deletion event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'file_deleted',
      userId,
      properties: { fileKey },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { deleted: true }, 'File deleted successfully');

  } catch (error) {
    console.error('File deletion error:', error);
    return jsonError(c, 'Deletion failed', 'An error occurred while deleting the file', 500);
  }
});

/**
 * Get upload statistics for user
 */
uploads.get('/stats', async (c) => {
  const userId = c.get('userId');
  
  try {
    // This would typically query a database of file metadata
    // For now, we'll return placeholder statistics
    const stats = {
      totalFiles: 0,
      totalSize: 0,
      imageCount: 0,
      documentCount: 0,
      storageUsed: '0 MB',
      storageLimit: '1 GB',
      recentUploads: []
    };

    return jsonSuccess(c, stats, 'Upload statistics retrieved successfully');

  } catch (error) {
    console.error('Get upload stats error:', error);
    return jsonError(c, 'Failed to retrieve statistics', 'An error occurred while fetching upload statistics', 500);
  }
});

/**
 * Validate uploaded file (security scan placeholder)
 */
uploads.post('/validate/:fileKey', async (c) => {
  const fileKey = c.req.param('fileKey');
  const userId = c.get('userId');
  
  try {
    // Verify user owns the file
    if (!fileKey.includes(userId)) {
      return jsonError(c, 'Access denied', 'You can only validate your own files', 403);
    }

    // In a real implementation, this would:
    // 1. Scan file for viruses/malware
    // 2. Validate file integrity
    // 3. Check for inappropriate content
    // 4. Verify file format matches extension

    // For now, return a successful validation
    const validationResult = {
      isValid: true,
      scannedAt: new Date().toISOString(),
      threats: [],
      warnings: [],
      fileInfo: {
        key: fileKey,
        status: 'clean'
      }
    };

    // Track validation event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'file_validated',
      userId,
      properties: { 
        fileKey,
        isValid: validationResult.isValid
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, validationResult, 'File validation completed');

  } catch (error) {
    console.error('File validation error:', error);
    return jsonError(c, 'Validation failed', 'An error occurred while validating the file', 500);
  }
});

/**
 * Get file metadata
 */
uploads.get('/metadata/:fileKey', async (c) => {
  const fileKey = c.req.param('fileKey');
  const userId = c.get('userId');
  
  try {
    // Verify user owns the file
    if (!fileKey.includes(userId)) {
      return jsonError(c, 'Access denied', 'You can only access metadata for your own files', 403);
    }

    // Get file metadata from R2
    const metadata = await c.env.STORAGE.head(fileKey);
    
    if (!metadata) {
      return jsonError(c, 'File not found', 'The requested file does not exist', 404);
    }

    const fileMetadata = {
      key: fileKey,
      size: metadata.size,
      contentType: metadata.httpMetadata?.contentType,
      lastModified: metadata.uploaded,
      etag: metadata.etag,
      customMetadata: metadata.customMetadata
    };

    return jsonSuccess(c, fileMetadata, 'File metadata retrieved successfully');

  } catch (error) {
    console.error('Get file metadata error:', error);
    return jsonError(c, 'Failed to retrieve metadata', 'An error occurred while fetching file metadata', 500);
  }
});

export { uploads as uploadRoutes };
