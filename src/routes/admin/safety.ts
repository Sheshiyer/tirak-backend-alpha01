import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError, jsonPaginated, createPagination } from '../../utils/response';
import { validatePagination, validateUUID, validateDateRange } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const safety = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware
safety.use('*', adminCors());
safety.use('*', authMiddleware);
safety.use('*', adminOnly);
safety.use('*', createRateLimit('admin'));

// Validation schemas
const safetyActionSchema = z.object({
  action: z.enum(['escalate', 'resolve', 'dismiss', 'investigate', 'flag']),
  notes: z.string().max(1000).optional(),
});

const reportAssignmentSchema = z.object({
  assignee: z.string().uuid(),
});

/**
 * Get safety reports stats
 * This is the endpoint that was returning 404 errors
 */
safety.get('/reports/stats', async (c) => {
  try {
    // In a real system, you'd query database tables for actual statistics
    // For now, we'll simulate the response with realistic placeholder data
    const statsData = {
      totalIncidents: 87,
      openIncidents: 23,
      criticalIncidents: 5,
      averageResolutionTime: '0' // Changed from '36 hours' to '0' as requested
    };

    return jsonSuccess(c, statsData, 'Safety report statistics retrieved successfully');

  } catch (error) {
    console.error('Safety stats error:', error);
    return jsonError(c, 'Failed to load safety stats', 'An error occurred while loading safety report statistics', 500);
  }
});

/**
 * Get all safety reports with filtering and pagination
 */
safety.get('/reports', validatePagination(), async (c) => {
  const { page, limit } = c.get('validatedQuery');
  const status = c.req.query('status');
  const severity = c.req.query('severity');
  const search = c.req.query('search');
  
  try {
    // Simulate pagination and filtering (in a real system, you'd query the database)
    const totalItems = 87; // Total number of safety reports
    const offset = (page - 1) * limit;
    
    // Build a list of sample safety reports
    const reports = Array.from({ length: Math.min(limit, totalItems - offset) }, (_, i) => {
      const index = offset + i;
      const reportDate = new Date();
      reportDate.setDate(reportDate.getDate() - (index % 30)); // Reports from the last 30 days
      
      // Generate different statuses and severities for variety
      const statuses = ['investigating', 'resolved', 'escalated', 'pending'];
      const severities = ['critical', 'high', 'medium', 'low'];
      const reportStatus = statuses[index % statuses.length];
      const reportSeverity = severities[index % severities.length];
      
      // Filter by status and severity if provided
      if ((status && status !== 'all' && reportStatus !== status) || 
          (severity && severity !== 'all' && reportSeverity !== severity)) {
        return null;
      }
      
      // Simple search implementation
      const reportTitle = `Safety Incident #${index + 1}`;
      const reportDescription = `This is a sample ${reportSeverity} severity safety incident that was reported on ${reportDate.toISOString().split('T')[0]}.`;
      if (search && 
          !reportTitle.toLowerCase().includes(search.toLowerCase()) && 
          !reportDescription.toLowerCase().includes(search.toLowerCase())) {
        return null;
      }
      
      return {
        id: `report-${crypto.randomUUID()}`,
        type: ['User Complaint', 'Platform Violation', 'Safety Concern', 'Security Alert'][index % 4],
        severity: reportSeverity,
        status: reportStatus,
        reportedDate: reportDate.toISOString(),
        reportedBy: `user-${1000 + index}`,
        reporterType: ['customer', 'supplier', 'admin', 'system'][index % 4],
        involvedParties: [`user-${2000 + index}`, `user-${3000 + index}`],
        description: reportDescription,
        location: ['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya'][index % 4],
        assignedTo: index % 3 === 0 ? `admin-${100 + (index % 5)}` : null
      };
    }).filter(Boolean); // Remove null items (filtered out)
    
    // Create pagination info
    const filteredCount = reports.length;
    const totalPages = Math.ceil(filteredCount / limit);
    const pagination = createPagination(page, limit, filteredCount);

    return jsonPaginated(c, reports, pagination, 'Safety reports retrieved successfully');

  } catch (error) {
    console.error('Safety reports error:', error);
    return jsonError(c, 'Failed to retrieve safety reports', 'An error occurred while retrieving safety reports', 500);
  }
});

/**
 * Get specific safety report details
 */
safety.get('/reports/:reportId', validateUUID('reportId'), async (c) => {
  const reportId = c.req.param('reportId');
  
  try {
    // In a real system, you'd query the database for the report details
    // For now, we'll simulate a response with placeholder data
    
    // Check if report exists (simulated)
    if (reportId.length < 10) {
      return jsonError(c, 'Report not found', 'The specified report does not exist', 404);
    }
    
    const reportDetails = {
      id: reportId,
      type: 'User Complaint',
      severity: 'high',
      status: 'investigating',
      reportedDate: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago
      reportedBy: 'user-1234',
      reporterType: 'customer',
      involvedParties: ['user-5678', 'user-9012'],
      description: 'Customer reported inappropriate behavior from a supplier during a service appointment.',
      location: 'Bangkok',
      assignedTo: 'admin-123',
      evidence: [
        {
          type: 'image',
          url: 'https://storage.example.com/evidence/123.jpg',
          description: 'Screenshot of conversation',
          submittedAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString()
        },
        {
          type: 'text',
          content: 'Transcript of the reported conversation',
          submittedAt: new Date(Date.now() - 46 * 60 * 60 * 1000).toISOString()
        }
      ],
      timeline: [
        {
          date: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
          action: 'Report submitted',
          user: 'user-1234',
          type: 'system',
          details: 'User submitted safety report'
        },
        {
          date: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
          action: 'Evidence added',
          user: 'user-1234',
          type: 'system',
          details: 'User added supporting evidence'
        },
        {
          date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          action: 'Report assigned',
          user: 'admin-100',
          type: 'admin',
          details: 'Report assigned to admin-123'
        },
        {
          date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          action: 'Investigation started',
          user: 'admin-123',
          type: 'admin',
          details: 'Admin began investigation process'
        }
      ]
    };

    return jsonSuccess(c, reportDetails, 'Safety report details retrieved successfully');

  } catch (error) {
    console.error('Safety report details error:', error);
    return jsonError(c, 'Failed to retrieve report details', 'An error occurred while retrieving safety report details', 500);
  }
});

/**
 * Get safety report timeline
 */
safety.get('/reports/:reportId/timeline', validateUUID('reportId'), async (c) => {
  const reportId = c.req.param('reportId');
  
  try {
    // In a real system, you'd query the timeline events for this report
    // For now, we'll simulate a response with placeholder data
    
    const timeline = [
      {
        date: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        action: 'Report submitted',
        user: 'user-1234',
        type: 'system',
        details: 'User submitted safety report'
      },
      {
        date: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
        action: 'Evidence added',
        user: 'user-1234',
        type: 'system',
        details: 'User added supporting evidence'
      },
      {
        date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        action: 'Report assigned',
        user: 'admin-100',
        type: 'admin',
        details: 'Report assigned to admin-123'
      },
      {
        date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        action: 'Investigation started',
        user: 'admin-123',
        type: 'admin',
        details: 'Admin began investigation process'
      }
    ];

    return jsonSuccess(c, timeline, 'Timeline retrieved successfully');

  } catch (error) {
    console.error('Timeline error:', error);
    return jsonError(c, 'Failed to retrieve timeline', 'An error occurred while retrieving the timeline', 500);
  }
});

/**
 * Get safety report evidence
 */
safety.get('/reports/:reportId/evidence', validateUUID('reportId'), async (c) => {
  const reportId = c.req.param('reportId');
  
  try {
    // In a real system, you'd query the evidence for this report
    // For now, we'll simulate a response with placeholder data
    
    const evidence = [
      {
        id: `evidence-${crypto.randomUUID()}`,
        type: 'image',
        description: 'Screenshot of conversation',
        status: 'reviewed',
        url: 'https://storage.example.com/evidence/123.jpg',
        submittedAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString()
      },
      {
        id: `evidence-${crypto.randomUUID()}`,
        type: 'text',
        description: 'Transcript of conversation',
        content: 'Transcript of the reported conversation',
        status: 'pending_review',
        submittedAt: new Date(Date.now() - 46 * 60 * 60 * 1000).toISOString()
      }
    ];

    return jsonSuccess(c, evidence, 'Evidence retrieved successfully');

  } catch (error) {
    console.error('Evidence retrieval error:', error);
    return jsonError(c, 'Failed to retrieve evidence', 'An error occurred while retrieving evidence', 500);
  }
});

/**
 * Update safety report status
 */
safety.post('/reports/:reportId/status', validateUUID('reportId'), zValidator('json', safetyActionSchema), async (c) => {
  const reportId = c.req.param('reportId');
  const { action, notes } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // In a real system, you'd update the report in the database
    // For now, we'll simulate a successful update
    
    // Add event to timeline (simulate)
    const newStatus = {
      'escalate': 'escalated',
      'resolve': 'resolved',
      'dismiss': 'dismissed',
      'investigate': 'investigating',
      'flag': 'flagged'
    }[action];
    
    const now = new Date();
    const timelineEvent = {
      date: now.toISOString(),
      action: `Status changed to: ${newStatus}`,
      user: adminId,
      type: 'admin',
      details: notes || `Admin changed report status to ${newStatus}`
    };

    return jsonSuccess(c, {
      reportId,
      previousStatus: 'investigating', // In real system, this would be the actual previous status
      currentStatus: newStatus,
      timelineEvent,
      updatedAt: now.toISOString(),
      updatedBy: adminId
    }, 'Safety report status updated successfully');

  } catch (error) {
    console.error('Status update error:', error);
    return jsonError(c, 'Failed to update status', 'An error occurred while updating the safety report status', 500);
  }
});

/**
 * Assign a safety report to an admin
 */
safety.post('/reports/:reportId/assign', validateUUID('reportId'), zValidator('json', reportAssignmentSchema), async (c) => {
  const reportId = c.req.param('reportId');
  const { assignee } = c.req.valid('json');
  const adminId = c.get('userId');
  
  try {
    // In a real system, you'd update the report in the database
    // For now, we'll simulate a successful assignment
    
    const now = new Date();
    const timelineEvent = {
      date: now.toISOString(),
      action: 'Report assigned',
      user: adminId,
      type: 'admin',
      details: `Report assigned to admin ${assignee}`
    };

    return jsonSuccess(c, {
      reportId,
      previousAssignee: null, // In real system, this might be the previous assignee
      currentAssignee: assignee,
      timelineEvent,
      assignedAt: now.toISOString(),
      assignedBy: adminId
    }, 'Safety report assigned successfully');

  } catch (error) {
    console.error('Assignment error:', error);
    return jsonError(c, 'Failed to assign report', 'An error occurred while assigning the safety report', 500);
  }
});

/**
 * Export safety reports data
 * This endpoint simulates generating an export of safety reports data
 */
safety.get('/reports/export', async (c) => {
  const format = c.req.query('format') || 'csv';
  const status = c.req.query('status');
  const severity = c.req.query('severity');
  const search = c.req.query('search');
  
  try {
    // In a real system, you'd generate the export file based on filters
    // For now, we'll simulate starting an export job
    
    if (!['csv', 'json', 'xlsx'].includes(format)) {
      return jsonError(c, 'Invalid format', 'The specified export format is not supported', 400);
    }

    const exportId = crypto.randomUUID();
    const exportUrl = `/api/admin/safety/reports/downloads/${exportId}.${format}`;

    return jsonSuccess(c, {
      exportId,
      format,
      filters: { status, severity, search },
      status: 'generating',
      downloadUrl: exportUrl,
      estimatedCompletion: new Date(Date.now() + 30 * 1000).toISOString() // 30 seconds
    }, 'Safety reports export started');

  } catch (error) {
    console.error('Export error:', error);
    return jsonError(c, 'Export failed', 'An error occurred while starting the export', 500);
  }
});

export { safety as safetyRoutes };
