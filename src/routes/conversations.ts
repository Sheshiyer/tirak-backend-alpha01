import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const conversations = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply authentication middleware to all routes
conversations.use('*', authMiddleware);
conversations.use('*', createRateLimit('chat'));

// Message creation schema
const createMessageSchema = z.object({
  text: z.string().max(2000, 'Message too long').optional(),
  type: z.enum(['text', 'image', 'audio'], {
    errorMap: () => ({ message: 'Type must be text, image, or audio' })
  }),
  mediaUrl: z.string().url('Invalid media URL').optional(),
  replyTo: z.string().uuid('Invalid reply message ID').optional()
});

// Conversation creation schema
const createConversationSchema = z.object({
  participantId: z.string().uuid('Invalid participant ID'),
  initialMessage: z.string().max(2000, 'Initial message too long').optional()
});

// Mark as read schema
const markAsReadSchema = z.object({
  messageId: z.string().uuid('Invalid message ID')
});

/**
 * Get user conversations
 */
conversations.get('/', async (c) => {
  const userId = c.get('userId');
  
  try {
    const conversationsResult = await c.env.DB.prepare(`
      SELECT 
        cr.id,
        CASE 
          WHEN cr.customer_id = ? THEN cr.supplier_id
          ELSE cr.customer_id
        END as participant_id,
        CASE 
          WHEN cr.customer_id = ? THEN sp.display_name
          ELSE cp.display_name
        END as participant_name,
        CASE 
          WHEN cr.customer_id = ? THEN sp.profile_images
          ELSE cp.profile_images
        END as participant_images,
        CASE 
          WHEN cr.customer_id = ? THEN u2.status
          ELSE u1.status
        END as participant_online,
        CASE 
          WHEN cr.customer_id = ? THEN u2.last_login_at
          ELSE u1.last_login_at
        END as participant_last_seen,
        cm.id as last_message_id,
        cm.content as last_message_text,
        cm.sender_id as last_message_sender,
        cm.message_type as last_message_type,
        cm.created_at as last_message_timestamp,
        cr.updated_at,
        COALESCE(unread.unread_count, 0) as unread_count
      FROM chat_rooms cr
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN users u1 ON cr.customer_id = u1.id
      LEFT JOIN users u2 ON cr.supplier_id = u2.id
      LEFT JOIN chat_messages cm ON cr.last_message_id = cm.id
      LEFT JOIN (
        SELECT 
          room_id,
          COUNT(*) as unread_count
        FROM chat_messages
        WHERE recipient_id = ? AND read_at IS NULL
        GROUP BY room_id
      ) unread ON cr.id = unread.room_id
      WHERE cr.customer_id = ? OR cr.supplier_id = ?
      ORDER BY cr.updated_at DESC
    `).bind(userId, userId, userId, userId, userId, userId, userId, userId).all();

    const conversationsList = conversationsResult.results.map((conv: any) => {
      const participantImages = JSON.parse(conv.participant_images || '[]');
      
      return {
        id: conv.id,
        participant: {
          id: conv.participant_id,
          name: conv.participant_name,
          profileImage: participantImages[0] || null,
          online: conv.participant_online === 'active',
          lastSeen: conv.participant_last_seen
        },
        lastMessage: conv.last_message_id ? {
          id: conv.last_message_id,
          text: conv.last_message_text,
          sender: conv.last_message_sender,
          timestamp: conv.last_message_timestamp,
          type: conv.last_message_type
        } : null,
        unreadCount: conv.unread_count,
        updatedAt: conv.updated_at
      };
    });

    return jsonSuccess(c, {
      conversations: conversationsList
    }, 'Conversations retrieved successfully');

  } catch (error) {
    console.error('Get conversations error:', error);
    return jsonError(c, 'Failed to retrieve conversations', 'An error occurred while fetching conversations', 500);
  }
});

/**
 * Get conversation messages
 */
conversations.get('/:id/messages', validateUUID('id'), validatePagination, async (c) => {
  const conversationId = c.req.param('id');
  const userId = c.get('userId');
  const { page, limit } = c.get('pagination') || { page: 1, limit: 20 };
  const before = c.req.query('before'); // message ID for pagination
  
  try {
    // Verify user has access to this conversation
    const conversation = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms 
      WHERE id = ? AND (customer_id = ? OR supplier_id = ?)
    `).bind(conversationId, userId, userId).first();

    if (!conversation) {
      return jsonError(c, 'Conversation not found', 'Access denied or conversation does not exist', 404);
    }

    let query = `
      SELECT 
        cm.id,
        cm.room_id as conversationId,
        cm.sender_id as senderId,
        cm.content as text,
        cm.message_type as type,
        cm.media_url as mediaUrl,
        cm.created_at as timestamp,
        CASE 
          WHEN cm.read_at IS NOT NULL THEN 'read'
          WHEN cm.delivered_at IS NOT NULL THEN 'delivered'
          ELSE 'sent'
        END as status,
        cm.reply_to_id as replyTo
      FROM chat_messages cm
      WHERE cm.room_id = ?
    `;

    const queryParams = [conversationId];

    if (before) {
      // Get messages before a specific message (for pagination)
      const beforeMessage = await c.env.DB.prepare(`
        SELECT created_at FROM chat_messages WHERE id = ?
      `).bind(before).first();
      
      if (beforeMessage && typeof beforeMessage.created_at === 'string') {
        query += ` AND cm.created_at < ?`;
        queryParams.push(beforeMessage.created_at);
      }
    }

    query += ` ORDER BY cm.created_at DESC LIMIT ?`;
    queryParams.push(limit.toString());

    const messagesResult = await c.env.DB.prepare(query).bind(...queryParams).all();

    // Reverse to get chronological order
    const messages = messagesResult.results.reverse();

    // Check if there are more messages
    const hasMore = messagesResult.results.length === limit;

    return jsonSuccess(c, {
      messages,
      pagination: {
        page,
        limit,
        hasMore
      }
    }, 'Messages retrieved successfully');

  } catch (error) {
    console.error('Get conversation messages error:', error);
    return jsonError(c, 'Failed to retrieve messages', 'An error occurred while fetching messages', 500);
  }
});

/**
 * Send message to conversation
 */
conversations.post('/:id/messages', validateUUID('id'), zValidator('json', createMessageSchema), async (c) => {
  const conversationId = c.req.param('id');
  const userId = c.get('userId');
  const messageData = c.req.valid('json');
  
  try {
    // Verify user has access to this conversation
    const conversation = await c.env.DB.prepare(`
      SELECT customer_id, supplier_id FROM chat_rooms 
      WHERE id = ? AND (customer_id = ? OR supplier_id = ?)
    `).bind(conversationId, userId, userId).first();

    if (!conversation) {
      return jsonError(c, 'Conversation not found', 'Access denied or conversation does not exist', 404);
    }

    // Determine recipient
    const recipientId = conversation.customer_id === userId ? conversation.supplier_id : conversation.customer_id;

    // Validate message content
    if (messageData.type === 'text' && !messageData.text) {
      return jsonError(c, 'Invalid message', 'Text messages must have content', 400);
    }

    if ((messageData.type === 'image' || messageData.type === 'audio') && !messageData.mediaUrl) {
      return jsonError(c, 'Invalid message', 'Media messages must have a media URL', 400);
    }

    // Create message
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO chat_messages (
        id, room_id, sender_id, recipient_id, content, message_type,
        media_url, reply_to_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      messageId,
      conversationId,
      userId,
      recipientId,
      messageData.text || null,
      messageData.type,
      messageData.mediaUrl || null,
      messageData.replyTo || null,
      now,
      now
    ).run();

    // Update conversation last message
    await c.env.DB.prepare(`
      UPDATE chat_rooms 
      SET last_message_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(messageId, now, conversationId).run();

    // Send notification to recipient
    await c.env.NOTIFICATION_QUEUE.send({
      type: 'new_message',
      userId: recipientId,
      title: 'New Message',
      message: messageData.type === 'text' ? messageData.text : `Sent a ${messageData.type}`,
      data: { conversationId, messageId },
      timestamp: now
    });

    // Track message sent event
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'message_sent',
        userId,
        properties: {
          conversationId,
          messageId,
          messageType: messageData.type,
          hasMedia: !!messageData.mediaUrl
        },
        timestamp: now
      });
    }

    return jsonSuccess(c, {
      message: {
        id: messageId,
        conversationId,
        senderId: userId,
        text: messageData.text,
        type: messageData.type,
        mediaUrl: messageData.mediaUrl,
        timestamp: now,
        status: 'sent'
      }
    }, 'Message sent successfully', 201);

  } catch (error) {
    console.error('Send message error:', error);
    return jsonError(c, 'Failed to send message', 'An error occurred while sending the message', 500);
  }
});

/**
 * Mark conversation as read
 */
conversations.put('/:id/read', validateUUID('id'), zValidator('json', markAsReadSchema), async (c) => {
  const conversationId = c.req.param('id');
  const userId = c.get('userId');
  const { messageId } = c.req.valid('json');
  
  try {
    // Verify user has access to this conversation
    const conversation = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms 
      WHERE id = ? AND (customer_id = ? OR supplier_id = ?)
    `).bind(conversationId, userId, userId).first();

    if (!conversation) {
      return jsonError(c, 'Conversation not found', 'Access denied or conversation does not exist', 404);
    }

    // Mark all messages up to the specified message as read
    const now = new Date().toISOString();
    await c.env.DB.prepare(`
      UPDATE chat_messages 
      SET read_at = ?
      WHERE room_id = ? 
        AND recipient_id = ? 
        AND read_at IS NULL
        AND created_at <= (
          SELECT created_at FROM chat_messages WHERE id = ?
        )
    `).bind(now, conversationId, userId, messageId).run();

    return jsonSuccess(c, {}, 'Messages marked as read');

  } catch (error) {
    console.error('Mark conversation as read error:', error);
    return jsonError(c, 'Failed to mark as read', 'An error occurred while marking messages as read', 500);
  }
});

/**
 * Create new conversation
 */
conversations.post('/', zValidator('json', createConversationSchema), async (c) => {
  const userId = c.get('userId');
  const { participantId, initialMessage } = c.req.valid('json');
  
  try {
    // Check if conversation already exists
    const existingConversation = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms 
      WHERE (customer_id = ? AND supplier_id = ?) 
         OR (customer_id = ? AND supplier_id = ?)
    `).bind(userId, participantId, participantId, userId).first();

    if (existingConversation) {
      return jsonSuccess(c, {
        conversation: {
          id: existingConversation.id,
          participant: { id: participantId },
          createdAt: new Date().toISOString()
        }
      }, 'Conversation already exists');
    }

    // Determine user types
    const userType = c.get('userType');
    let customerId, supplierId;

    if (userType === 'customer') {
      customerId = userId;
      supplierId = participantId;
    } else {
      customerId = participantId;
      supplierId = userId;
    }

    // Create conversation
    const conversationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO chat_rooms (id, customer_id, supplier_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(conversationId, customerId, supplierId, now, now).run();

    // Send initial message if provided
    if (initialMessage) {
      const messageId = crypto.randomUUID();
      
      await c.env.DB.prepare(`
        INSERT INTO chat_messages (
          id, room_id, sender_id, recipient_id, content, message_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        messageId,
        conversationId,
        userId,
        participantId,
        initialMessage,
        'text',
        now,
        now
      ).run();

      // Update conversation with last message
      await c.env.DB.prepare(`
        UPDATE chat_rooms SET last_message_id = ? WHERE id = ?
      `).bind(messageId, conversationId).run();
    }

    // Get participant details
    const participant = await c.env.DB.prepare(`
      SELECT 
        CASE 
          WHEN ? = 'customer' THEN sp.display_name
          ELSE cp.display_name
        END as name,
        CASE 
          WHEN ? = 'customer' THEN sp.profile_images
          ELSE cp.profile_images
        END as images
      FROM users u
      LEFT JOIN supplier_profiles sp ON u.id = sp.user_id
      LEFT JOIN customer_profiles cp ON u.id = cp.user_id
      WHERE u.id = ?
    `).bind(userType, userType, participantId).first();

    const participantImages = typeof participant?.images === 'string' ? JSON.parse(participant.images || '[]') : [];

    return jsonSuccess(c, {
      conversation: {
        id: conversationId,
        participant: {
          id: participantId,
          name: participant?.name || 'Unknown',
          profileImage: participantImages[0] || null
        },
        createdAt: now
      }
    }, 'Conversation created successfully', 201);

  } catch (error) {
    console.error('Create conversation error:', error);
    return jsonError(c, 'Failed to create conversation', 'An error occurred while creating the conversation', 500);
  }
});

export { conversations as conversationRoutes };
