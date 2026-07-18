import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { chatMessageSchema } from '../utils/validation';
import { validateUUID, validatePagination } from '../middleware/validation';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rateLimit';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../utils/response';
import type { Env, Variables } from '../index';

const chat = new Hono<{ Bindings: Env; Variables: Variables }>();

const createChatRoomSchema = z.object({
  bookingId: z.string().uuid('Booking ID must be a valid UUID'),
});

const eligibleBookingJoin = (roomAlias: string): string => `
  INNER JOIN bookings b
    ON b.id = ${roomAlias}.booking_id
   AND b.customer_id = ${roomAlias}.customer_id
   AND b.supplier_id = ${roomAlias}.supplier_id
   AND b.status IN ('confirmed', 'in_progress')
`;

// Apply authentication middleware to all routes
chat.use('*', authMiddleware);

// Apply rate limiting for chat operations
chat.use('*', createRateLimit('chat'));

/**
 * Get user's chat rooms
 */
chat.get('/rooms', validatePagination(), async (c) => {
  const userId = c.get('userId') as string;
  const { page, limit } = c.get('validatedQuery');
  
  try {
    // Get total count
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total 
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      WHERE b.customer_id = ? OR b.supplier_id = ?
    `).bind(userId, userId).first();
    
    const total = countResult?.total as number || 0;

    // Get chat rooms with pagination
    const offset = (page - 1) * limit;
    const roomsResult = await c.env.DB.prepare(`
      SELECT 
        cr.id, cr.booking_id, cr.customer_id, cr.supplier_id, cr.status,
        cr.last_message_at, cr.created_at,
        cp.display_name as customer_name, cp.profile_image as customer_image,
        sp.display_name as supplier_name, sp.profile_images as supplier_images,
        cm.content as last_message, cm.message_type as last_message_type,
        cm.created_at as last_message_time
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      LEFT JOIN chat_messages cm ON cr.id = cm.room_id 
        AND cm.created_at = cr.last_message_at
      WHERE b.customer_id = ? OR b.supplier_id = ?
      ORDER BY cr.last_message_at DESC NULLS LAST, cr.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(userId, userId, limit, offset).all();

    const rooms = roomsResult.results?.map((room: any) => {
      const isCustomer = room.customer_id === userId;
      const otherParty = isCustomer ? {
        id: room.supplier_id,
        name: room.supplier_name,
        image: JSON.parse(String(room.supplier_images || '[]'))[0] || null,
        type: 'supplier'
      } : {
        id: room.customer_id,
        name: room.customer_name,
        image: room.customer_image,
        type: 'customer'
      };

      return {
        id: room.id,
        bookingId: room.booking_id,
        status: room.status,
        otherParty,
        lastMessage: room.last_message ? {
          content: room.last_message,
          type: room.last_message_type,
          timestamp: room.last_message_time
        } : null,
        lastActivity: room.last_message_at || room.created_at,
        createdAt: room.created_at
      };
    }) || [];

    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, rooms, pagination, 'Chat rooms retrieved successfully');

  } catch (error) {
    console.error('Get chat rooms error:', error);
    return jsonError(c, 'Failed to retrieve chat rooms', 'An error occurred while fetching chat rooms', 500);
  }
});

/**
 * Create or get existing chat room
 */
chat.post('/rooms', async (c) => {
  const userId = c.get('userId') as string;

  try {
    const body = await c.req.json();
    const parsed = createChatRoomSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(
        c,
        'Booking required',
        parsed.error.issues[0]?.message || 'A valid experience booking ID is required',
        400
      );
    }

    const { bookingId } = parsed.data;

    const booking = await c.env.DB.prepare(`
      SELECT id, customer_id, supplier_id, status
      FROM bookings
      WHERE id = ?
    `).bind(bookingId).first();

    if (!booking) {
      return jsonError(c, 'Experience booking not found', 'The requested experience booking does not exist', 404);
    }

    const customerId = String(booking.customer_id);
    const supplierId = String(booking.supplier_id);
    if (userId !== customerId && userId !== supplierId) {
      return jsonError(
        c,
        'Booking access denied',
        'Only the traveler and assigned guide can open chat for this experience booking',
        403
      );
    }

    if (!['confirmed', 'in_progress'].includes(String(booking.status))) {
      return jsonError(
        c,
        'Experience chat unavailable',
        'Chat becomes available after the guide confirms the experience and closes when the experience ends',
        403
      );
    }

    const existingRoom = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms
      WHERE booking_id = ? AND customer_id = ? AND supplier_id = ?
    `).bind(bookingId, customerId, supplierId).first();

    if (existingRoom) {
      return jsonSuccess(c, {
        roomId: existingRoom.id,
        bookingId,
        existed: true 
      }, 'Chat room already exists');
    }

    const roomId = crypto.randomUUID();

    await c.env.DB.prepare(`
      INSERT INTO chat_rooms (id, booking_id, customer_id, supplier_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      roomId,
      bookingId,
      customerId,
      supplierId,
      new Date().toISOString(),
      new Date().toISOString()
    ).run();

    // Track chat room creation
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'chat_room_created',
      userId,
      properties: {
        roomId,
        bookingId,
        otherUserId: userId === customerId ? supplierId : customerId,
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, {
      roomId,
      bookingId,
      existed: false 
    }, 'Chat room created successfully', 201);

  } catch (error) {
    console.error('Create chat room error:', error);
    return jsonError(c, 'Failed to create chat room', 'An error occurred while creating the chat room', 500);
  }
});

/**
 * Get chat room details and recent messages
 */
chat.get('/rooms/:roomId', validateUUID('roomId'), validatePagination(), async (c) => {
  const roomId = c.req.param('roomId') as string;
  const userId = c.get('userId') as string;
  const { page, limit } = c.get('validatedQuery');
  
  try {
    // Verify user has access to this chat room
    const room = await c.env.DB.prepare(`
      SELECT 
        cr.id, cr.booking_id, cr.customer_id, cr.supplier_id, cr.status, cr.created_at,
        cp.display_name as customer_name, cp.profile_image as customer_image,
        sp.display_name as supplier_name, sp.profile_images as supplier_images
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      WHERE cr.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
    `).bind(roomId, userId, userId).first();

    if (!room) {
      return jsonError(c, 'Chat room not found', 'The requested chat room does not exist or you do not have access', 404);
    }

    // Get message count for pagination
    const countResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM chat_messages WHERE room_id = ?
    `).bind(roomId).first();
    
    const total = countResult?.total as number || 0;

    // Get messages with pagination (newest first)
    const offset = (page - 1) * limit;
    const messagesResult = await c.env.DB.prepare(`
      SELECT 
        cm.id, cm.sender_id, cm.message_type, cm.content, 
        cm.image_url, cm.metadata, cm.created_at,
        CASE 
          WHEN cm.sender_id = ? THEN cp.display_name 
          ELSE sp.display_name 
        END as sender_name
      FROM chat_messages cm
      LEFT JOIN customer_profiles cp ON cm.sender_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cm.sender_id = sp.user_id
      WHERE cm.room_id = ?
      ORDER BY cm.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(room.customer_id, roomId, limit, offset).all();

    const messages = messagesResult.results?.map((message: any) => ({
      id: message.id,
      senderId: message.sender_id,
      senderName: message.sender_name,
      type: message.message_type,
      content: message.content,
      imageUrl: message.image_url,
      metadata: message.metadata ? JSON.parse(message.metadata) : null,
      timestamp: message.created_at,
      isOwn: message.sender_id === userId
    })) || [];

    // Determine other participant info
    const isCustomer = room.customer_id === userId;
    const otherParty = isCustomer ? {
      id: room.supplier_id,
      name: room.supplier_name,
      image: JSON.parse(String(room.supplier_images || '[]'))[0] || null,
      type: 'supplier'
    } : {
      id: room.customer_id,
      name: room.customer_name,
      image: room.customer_image,
      type: 'customer'
    };

    const roomData = {
      id: room.id,
      bookingId: room.booking_id,
      status: room.status,
      otherParty,
      createdAt: room.created_at,
      messages: messages.reverse(), // Return in chronological order
      pagination: createPagination(page, limit, total)
    };

    return jsonSuccess(c, roomData, 'Chat room details retrieved successfully');

  } catch (error) {
    console.error('Get chat room details error:', error);
    return jsonError(c, 'Failed to retrieve chat room', 'An error occurred while fetching chat room details', 500);
  }
});

/**
 * WebSocket endpoint for real-time chat
 */
chat.get('/rooms/:roomId/ws', validateUUID('roomId'), async (c) => {
  const roomId = c.req.param('roomId') as string;
  const userId = c.get('userId') as string;
  
  try {
    // Verify user has access to this chat room
    const room = await c.env.DB.prepare(`
      SELECT cr.id, cr.booking_id
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      WHERE cr.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
    `).bind(roomId, userId, userId).first();

    if (!room) {
      return jsonError(c, 'Chat room not found', 'Access denied or room does not exist', 404);
    }

    // Get Durable Object for this chat room
    const durableObjectId = c.env.CHAT_ROOM.idFromName(roomId);
    const durableObject = c.env.CHAT_ROOM.get(durableObjectId);

    // Forward the WebSocket request to the Durable Object
    const url = new URL(c.req.url);
    url.pathname = '/websocket';
    url.searchParams.set('userId', userId);
    url.searchParams.set('roomId', roomId);
    url.searchParams.set('bookingId', String(room.booking_id));

    return await durableObject.fetch(url.toString(), {
      headers: c.req.raw.headers,
    });

  } catch (error) {
    console.error('WebSocket connection error:', error);
    return jsonError(c, 'Connection failed', 'Failed to establish WebSocket connection', 500);
  }
});

/**
 * Send message to chat room
 */
chat.post('/rooms/:roomId/messages', 
  validateUUID('roomId'), 
  zValidator('json', chatMessageSchema),
  async (c) => {
    const roomId = c.req.param('roomId') as string;
    const userId = c.get('userId') as string;
    const messageData = c.req.valid('json');
    
    try {
      // Verify user has access to this chat room
      const room = await c.env.DB.prepare(`
        SELECT cr.id, cr.booking_id, cr.customer_id, cr.supplier_id
        FROM chat_rooms cr
        ${eligibleBookingJoin('cr')}
        WHERE cr.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
      `).bind(roomId, userId, userId).first();

      if (!room) {
        return jsonError(c, 'Chat room not found', 'Access denied or room does not exist', 404);
      }

      // Get Durable Object for this chat room
      const durableObjectId = c.env.CHAT_ROOM.idFromName(roomId);
      const durableObject = c.env.CHAT_ROOM.get(durableObjectId);

      // Send message via Durable Object
      const response = await durableObject.fetch('http://localhost/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          bookingId: room.booking_id,
          senderId: userId,
          recipientId: room.customer_id === userId ? room.supplier_id : room.customer_id,
          messageType: messageData.messageType,
          content: messageData.content,
          mediaUrl: messageData.imageUrl
        })
      });

      const result = await response.json() as {
        message: {
          id: string;
          senderId: string;
          messageType: 'text' | 'image';
          content?: string;
          mediaUrl?: string;
          timestamp: string;
        };
      };
      
      if (!response.ok) {
        return jsonError(c, 'Message failed', 'Failed to send message', response.status);
      }

      return jsonSuccess(c, {
        id: result.message.id,
        senderId: result.message.senderId,
        senderName: null,
        type: result.message.messageType,
        content: result.message.content || null,
        imageUrl: result.message.mediaUrl || null,
        metadata: null,
        timestamp: result.message.timestamp,
        isOwn: true
      }, 'Message sent successfully', 201);

    } catch (error) {
      console.error('Send message error:', error);
      return jsonError(c, 'Failed to send message', 'An error occurred while sending the message', 500);
    }
  }
);

/**
 * Mark messages as read
 */
chat.post('/rooms/:roomId/read', validateUUID('roomId'), async (c) => {
  const roomId = c.req.param('roomId') as string;
  const userId = c.get('userId') as string;
  
  try {
    const body = await c.req.json();
    const { messageId } = body;

    // Verify user has access to this chat room
    const room = await c.env.DB.prepare(`
      SELECT cr.id, cr.booking_id
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      WHERE cr.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
    `).bind(roomId, userId, userId).first();

    if (!room) {
      return jsonError(c, 'Chat room not found', 'Access denied or room does not exist', 404);
    }

    // In a full implementation, this would update read receipts
    // For now, we'll just track the analytics event
    await c.env.ANALYTICS_QUEUE.send({
      eventType: 'message_read',
      userId,
      properties: { 
        roomId,
        bookingId: room.booking_id,
        messageId: messageId || 'latest'
      },
      timestamp: new Date().toISOString()
    });

    return jsonSuccess(c, { marked: true }, 'Messages marked as read');

  } catch (error) {
    console.error('Mark messages read error:', error);
    return jsonError(c, 'Failed to mark messages', 'An error occurred while marking messages as read', 500);
  }
});

/**
 * Search messages in chat room
 */
chat.get('/rooms/:roomId/search', validateUUID('roomId'), async (c) => {
  const roomId = c.req.param('roomId') as string;
  const userId = c.get('userId') as string;
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '20');
  
  if (!query || query.length < 2) {
    return jsonError(c, 'Query too short', 'Search query must be at least 2 characters', 400);
  }

  try {
    // Verify user has access to this chat room
    const room = await c.env.DB.prepare(`
      SELECT cr.id, cr.booking_id
      FROM chat_rooms cr
      ${eligibleBookingJoin('cr')}
      WHERE cr.id = ? AND (b.customer_id = ? OR b.supplier_id = ?)
    `).bind(roomId, userId, userId).first();

    if (!room) {
      return jsonError(c, 'Chat room not found', 'Access denied or room does not exist', 404);
    }

    // Search messages
    const messagesResult = await c.env.DB.prepare(`
      SELECT 
        cm.id, cm.sender_id, cm.message_type, cm.content, 
        cm.image_url, cm.created_at
      FROM chat_messages cm
      WHERE cm.room_id = ? 
        AND cm.message_type = 'text' 
        AND cm.content LIKE ?
      ORDER BY cm.created_at DESC
      LIMIT ?
    `).bind(roomId, `%${query}%`, limit).all();

    const messages = messagesResult.results?.map((message: any) => ({
      id: message.id,
      senderId: message.sender_id,
      type: message.message_type,
      content: message.content,
      imageUrl: message.image_url,
      timestamp: message.created_at,
      isOwn: message.sender_id === userId
    })) || [];

    return jsonSuccess(c, {
      query,
      results: messages,
      count: messages.length
    }, 'Message search completed');

  } catch (error) {
    console.error('Search messages error:', error);
    return jsonError(c, 'Search failed', 'An error occurred while searching messages', 500);
  }
});

export { chat as chatRoutes };
