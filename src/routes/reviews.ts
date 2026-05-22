import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import { firstProfileImage } from '../utils/profileImages';
import type { Env, Variables } from '../index';

const reviews = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
reviews.use('*', authMiddleware);
reviews.use('*', createRateLimit('review'));

// Review creation schema
const createReviewSchema = z.object({
  bookingId: z.string().uuid('Invalid booking ID'),
  companionId: z.string().uuid('Invalid companion ID'),
  rating: z.number().min(1, 'Rating must be at least 1').max(5, 'Rating cannot exceed 5'),
  comment: z.string().max(1000, 'Comment too long'),
  categories: z.object({
    communication: z.number().min(1).max(5),
    punctuality: z.number().min(1).max(5),
    professionalism: z.number().min(1).max(5),
    knowledge: z.number().min(1).max(5)
  }).optional()
});

/**
 * Create review
 */
reviews.post('/', zValidator('json', createReviewSchema), async (c) => {
  const userId = c.get('userId');
  const userType = c.get('userType');
  const reviewData = c.req.valid('json');
  
  try {
    // Only customers can create reviews
    if (userType !== 'customer') {
      return jsonError(c, 'Access denied', 'Only customers can create reviews', 403);
    }

    // Validate booking exists and is completed
    const booking = await c.env.DB.prepare(`
      SELECT id, customer_id, companion_id, status
      FROM bookings
      WHERE id = ? AND customer_id = ? AND companion_id = ? AND status = 'completed'
    `).bind(reviewData.bookingId, userId, reviewData.companionId).first();

    if (!booking) {
      return jsonError(c, 'Booking not found', 'Booking not found or not eligible for review', 404);
    }

    // Check if review already exists
    const existingReview = await c.env.DB.prepare(`
      SELECT id FROM reviews WHERE booking_id = ? AND reviewer_id = ?
    `).bind(reviewData.bookingId, userId).first();

    if (existingReview) {
      return jsonError(c, 'Review exists', 'You have already reviewed this booking', 409);
    }

    // Create review
    const reviewId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO reviews (
        id, booking_id, reviewer_id, reviewee_id, rating, comment,
        is_public, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reviewId,
      reviewData.bookingId,
      userId,
      reviewData.companionId,
      reviewData.rating,
      reviewData.comment,
      true, // Reviews from completed bookings are verified
      now,
      now
    ).run();

    // Update companion's rating
    await updateCompanionRating(c.env.DB, reviewData.companionId);

    // Track review creation event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'review_created',
      userId,
      properties: {
        reviewId,
        bookingId: reviewData.bookingId,
        companionId: reviewData.companionId,
        rating: reviewData.rating
      },
      timestamp: now
    });

    // Send notification to companion
    await c.env.NOTIFICATION_QUEUE.send({
      type: 'review_received',
      userId: reviewData.companionId,
      title: 'New Review Received',
      message: `You received a ${reviewData.rating}-star review`,
      data: { reviewId, rating: reviewData.rating },
      timestamp: now
    });

    // Get created review with customer details
    const createdReview = await c.env.DB.prepare(`
      SELECT 
        r.*,
        cp.display_name as customer_name,
        cp.profile_image as customer_image
      FROM reviews r
      JOIN customer_profiles cp ON r.reviewer_id = cp.user_id
      WHERE r.id = ?
    `).bind(reviewId).first();

    if (!createdReview) {
      return jsonError(c, 'Review failed', 'Created review could not be loaded', 500);
    }

    const created = createdReview as any;

    return jsonSuccess(c, {
      review: {
        id: created.id,
        bookingId: created.booking_id,
        companionId: created.reviewee_id,
        customerId: created.reviewer_id,
        rating: created.rating,
        comment: created.comment,
        categories: reviewData.categories || {},
        verified: true,
        createdAt: created.created_at
      }
    }, 'Review created successfully', 201);

  } catch (error) {
    console.error('Create review error:', error);
    return jsonError(c, 'Review failed', 'An error occurred while creating the review', 500);
  }
});

/**
 * Get companion reviews
 */
reviews.get('/companion/:id', validateUUID('id'), validatePagination(), async (c) => {
  const companionId = c.req.param('id');
  const { page, limit } = c.get('validatedQuery');
  const rating = c.req.query('rating');
  
  try {
    // Verify companion exists
    const companion = await c.env.DB.prepare(`
      SELECT user_id FROM supplier_profiles WHERE user_id = ?
    `).bind(companionId).first();

    if (!companion) {
      return jsonError(c, 'Companion not found', 'The requested companion does not exist', 404);
    }

    let query = `
      SELECT 
        r.*,
        cp.display_name as customer_name,
        cp.profile_image as customer_image
      FROM reviews r
      JOIN customer_profiles cp ON r.reviewer_id = cp.user_id
      WHERE r.reviewee_id = ? AND r.is_public = TRUE
    `;

    const queryParams = [companionId];

    if (rating) {
      query += ` AND r.rating = ?`;
      queryParams.push(rating);
    }

    query += ` ORDER BY r.created_at DESC`;

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = Number((countResult as any)?.total || 0);

    // Get paginated results
    const offset = (page - 1) * limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const reviewsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, limit, offset).all();

    const reviewsList = reviewsResult.results.map((review: any) => ({
        id: review.id,
        customer: {
        id: review.reviewer_id,
        name: review.customer_name,
        profileImage: firstProfileImage(review.customer_image)
      },
      rating: review.rating,
      comment: review.comment,
      categories: {},
      verified: true,
      createdAt: review.created_at
    }));

    // Get review summary
    const summaryResult = await c.env.DB.prepare(`
      SELECT 
        AVG(rating) as average_rating,
        COUNT(*) as total_reviews,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as rating_5,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as rating_4,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as rating_3,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as rating_2,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as rating_1,
        0 as avg_communication,
        0 as avg_punctuality,
        0 as avg_professionalism,
        0 as avg_knowledge
      FROM reviews
      WHERE reviewee_id = ? AND is_public = TRUE
    `).bind(companionId).first();

    const summaryRow = summaryResult as any;
    const summary = {
      averageRating: Math.round(Number(summaryRow?.average_rating || 0) * 10) / 10,
      totalReviews: Number(summaryRow?.total_reviews || 0),
      ratingDistribution: {
        5: Number(summaryRow?.rating_5 || 0),
        4: Number(summaryRow?.rating_4 || 0),
        3: Number(summaryRow?.rating_3 || 0),
        2: Number(summaryRow?.rating_2 || 0),
        1: Number(summaryRow?.rating_1 || 0)
      },
      categoryAverages: {
        communication: Math.round(Number(summaryRow?.avg_communication || 0) * 10) / 10,
        punctuality: Math.round(Number(summaryRow?.avg_punctuality || 0) * 10) / 10,
        professionalism: Math.round(Number(summaryRow?.avg_professionalism || 0) * 10) / 10,
        knowledge: Math.round(Number(summaryRow?.avg_knowledge || 0) * 10) / 10
      }
    };

    return jsonSuccess(c, {
      reviews: reviewsList,
      pagination: createPagination(page, limit, total),
      summary
    }, 'Reviews retrieved successfully');

  } catch (error) {
    console.error('Get companion reviews error:', error);
    return jsonError(c, 'Failed to retrieve reviews', 'An error occurred while fetching reviews', 500);
  }
});

// Helper function to update companion rating
async function updateCompanionRating(db: any, companionId: string) {
  const ratingResult = await db.prepare(`
    SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
    FROM reviews
    WHERE reviewee_id = ? AND is_public = TRUE
  `).bind(companionId).first();

  if (ratingResult) {
    await db.prepare(`
      UPDATE supplier_profiles
      SET rating_average = ?, rating_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).bind(
      Math.round((ratingResult.avg_rating || 0) * 10) / 10,
      ratingResult.review_count || 0,
      companionId
    ).run();
  }
}

export { reviews as reviewRoutes };
