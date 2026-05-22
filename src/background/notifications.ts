import type { Env } from '../index';
import {
  createEmailConfig,
  renderBasicEmail,
  sendEmail as sendTransactionalEmail,
} from '../utils/communication';

export interface NotificationJob {
  id: string;
  type: 'push' | 'email' | 'sms' | 'in_app';
  userId: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  scheduledFor?: string; // ISO timestamp for scheduled notifications
  retryCount?: number;
  maxRetries?: number;
  channels: ('push' | 'email' | 'sms' | 'in_app')[];
  template?: string;
  templateData?: Record<string, any>;
}

export interface NotificationResult {
  notificationId: string;
  channel: string;
  status: 'sent' | 'failed' | 'pending' | 'skipped';
  deliveredAt?: string;
  error?: string;
  externalId?: string; // ID from external service (FCM, SendGrid, etc.)
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Main queue consumer for notification jobs
 */
export async function handleNotificationQueue(batch: MessageBatch<NotificationJob>, env: Env): Promise<void> {
  console.log(`Processing ${batch.messages.length} notification jobs`);

  for (const message of batch.messages) {
    try {
      const job = message.body;
      
      // Check if notification is scheduled for future
      if (job.scheduledFor && new Date(job.scheduledFor) > new Date()) {
        // Re-queue for later processing
        await env.NOTIFICATION_QUEUE.send(job, {
          delaySeconds: Math.floor((new Date(job.scheduledFor).getTime() - Date.now()) / 1000),
        });
        message.ack();
        continue;
      }

      console.log(`Processing notification: ${job.id} for user ${job.userId}`);

      // Get user preferences
      const userPreferences = await getUserNotificationPreferences(job.userId, env);
      
      // Filter channels based on user preferences
      const enabledChannels = job.channels.filter(channel => 
        userPreferences[channel] !== false
      );

      if (userPreferences.types?.[job.data?.type || job.type] === false) {
        console.log(`Notification type disabled for user ${job.userId}`);
        await storeNotificationResult({
          notificationId: job.id,
          channel: 'all',
          status: 'skipped',
          error: 'Notification type disabled by user preferences'
        }, env);
        message.ack();
        continue;
      }

      if (enabledChannels.length === 0) {
        console.log(`All notification channels disabled for user ${job.userId}`);
        await storeNotificationResult({
          notificationId: job.id,
          channel: 'all',
          status: 'skipped',
          error: 'All channels disabled by user preferences'
        }, env);
        message.ack();
        continue;
      }

      // Process notification through enabled channels
      const results = await Promise.allSettled(
        enabledChannels.map(channel => processNotificationChannel(job, channel, env))
      );

      // Store results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const channel = enabledChannels[i];
        if (!result || !channel) continue;
        
        if (result.status === 'fulfilled') {
          await storeNotificationResult(result.value, env);
        } else {
          await storeNotificationResult({
            notificationId: job.id,
            channel,
            status: 'failed',
            error: getErrorMessage(result.reason)
          }, env);
        }
      }

      // Check if we need to retry failed notifications
      const failedResults = results.filter(r => r.status === 'rejected');
      if (failedResults.length > 0 && (job.retryCount || 0) < (job.maxRetries || 3)) {
        // Retry with exponential backoff
        const retryDelay = Math.pow(2, job.retryCount || 0) * 60; // Start with 1 minute
        const retryJob = { ...job, retryCount: (job.retryCount || 0) + 1 };
        await env.NOTIFICATION_QUEUE.send(retryJob, { delaySeconds: retryDelay });
      }

      message.ack();
      console.log(`Completed notification: ${job.id}`);

    } catch (error) {
      console.error(`Failed to process notification job:`, error);
      message.retry();
    }
  }
}

/**
 * Process notification through specific channel
 */
async function processNotificationChannel(job: NotificationJob, channel: string, env: Env): Promise<NotificationResult> {
  switch (channel) {
    case 'push':
      return await sendPushNotification(job, env);
    case 'email':
      return await sendEmailNotification(job, env);
    case 'sms':
      return await sendSMSNotification(job, env);
    case 'in_app':
      return await sendInAppNotification(job, env);
    default:
      throw new Error(`Unknown notification channel: ${channel}`);
  }
}

/**
 * Send push notification
 */
async function sendPushNotification(job: NotificationJob, env: Env): Promise<NotificationResult> {
  try {
    // Get user's push tokens
    const pushTokens = await getUserPushTokens(job.userId, env);
    
    if (pushTokens.length === 0) {
      return {
        notificationId: job.id,
        channel: 'push',
        status: 'skipped',
        error: 'No push tokens found for user'
      };
    }

    const pushResponse = await sendExpoPushNotification({
      tokens: pushTokens,
      title: job.title,
      body: job.message,
      data: job.data || {}
    }, env);

    return {
      notificationId: job.id,
      channel: 'push',
      status: 'sent',
      deliveredAt: new Date().toISOString(),
      externalId: pushResponse.messageId
    };

  } catch (error) {
    return {
      notificationId: job.id,
      channel: 'push',
      status: 'failed',
      error: getErrorMessage(error)
    };
  }
}

/**
 * Send email notification
 */
async function sendEmailNotification(job: NotificationJob, env: Env): Promise<NotificationResult> {
  try {
    // Get user email
    const userEmail = await getUserEmail(job.userId, env);
    
    if (!userEmail) {
      return {
        notificationId: job.id,
        channel: 'email',
        status: 'skipped',
        error: 'No email address found for user'
      };
    }

    // Prepare email content
    let emailContent = {
      subject: job.title,
      html: job.message,
      text: job.message
    };

    // Use template if specified
    if (job.template) {
      emailContent = await renderEmailTemplate(job.template, job.templateData || {}, env);
    }

    const emailResponse = await sendEmail({
      to: userEmail,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text
    }, env);

    return {
      notificationId: job.id,
      channel: 'email',
      status: 'sent',
      deliveredAt: new Date().toISOString(),
      externalId: emailResponse.messageId
    };

  } catch (error) {
    return {
      notificationId: job.id,
      channel: 'email',
      status: 'failed',
      error: getErrorMessage(error)
    };
  }
}

/**
 * Send SMS notification
 */
async function sendSMSNotification(job: NotificationJob, env: Env): Promise<NotificationResult> {
  try {
    // Get user phone number
    const userPhone = await getUserPhone(job.userId, env);
    
    if (!userPhone) {
      return {
        notificationId: job.id,
        channel: 'sms',
        status: 'skipped',
        error: 'No phone number found for user'
      };
    }

    // Send via SMS service (placeholder for actual implementation)
    const smsResponse = await sendSMS({
      to: userPhone,
      message: `${job.title}\n${job.message}`
    }, env);

    return {
      notificationId: job.id,
      channel: 'sms',
      status: 'sent',
      deliveredAt: new Date().toISOString(),
      externalId: smsResponse.messageId
    };

  } catch (error) {
    return {
      notificationId: job.id,
      channel: 'sms',
      status: 'failed',
      error: getErrorMessage(error)
    };
  }
}

/**
 * Send in-app notification
 */
async function sendInAppNotification(job: NotificationJob, env: Env): Promise<NotificationResult> {
  try {
    // Store in-app notification in database
    await env.DB.prepare(`
      INSERT INTO in_app_notifications (
        id, user_id, title, message, data, priority, 
        is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      job.userId,
      job.title,
      job.message,
      JSON.stringify(job.data || {}),
      job.priority,
      false,
      new Date().toISOString()
    ).run();

    // Send real-time notification via WebSocket
    const notificationService = env.NOTIFICATION_SERVICE.get(
      env.NOTIFICATION_SERVICE.idFromName(job.userId)
    );
    
    await notificationService.fetch('http://localhost/send-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: job.userId,
        type: 'notification',
        title: job.title,
        message: job.message,
        data: job.data
      })
    });

    return {
      notificationId: job.id,
      channel: 'in_app',
      status: 'sent',
      deliveredAt: new Date().toISOString()
    };

  } catch (error) {
    return {
      notificationId: job.id,
      channel: 'in_app',
      status: 'failed',
      error: getErrorMessage(error)
    };
  }
}

/**
 * Store notification result
 */
async function storeNotificationResult(result: NotificationResult, env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO notification_results (
      id, notification_id, channel, status, delivered_at, 
      error, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    result.notificationId,
    result.channel,
    result.status,
    result.deliveredAt || null,
    result.error || null,
    result.externalId || null,
    new Date().toISOString()
  ).run();
}

// Helper functions (placeholders for actual service integrations)

async function getUserNotificationPreferences(userId: string, env: Env): Promise<Record<string, any>> {
  const result = await env.DB.prepare(`
    SELECT notification_preferences FROM users WHERE id = ?
  `).bind(userId).first();
  
  if (result?.notification_preferences) {
    return JSON.parse(String(result.notification_preferences));
  }
  
  // Default preferences
  return {
    push: true,
    email: true,
    sms: false,
    in_app: true
  };
}

async function getUserPushTokens(userId: string, env: Env): Promise<string[]> {
  const result = await env.DB.prepare(`
    SELECT push_tokens FROM user_devices WHERE user_id = ? AND is_active = TRUE
  `).bind(userId).all();
  
  const tokens: string[] = [];
  for (const row of result.results || []) {
    if (row.push_tokens) {
      tokens.push(...JSON.parse(String(row.push_tokens)));
    }
  }
  
  return tokens;
}

async function getUserEmail(userId: string, env: Env): Promise<string | null> {
  const result = await env.DB.prepare(`
    SELECT email FROM users WHERE id = ? AND email_verified = TRUE
  `).bind(userId).first();
  
  return typeof result?.email === 'string' ? result.email : null;
}

async function getUserPhone(userId: string, env: Env): Promise<string | null> {
  const result = await env.DB.prepare(`
    SELECT phone FROM users WHERE id = ? AND phone_verified = TRUE
  `).bind(userId).first();
  
  return typeof result?.phone === 'string' ? result.phone : null;
}

// External service integrations

async function sendExpoPushNotification(payload: any, env: Env): Promise<{ messageId: string }> {
  const messages = payload.tokens.map((to: string) => ({
    to,
    sound: 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
  }));

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages.length === 1 ? messages[0] : messages),
  });

  if (!response.ok) {
    throw new Error(`Expo push failed with ${response.status}`);
  }

  const result = await response.json() as any;
  const firstTicket = Array.isArray(result?.data) ? result.data[0] : result?.data;

  if (firstTicket?.status === 'error') {
    throw new Error(firstTicket?.message || 'Expo push ticket returned an error');
  }

  return { messageId: firstTicket?.id || `expo_${crypto.randomUUID()}` };
}

async function sendEmail(payload: any, env: Env): Promise<{ messageId: string }> {
  const config = createEmailConfig(env);
  const delivery = await sendTransactionalEmail(
    config,
    payload.to,
    payload.subject,
    payload.html || renderBasicEmail(payload.subject, payload.text || payload.subject),
    'notification'
  );

  if (delivery.status === 'failed') {
    throw new Error(delivery.error || 'Email delivery failed');
  }

  return { messageId: delivery.id };
}

async function sendSMS(payload: any, env: Env): Promise<{ messageId: string }> {
  // Placeholder for SMS service integration (Twilio, AWS SNS, etc.)
  console.log('Sending SMS:', payload);
  return { messageId: `sms_${crypto.randomUUID()}` };
}

async function renderEmailTemplate(template: string, data: Record<string, any>, env: Env): Promise<{ subject: string; html: string; text: string }> {
  // Placeholder for email template rendering
  // In production, integrate with template engine like Handlebars or Mustache
  return {
    subject: `Tirak - ${template}`,
    html: `<h1>${data.title || 'Notification'}</h1><p>${data.message || 'You have a new notification.'}</p>`,
    text: `${data.title || 'Notification'}\n\n${data.message || 'You have a new notification.'}`
  };
}

/**
 * Utility function to queue a notification
 */
export async function queueNotification(notification: Omit<NotificationJob, 'id'>, env: Env): Promise<string> {
  const notificationId = crypto.randomUUID();
  const job: NotificationJob = {
    id: notificationId,
    ...notification
  };

  await env.NOTIFICATION_QUEUE.send(job);
  return notificationId;
}

/**
 * Utility function to queue bulk notifications
 */
export async function queueBulkNotifications(notifications: Omit<NotificationJob, 'id'>[], env: Env): Promise<string[]> {
  const jobs = notifications.map(notification => ({
    id: crypto.randomUUID(),
    ...notification
  }));

  await Promise.all(jobs.map(job => env.NOTIFICATION_QUEUE.send(job)));
  return jobs.map(job => job.id);
}
