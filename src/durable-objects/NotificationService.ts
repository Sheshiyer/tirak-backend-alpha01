import type { Env } from '../index';

export interface NotificationChannel {
  userId: string;
  type: 'mobile' | 'admin' | 'web';
  deviceToken?: string;
  preferences: {
    push: boolean;
    email: boolean;
    sms: boolean;
    types: {
      booking_confirmed: boolean;
      booking_cancelled: boolean;
      new_message: boolean;
      review_received: boolean;
      payment_completed: boolean;
    };
  };
}

export interface PushNotification {
  id: string;
  userId: string;
  title: string;
  message: string;
  data?: any;
  priority: 'low' | 'normal' | 'high';
  timestamp: string;
  deliveryStatus: 'pending' | 'sent' | 'delivered' | 'failed';
  retryCount: number;
}

export class NotificationService {
  private connections: Map<string, WebSocket> = new Map();
  private channels: Map<string, NotificationChannel> = new Map();
  private pendingNotifications: Map<string, PushNotification> = new Map();
  private env: Env;

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/send-notification':
        return this.handleSendNotification(request);
      case '/broadcast':
        return this.handleBroadcast(request);
      case '/register-device':
        return this.handleRegisterDevice(request);
      case '/send-push':
        return this.handleSendPush(request);
      case '/update-preferences':
        return this.handleUpdatePreferences(request);
      case '/retry-failed':
        return this.handleRetryFailed(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    
    // Get user ID from URL params
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');
    const channelType = url.searchParams.get('type') || 'mobile';
    const deviceToken = url.searchParams.get('deviceToken');

    if (!userId || !token) {
      return new Response('Missing userId or token', { status: 401 });
    }

    // Store the connection
    this.connections.set(userId, server);

    // Register or update channel
    const existingChannel = this.channels.get(userId);
    const channel: NotificationChannel = {
      userId,
      type: channelType as any,
      deviceToken: deviceToken ?? undefined,
      preferences: existingChannel?.preferences || {
        push: true,
        email: true,
        sms: false,
        types: {
          booking_confirmed: true,
          booking_cancelled: true,
          new_message: true,
          review_received: true,
          payment_completed: true
        }
      }
    };
    this.channels.set(userId, channel);

    // Handle connection events
    server.accept();

    server.addEventListener('close', () => {
      this.connections.delete(userId);
      // Keep channel info for push notifications
    });

    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        await this.handleWebSocketMessage(userId, data);
      } catch (error) {
        console.error('WebSocket message error:', error);
        server.send(JSON.stringify({
          type: 'error',
          data: { message: 'Failed to process message' },
          timestamp: new Date().toISOString()
        }));
      }
    });

    // Send connection confirmation with mobile app format
    server.send(JSON.stringify({
      type: 'connected',
      data: {
        userId: userId,
        channelType,
        preferences: channel.preferences
      },
      timestamp: new Date().toISOString()
    }));
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleSendNotification(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      type: string;
      title: string;
      message: string;
      data?: any;
      priority?: 'low' | 'normal' | 'high';
    };
    const { userId, type, title, message, data, priority = 'normal' } = body;

    try {
      const notificationId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const notification: PushNotification = {
        id: notificationId,
        userId,
        title,
        message,
        data,
        priority,
        timestamp,
        deliveryStatus: 'pending',
        retryCount: 0
      };

      // Check user preferences
      const channel = this.channels.get(userId);
      if (channel && !this.shouldSendNotification(channel, type)) {
        return new Response(JSON.stringify({
          success: true,
          notificationId,
          status: 'filtered'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let delivered = false;

      // Try WebSocket first
      const userSocket = this.connections.get(userId);
      if (userSocket) {
        try {
          userSocket.send(JSON.stringify({
            type: 'notification',
            data: {
              id: notificationId,
              type,
              title,
              message,
              data,
              priority,
              timestamp
            },
            timestamp
          }));
          notification.deliveryStatus = 'delivered';
          delivered = true;
        } catch (error) {
          console.error('WebSocket delivery failed:', error);
          this.connections.delete(userId);
        }
      }

      // If WebSocket failed or user not connected, try push notification
      if (!delivered && channel?.deviceToken && channel.preferences.push) {
        try {
          await this.sendPushNotification(notification, channel.deviceToken);
          notification.deliveryStatus = 'sent';
        } catch (error) {
          console.error('Push notification failed:', error);
          notification.deliveryStatus = 'failed';
          this.pendingNotifications.set(notificationId, notification);
        }
      }

      // Save to database for persistence
      await this.saveNotificationToDatabase(notification);

      return new Response(JSON.stringify({
        success: true,
        notificationId,
        deliveryStatus: notification.deliveryStatus
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Send notification error:', error);
      return new Response(JSON.stringify({ error: 'Failed to send notification' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = await request.json() as { type: string; title: string; message: string; data?: any; userIds?: string[] };
    const { type, title, message, data, userIds } = body;
    
    try {
      const notification = {
        id: crypto.randomUUID(),
        type,
        title,
        message,
        data,
        timestamp: new Date().toISOString()
      };
      
      const messageData = JSON.stringify({
        type: 'notification',
        data: notification
      });
      
      let sentCount = 0;
      
      if (userIds && Array.isArray(userIds)) {
        // Send to specific users
        userIds.forEach((userId: string) => {
          const socket = this.connections.get(userId);
          if (socket) {
            try {
              socket.send(messageData);
              sentCount++;
            } catch (error) {
              console.error(`Failed to send to user ${userId}:`, error);
            }
          }
        });
      } else {
        // Broadcast to all connected users
        this.connections.forEach((socket) => {
          try {
            socket.send(messageData);
            sentCount++;
          } catch (error) {
            console.error('Failed to send broadcast message:', error);
          }
        });
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        notificationId: notification.id,
        sentCount 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Broadcast error:', error);
      return new Response(JSON.stringify({ error: 'Failed to broadcast notification' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleRegisterDevice(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      deviceToken: string;
      platform: 'ios' | 'android';
      preferences?: any;
    };
    const { userId, deviceToken, platform, preferences } = body;

    try {
      const channel = this.channels.get(userId) || {
        userId,
        type: 'mobile' as const,
        deviceToken,
        preferences: {
          push: true,
          email: true,
          sms: false,
          types: {
            booking_confirmed: true,
            booking_cancelled: true,
            new_message: true,
            review_received: true,
            payment_completed: true
          }
        }
      };

      channel.deviceToken = deviceToken;
      if (preferences) {
        channel.preferences = { ...channel.preferences, ...preferences };
      }

      this.channels.set(userId, channel);

      return new Response(JSON.stringify({
        success: true,
        message: 'Device registered successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Device registration error:', error);
      return new Response(JSON.stringify({ error: 'Failed to register device' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleSendPush(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      title: string;
      message: string;
      data?: any;
      priority?: 'low' | 'normal' | 'high';
    };

    try {
      const channel = this.channels.get(body.userId);
      if (!channel?.deviceToken) {
        return new Response(JSON.stringify({
          error: 'No device token found for user'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const notification: PushNotification = {
        id: crypto.randomUUID(),
        userId: body.userId,
        title: body.title,
        message: body.message,
        data: body.data,
        priority: body.priority || 'normal',
        timestamp: new Date().toISOString(),
        deliveryStatus: 'pending',
        retryCount: 0
      };

      await this.sendPushNotification(notification, channel.deviceToken);
      notification.deliveryStatus = 'sent';

      return new Response(JSON.stringify({
        success: true,
        notificationId: notification.id
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Send push error:', error);
      return new Response(JSON.stringify({ error: 'Failed to send push notification' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleUpdatePreferences(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      preferences: Partial<NotificationChannel['preferences']>;
    };
    const { userId, preferences } = body;

    try {
      const channel = this.channels.get(userId);
      if (!channel) {
        return new Response(JSON.stringify({
          error: 'Channel not found for user'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      channel.preferences = { ...channel.preferences, ...preferences };
      this.channels.set(userId, channel);

      return new Response(JSON.stringify({
        success: true,
        preferences: channel.preferences
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Update preferences error:', error);
      return new Response(JSON.stringify({ error: 'Failed to update preferences' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleRetryFailed(request: Request): Promise<Response> {
    try {
      let retryCount = 0;
      const failedNotifications = Array.from(this.pendingNotifications.values())
        .filter(n => n.deliveryStatus === 'failed' && n.retryCount < 3);

      for (const notification of failedNotifications) {
        const channel = this.channels.get(notification.userId);
        if (channel?.deviceToken) {
          try {
            await this.sendPushNotification(notification, channel.deviceToken);
            notification.deliveryStatus = 'sent';
            notification.retryCount++;
            this.pendingNotifications.delete(notification.id);
            retryCount++;
          } catch (error) {
            notification.retryCount++;
            if (notification.retryCount >= 3) {
              this.pendingNotifications.delete(notification.id);
            }
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        retriedCount: retryCount
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Retry failed notifications error:', error);
      return new Response(JSON.stringify({ error: 'Failed to retry notifications' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleWebSocketMessage(userId: string, data: any): Promise<void> {
    const timestamp = new Date().toISOString();

    switch (data.type) {
      case 'ping':
        const userSocket = this.connections.get(userId);
        if (userSocket) {
          userSocket.send(JSON.stringify({
            type: 'pong',
            timestamp
          }));
        }
        break;

      case 'register_device':
        if (data.deviceToken) {
          const channel = this.channels.get(userId);
          if (channel) {
            channel.deviceToken = data.deviceToken;
            this.channels.set(userId, channel);
          }
        }
        break;

      case 'update_preferences':
        if (data.preferences) {
          const channel = this.channels.get(userId);
          if (channel) {
            channel.preferences = { ...channel.preferences, ...data.preferences };
            this.channels.set(userId, channel);
          }
        }
        break;

      case 'mark_delivered':
        if (data.notificationId) {
          const notification = this.pendingNotifications.get(data.notificationId);
          if (notification) {
            notification.deliveryStatus = 'delivered';
            await this.saveNotificationToDatabase(notification);
          }
        }
        break;

      default:
        console.warn('Unknown WebSocket message type:', data.type);
    }
  }

  private shouldSendNotification(channel: NotificationChannel, notificationType: string): boolean {
    // Check if user has enabled this notification type
    const typeKey = notificationType as keyof typeof channel.preferences.types;
    return channel.preferences.types[typeKey] !== false;
  }

  private async sendPushNotification(notification: PushNotification, deviceToken: string): Promise<void> {
    // This is a placeholder for actual push notification service integration
    // In production, you would integrate with FCM for Android and APNS for iOS

    try {
      // Simulate push notification API call
      const pushPayload = {
        to: deviceToken,
        notification: {
          title: notification.title,
          body: notification.message,
          priority: notification.priority
        },
        data: notification.data || {}
      };

      // In production, replace with actual FCM/APNS API call
      console.log('Sending push notification:', pushPayload);

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 100));

      // For development, we'll assume success
      // In production, handle actual API response and errors

    } catch (error) {
      console.error('Push notification API error:', error);
      throw error;
    }
  }

  private async saveNotificationToDatabase(notification: PushNotification): Promise<void> {
    try {
      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO notifications (
          id, user_id, type, title, message, data, read, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        notification.id,
        notification.userId,
        'push_notification',
        notification.title,
        notification.message,
        JSON.stringify(notification.data || {}),
        false,
        notification.timestamp,
        notification.timestamp
      ).run();
    } catch (error) {
      console.error('Failed to save notification to database:', error);
      // Don't throw error to avoid breaking notification flow
    }
  }

  // Admin notification methods
  public async sendAdminNotification(type: string, title: string, message: string, data?: any): Promise<void> {
    const adminConnections = Array.from(this.connections.entries())
      .filter(([userId]) => {
        const channel = this.channels.get(userId);
        return channel?.type === 'admin';
      });

    const notification = {
      id: crypto.randomUUID(),
      type,
      title,
      message,
      data,
      timestamp: new Date().toISOString()
    };

    const messageData = JSON.stringify({
      type: 'admin_notification',
      data: notification
    });

    adminConnections.forEach(([userId, socket]) => {
      try {
        socket.send(messageData);
      } catch (error) {
        console.error(`Failed to send admin notification to ${userId}:`, error);
        this.connections.delete(userId);
      }
    });
  }

  public async broadcastToMobile(type: string, title: string, message: string, data?: any): Promise<number> {
    const mobileConnections = Array.from(this.connections.entries())
      .filter(([userId]) => {
        const channel = this.channels.get(userId);
        return channel?.type === 'mobile';
      });

    const notification = {
      id: crypto.randomUUID(),
      type,
      title,
      message,
      data,
      timestamp: new Date().toISOString()
    };

    const messageData = JSON.stringify({
      type: 'notification',
      data: notification,
      timestamp: notification.timestamp
    });

    let sentCount = 0;
    mobileConnections.forEach(([userId, socket]) => {
      try {
        socket.send(messageData);
        sentCount++;
      } catch (error) {
        console.error(`Failed to send mobile notification to ${userId}:`, error);
        this.connections.delete(userId);
      }
    });

    return sentCount;
  }
}
