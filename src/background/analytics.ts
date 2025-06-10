import type { Env } from '../index';

export interface AnalyticsEvent {
  eventType: string;
  userId: string;
  properties: Record<string, any>;
  timestamp: string;
  sessionId?: string;
  deviceInfo?: {
    platform: string;
    version: string;
    userAgent?: string;
  };
}

export interface AggregatedMetric {
  metric: string;
  value: number;
  dimensions: Record<string, string>;
  timestamp: string;
  period: 'hour' | 'day' | 'week' | 'month';
}

/**
 * Main queue consumer for analytics events
 */
export async function handleAnalyticsQueue(batch: MessageBatch<AnalyticsEvent>, env: Env): Promise<void> {
  console.log(`Processing ${batch.messages.length} analytics events`);

  const events: AnalyticsEvent[] = [];
  
  for (const message of batch.messages) {
    try {
      const event = message.body;
      events.push(event);
      message.ack();
    } catch (error) {
      console.error(`Failed to process analytics event:`, error);
      message.retry();
    }
  }

  if (events.length === 0) return;

  // Process events in batches
  await Promise.all([
    storeRawEvents(events, env),
    updateRealTimeMetrics(events, env),
    updateAggregatedMetrics(events, env),
    updateUserMetrics(events, env),
    updateBusinessMetrics(events, env)
  ]);

  console.log(`Processed ${events.length} analytics events`);
}

/**
 * Store raw events for detailed analysis
 */
async function storeRawEvents(events: AnalyticsEvent[], env: Env): Promise<void> {
  const stmt = env.DB.prepare(`
    INSERT INTO analytics_events (
      id, event_type, user_id, properties, timestamp, 
      session_id, device_info, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = events.map(event => 
    stmt.bind(
      crypto.randomUUID(),
      event.eventType,
      event.userId,
      JSON.stringify(event.properties),
      event.timestamp,
      event.sessionId || null,
      JSON.stringify(event.deviceInfo || {}),
      new Date().toISOString()
    )
  );

  await env.DB.batch(batch);
}

/**
 * Update real-time metrics for dashboard
 */
async function updateRealTimeMetrics(events: AnalyticsEvent[], env: Env): Promise<void> {
  const now = new Date();
  const hourKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`;

  // Group events by type
  const eventCounts = events.reduce((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Update real-time counters in KV
  for (const [eventType, count] of Object.entries(eventCounts)) {
    const key = `realtime:${eventType}:${hourKey}`;
    const current = await env.CACHE.get(key);
    const newCount = (parseInt(current || '0') + count).toString();
    await env.CACHE.put(key, newCount, { expirationTtl: 86400 }); // 24 hours
  }

  // Update active users
  const uniqueUsers = new Set(events.map(e => e.userId));
  const activeUsersKey = `realtime:active_users:${hourKey}`;
  const currentActiveUsers = await env.CACHE.get(activeUsersKey);
  const currentSet = new Set(currentActiveUsers ? JSON.parse(currentActiveUsers) : []);
  uniqueUsers.forEach(userId => currentSet.add(userId));
  await env.CACHE.put(activeUsersKey, JSON.stringify([...currentSet]), { expirationTtl: 86400 });
}

/**
 * Update aggregated metrics for reporting
 */
async function updateAggregatedMetrics(events: AnalyticsEvent[], env: Env): Promise<void> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Daily aggregations
  const dailyMetrics = calculateDailyMetrics(events, today);
  await storeDailyMetrics(dailyMetrics, env);

  // Hourly aggregations
  const hourlyMetrics = calculateHourlyMetrics(events, now);
  await storeHourlyMetrics(hourlyMetrics, env);
}

/**
 * Calculate daily metrics
 */
function calculateDailyMetrics(events: AnalyticsEvent[], date: string): AggregatedMetric[] {
  const metrics: AggregatedMetric[] = [];

  // User activity metrics
  const uniqueUsers = new Set(events.map(e => e.userId));
  metrics.push({
    metric: 'daily_active_users',
    value: uniqueUsers.size,
    dimensions: { date },
    timestamp: new Date().toISOString(),
    period: 'day'
  });

  // Event type metrics
  const eventCounts = events.reduce((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [eventType, count] of Object.entries(eventCounts)) {
    metrics.push({
      metric: 'event_count',
      value: count,
      dimensions: { date, event_type: eventType },
      timestamp: new Date().toISOString(),
      period: 'day'
    });
  }

  // User type metrics
  const userTypeEvents = events.filter(e => e.properties.userType);
  const userTypeCounts = userTypeEvents.reduce((acc, event) => {
    const userType = event.properties.userType;
    acc[userType] = (acc[userType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [userType, count] of Object.entries(userTypeCounts)) {
    metrics.push({
      metric: 'user_type_activity',
      value: count,
      dimensions: { date, user_type: userType },
      timestamp: new Date().toISOString(),
      period: 'day'
    });
  }

  return metrics;
}

/**
 * Calculate hourly metrics
 */
function calculateHourlyMetrics(events: AnalyticsEvent[], date: Date): AggregatedMetric[] {
  const hour = date.getHours();
  const dateHour = `${date.toISOString().split('T')[0]}-${String(hour).padStart(2, '0')}`;

  return [
    {
      metric: 'hourly_events',
      value: events.length,
      dimensions: { date_hour: dateHour },
      timestamp: new Date().toISOString(),
      period: 'hour'
    }
  ];
}

/**
 * Store daily metrics
 */
async function storeDailyMetrics(metrics: AggregatedMetric[], env: Env): Promise<void> {
  const stmt = env.DB.prepare(`
    INSERT OR REPLACE INTO daily_metrics (
      id, metric, value, dimensions, date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const batch = metrics.map(metric => {
    const id = `${metric.metric}-${metric.dimensions.date || new Date().toISOString().split('T')[0]}`;
    return stmt.bind(
      id,
      metric.metric,
      metric.value,
      JSON.stringify(metric.dimensions),
      metric.dimensions.date || new Date().toISOString().split('T')[0],
      new Date().toISOString()
    );
  });

  await env.DB.batch(batch);
}

/**
 * Store hourly metrics
 */
async function storeHourlyMetrics(metrics: AggregatedMetric[], env: Env): Promise<void> {
  const stmt = env.DB.prepare(`
    INSERT OR REPLACE INTO hourly_metrics (
      id, metric, value, dimensions, date_hour, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const batch = metrics.map(metric => {
    const dateHour = metric.dimensions.date_hour;
    const id = `${metric.metric}-${dateHour}`;
    return stmt.bind(
      id,
      metric.metric,
      metric.value,
      JSON.stringify(metric.dimensions),
      dateHour,
      new Date().toISOString()
    );
  });

  await env.DB.batch(batch);
}

/**
 * Update user-specific metrics
 */
async function updateUserMetrics(events: AnalyticsEvent[], env: Env): Promise<void> {
  const userMetrics = new Map<string, any>();

  // Calculate per-user metrics
  for (const event of events) {
    if (!userMetrics.has(event.userId)) {
      userMetrics.set(event.userId, {
        userId: event.userId,
        eventCount: 0,
        lastActivity: event.timestamp,
        eventTypes: new Set(),
        sessionIds: new Set()
      });
    }

    const metrics = userMetrics.get(event.userId);
    metrics.eventCount++;
    metrics.eventTypes.add(event.eventType);
    if (event.sessionId) {
      metrics.sessionIds.add(event.sessionId);
    }
    
    // Update last activity if this event is more recent
    if (new Date(event.timestamp) > new Date(metrics.lastActivity)) {
      metrics.lastActivity = event.timestamp;
    }
  }

  // Update user activity in database
  for (const [userId, metrics] of userMetrics) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO user_activity_summary (
        user_id, last_activity, daily_events, session_count, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      userId,
      metrics.lastActivity,
      metrics.eventCount,
      metrics.sessionIds.size,
      new Date().toISOString()
    ).run();
  }
}

/**
 * Update business metrics
 */
async function updateBusinessMetrics(events: AnalyticsEvent[], env: Env): Promise<void> {
  const businessEvents = events.filter(e => 
    ['booking_created', 'payment_completed', 'chat_started', 'profile_view'].includes(e.eventType)
  );

  if (businessEvents.length === 0) return;

  const today = new Date().toISOString().split('T')[0];

  // Calculate business metrics
  const bookingEvents = businessEvents.filter(e => e.eventType === 'booking_created');
  const paymentEvents = businessEvents.filter(e => e.eventType === 'payment_completed');
  const chatEvents = businessEvents.filter(e => e.eventType === 'chat_started');
  const profileViewEvents = businessEvents.filter(e => e.eventType === 'profile_view');

  // Calculate revenue
  const revenue = paymentEvents.reduce((sum, event) => {
    return sum + (event.properties.amount || 0);
  }, 0);

  // Store business metrics
  await env.DB.prepare(`
    INSERT OR REPLACE INTO business_metrics (
      date, bookings_created, revenue, chats_started, 
      profile_views, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    today,
    bookingEvents.length,
    revenue,
    chatEvents.length,
    profileViewEvents.length,
    new Date().toISOString()
  ).run();
}

/**
 * Generate analytics reports
 */
export async function generateDailyReport(date: string, env: Env): Promise<any> {
  const [
    dailyMetrics,
    userActivity,
    businessMetrics,
    topEvents
  ] = await Promise.all([
    getDailyMetrics(date, env),
    getUserActivitySummary(date, env),
    getBusinessMetrics(date, env),
    getTopEvents(date, env)
  ]);

  return {
    date,
    summary: {
      totalEvents: dailyMetrics.reduce((sum, m) => sum + (m.metric === 'event_count' ? m.value : 0), 0),
      activeUsers: dailyMetrics.find(m => m.metric === 'daily_active_users')?.value || 0,
      revenue: businessMetrics?.revenue || 0,
      bookings: businessMetrics?.bookings_created || 0
    },
    metrics: dailyMetrics,
    userActivity,
    businessMetrics,
    topEvents
  };
}

async function getDailyMetrics(date: string, env: Env): Promise<any[]> {
  const result = await env.DB.prepare(`
    SELECT metric, value, dimensions 
    FROM daily_metrics 
    WHERE date = ?
  `).bind(date).all();
  
  return result.results || [];
}

async function getUserActivitySummary(date: string, env: Env): Promise<any> {
  const result = await env.DB.prepare(`
    SELECT 
      COUNT(*) as active_users,
      AVG(daily_events) as avg_events_per_user,
      AVG(session_count) as avg_sessions_per_user
    FROM user_activity_summary 
    WHERE DATE(last_activity) = ?
  `).bind(date).first();
  
  return result || {};
}

async function getBusinessMetrics(date: string, env: Env): Promise<any> {
  const result = await env.DB.prepare(`
    SELECT * FROM business_metrics WHERE date = ?
  `).bind(date).first();
  
  return result || {};
}

async function getTopEvents(date: string, env: Env): Promise<any[]> {
  const result = await env.DB.prepare(`
    SELECT 
      JSON_EXTRACT(dimensions, '$.event_type') as event_type,
      value as count
    FROM daily_metrics 
    WHERE date = ? AND metric = 'event_count'
    ORDER BY value DESC
    LIMIT 10
  `).bind(date).all();
  
  return result.results || [];
}
