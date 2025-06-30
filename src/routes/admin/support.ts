import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const support = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
support.use('*', adminCors());
support.use('*', authMiddleware);
support.use('*', adminOnly);
support.use('*', createRateLimit('admin'));

// Validation schemas
const ticketUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  category: z.string().optional(),
  notes: z.string().optional()
});

const ticketAssignSchema = z.object({
  assigneeId: z.string().uuid()
});

const ticketReplySchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.string()).optional()
});

const ticketCreateSchema = z.object({
  subject: z.string().min(1).max(200),
  content: z.string().min(1),
  category: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  submittedBy: z.string().uuid().optional(),
  attachments: z.array(z.string()).optional()
});

/**
 * Get support tickets stats
 */
support.get('/tickets/stats', async (c) => {
  try {
    // Get total tickets count
    const totalTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as total FROM support_tickets
    `).first();
    
    // Get open tickets count
    const openTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM support_tickets WHERE status = 'open'
    `).first();
    
    // Get in progress tickets count
    const inProgressTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM support_tickets WHERE status = 'in_progress'
    `).first();
    
    // Get resolved tickets count
    const resolvedTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM support_tickets WHERE status = 'resolved'
    `).first();
    
    // Get closed tickets count
    const closedTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM support_tickets WHERE status = 'closed'
    `).first();
    
    // Get urgent tickets count
    const urgentTicketsResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM support_tickets WHERE priority = 'urgent'
    `).first();
    
    // Get average resolution time (in hours)
    const avgResolutionTimeResult = await c.env.DB.prepare(`
      SELECT AVG(
        CAST(
          (JULIANDAY(resolved_at) - JULIANDAY(created_at)) * 24 
          AS INTEGER
        )
      ) as avg_hours
      FROM support_tickets
      WHERE status IN ('resolved', 'closed')
      AND resolved_at IS NOT NULL
    `).first();
    
    const statsData = {
      totalTickets: Number(totalTicketsResult?.total || 0),
      openTickets: Number(openTicketsResult?.count || 0),
      inProgressTickets: Number(inProgressTicketsResult?.count || 0),
      resolvedTickets: Number(resolvedTicketsResult?.count || 0),
      closedTickets: Number(closedTicketsResult?.count || 0),
      urgentTickets: Number(urgentTicketsResult?.count || 0),
      averageResolutionTime: Number(avgResolutionTimeResult?.avg_hours || 0)
    };

    return jsonSuccess(c, statsData, 'Support ticket statistics retrieved successfully');

  } catch (error) {
    console.error('Support ticket stats error:', error);
    return jsonError(c, 'Failed to load support ticket stats', 'An error occurred while loading support ticket statistics', 500);
  }
});

/**
 * Get all support tickets with filtering and pagination
 */
support.get('/tickets', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const statusFilter = c.req.query('status');
  const priorityFilter = c.req.query('priority');
  const categoryFilter = c.req.query('category');
  const searchTerm = c.req.query('search');
  
  try {
    // Build the base query
    let countQuery = `
      SELECT COUNT(*) as total
      FROM support_tickets st
      LEFT JOIN users u ON st.submitted_by = u.id
    `;
    
    let ticketsQuery = `
      SELECT 
        st.id,
        st.subject,
        st.status,
        st.priority,
        st.category,
        st.created_at,
        st.updated_at,
        st.last_update,
        st.submitted_by,
        COALESCE(u.email, 'Unknown') as submitter_email,
        COALESCE(
          (SELECT display_name FROM customer_profiles WHERE user_id = st.submitted_by),
          (SELECT display_name FROM supplier_profiles WHERE user_id = st.submitted_by),
          u.email,
          'Unknown'
        ) as submittedBy
      FROM support_tickets st
      LEFT JOIN users u ON st.submitted_by = u.id
    `;
    
    // Add WHERE clauses for filtering
    let whereConditions = [];
    let params = [];
    
    if (statusFilter && statusFilter !== 'all') {
      whereConditions.push('st.status = ?');
      params.push(statusFilter);
    }
    
    if (priorityFilter && priorityFilter !== 'all') {
      whereConditions.push('st.priority = ?');
      params.push(priorityFilter);
    }
    
    if (categoryFilter && categoryFilter !== 'all') {
      whereConditions.push('st.category = ?');
      params.push(categoryFilter);
    }
    
    if (searchTerm) {
      whereConditions.push('(st.subject LIKE ? OR st.content LIKE ? OR u.email LIKE ?)');
      const searchPattern = `%${searchTerm}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }
    
    // Add WHERE clause to queries if conditions exist
    if (whereConditions.length > 0) {
      const whereClause = ' WHERE ' + whereConditions.join(' AND ');
      countQuery += whereClause;
      ticketsQuery += whereClause;
    }
    
    // Add pagination to tickets query
    ticketsQuery += ' ORDER BY st.created_at DESC LIMIT ? OFFSET ?';
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    
    // Execute count query
    const countResult = await c.env.DB.prepare(countQuery).bind(...params.slice(0, -2)).first();
    const total = Number(countResult?.total || 0);
    
    // Execute tickets query
    const ticketsResult = await c.env.DB.prepare(ticketsQuery).bind(...params).all();
    
    // Format the results
    const tickets = ticketsResult.results?.map((ticket: any) => ({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      submittedBy: ticket.submittedBy,
      lastUpdate: ticket.last_update || ticket.updated_at || ticket.created_at
    })) || [];
    
    const pagination = createPagination(page, limit, total);
    return jsonPaginated(c, tickets, pagination, 'Support tickets retrieved successfully');

  } catch (error) {
    console.error('Support tickets error:', error);
    return jsonError(c, 'Failed to retrieve support tickets', 'An error occurred while retrieving support tickets', 500);
  }
});

/**
 * Get specific support ticket details
 */
support.get('/tickets/:ticketId', validateUUID('ticketId'), async (c) => {
  const ticketId = c.req.param('ticketId');
  
  try {
    // Get ticket details
    const ticketResult = await c.env.DB.prepare(`
      SELECT 
        st.*,
        COALESCE(
          (SELECT display_name FROM customer_profiles WHERE user_id = st.submitted_by),
          (SELECT display_name FROM supplier_profiles WHERE user_id = st.submitted_by),
          u.email,
          'Unknown'
        ) as submitter_name,
        u.email as submitter_email,
        u.user_type as submitter_type,
        COALESCE(
          (SELECT display_name FROM customer_profiles WHERE user_id = st.assignee_id),
          (SELECT display_name FROM supplier_profiles WHERE user_id = st.assignee_id),
          a.email,
          'Unassigned'
        ) as assignee_name,
        a.email as assignee_email
      FROM support_tickets st
      LEFT JOIN users u ON st.submitted_by = u.id
      LEFT JOIN users a ON st.assignee_id = a.id
      WHERE st.id = ?
    `).bind(ticketId).first();

    if (!ticketResult) {
      return jsonError(c, 'Ticket not found', 'The specified support ticket does not exist', 404);
    }

    // Get ticket replies
    const repliesResult = await c.env.DB.prepare(`
      SELECT 
        r.*,
        COALESCE(
          (SELECT display_name FROM customer_profiles WHERE user_id = r.user_id),
          (SELECT display_name FROM supplier_profiles WHERE user_id = r.user_id),
          u.email,
          'Unknown'
        ) as user_name,
        u.email as user_email,
        u.user_type
      FROM support_ticket_replies r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.ticket_id = ?
      ORDER BY r.created_at ASC
    `).bind(ticketId).all();

    // Get ticket attachments
    const attachmentsResult = await c.env.DB.prepare(`
      SELECT * FROM support_ticket_attachments
      WHERE ticket_id = ?
      ORDER BY created_at ASC
    `).bind(ticketId).all();

    // Format the ticket details
    const ticket = {
      id: ticketResult.id,
      subject: ticketResult.subject,
      content: ticketResult.content,
      status: ticketResult.status,
      priority: ticketResult.priority,
      category: ticketResult.category,
      createdAt: ticketResult.created_at,
      updatedAt: ticketResult.updated_at,
      resolvedAt: ticketResult.resolved_at,
      submittedBy: {
        id: ticketResult.submitted_by,
        name: ticketResult.submitter_name,
        email: ticketResult.submitter_email,
        type: ticketResult.submitter_type
      },
      assignee: ticketResult.assignee_id ? {
        id: ticketResult.assignee_id,
        name: ticketResult.assignee_name,
        email: ticketResult.assignee_email
      } : null,
      replies: repliesResult.results?.map((reply: any) => ({
        id: reply.id,
        content: reply.content,
        createdAt: reply.created_at,
        user: {
          id: reply.user_id,
          name: reply.user_name,
          email: reply.user_email,
          type: reply.user_type
        },
        attachments: [] as Array<{
          id: string;
          filename: string;
          filesize: number;
          filetype: string;
          url: string;
          createdAt: string;
        }> // Will be populated below
      })) || [],
      attachments: attachmentsResult.results?.filter((att: any) => !att.reply_id).map((att: any) => ({
        id: att.id,
        filename: att.filename,
        filesize: att.filesize,
        filetype: att.filetype,
        url: att.url,
        createdAt: att.created_at
      })) || []
    };

    // Add reply attachments to their respective replies
    if (attachmentsResult.results) {
      for (const att of attachmentsResult.results) {
        if (att.reply_id) {
          const reply = ticket.replies.find(r => r.id === att.reply_id);
          if (reply) {
            reply.attachments.push({
              id: att.id as string,
              filename: att.filename as string,
              filesize: Number(att.filesize || 0),
              filetype: att.filetype as string,
              url: att.url as string,
              createdAt: att.created_at as string
            });
          }
        }
      }
    }

    return jsonSuccess(c, ticket, 'Support ticket details retrieved successfully');

  } catch (error) {
    console.error('Support ticket details error:', error);
    return jsonError(c, 'Failed to retrieve ticket details', 'An error occurred while retrieving support ticket details', 500);
  }
});

/**
 * Update support ticket
 */
support.patch('/tickets/:ticketId', validateUUID('ticketId'), zValidator('json', ticketUpdateSchema), async (c) => {
  const ticketId = c.req.param('ticketId');
  const updates = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if ticket exists
    const ticketExists = await c.env.DB.prepare(`
      SELECT id, status FROM support_tickets WHERE id = ?
    `).bind(ticketId).first();
    
    if (!ticketExists) {
      return jsonError(c, 'Ticket not found', 'The specified support ticket does not exist', 404);
    }

    // Build update query
    const updateFields = [];
    const params = [];

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      params.push(updates.status);
      
      // If status is being changed to resolved, set resolved_at timestamp
      if (updates.status === 'resolved' && ticketExists.status !== 'resolved') {
        updateFields.push('resolved_at = CURRENT_TIMESTAMP');
      }
    }

    if (updates.priority !== undefined) {
      updateFields.push('priority = ?');
      params.push(updates.priority);
    }

    if (updates.category !== undefined) {
      updateFields.push('category = ?');
      params.push(updates.category);
    }

    if (updates.notes !== undefined) {
      updateFields.push('notes = ?');
      params.push(updates.notes);
    }

    if (updateFields.length === 0) {
      return jsonError(c, 'No updates provided', 'At least one field must be updated', 400);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateFields.push('last_update = CURRENT_TIMESTAMP');
    params.push(ticketId);

    // Update ticket
    await c.env.DB.prepare(`
      UPDATE support_tickets 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `).bind(...params).run();

    // Log admin action
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_ticket_update',
        userId: adminId,
        properties: { 
          actionId,
          ticketId,
          updates
        },
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Failed to log ticket update:', err));
    }

    return jsonSuccess(c, { 
      ticketId, 
      updates,
      updatedBy: adminId,
      updatedAt: new Date().toISOString()
    }, 'Support ticket updated successfully');

  } catch (error) {
    console.error('Support ticket update error:', error);
    return jsonError(c, 'Failed to update ticket', 'An error occurred while updating the support ticket', 500);
  }
});

/**
 * Assign support ticket
 */
support.post('/tickets/:ticketId/assign', validateUUID('ticketId'), zValidator('json', ticketAssignSchema), async (c) => {
  const ticketId = c.req.param('ticketId');
  const { assigneeId } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if ticket exists
    const ticketExists = await c.env.DB.prepare(`
      SELECT id FROM support_tickets WHERE id = ?
    `).bind(ticketId).first();
    
    if (!ticketExists) {
      return jsonError(c, 'Ticket not found', 'The specified support ticket does not exist', 404);
    }

    // Check if assignee exists and is an admin
    const assigneeExists = await c.env.DB.prepare(`
      SELECT id FROM users WHERE id = ? AND user_type = 'admin'
    `).bind(assigneeId).first();
    
    if (!assigneeExists) {
      return jsonError(c, 'Invalid assignee', 'The specified assignee does not exist or is not an admin', 400);
    }

    // Update ticket
    await c.env.DB.prepare(`
      UPDATE support_tickets 
      SET assignee_id = ?, updated_at = CURRENT_TIMESTAMP, last_update = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(assigneeId, ticketId).run();

    // Log admin action
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_ticket_assign',
        userId: adminId,
        properties: { 
          actionId,
          ticketId,
          assigneeId
        },
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Failed to log ticket assignment:', err));
    }

    return jsonSuccess(c, { 
      ticketId, 
      assigneeId,
      assignedBy: adminId,
      assignedAt: new Date().toISOString()
    }, 'Support ticket assigned successfully');

  } catch (error) {
    console.error('Support ticket assignment error:', error);
    return jsonError(c, 'Failed to assign ticket', 'An error occurred while assigning the support ticket', 500);
  }
});

/**
 * Reply to support ticket
 */
support.post('/tickets/:ticketId/reply', validateUUID('ticketId'), zValidator('json', ticketReplySchema), async (c) => {
  const ticketId = c.req.param('ticketId');
  const { content, attachments } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Check if ticket exists
    const ticketExists = await c.env.DB.prepare(`
      SELECT id FROM support_tickets WHERE id = ?
    `).bind(ticketId).first();
    
    if (!ticketExists) {
      return jsonError(c, 'Ticket not found', 'The specified support ticket does not exist', 404);
    }

    // Create reply
    const replyId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO support_ticket_replies (
        id, ticket_id, user_id, content, created_at
      )
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(replyId, ticketId, adminId, content).run();

    // Update ticket's last_update timestamp
    await c.env.DB.prepare(`
      UPDATE support_tickets 
      SET updated_at = CURRENT_TIMESTAMP, last_update = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(ticketId).run();

    // Add attachments if provided
    const savedAttachments = [];
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        // In a real system, you'd validate and process the attachment
        // For now, we'll just save the attachment reference
        const attachmentId = crypto.randomUUID();
        const filename = attachment.split('/').pop() || 'file';
        const filetype = filename.split('.').pop() || 'unknown';
        
        await c.env.DB.prepare(`
          INSERT INTO support_ticket_attachments (
            id, ticket_id, reply_id, filename, filetype, filesize, url, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          attachmentId, 
          ticketId, 
          replyId, 
          filename, 
          filetype, 
          0, // Filesize would be determined from the actual file
          attachment
        ).run();
        
        savedAttachments.push({
          id: attachmentId,
          filename,
          filetype,
          url: attachment
        });
      }
    }

    // Log admin action
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_ticket_reply',
        userId: adminId,
        properties: { 
          actionId,
          ticketId,
          replyId,
          hasAttachments: attachments && attachments.length > 0
        },
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Failed to log ticket reply:', err));
    }

    return jsonSuccess(c, { 
      ticketId, 
      replyId,
      content,
      attachments: savedAttachments,
      createdBy: adminId,
      createdAt: new Date().toISOString()
    }, 'Reply added successfully');

  } catch (error) {
    console.error('Support ticket reply error:', error);
    return jsonError(c, 'Failed to add reply', 'An error occurred while adding reply to the support ticket', 500);
  }
});

/**
 * Create new support ticket
 */
support.post('/tickets/create', zValidator('json', ticketCreateSchema), async (c) => {
  const { subject, content, category, priority, submittedBy, attachments } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // Use provided submittedBy or default to the admin creating the ticket
    const effectiveSubmitter = submittedBy || adminId;
    
    // Check if submitter exists
    const submitterExists = await c.env.DB.prepare(`
      SELECT id FROM users WHERE id = ?
    `).bind(effectiveSubmitter).first();
    
    if (!submitterExists) {
      return jsonError(c, 'Invalid submitter', 'The specified submitter does not exist', 400);
    }

    // Create ticket
    const ticketId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO support_tickets (
        id, subject, content, status, priority, category, 
        submitted_by, created_at, updated_at, last_update
      )
      VALUES (?, ?, ?, 'open', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      ticketId, 
      subject, 
      content, 
      priority, 
      category, 
      effectiveSubmitter
    ).run();

    // Add attachments if provided
    const savedAttachments = [];
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        // In a real system, you'd validate and process the attachment
        // For now, we'll just save the attachment reference
        const attachmentId = crypto.randomUUID();
        const filename = attachment.split('/').pop() || 'file';
        const filetype = filename.split('.').pop() || 'unknown';
        
        await c.env.DB.prepare(`
          INSERT INTO support_ticket_attachments (
            id, ticket_id, filename, filetype, filesize, url, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          attachmentId, 
          ticketId, 
          filename, 
          filetype, 
          0, // Filesize would be determined from the actual file
          attachment
        ).run();
        
        savedAttachments.push({
          id: attachmentId,
          filename,
          filetype,
          url: attachment
        });
      }
    }

    // Log admin action
    const actionId = crypto.randomUUID();
    if (c.env.ANALYTICS_QUEUE && typeof c.env.ANALYTICS_QUEUE.send === 'function') {
      await c.env.ANALYTICS_QUEUE.send({
        eventType: 'admin_ticket_create',
        userId: adminId,
        properties: { 
          actionId,
          ticketId,
          subject,
          category,
          priority,
          submittedBy: effectiveSubmitter,
          hasAttachments: attachments && attachments.length > 0
        },
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Failed to log ticket creation:', err));
    }

    return jsonSuccess(c, { 
      ticketId, 
      subject,
      status: 'open',
      priority,
      category,
      submittedBy: effectiveSubmitter,
      attachments: savedAttachments,
      createdAt: new Date().toISOString()
    }, 'Support ticket created successfully', 201);

  } catch (error) {
    console.error('Support ticket creation error:', error);
    return jsonError(c, 'Failed to create ticket', 'An error occurred while creating the support ticket', 500);
  }
});

export { support as supportRoutes };
