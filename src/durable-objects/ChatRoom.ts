import type { Env } from '../index';

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  recipientId: string;
  content: string;
  messageType: 'text' | 'image' | 'audio' | 'file';
  mediaUrl?: string;
  timestamp: string;
  edited?: boolean;
  editedAt?: string;
  status: 'sent' | 'delivered' | 'read';
  deliveredAt?: string;
  readAt?: string;
  replyTo?: string;
}

export interface TypingIndicator {
  userId: string;
  timestamp: string;
}

export interface UserPresence {
  userId: string;
  status: 'online' | 'offline' | 'away';
  lastSeen: string;
}

export interface WebSocketEvent {
  type: 'message_received' | 'typing_start' | 'typing_stop' | 'message_status_update' |
        'booking_status_update' | 'booking_request' | 'notification' | 'user_presence_update' |
        'connected' | 'error';
  data: any;
  timestamp: string;
}

export class ChatRoom {
  private sessions: Map<string, WebSocket> = new Map();
  private userPresence: Map<string, UserPresence> = new Map();
  private typingUsers: Map<string, TypingIndicator> = new Map();
  private env: Env;
  private roomId: string | null = null;

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env;
  }

  // The authenticated router supplies the logical room ID. A Durable Object ID
  // is not a database room ID, and one instance must never switch rooms.
  private bindRoom(roomId: string): boolean {
    if (!roomId || (this.roomId && this.roomId !== roomId)) return false;
    this.roomId = roomId;
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/send-message':
        return this.handleSendMessage(request);
      case '/typing':
        return this.handleTyping(request);
      case '/end-chat':
        return this.handleEndChat(request);
      case '/message-status':
        return this.handleMessageStatus(request);
      case '/presence':
        return this.handlePresenceUpdate(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    // The authenticated route injects the verified user ID before forwarding.
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const roomId = url.searchParams.get('roomId');
    
    if (!userId || !roomId) {
      return new Response('Missing authenticated user ID', { status: 401 });
    }
    if (!this.bindRoom(roomId)) {
      return new Response('Chat room mismatch', { status: 409 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    
    // Store the connection
    this.sessions.set(userId, server);

    // Update user presence
    this.userPresence.set(userId, {
      userId,
      status: 'online',
      lastSeen: new Date().toISOString()
    });

    // Handle connection events
    server.accept();

    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        await this.handleWebSocketMessage(userId, data);
      } catch (error) {
        console.error('WebSocket message error:', error);
        this.sendToUser(userId, {
          type: 'error',
          data: { message: 'Failed to process message' },
          timestamp: new Date().toISOString()
        });
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(userId);
      this.typingUsers.delete(userId);

      // Update presence to offline
      const presence = this.userPresence.get(userId);
      if (presence) {
        presence.status = 'offline';
        presence.lastSeen = new Date().toISOString();
        this.userPresence.set(userId, presence);

        // Broadcast presence update
        this.broadcastPresenceUpdate(userId, presence);
      }
    });

    // Send connection confirmation with mobile app format
    this.sendToUser(userId, {
      type: 'connected',
      data: {
        roomId: this.roomId,
        userId: userId,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });

    // Broadcast presence update to other users
    const presence = this.userPresence.get(userId);
    if (presence) {
      this.broadcastPresenceUpdate(userId, presence);
    }
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleSendMessage(request: Request): Promise<Response> {
    const body = await request.json() as {
      roomId: string;
      senderId: string;
      recipientId: string;
      messageType: string;
      content?: string;
      mediaUrl?: string;
      replyTo?: string;
    };
    const { roomId, senderId, recipientId, messageType, content, mediaUrl, replyTo } = body;

    if (typeof roomId !== 'string' || !roomId || !senderId || !recipientId || senderId === recipientId) {
      return new Response(JSON.stringify({ error: 'Valid room and participants are required' }), { status: 400 });
    }
    if (!this.bindRoom(roomId)) {
      return new Response(JSON.stringify({ error: 'Chat room mismatch' }), { status: 409 });
    }

    try {
      const messageId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      // Create message with mobile app format
      const message: ChatMessage = {
        id: messageId,
        roomId,
        senderId,
        recipientId,
        content: content || '',
        messageType: messageType as any,
        mediaUrl,
        timestamp,
        status: 'sent',
        replyTo
      };

      // Save to database
      await this.saveMessageToDatabase(message);

      // Broadcast message to all connected clients
      this.broadcastEvent({
        type: 'message_received',
        data: message,
        timestamp
      });

      // Mark as delivered if recipient is online
      if (this.sessions.has(recipientId)) {
        try {
          const updated = await this.updateMessageStatus(messageId, 'delivered', timestamp, recipientId);
          if (updated) {
            message.status = 'delivered';
            message.deliveredAt = timestamp;
            this.sendToUser(senderId, {
              type: 'message_status_update',
              data: { messageId, status: 'delivered', timestamp },
              timestamp
            });
          }
        } catch {
          // The message is already committed and broadcast. A receipt outage
          // must not turn a successful send into a retryable send failure.
          console.warn('Message saved; delivery receipt could not be recorded.');
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: {
          id: messageId,
          roomId: message.roomId,
          senderId,
          recipientId,
          messageType,
          content: message.content,
          mediaUrl,
          status: message.status,
          timestamp
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Send message error:', error);
      return new Response(JSON.stringify({ error: 'Failed to send message' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleTyping(request: Request): Promise<Response> {
    const body = await request.json() as { userId: string; isTyping: boolean };
    const { userId, isTyping } = body;

    const timestamp = new Date().toISOString();

    if (isTyping) {
      // Add to typing users
      this.typingUsers.set(userId, {
        userId,
        timestamp
      });

      // Broadcast typing start event
      this.broadcastEvent({
        type: 'typing_start',
        data: { userId, timestamp },
        timestamp
      }, userId);
    } else {
      // Remove from typing users
      this.typingUsers.delete(userId);

      // Broadcast typing stop event
      this.broadcastEvent({
        type: 'typing_stop',
        data: { userId, timestamp },
        timestamp
      }, userId);
    }

    return new Response(JSON.stringify({ success: true }));
  }

  private async handleMessageStatus(request: Request): Promise<Response> {
    const body = await request.json() as {
      messageId: string;
      status: 'delivered' | 'read';
      userId: string;
      roomId?: string;
    };
    const { messageId, status, userId } = body;

    if (!messageId || typeof messageId !== 'string' || !userId || (status !== 'read' && status !== 'delivered')) {
      return new Response(JSON.stringify({ error: 'Invalid receipt request' }), { status: 400 });
    }
    if (body.roomId && !this.bindRoom(body.roomId)) {
      return new Response(JSON.stringify({ error: 'Chat room mismatch' }), { status: 409 });
    }
    if (!this.roomId) {
      return new Response(JSON.stringify({ error: 'A trusted chat room is required' }), { status: 400 });
    }

    try {
      const timestamp = new Date().toISOString();
      const updated = await this.updateMessageStatus(messageId, status, timestamp, userId);
      if (!updated) {
        return new Response(JSON.stringify({ error: 'Message not found or receipt not permitted' }), { status: 404 });
      }

      // Broadcast status update to sender
      this.broadcastEvent({
        type: 'message_status_update',
        data: {
          messageId,
          status,
          timestamp,
          userId
        },
        timestamp
      });

      return new Response(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Message status update error:', error);
      return new Response(JSON.stringify({ error: 'Failed to update message status' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handlePresenceUpdate(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string;
      status: 'online' | 'offline' | 'away';
    };
    const { userId, status } = body;

    try {
      const timestamp = new Date().toISOString();
      const presence: UserPresence = {
        userId,
        status,
        lastSeen: timestamp
      };

      this.userPresence.set(userId, presence);
      this.broadcastPresenceUpdate(userId, presence);

      return new Response(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Presence update error:', error);
      return new Response(JSON.stringify({ error: 'Failed to update presence' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleEndChat(request: Request): Promise<Response> {
    // Close all connections
    this.sessions.forEach((socket) => {
      socket.close();
    });
    this.sessions.clear();
    this.userPresence.clear();
    this.typingUsers.clear();

    return new Response(JSON.stringify({ success: true }));
  }

  private broadcastEvent(event: WebSocketEvent, excludeUserId?: string): void {
    const eventData = JSON.stringify(event);

    this.sessions.forEach((socket, userId) => {
      if (excludeUserId && userId === excludeUserId) return;

      try {
        socket.send(eventData);
      } catch (error) {
        console.error('Failed to send event to client:', error);
        // Remove failed connection
        this.sessions.delete(userId);
      }
    });
  }

  private sendToUser(userId: string, event: WebSocketEvent): void {
    const socket = this.sessions.get(userId);
    if (socket) {
      try {
        socket.send(JSON.stringify(event));
      } catch (error) {
        console.error('Failed to send event to user:', error);
        this.sessions.delete(userId);
      }
    }
  }

  private broadcastPresenceUpdate(userId: string, presence: UserPresence): void {
    this.broadcastEvent({
      type: 'user_presence_update',
      data: presence,
      timestamp: new Date().toISOString()
    }, userId);
  }

  private async saveMessageToDatabase(message: ChatMessage): Promise<void> {
    try {
      await this.env.DB.batch([this.env.DB.prepare(`
        INSERT INTO booking_chat_messages (
          id, room_id, sender_id, content, message_type,
          image_url, metadata, reply_to_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        message.id,
        message.roomId,
        message.senderId,
        message.content,
        message.messageType,
        message.mediaUrl || null,
        null,
        message.replyTo || null,
        message.timestamp
      ), this.env.DB.prepare(`UPDATE booking_chat_rooms
        SET last_message_at = ?, updated_at = ? WHERE id = ?`)
        .bind(message.timestamp, message.timestamp, message.roomId)]);
    } catch (error) {
      console.error('Failed to save message to database:', error);
      throw error;
    }
  }

  private async updateMessageStatus(messageId: string, status: 'delivered' | 'read', timestamp: string, recipientId: string): Promise<boolean> {
    if (!this.roomId) return false;
    const statusField = status === 'delivered' ? 'delivered_at' : 'read_at';
    const result = await this.env.DB.prepare(`
        UPDATE booking_chat_messages
        SET ${statusField} = COALESCE(${statusField}, ?)
        WHERE id = ? AND room_id = ? AND sender_id <> ?
          AND EXISTS (
            SELECT 1 FROM booking_chat_rooms cr
            WHERE cr.id = booking_chat_messages.room_id
              AND (
                (cr.customer_id = ? AND cr.supplier_id = booking_chat_messages.sender_id)
                OR (cr.supplier_id = ? AND cr.customer_id = booking_chat_messages.sender_id)
              )
          )
      `).bind(timestamp, messageId, this.roomId, recipientId, recipientId, recipientId).run();
    return result.success && Number(result.meta.changes) > 0;
  }

  private async handleWebSocketMessage(userId: string, data: any): Promise<void> {
    const timestamp = new Date().toISOString();

    switch (data.type) {
      case 'ping':
        this.sendToUser(userId, {
          type: 'pong' as any,
          data: { timestamp },
          timestamp
        });
        break;

      case 'typing_start':
        this.typingUsers.set(userId, { userId, timestamp });
        this.broadcastEvent({
          type: 'typing_start',
          data: { userId, timestamp },
          timestamp
        }, userId);
        break;

      case 'typing_stop':
        this.typingUsers.delete(userId);
        this.broadcastEvent({
          type: 'typing_stop',
          data: { userId, timestamp },
          timestamp
        }, userId);
        break;

      case 'message_read':
        if (typeof data.messageId === 'string' && data.messageId) {
          const updated = await this.updateMessageStatus(data.messageId, 'read', timestamp, userId);
          if (!updated) {
            this.sendToUser(userId, {
              type: 'error',
              data: { message: 'Message not found or receipt not permitted' },
              timestamp
            });
            break;
          }
          this.broadcastEvent({
            type: 'message_status_update',
            data: {
              messageId: data.messageId,
              status: 'read',
              timestamp,
              userId
            },
            timestamp
          });
        }
        break;

      case 'presence_update':
        if (data.status) {
          const presence: UserPresence = {
            userId,
            status: data.status,
            lastSeen: timestamp
          };
          this.userPresence.set(userId, presence);
          this.broadcastPresenceUpdate(userId, presence);
        }
        break;

      case 'join_room':
        // Update presence to online
        this.userPresence.set(userId, {
          userId,
          status: 'online',
          lastSeen: timestamp
        });
        break;

      case 'leave_room':
        // Update presence to offline
        const presence = this.userPresence.get(userId);
        if (presence) {
          presence.status = 'offline';
          presence.lastSeen = timestamp;
          this.userPresence.set(userId, presence);
          this.broadcastPresenceUpdate(userId, presence);
        }
        this.sessions.delete(userId);
        this.typingUsers.delete(userId);
        break;

      default:
        console.warn('Unknown WebSocket message type:', data.type);
    }
  }
}
