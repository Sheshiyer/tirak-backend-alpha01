import type { Env } from '../index';

export interface WebSocketConnection {
  userId: string;
  userType: 'customer' | 'supplier' | 'admin';
  socket: WebSocket;
  lastActivity: Date;
  subscriptions: Set<string>;
}

export interface WebSocketEvent {
  type: 'message_received' | 'typing_start' | 'typing_stop' | 'message_status_update' | 
        'booking_status_update' | 'booking_request' | 'notification' | 'user_presence_update';
  data: any;
  timestamp: string;
  targetUserId?: string;
  roomId?: string;
}

export class WebSocketService {
  private connections: Map<string, WebSocketConnection> = new Map();
  private roomConnections: Map<string, Set<string>> = new Map();
  
  constructor(private env: Env) {}

  /**
   * Handle WebSocket upgrade request
   */
  async handleUpgrade(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');
    const userType = url.searchParams.get('userType') || 'customer';

    if (!userId || !token) {
      return new Response('Missing userId or token', { status: 401 });
    }

    // Verify token (simplified for demo)
    // In production, verify JWT token here

    const { 0: client, 1: server } = new WebSocketPair();

    const connection: WebSocketConnection = {
      userId,
      userType: userType as any,
      socket: server,
      lastActivity: new Date(),
      subscriptions: new Set()
    };

    // Store connection
    this.connections.set(userId, connection);

    // Handle WebSocket events
    server.accept();

    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        await this.handleMessage(userId, data);
      } catch (error) {
        console.error('WebSocket message error:', error);
        this.sendToUser(userId, {
          type: 'error' as any,
          data: { message: 'Failed to process message' },
          timestamp: new Date().toISOString()
        });
      }
    });

    server.addEventListener('close', () => {
      this.handleDisconnection(userId);
    });

    server.addEventListener('error', (error) => {
      console.error('WebSocket error for user', userId, error);
      this.handleDisconnection(userId);
    });

    // Send connection confirmation
    this.sendToUser(userId, {
      type: 'connected' as any,
      data: {
        userId,
        userType,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(userId: string, data: any): Promise<void> {
    const connection = this.connections.get(userId);
    if (!connection) return;

    connection.lastActivity = new Date();
    const timestamp = new Date().toISOString();

    switch (data.type) {
      case 'ping':
        this.sendToUser(userId, {
          type: 'pong' as any,
          data: { timestamp },
          timestamp
        });
        break;

      case 'join_room':
        await this.handleJoinRoom(userId, data.roomId);
        break;

      case 'leave_room':
        await this.handleLeaveRoom(userId, data.roomId);
        break;

      case 'subscribe':
        if (data.events && Array.isArray(data.events)) {
          data.events.forEach((event: string) => {
            connection.subscriptions.add(event);
          });
        }
        break;

      case 'unsubscribe':
        if (data.events && Array.isArray(data.events)) {
          data.events.forEach((event: string) => {
            connection.subscriptions.delete(event);
          });
        }
        break;

      case 'typing_start':
        if (data.roomId) {
          this.broadcastToRoom(data.roomId, {
            type: 'typing_start',
            data: { userId, roomId: data.roomId },
            timestamp
          }, userId);
        }
        break;

      case 'typing_stop':
        if (data.roomId) {
          this.broadcastToRoom(data.roomId, {
            type: 'typing_stop',
            data: { userId, roomId: data.roomId },
            timestamp
          }, userId);
        }
        break;

      case 'presence_update':
        await this.handlePresenceUpdate(userId, data.status);
        break;

      default:
        console.warn('Unknown WebSocket message type:', data.type);
    }
  }

  /**
   * Handle user joining a room
   */
  private async handleJoinRoom(userId: string, roomId: string): Promise<void> {
    if (!roomId) return;

    // Add user to room
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(userId);

    // Notify other users in room
    this.broadcastToRoom(roomId, {
      type: 'user_presence_update',
      data: {
        userId,
        status: 'online',
        action: 'joined',
        roomId
      },
      timestamp: new Date().toISOString()
    }, userId);
  }

  /**
   * Handle user leaving a room
   */
  private async handleLeaveRoom(userId: string, roomId: string): Promise<void> {
    if (!roomId) return;

    // Remove user from room
    const roomUsers = this.roomConnections.get(roomId);
    if (roomUsers) {
      roomUsers.delete(userId);
      if (roomUsers.size === 0) {
        this.roomConnections.delete(roomId);
      }
    }

    // Notify other users in room
    this.broadcastToRoom(roomId, {
      type: 'user_presence_update',
      data: {
        userId,
        status: 'offline',
        action: 'left',
        roomId
      },
      timestamp: new Date().toISOString()
    }, userId);
  }

  /**
   * Handle presence updates
   */
  private async handlePresenceUpdate(userId: string, status: string): Promise<void> {
    // Broadcast presence update to all rooms user is in
    for (const [roomId, users] of this.roomConnections.entries()) {
      if (users.has(userId)) {
        this.broadcastToRoom(roomId, {
          type: 'user_presence_update',
          data: {
            userId,
            status,
            timestamp: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        }, userId);
      }
    }
  }

  /**
   * Handle user disconnection
   */
  private handleDisconnection(userId: string): void {
    // Remove from all rooms
    for (const [roomId, users] of this.roomConnections.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          this.roomConnections.delete(roomId);
        } else {
          // Notify other users
          this.broadcastToRoom(roomId, {
            type: 'user_presence_update',
            data: {
              userId,
              status: 'offline',
              action: 'disconnected',
              roomId
            },
            timestamp: new Date().toISOString()
          }, userId);
        }
      }
    }

    // Remove connection
    this.connections.delete(userId);
  }

  /**
   * Send event to specific user
   */
  public sendToUser(userId: string, event: WebSocketEvent): boolean {
    const connection = this.connections.get(userId);
    if (!connection) return false;

    try {
      connection.socket.send(JSON.stringify(event));
      return true;
    } catch (error) {
      console.error('Failed to send to user:', error);
      this.handleDisconnection(userId);
      return false;
    }
  }

  /**
   * Broadcast event to all users in a room
   */
  public broadcastToRoom(roomId: string, event: WebSocketEvent, excludeUserId?: string): number {
    const roomUsers = this.roomConnections.get(roomId);
    if (!roomUsers) return 0;

    let sentCount = 0;
    for (const userId of roomUsers) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      if (this.sendToUser(userId, event)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Broadcast event to all connected users
   */
  public broadcastToAll(event: WebSocketEvent, excludeUserId?: string): number {
    let sentCount = 0;
    for (const userId of this.connections.keys()) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      if (this.sendToUser(userId, event)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Get connected users count
   */
  public getConnectedUsersCount(): number {
    return this.connections.size;
  }

  /**
   * Get users in room
   */
  public getRoomUsers(roomId: string): string[] {
    const roomUsers = this.roomConnections.get(roomId);
    return roomUsers ? Array.from(roomUsers) : [];
  }

  /**
   * Check if user is connected
   */
  public isUserConnected(userId: string): boolean {
    return this.connections.has(userId);
  }

  /**
   * Clean up inactive connections
   */
  public cleanupInactiveConnections(maxInactiveMinutes: number = 30): number {
    const cutoff = new Date(Date.now() - maxInactiveMinutes * 60 * 1000);
    let cleanedCount = 0;

    for (const [userId, connection] of this.connections.entries()) {
      if (connection.lastActivity < cutoff) {
        this.handleDisconnection(userId);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }
}
