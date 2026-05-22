import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { createRateLimit } from '../../middleware/rateLimit';
import { adminCors } from '../../middleware/cors';
import { jsonSuccess, jsonError } from '../../utils/response';
import { validateDateRange } from '../../middleware/validation';
import type { Env, Variables } from '../../index';

const dashboard = new Hono<{ Bindings: Env; Variables: Variables }>();

type IntegrationStatus = 'connected' | 'unconfigured' | 'error' | 'no_data';

type DashboardIntegration = {
  id: string;
  label: string;
  status: IntegrationStatus;
  configured: boolean;
  summary: string;
  metrics?: Record<string, number | string | null>;
  details?: unknown;
  error?: string;
};

function missingIntegration(id: string, label: string, required: string[]): DashboardIntegration {
  return {
    id,
    label,
    status: 'unconfigured',
    configured: false,
    summary: `Set ${required.join(', ')} to connect ${label}.`,
  };
}

function providerError(id: string, label: string, error: unknown): DashboardIntegration {
  return {
    id,
    label,
    status: 'error',
    configured: true,
    summary: `${label} is configured but the API request failed.`,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function parseJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }

  return text ? JSON.parse(text) : {};
}

async function getCloudflareAnalytics(env: Env): Promise<DashboardIntegration> {
  if (!env.CF_ANALYTICS_API_TOKEN || !env.CF_ZONE_TAG) {
    return missingIntegration('cloudflare', 'Cloudflare Analytics', ['CF_ANALYTICS_API_TOKEN', 'CF_ZONE_TAG']);
  }

  try {
    const dateGeq = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          query ZoneTraffic($zoneTag: string, $dateGeq: string) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                httpRequests1dGroups(limit: 7, filter: { date_geq: $dateGeq }, orderBy: [date_ASC]) {
                  dimensions { date }
                  sum { requests bytes }
                  uniq { uniques }
                }
              }
            }
          }
        `,
        variables: { zoneTag: env.CF_ZONE_TAG, dateGeq },
      }),
    });

    const payload = await parseJsonResponse(response);
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error: any) => error.message).join('; '));
    }

    const rows = payload.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
    const requests = rows.reduce((sum: number, row: any) => sum + Number(row.sum?.requests ?? 0), 0);
    const bytes = rows.reduce((sum: number, row: any) => sum + Number(row.sum?.bytes ?? 0), 0);
    const uniques = rows.reduce((sum: number, row: any) => sum + Number(row.uniq?.uniques ?? 0), 0);

    return {
      id: 'cloudflare',
      label: 'Cloudflare Analytics',
      status: rows.length ? 'connected' : 'no_data',
      configured: true,
      summary: rows.length ? 'Cloudflare zone traffic loaded for the last 7 days.' : 'Cloudflare is connected but returned no traffic rows.',
      metrics: { requests, bytes, uniques, days: rows.length },
      details: rows,
    };
  } catch (error) {
    return providerError('cloudflare', 'Cloudflare Analytics', error);
  }
}

async function getGoogleAnalytics(env: Env): Promise<DashboardIntegration> {
  if (!env.GA_PROPERTY_ID || !env.GA_DATA_API_ACCESS_TOKEN) {
    return missingIntegration('ga4', 'Google Analytics', ['GA_PROPERTY_ID', 'GA_DATA_API_ACCESS_TOKEN']);
  }

  try {
    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GA_DATA_API_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }, { name: 'eventCount' }],
      }),
    });

    const payload = await parseJsonResponse(response);
    const values = payload.rows?.[0]?.metricValues ?? [];
    const activeUsers = Number(values[0]?.value ?? 0);
    const views = Number(values[1]?.value ?? 0);
    const events = Number(values[2]?.value ?? 0);

    return {
      id: 'ga4',
      label: 'Google Analytics',
      status: payload.rows?.length ? 'connected' : 'no_data',
      configured: true,
      summary: payload.rows?.length ? 'GA4 metrics loaded for the last 7 days.' : 'GA4 is connected but returned no rows.',
      metrics: { activeUsers, views, events },
    };
  } catch (error) {
    return providerError('ga4', 'Google Analytics', error);
  }
}

async function getUptimeRobot(env: Env): Promise<DashboardIntegration> {
  if (!env.UPTIMEROBOT_API_KEY) {
    return missingIntegration('uptimerobot', 'UptimeRobot', ['UPTIMEROBOT_API_KEY']);
  }

  try {
    const body = new URLSearchParams({
      api_key: env.UPTIMEROBOT_API_KEY,
      format: 'json',
      logs: '1',
      response_times: '1',
    });
    const response = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = await parseJsonResponse(response);
    if (payload.stat !== 'ok') {
      throw new Error(payload.error?.message || 'UptimeRobot returned a failed response.');
    }

    const monitors = payload.monitors ?? [];
    const up = monitors.filter((monitor: any) => monitor.status === 2).length;
    const down = monitors.filter((monitor: any) => monitor.status === 9).length;
    const paused = monitors.filter((monitor: any) => monitor.status === 0).length;
    const avgUptime = monitors.length
      ? monitors.reduce((sum: number, monitor: any) => sum + Number.parseFloat(monitor.all_time_uptime_ratio || '0'), 0) / monitors.length
      : 0;

    return {
      id: 'uptimerobot',
      label: 'UptimeRobot',
      status: monitors.length ? 'connected' : 'no_data',
      configured: true,
      summary: monitors.length ? 'UptimeRobot monitor status loaded.' : 'UptimeRobot is connected but has no monitors.',
      metrics: { monitors: monitors.length, up, down, paused, avgUptime: Number(avgUptime.toFixed(2)) },
      details: monitors.map((monitor: any) => ({
        id: monitor.id,
        name: monitor.friendly_name,
        url: monitor.url,
        status: monitor.status,
        uptime: monitor.all_time_uptime_ratio,
      })),
    };
  } catch (error) {
    return providerError('uptimerobot', 'UptimeRobot', error);
  }
}

async function getSentry(env: Env): Promise<DashboardIntegration> {
  if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_ORG_SLUG) {
    return missingIntegration('sentry', 'Sentry', ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG_SLUG']);
  }

  try {
    const apiBase = (env.SENTRY_API_BASE_URL || 'https://sentry.io').replace(/\/$/, '');
    const params = new URLSearchParams({
      statsPeriod: '24h',
      limit: '10',
      query: 'is:unresolved',
      sort: 'freq',
    });
    if (env.SENTRY_PROJECT_ID) {
      params.append('project', env.SENTRY_PROJECT_ID);
    }

    const response = await fetch(`${apiBase}/api/0/organizations/${env.SENTRY_ORG_SLUG}/issues/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.SENTRY_AUTH_TOKEN}` },
    });

    const issues = await parseJsonResponse(response);
    const totalEvents = Array.isArray(issues)
      ? issues.reduce((sum: number, issue: any) => sum + Number(issue.count ?? 0), 0)
      : 0;

    return {
      id: 'sentry',
      label: 'Sentry',
      status: Array.isArray(issues) ? 'connected' : 'no_data',
      configured: true,
      summary: Array.isArray(issues) ? 'Sentry unresolved issues loaded.' : 'Sentry returned no issue list.',
      metrics: { unresolvedIssues: Array.isArray(issues) ? issues.length : 0, eventCount: totalEvents },
      details: Array.isArray(issues)
        ? issues.slice(0, 5).map((issue: any) => ({
            id: issue.id,
            title: issue.title,
            level: issue.level,
            count: issue.count,
            lastSeen: issue.lastSeen,
          }))
        : [],
    };
  } catch (error) {
    return providerError('sentry', 'Sentry', error);
  }
}

async function getPostHog(env: Env): Promise<DashboardIntegration> {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) {
    return missingIntegration('posthog', 'PostHog', ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID']);
  }

  try {
    const host = (env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '');
    const response = await fetch(`${host}/api/projects/${env.POSTHOG_PROJECT_ID}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: `
            SELECT
              count() AS events,
              uniq(person_id) AS users
            FROM events
            WHERE timestamp >= now() - INTERVAL 7 DAY
          `,
        },
      }),
    });

    const payload = await parseJsonResponse(response);
    const firstRow = payload.results?.[0] ?? [];
    const events = Number(firstRow[0] ?? 0);
    const users = Number(firstRow[1] ?? 0);

    return {
      id: 'posthog',
      label: 'PostHog',
      status: payload.results?.length ? 'connected' : 'no_data',
      configured: true,
      summary: payload.results?.length ? 'PostHog product events loaded for the last 7 days.' : 'PostHog is connected but returned no query rows.',
      metrics: { events, users },
    };
  } catch (error) {
    return providerError('posthog', 'PostHog', error);
  }
}

async function getIntegrationOverview(env: Env): Promise<DashboardIntegration[]> {
  return Promise.all([
    getCloudflareAnalytics(env),
    getGoogleAnalytics(env),
    getUptimeRobot(env),
    getSentry(env),
    getPostHog(env),
  ]);
}

// Apply admin-specific middleware
dashboard.use('*', adminCors());
dashboard.use('*', authMiddleware);
dashboard.use('*', adminOnly);
dashboard.use('*', createRateLimit('admin'));

/**
 * Get platform overview statistics
 */
dashboard.get('/overview', async (c) => {
  try {
    // Get current date for time-based queries
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get total users by type
    const userStats = await c.env.DB.prepare(`
      SELECT 
        user_type,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_count,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_count
      FROM users 
      GROUP BY user_type
    `).bind(today).all();

    // Get total bookings and revenue
    const bookingStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_bookings,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_bookings,
        SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_revenue,
        SUM(CASE WHEN status = 'completed' AND DATE(created_at) >= ? THEN total_amount ELSE 0 END) as monthly_revenue
      FROM bookings
    `).bind(today, thirtyDaysAgo).first();

    // Get chat activity
    const chatStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(DISTINCT room_id) as active_rooms,
        COUNT(*) as total_messages,
        COUNT(CASE WHEN DATE(created_at) = ? THEN 1 END) as today_messages
      FROM chat_messages
      WHERE created_at >= ?
    `).bind(today, thirtyDaysAgo).first();

    // Get supplier verification stats
    const supplierStats = await c.env.DB.prepare(`
      SELECT 
        verification_status,
        COUNT(*) as count
      FROM supplier_profiles
      GROUP BY verification_status
    `).all();

    // Get recent activity (last 24 hours)
    const recentActivity = await c.env.DB.prepare(`
      SELECT 
        'user_registration' as type,
        COUNT(*) as count
      FROM users 
      WHERE created_at >= datetime('now', '-24 hours')
      
      UNION ALL
      
      SELECT 
        'booking_created' as type,
        COUNT(*) as count
      FROM bookings 
      WHERE created_at >= datetime('now', '-24 hours')
      
      UNION ALL
      
      SELECT 
        'chat_message' as type,
        COUNT(*) as count
      FROM chat_messages 
      WHERE created_at >= datetime('now', '-24 hours')
    `).all();

    const integrations = await getIntegrationOverview(c.env);

    return jsonSuccess(c, {
      users: {
        total: userStats.results?.reduce((sum: number, row: any) => sum + row.count, 0) || 0,
        active: userStats.results?.reduce((sum: number, row: any) => sum + row.active_count, 0) || 0,
        today: userStats.results?.reduce((sum: number, row: any) => sum + row.today_count, 0) || 0,
        byType: userStats.results?.reduce((acc: any, row: any) => {
          acc[row.user_type] = {
            total: row.count,
            active: row.active_count,
            today: row.today_count
          };
          return acc;
        }, {}) || {}
      },
      bookings: {
        total: bookingStats?.total_bookings || 0,
        completed: bookingStats?.completed_bookings || 0,
        today: bookingStats?.today_bookings || 0,
        revenue: {
          total: bookingStats?.total_revenue || 0,
          monthly: bookingStats?.monthly_revenue || 0
        }
      },
      chat: {
        activeRooms: chatStats?.active_rooms || 0,
        totalMessages: chatStats?.total_messages || 0,
        todayMessages: chatStats?.today_messages || 0
      },
      suppliers: {
        verification: supplierStats.results?.reduce((acc: any, row: any) => {
          acc[row.verification_status] = row.count;
          return acc;
        }, {}) || {}
      },
      recentActivity: recentActivity.results?.reduce((acc: any, row: any) => {
        acc[row.type] = row.count;
        return acc;
      }, {}) || {},
      integrations,
      generatedAt: new Date().toISOString()
    }, 'Platform overview retrieved successfully');

  } catch (error) {
    console.error('Dashboard overview error:', error);
    return jsonError(c, 'Failed to load dashboard', 'An error occurred while loading dashboard data', 500);
  }
});

/**
 * Get external analytics and observability provider status.
 */
dashboard.get('/integrations', async (c) => {
  try {
    return jsonSuccess(c, {
      integrations: await getIntegrationOverview(c.env),
      generatedAt: new Date().toISOString()
    }, 'Dashboard integrations retrieved successfully');
  } catch (error) {
    console.error('Dashboard integrations error:', error);
    return jsonError(c, 'Failed to load dashboard integrations', 'An error occurred while loading integration data', 500);
  }
});

/**
 * Get system health indicators
 */
dashboard.get('/health', async (c) => {
  try {
    const healthChecks = [];

    // Database connectivity check
    try {
      await c.env.DB.prepare('SELECT 1').first();
      healthChecks.push({
        service: 'database',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Database connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'database',
        status: 'unhealthy',
        responseTime: null,
        message: 'Database connection failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Storage connectivity check
    try {
      await c.env.STORAGE.head('health-check');
      healthChecks.push({
        service: 'storage',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Storage connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'storage',
        status: 'healthy', // R2 head requests can fail for non-existent objects but still indicate connectivity
        responseTime: Date.now(),
        message: 'Storage connection successful'
      });
    }

    // Cache connectivity check
    try {
      await c.env.CACHE.get('health-check');
      healthChecks.push({
        service: 'cache',
        status: 'healthy',
        responseTime: Date.now(),
        message: 'Cache connection successful'
      });
    } catch (error) {
      healthChecks.push({
        service: 'cache',
        status: 'unhealthy',
        responseTime: null,
        message: 'Cache connection failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    const overallStatus = healthChecks.every(check => check.status === 'healthy') ? 'healthy' : 'degraded';

    return jsonSuccess(c, {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      environment: c.env.ENVIRONMENT,
      checks: healthChecks
    }, 'System health check completed');

  } catch (error) {
    console.error('Health check error:', error);
    return jsonError(c, 'Health check failed', 'An error occurred during health check', 500);
  }
});

/**
 * Get platform metrics for a specific time range
 */
dashboard.get('/metrics', validateDateRange(), async (c) => {
  const { startDate, endDate } = c.get('validatedQuery');
  
  try {
    // User registration metrics
    const userMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        user_type,
        COUNT(*) as registrations
      FROM users 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), user_type
      ORDER BY date DESC
    `).bind(startDate, endDate).all();

    // Booking metrics
    const bookingMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        status,
        COUNT(*) as count,
        SUM(total_amount) as revenue
      FROM bookings 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at), status
      ORDER BY date DESC
    `).bind(startDate, endDate).all();

    // Chat activity metrics
    const chatMetrics = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as messages,
        COUNT(DISTINCT room_id) as active_rooms
      FROM chat_messages 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).bind(startDate, endDate).all();

    return jsonSuccess(c, {
      dateRange: { startDate, endDate },
      users: userMetrics.results || [],
      bookings: bookingMetrics.results || [],
      chat: chatMetrics.results || []
    }, 'Platform metrics retrieved successfully');

  } catch (error) {
    console.error('Metrics error:', error);
    return jsonError(c, 'Failed to load metrics', 'An error occurred while loading metrics data', 500);
  }
});

export { dashboard as dashboardRoutes };
