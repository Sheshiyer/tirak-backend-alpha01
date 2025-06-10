import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const payments = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
payments.use('*', authMiddleware);
payments.use('*', createRateLimit('payment'));

// Payment method creation schema
const createPaymentMethodSchema = z.object({
  type: z.enum(['card', 'promptpay', 'truemoney', 'bank_transfer'], {
    errorMap: () => ({ message: 'Type must be card, promptpay, truemoney, or bank_transfer' })
  }),
  details: z.object({
    cardNumber: z.string().optional(),
    expiryMonth: z.number().min(1).max(12).optional(),
    expiryYear: z.number().min(2024).optional(),
    cvv: z.string().optional(),
    holderName: z.string().optional(),
    phoneNumber: z.string().optional(),
    accountNumber: z.string().optional()
  }),
  isDefault: z.boolean().optional().default(false)
});

/**
 * Get user payment methods
 */
payments.get('/payment-methods', async (c) => {
  const userId = c.get('userId');
  
  try {
    const paymentMethods = await c.env.DB.prepare(`
      SELECT id, type, is_default, details, created_at
      FROM payment_methods
      WHERE user_id = ? AND is_active = TRUE
      ORDER BY is_default DESC, created_at DESC
    `).bind(userId).all();

    const methods = paymentMethods.results.map((pm: any) => {
      const details = JSON.parse(pm.details || '{}');
      
      // Mask sensitive information
      const maskedDetails: any = {};
      
      if (pm.type === 'card') {
        maskedDetails.last4 = details.last4;
        maskedDetails.brand = details.brand;
        maskedDetails.expiryMonth = details.expiryMonth;
        maskedDetails.expiryYear = details.expiryYear;
        maskedDetails.holderName = details.holderName;
      } else if (pm.type === 'promptpay' || pm.type === 'truemoney') {
        maskedDetails.phoneNumber = details.phoneNumber;
      } else if (pm.type === 'bank_transfer') {
        maskedDetails.accountNumber = details.accountNumber;
        maskedDetails.bankName = details.bankName;
      }

      return {
        id: pm.id,
        type: pm.type,
        isDefault: pm.is_default,
        details: maskedDetails,
        createdAt: pm.created_at
      };
    });

    return jsonSuccess(c, {
      paymentMethods: methods
    }, 'Payment methods retrieved successfully');

  } catch (error) {
    console.error('Get payment methods error:', error);
    return jsonError(c, 'Failed to retrieve payment methods', 'An error occurred while fetching payment methods', 500);
  }
});

/**
 * Add payment method
 */
payments.post('/payment-methods', zValidator('json', createPaymentMethodSchema), async (c) => {
  const userId = c.get('userId');
  const { type, details, isDefault } = c.req.valid('json');
  
  try {
    // Validate payment method details based on type
    if (type === 'card') {
      if (!details.cardNumber || !details.expiryMonth || !details.expiryYear || !details.cvv) {
        return jsonError(c, 'Invalid card details', 'Card number, expiry date, and CVV are required', 400);
      }
    } else if (type === 'promptpay' || type === 'truemoney') {
      if (!details.phoneNumber) {
        return jsonError(c, 'Invalid phone details', 'Phone number is required', 400);
      }
    } else if (type === 'bank_transfer') {
      if (!details.accountNumber) {
        return jsonError(c, 'Invalid bank details', 'Account number is required', 400);
      }
    }

    // Process and store payment method details
    const processedDetails: any = {};
    
    if (type === 'card') {
      // In production, integrate with payment processor for tokenization
      processedDetails.last4 = details.cardNumber!.slice(-4);
      processedDetails.brand = detectCardBrand(details.cardNumber!);
      processedDetails.expiryMonth = details.expiryMonth;
      processedDetails.expiryYear = details.expiryYear;
      processedDetails.holderName = details.holderName;
      // Never store full card number or CVV
    } else if (type === 'promptpay' || type === 'truemoney') {
      processedDetails.phoneNumber = details.phoneNumber;
    } else if (type === 'bank_transfer') {
      processedDetails.accountNumber = details.accountNumber;
      processedDetails.bankName = details.bankName || 'Unknown Bank';
    }

    // If this is set as default, unset other defaults
    if (isDefault) {
      await c.env.DB.prepare(`
        UPDATE payment_methods 
        SET is_default = FALSE 
        WHERE user_id = ? AND is_active = TRUE
      `).bind(userId).run();
    }

    // Create payment method
    const paymentMethodId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO payment_methods (
        id, user_id, type, details, is_default, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      paymentMethodId,
      userId,
      type,
      JSON.stringify(processedDetails),
      isDefault,
      true,
      now,
      now
    ).run();

    // Track payment method addition
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'payment_method_added',
      userId,
      properties: {
        paymentMethodId,
        type,
        isDefault
      },
      timestamp: now
    });

    return jsonSuccess(c, {
      paymentMethod: {
        id: paymentMethodId,
        type,
        isDefault,
        details: processedDetails
      }
    }, 'Payment method added successfully', 201);

  } catch (error) {
    console.error('Add payment method error:', error);
    return jsonError(c, 'Failed to add payment method', 'An error occurred while adding the payment method', 500);
  }
});

/**
 * Remove payment method
 */
payments.delete('/payment-methods/:id', validateUUID('id'), async (c) => {
  const paymentMethodId = c.req.param('id');
  const userId = c.get('userId');
  
  try {
    // Check if payment method exists and belongs to user
    const paymentMethod = await c.env.DB.prepare(`
      SELECT id, is_default FROM payment_methods
      WHERE id = ? AND user_id = ? AND is_active = TRUE
    `).bind(paymentMethodId, userId).first();

    if (!paymentMethod) {
      return jsonError(c, 'Payment method not found', 'The requested payment method does not exist', 404);
    }

    // Check if there are pending payments using this method
    const pendingPayments = await c.env.DB.prepare(`
      SELECT id FROM bookings
      WHERE payment_method_id = ? AND payment_status = 'pending'
    `).bind(paymentMethodId).first();

    if (pendingPayments) {
      return jsonError(c, 'Cannot remove payment method', 'This payment method has pending transactions', 409);
    }

    // Soft delete the payment method
    await c.env.DB.prepare(`
      UPDATE payment_methods 
      SET is_active = FALSE, updated_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), paymentMethodId).run();

    // If this was the default method, set another as default
    if (paymentMethod.is_default) {
      const nextMethod = await c.env.DB.prepare(`
        SELECT id FROM payment_methods
        WHERE user_id = ? AND is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(userId).first();

      if (nextMethod) {
        await c.env.DB.prepare(`
          UPDATE payment_methods 
          SET is_default = TRUE 
          WHERE id = ?
        `).bind(nextMethod.id).run();
      }
    }

    // Track payment method removal
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'payment_method_removed',
      userId,
      properties: {
        paymentMethodId
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {}, 'Payment method removed successfully');

  } catch (error) {
    console.error('Remove payment method error:', error);
    return jsonError(c, 'Failed to remove payment method', 'An error occurred while removing the payment method', 500);
  }
});

/**
 * Get payment history
 */
payments.get('/payments/history', validatePagination, async (c) => {
  const userId = c.get('userId');
  const { page, limit } = c.get('pagination');
  const status = c.req.query('status');
  
  try {
    let query = `
      SELECT 
        b.id as booking_id,
        b.total_amount,
        b.service_fee,
        b.payment_status,
        b.created_at,
        b.updated_at,
        pm.type as payment_method_type,
        JSON_EXTRACT(pm.details, '$.last4') as payment_method_last4,
        sp.display_name as companion_name,
        s.title as service_name
      FROM bookings b
      LEFT JOIN payment_methods pm ON b.payment_method_id = pm.id
      LEFT JOIN supplier_profiles sp ON b.companion_id = sp.user_id
      LEFT JOIN supplier_services s ON b.service_id = s.id
      WHERE b.customer_id = ?
    `;

    const queryParams = [userId];

    if (status) {
      query += ` AND b.payment_status = ?`;
      queryParams.push(status);
    }

    query += ` ORDER BY b.created_at DESC`;

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
    const countResult = await c.env.DB.prepare(countQuery).bind(...queryParams).first();
    const total = countResult?.total as number || 0;

    // Get paginated results
    const offset = (page - 1) * limit;
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const paymentsResult = await c.env.DB.prepare(paginatedQuery)
      .bind(...queryParams, limit, offset).all();

    const paymentsList = paymentsResult.results.map((payment: any) => ({
      id: payment.booking_id,
      bookingId: payment.booking_id,
      amount: payment.total_amount - payment.service_fee,
      serviceFee: payment.service_fee,
      totalAmount: payment.total_amount,
      currency: 'THB',
      status: payment.payment_status,
      paymentMethod: {
        type: payment.payment_method_type,
        last4: payment.payment_method_last4
      },
      companionName: payment.companion_name,
      serviceName: payment.service_name,
      createdAt: payment.created_at,
      completedAt: payment.payment_status === 'completed' ? payment.updated_at : null
    }));

    return jsonPaginated(c, {
      payments: paymentsList
    }, createPagination(page, limit, total));

  } catch (error) {
    console.error('Get payment history error:', error);
    return jsonError(c, 'Failed to retrieve payment history', 'An error occurred while fetching payment history', 500);
  }
});

// Helper function to detect card brand
function detectCardBrand(cardNumber: string): string {
  const number = cardNumber.replace(/\s/g, '');
  
  if (/^4/.test(number)) return 'visa';
  if (/^5[1-5]/.test(number)) return 'mastercard';
  if (/^3[47]/.test(number)) return 'amex';
  if (/^6(?:011|5)/.test(number)) return 'discover';
  
  return 'unknown';
}

export { payments as paymentRoutes };
