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
 * Upload a single image
 */
uploads.post('/image', authMiddleware, async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as unknown as File;
    const type = formData.get('type') as string;
    const userId = c.get('userId') as string;

    if (!file) {
      return jsonError(c, 'No file provided', 'Please select a file to upload', 400);
    }

    if (!type || !['profile', 'gallery', 'verification', 'chat', 'companion-covers', 'companion-profiles'].includes(type)) {
      return jsonError(c, 'Invalid type', 'Type must be one of: profile, gallery, verification, chat, companion-covers, companion-profiles', 400);
    }

    // Validate image file
    const validation = validateImageFile(file);
    if (!validation.isValid) {
      return jsonError(c, 'Invalid image', validation.errors.join(', '), 400);
    }

    // Generate unique file key
    const fileKey = generateFileKey(userId, file.name, type);
    
    // Upload to R2
    const uploadResult = await uploadFile(
      c.env.STORAGE,
      file,
      fileKey,
      file.type,
      {
        userId,
        purpose: type,
        originalName: file.name
      }
    );

    return jsonSuccess(c, {
      url: uploadResult.url,
      filename: uploadResult.key,
      size: uploadResult.size,
      mimeType: uploadResult.contentType
    }, 'Image uploaded successfully', 201);

  } catch (error) {
    console.error('Image upload error:', error);
    return jsonError(c, 'Upload failed', 'An error occurred while uploading the image', 500);
  }
});

/**
 * Upload multiple images
 */
uploads.post('/multiple', authMiddleware, async (c) => {
  try {
    const formData = await c.req.formData();
    const files = formData.getAll('files') as unknown as File[];
    const type = formData.get('type') as string;
    const userId = c.get('userId') as string;

    if (!files || files.length === 0) {
      return jsonError(c, 'No files provided', 'Please select files to upload', 400);
    }

    if (!type || !['gallery', 'verification'].includes(type)) {
      return jsonError(c, 'Invalid type', 'Type must be one of: gallery, verification', 400);
    }

    if (files.length > 10) {
      return jsonError(c, 'Too many files', 'Maximum 10 files allowed per upload', 400);
    }

    const uploadResults = [];

    for (const file of files) {
      // Validate image file
      const validation = validateImageFile(file);
      if (!validation.isValid) {
        return jsonError(c, 'Invalid image', `File ${file.name}: ${validation.errors.join(', ')}`, 400);
      }

      // Generate unique file key
      const fileKey = generateFileKey(userId, file.name, type);
      
      // Upload to R2
      const uploadResult = await uploadFile(
        c.env.STORAGE,
        file,
        fileKey,
        file.type,
        {
          userId,
          purpose: type,
          originalName: file.name
        }
      );

      uploadResults.push({
        url: uploadResult.url,
        filename: uploadResult.key,
        size: uploadResult.size,
        mimeType: uploadResult.contentType
      });
    }

    return jsonSuccess(c, {
      urls: uploadResults
    }, 'Images uploaded successfully', 201);

  } catch (error) {
    console.error('Multiple image upload error:', error);
    return jsonError(c, 'Upload failed', 'An error occurred while uploading the images', 500);
  }
});

/**
 * Upload document file
 */
uploads.post('/document', async (c) => {
  const userId = c.get('userId');
  
  try {
    const formData = await c.req.formData();
    const fileDoc = formData.get('file') as unknown as File;
    if (!(fileDoc instanceof File)) {
      return jsonError(c, 'No file provided', 'Please select a file to upload', 400);
    }
    const category = formData.get('category') as string || 'general';
    
    // Validate document file types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];

    if (!allowedTypes.includes(fileDoc.type)) {
      return jsonError(c, 'Invalid file type', 'Only PDF, DOC, DOCX, and TXT files are allowed', 400);
    }

    // Check file size (max 25MB for documents)
    const maxSize = 25 * 1024 * 1024;
    if (fileDoc.size > maxSize) {
      return jsonError(c, 'File too large', `Maximum file size is ${formatFileSize(maxSize)}`, 400);
    }

    // Generate unique file key
    const fileKeyDoc = generateFileKey(userId || '', fileDoc.name || '', `documents/${category}`);
    
    // Upload to R2
    const uploadResultDoc = await uploadFile(
      c.env.STORAGE,
      fileDoc,
      fileKeyDoc,
      fileDoc.type || '',
      {
        userId: userId || '',
        category,
        originalName: fileDoc.name || '',
        uploadedAt: new Date().toISOString(),
        documentType: 'document'
      }
    );

    // Track upload event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'document_upload',
        userId,
        properties: { 
          fileSize: fileDoc.size,
          fileType: fileDoc.type,
          category,
          fileName: fileDoc.name
        },
        timestamp: new Date().toISOString()
      });
    }

    return jsonSuccess(c, {
      url: uploadResultDoc.url,
      key: uploadResultDoc.key,
      size: uploadResultDoc.size,
      contentType: uploadResultDoc.contentType,
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
    const fileKeyPresigned = generateFileKey(userId || '', fileName || '', `${prefix}/${category}`);
    
    // Generate presigned URL (expires in 1 hour)
    const presignedUrl = await generatePresignedUploadUrl(c.env.STORAGE, fileKeyPresigned, 3600);

    // Track presigned URL generation
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
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
    }

    return jsonSuccess(c, {
      uploadUrl: presignedUrl,
      fileKey: fileKeyPresigned,
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
    if ((fileKey || '').includes(userId || '')) {
      // Delete from R2
      await deleteFile(c.env.STORAGE, fileKey);

      // Track deletion event
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'file_deleted',
          userId,
          properties: { fileKey },
          timestamp: new Date().toISOString()
        });
      }

      return jsonSuccess(c, { deleted: true }, 'File deleted successfully');
    } else {
      return jsonError(c, 'Access denied', 'You can only delete your own files', 403);
    }

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
    if ((fileKey || '').includes(userId || '')) {
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
      if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
        await c.env.ANALYTICS_QUEUE.send({
          eventType: 'file_validated',
          userId,
          properties: { 
            fileKey,
            isValid: validationResult.isValid
          },
          timestamp: new Date().toISOString()
        });
      }

      return jsonSuccess(c, validationResult, 'File validation completed');
    } else {
      return jsonError(c, 'Access denied', 'You can only validate your own files', 403);
    }

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
    if ((fileKey || '').includes(userId || '')) {
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
    } else {
      return jsonError(c, 'Access denied', 'You can only access metadata for your own files', 403);
    }

  } catch (error) {
    console.error('Get file metadata error:', error);
    return jsonError(c, 'Failed to retrieve metadata', 'An error occurred while fetching file metadata', 500);
  }
});

/**
 * Serve images from R2 storage
 * This route allows public access to uploaded images
 */
uploads.get('/:type/:userId/:filename', async (c) => {
  try {
    const type = c.req.param('type');
    const userId = c.req.param('userId');
    const filename = c.req.param('filename');
    
    // Validate type
    if (!['profile', 'gallery', 'verification', 'chat', 'companion-covers', 'companion-profiles'].includes(type)) {
      return jsonError(c, 'Invalid type', 'Invalid image type', 400);
    }

    // Construct the key
    const key = `${type}/${userId}/${filename}`;
    
    // Get the file from R2
    const object = await c.env.STORAGE.get(key);
    
    if (!object) {
      return jsonError(c, 'File not found', 'The requested image does not exist', 404);
    }

    // Return the image with proper headers
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    headers.set('Access-Control-Allow-Origin', '*');
    
    return new Response(object.body, {
      headers
    });

  } catch (error) {
    console.error('Image serve error:', error);
    return jsonError(c, 'Failed to serve image', 'An error occurred while serving the image', 500);
  }
});

export { uploads as uploadRoutes };
