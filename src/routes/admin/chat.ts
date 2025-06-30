import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const chat = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
chat.use('*', adminCors());
chat.use('*', authMiddleware);
chat.use('*', adminOnly);
chat.use('*', createRateLimit('admin'));

// Validation schemas
const chatActionSchema = z.object({
  action: z.enum(['terminate', 'warn', 'flag', 'block', 'monitor']),
  reason: z.string().max(1000).optional(),
});

const chatInterveneSchema = z.object({
  message: z.string().max(1000),
});

/**
 * Get chat monitoring stats
 */
chat.get('/monitoring/stats', async (c) => {
  try {
    // Get total chats count
    const totalChatsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM chat_rooms
    `).first();
    
    // Get high risk chats (those with messages in moderation queue)
    const highRiskResult = await c.env.DB.prepare(`
      SELECT COUNT(DISTINCT cr.id) as count
      FROM chat_rooms cr
      JOIN chat_messages cm ON cr.id = cm.room_id
      JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
    `).first();
    
    // Get safe chats (no messages in moderation queue)
    const safeChatsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM chat_rooms cr
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages cm 
        JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
        WHERE cm.room_id = cr.id
      )
    `).first();
    
    // Calculate average chat duration (using last_message_at if available, otherwise current timestamp)
    const durationResult = await c.env.DB.prepare(`
      SELECT AVG(
        CAST(
          (JULIANDAY(COALESCE(cr.last_message_at, CURRENT_TIMESTAMP)) - JULIANDAY(cr.created_at)) * 24 * 60 
          AS INTEGER
        )
      ) as avg_duration
      FROM chat_rooms cr
    `).first();

    const statsData = {
      totalChats: Number(totalChatsResult?.total || 0),
      highRiskChats: Number(highRiskResult?.count || 0),
      safeChats: Number(safeChatsResult?.count || 0),
      averageDuration: `${Math.round(Number(durationResult?.avg_duration || 0))} minutes`
    };

    return jsonSuccess(c, statsData, 'Chat monitoring statistics retrieved successfully');

  } catch (error) {
    console.error('Chat stats error:', error);
    return jsonError(c, 'Failed to load chat stats', 'An error occurred while loading chat monitoring statistics', 500);
  }
});

/**
 * Get all chat sessions with filtering and pagination
 */
chat.get('/monitoring/sessions', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const riskLevel = c.req.query('riskLevel');
  const status = c.req.query('status');
  const search = c.req.query('search');
  
  try {
    // Build the base query
    let countQuery = `
      SELECT COUNT(DISTINCT cr.id) as total
      FROM chat_rooms cr
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
    `;
    
    let sessionsQuery = `
      SELECT 
        cr.id, cr.status, cr.created_at as start_time,
        cp.display_name as customer_name, cp.user_id as customer_id,
        sp.display_name as supplier_name, sp.user_id as supplier_id,
        (SELECT COUNT(*) FROM chat_messages cm WHERE cm.room_id = cr.id) as total_messages,
        (SELECT COUNT(*) 
         FROM chat_messages cm 
         JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
         WHERE cm.room_id = cr.id) as flagged_messages,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id AND mq.priority = 'high'
          ) THEN 'high'
          WHEN EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id
          ) THEN 'medium'
          ELSE 'low'
        END as risk_level
      FROM chat_rooms cr
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
    `;
    
    // Add WHERE clauses for filtering
    let whereConditions = [];
    let params = [];
    
    if (status && status !== 'all') {
      whereConditions.push('cr.status = ?');
      params.push(status);
    }
    
    if (riskLevel && riskLevel !== 'all') {
      if (riskLevel === 'high') {
        whereConditions.push(`
          EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id AND mq.priority = 'high'
          )
        `);
      } else if (riskLevel === 'medium') {
        whereConditions.push(`
          EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id AND mq.priority = 'medium'
          )
        `);
      } else if (riskLevel === 'low') {
        whereConditions.push(`
          NOT EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id
          )
        `);
      }
    }
    
    if (search) {
      whereConditions.push('(cp.display_name LIKE ? OR sp.display_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    
    // Add WHERE clause to queries if conditions exist
    if (whereConditions.length > 0) {
      const whereClause = ' WHERE ' + whereConditions.join(' AND ');
      countQuery += whereClause;
      sessionsQuery += whereClause;
    }
    
    // Add pagination to sessions query
    sessionsQuery += ' ORDER BY cr.created_at DESC LIMIT ? OFFSET ?';
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    
    // Execute count query
    const countResult = await c.env.DB.prepare(countQuery).bind(...params.slice(0, -2)).first();
    const total = Number(countResult?.total || 0);
    
    // Execute sessions query
    const sessionsResult = await c.env.DB.prepare(sessionsQuery).bind(...params).all();
    
    // Format the results
    const sessions = sessionsResult.results?.map((room: any) => ({
      id: room.id,
      participants: [room.customer_name, room.supplier_name],
      startTime: room.start_time,
      status: room.status,
      riskLevel: room.risk_level,
      flaggedMessages: room.flagged_messages,
      totalMessages: room.total_messages
    })) || [];
    
    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, sessions, pagination, 'Chat sessions retrieved successfully');

  } catch (error) {
    console.error('Chat sessions error:', error);
    return jsonError(c, 'Failed to retrieve chat sessions', 'An error occurred while retrieving chat sessions', 500);
  }
});

/**
 * Get specific chat details
 */
chat.get('/monitoring/details/:chatId', validateUUID('chatId'), async (c) => {
  const chatId = c.req.param('chatId');
  
  try {
    // Get chat room details
    const roomResult = await c.env.DB.prepare(`
      SELECT 
        cr.id, cr.customer_id, cr.supplier_id, cr.status, cr.created_at as start_time,
        cp.display_name as customer_name, cp.profile_image as customer_image,
        sp.display_name as supplier_name, sp.profile_images as supplier_images,
        (SELECT COUNT(*) FROM chat_messages cm WHERE cm.room_id = cr.id) as total_messages,
        (SELECT COUNT(*) 
         FROM chat_messages cm 
         JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
         WHERE cm.room_id = cr.id) as flagged_messages,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id AND mq.priority = 'high'
          ) THEN 'high'
          WHEN EXISTS (
            SELECT 1 FROM chat_messages cm 
            JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
            WHERE cm.room_id = cr.id
          ) THEN 'medium'
          ELSE 'low'
        END as risk_level
      FROM chat_rooms cr
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      WHERE cr.id = ?
    `).bind(chatId).first();

    if (!roomResult) {
      return jsonError(c, 'Chat not found', 'The specified chat does not exist', 404);
    }

    // Get recent messages (limited to 5 for the preview)
    const messagesResult = await c.env.DB.prepare(`
      SELECT 
        cm.id, cm.sender_id, cm.message_type, cm.content, cm.created_at,
        CASE 
          WHEN cm.sender_id = cr.customer_id THEN cp.display_name 
          WHEN cm.sender_id = cr.supplier_id THEN sp.display_name
          ELSE 'Admin'
        END as sender_name,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM moderation_queue mq 
            WHERE mq.content_id = cm.id AND mq.content_type = 'message'
          ) THEN 1
          ELSE 0
        END as is_flagged,
        COALESCE(mq.priority, 'low') as risk_level
      FROM chat_messages cm
      JOIN chat_rooms cr ON cm.room_id = cr.id
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      LEFT JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
      WHERE cm.room_id = ?
      ORDER BY cm.created_at DESC
      LIMIT 5
    `).bind(chatId).all();

    // Get violations (flagged messages in moderation queue)
    const violationsResult = await c.env.DB.prepare(`
      SELECT 
        cm.id, cm.content as message, cm.created_at as detected,
        mq.priority,
        mq.flagged_reason as type,
        mq.priority as severity
      FROM chat_messages cm
      JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
      WHERE cm.room_id = ?
      ORDER BY mq.priority DESC, cm.created_at DESC
    `).bind(chatId).all();

    // Format the messages
    const messages = messagesResult.results?.map((msg: any) => ({
      id: msg.id,
      sender: msg.sender_name,
      message: msg.content,
      timestamp: msg.created_at,
      flagged: msg.is_flagged === 1,
      aiScore: msg.risk_level === 'high' ? 0.8 : msg.risk_level === 'medium' ? 0.5 : 0.1
    })) || [];

    // Format the violations
    const violations = violationsResult.results?.map((v: any) => ({
      type: v.type || 'general_violation',
      severity: v.severity || 'medium',
      detected: v.detected,
      message: v.message
    })) || [];

    // Create a simplified AI analysis based on moderation data
    const flaggedCount = Number(roomResult.flagged_messages || 0);
    const totalCount = Number(roomResult.total_messages || 0);
    const toxicityRatio = totalCount > 0 ? flaggedCount / totalCount : 0;
    
    // Determine sentiment based on flagged ratio
    let sentiment = 'neutral';
    if (toxicityRatio > 0.3) sentiment = 'negative';
    else if (toxicityRatio < 0.05) sentiment = 'positive';

    // Format the AI analysis
    const aiAnalysis = {
      sentiment: sentiment,
      toxicity: toxicityRatio,
      inappropriateContent: flaggedCount > 0,
      languageViolations: violations.map(v => v.type).filter((v, i, a) => a.indexOf(v) === i) // unique types
    };

    // Build the final chat details object
    const chatDetails = {
      id: roomResult.id,
      participants: [roomResult.customer_name, roomResult.supplier_name],
      startTime: roomResult.start_time,
      status: roomResult.status,
      riskLevel: roomResult.risk_level,
      flaggedMessages: Number(roomResult.flagged_messages || 0),
      totalMessages: Number(roomResult.total_messages || 0),
      aiAnalysis: aiAnalysis,
      messages: messages,
      violations: violations
    };

    return jsonSuccess(c, chatDetails, 'Chat details retrieved successfully');

  } catch (error) {
    console.error('Chat details error:', error);
    return jsonError(c, 'Failed to retrieve chat details', 'An error occurred while retrieving chat details', 500);
  }
});

/**
 * Get chat messages
 */
chat.get('/monitoring/messages/:chatId', validateUUID('chatId'), async (c) => {
  const chatId = c.req.param('chatId');
  
  try {
    // Verify chat exists
    const roomExists = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms WHERE id = ?
    `).bind(chatId).first();

    if (!roomExists) {
      return jsonError(c, 'Chat not found', 'The specified chat does not exist', 404);
    }

    // Get chat room participants for sender name resolution
    const roomResult = await c.env.DB.prepare(`
      SELECT 
        cr.customer_id, cr.supplier_id,
        cp.display_name as customer_name,
        sp.display_name as supplier_name
      FROM chat_rooms cr
      LEFT JOIN customer_profiles cp ON cr.customer_id = cp.user_id
      LEFT JOIN supplier_profiles sp ON cr.supplier_id = sp.user_id
      WHERE cr.id = ?
    `).bind(chatId).first();

    // Get all messages for this chat with moderation info
    const messagesResult = await c.env.DB.prepare(`
      SELECT 
        cm.id, cm.sender_id, cm.message_type, cm.content, cm.created_at,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM moderation_queue mq 
            WHERE mq.content_id = cm.id AND mq.content_type = 'message'
          ) THEN 1
          ELSE 0
        END as is_flagged,
        COALESCE(mq.priority, 'low') as risk_level,
        COALESCE(mq.flagged_reason, '') as detection_type
      FROM chat_messages cm
      LEFT JOIN moderation_queue mq ON cm.id = mq.content_id AND mq.content_type = 'message'
      WHERE cm.room_id = ?
      ORDER BY cm.created_at ASC
    `).bind(chatId).all();

    // Format the messages with sender names
    const messages = messagesResult.results?.map((msg: any) => {
      let senderName = 'Unknown';
      
      if (roomResult && msg.sender_id === roomResult.customer_id) {
        senderName = String(roomResult.customer_name || 'Customer');
      } else if (roomResult && msg.sender_id === roomResult.supplier_id) {
        senderName = String(roomResult.supplier_name || 'Supplier');
      } else {
        senderName = 'Admin'; // Messages from admins
      }
      
      // Calculate a risk score based on priority
      const aiScore = msg.risk_level === 'high' ? 0.8 : 
                      msg.risk_level === 'medium' ? 0.5 : 
                      msg.risk_level === 'urgent' ? 0.9 : 0.1;
      
      return {
        id: msg.id,
        sender: senderName,
        senderId: msg.sender_id,
        message: msg.content,
        messageType: msg.message_type,
        timestamp: msg.created_at,
        flagged: msg.is_flagged === 1,
        aiScore: aiScore,
        detectionType: msg.detection_type
      };
    }) || [];

    return jsonSuccess(c, messages, 'Chat messages retrieved successfully');

  } catch (error) {
    console.error('Chat messages error:', error);
    return jsonError(c, 'Failed to retrieve chat messages', 'An error occurred while retrieving chat messages', 500);
  }
});

/**
 * Take action on a chat
 */
chat.post('/monitoring/action/:chatId', validateUUID('chatId'), zValidator('json', chatActionSchema), async (c) => {
  const chatId = c.req.param('chatId');
  const { action, reason } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Verify chat exists
    const roomExists = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms WHERE id = ?
    `).bind(chatId).first();

    if (!roomExists) {
      return jsonError(c, 'Chat not found', 'The specified chat does not exist', 404);
    }

    // Determine new status based on action
    let newStatus;
    switch (action) {
      case 'terminate':
        newStatus = 'terminated';
        break;
      case 'warn':
        newStatus = 'warned';
        break;
      case 'flag':
        newStatus = 'flagged';
        break;
      case 'block':
        newStatus = 'blocked';
        break;
      case 'monitor':
        newStatus = 'monitored';
        break;
      default:
        newStatus = 'flagged';
    }

    // Update chat room status
    await c.env.DB.prepare(`
      UPDATE chat_rooms
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).bind(newStatus, new Date().toISOString(), chatId).run();

    // Log admin action in analytics
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_chat_action',
        userId: adminId,
        properties: { 
          actionId,
          chatId,
          action,
          reason: String(reason || ''),
          newStatus
        },
        timestamp: new Date().toISOString()
      });
    }


    const actionResult = {
      chatId,
      action,
      reason: String(reason || ''),
      timestamp: new Date().toISOString(),
      adminId,
      success: true,
      newStatus,
      actionId
    };

    return jsonSuccess(c, actionResult, `Chat action '${action}' performed successfully`);

  } catch (error) {
    console.error('Chat action error:', error);
    return jsonError(c, 'Failed to perform chat action', 'An error occurred while performing the chat action', 500);
  }
});

/**
 * Intervene in a chat
 */
chat.post('/monitoring/intervene/:chatId', validateUUID('chatId'), zValidator('json', chatInterveneSchema), async (c) => {
  const chatId = c.req.param('chatId');
  const { message } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Verify chat exists
    const roomExists = await c.env.DB.prepare(`
      SELECT id FROM chat_rooms WHERE id = ?
    `).bind(chatId).first();

    if (!roomExists) {
      return jsonError(c, 'Chat not found', 'The specified chat does not exist', 404);
    }

    // Insert admin intervention message
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    await c.env.DB.prepare(`
      INSERT INTO chat_messages (
        id, room_id, sender_id, message_type, content, 
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      messageId,
      chatId,
      adminId,
      'system', // Use system message type for admin messages
      message,
      timestamp
    ).run();

    // Update chat room's last_message_at
    await c.env.DB.prepare(`
      UPDATE chat_rooms
      SET last_message_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(timestamp, timestamp, chatId).run();

    // Log admin action in analytics
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_chat_intervention',
        userId: adminId,
        properties: { 
          actionId,
          chatId,
          messageId,
          message
        },
        timestamp
      });
    }


    // Get Durable Object for this chat room to notify participants
    const durableObjectId = c.env.CHAT_ROOM.idFromName(chatId);
    const durableObject = c.env.CHAT_ROOM.get(durableObjectId);

    // Notify participants about the intervention
    await durableObject.fetch('http://localhost/admin-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        senderId: adminId,
        content: message,
        timestamp
      })
    }).catch(err => {
      console.error('Failed to notify chat participants:', err);
      // Continue execution even if notification fails
    });

    const interventionResult = {
      chatId,
      message,
      timestamp,
      adminId,
      success: true,
      messageId
    };

    return jsonSuccess(c, interventionResult, 'Intervention message sent successfully');

  } catch (error) {
    console.error('Chat intervention error:', error);
    return jsonError(c, 'Failed to send intervention message', 'An error occurred while sending the intervention message', 500);
  }
});

export { chat as chatRoutes };
