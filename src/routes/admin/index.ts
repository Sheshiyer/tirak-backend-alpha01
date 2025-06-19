import { Hono } from 'hono';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess } from '../../utils/response';
import { dashboardRoutes } from './dashboard';
import { userManagementRoutes } from './users';
import { moderationRoutes } from './moderation';
import { analyticsRoutes } from './analytics';
import { subscriptionRoutes } from './subscriptions';
import { safetyRoutes } from './safety';
import { chatRoutes } from './chat';
import { regionsRoutes } from './regions';
import { supportRoutes } from './support';
import { reportsRoutes } from './reports';
import type { Env, Variables } from '../../index';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply admin-specific middleware to all routes
admin.use('*', adminCors());
admin.use('*', authMiddleware);
admin.use('*', adminOnly);
admin.use('*', createRateLimit('admin'));

// Admin API info endpoint
admin.get('/', (c) => {
  return jsonSuccess(c, {
    message: 'Tirak Admin API',
    version: '1.0.0',
    endpoints: {
      dashboard: '/api/admin/dashboard',
      users: '/api/admin/users',
      moderation: '/api/admin/moderation',
      analytics: '/api/admin/analytics',
      subscriptions: '/api/admin/subscriptions',
      safety: '/api/admin/safety',
      chat: '/api/admin/chat',
      regions: '/api/admin/regions',
      support: '/api/admin/support',
      reports: '/api/admin/reports'
    },
    adminUser: {
      id: c.get('userId'),
      userType: c.get('userType')
    }
  }, 'Admin API access granted');
});

// Mount sub-routes
admin.route('/dashboard', dashboardRoutes);
admin.route('/users', userManagementRoutes);
admin.route('/moderation', moderationRoutes);
admin.route('/analytics', analyticsRoutes);
admin.route('/subscriptions', subscriptionRoutes);
admin.route('/safety', safetyRoutes);
admin.route('/chat', chatRoutes);
admin.route('/regions', regionsRoutes);
admin.route('/support', supportRoutes);
admin.route('/reports', reportsRoutes);

export { admin as adminRoutes };
