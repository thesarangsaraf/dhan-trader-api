import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import WebSocket from 'ws';
import { ConfigService } from '../config/config.service';
import { TelegramService } from '../telegram/telegram.service';

export interface DhanOrderWebSocketStatus {
  connected: boolean;
  connecting: boolean;
  url: string;
  lastConnectedTime: string | null;
  lastEventTime: string | null;
  clientId: string;
  disconnectCount: number;
  cachedEventsCount: number;
}

@Injectable()
export class DhanOrderWebSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DhanOrderWebSocketService.name);

  private ws: WebSocket | null = null;
  private isConnected = false;
  private isConnecting = false;
  private isDestroyed = false;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private lastConnectedTime: Date | null = null;
  private lastEventTime: Date | null = null;
  private disconnectCount = 0;

  // Deduplication cache: orderId:status:tradedQty
  private readonly notifiedEvents = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
  ) {}

  onModuleInit() {
    this.config.onChange(() => {
      this.handleConfigChange();
    });

    if (process.env.NODE_ENV !== 'test') {
      this.connect();
    }
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    this.disconnect();
  }

  getWsUrl(): string {
    return (
      process.env.DHAN_ORDER_WS_URL ||
      (this.config as any).dhanOrderWsUrl ||
      'wss://api-order-update.dhan.co'
    );
  }

  connect(): void {
    if (this.isDestroyed) return;

    if (!this.config.clientId || !this.config.accessToken) {
      this.logger.debug(
        'Dhan Order WebSocket skipped: DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN is not configured',
      );
      return;
    }

    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.disconnect();
    this.isConnecting = true;

    const url = this.getWsUrl();
    this.logger.log(`Connecting to Dhan Order WebSocket feed: ${url}`);

    try {
      this.ws = new WebSocket(url, {
        handshakeTimeout: 10000,
      });

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));
      this.ws.on('error', (err: Error) => this.handleError(err));
      this.ws.on('close', (code: number, reason: Buffer) =>
        this.handleClose(code, reason ? reason.toString('utf8') : ''),
      );
      this.ws.on('ping', (data: Buffer) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.pong(data);
        }
      });
    } catch (err: any) {
      this.logger.error(`Failed to initialize WebSocket client: ${err.message}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
  }

  private handleOpen(): void {
    this.isConnected = true;
    this.isConnecting = false;
    this.lastConnectedTime = new Date();
    this.logger.log('Dhan Order WebSocket connected. Sending MsgCode 42 authorization handshake...');

    const authPayload = {
      LoginReq: {
        MsgCode: 42,
        ClientId: this.config.clientId,
        Token: this.config.accessToken,
      },
      UserType: 'SELF',
    };

    try {
      this.ws?.send(JSON.stringify(authPayload));
      this.logger.log(`Dhan Order WebSocket authorized for ClientId: ${this.config.clientId}`);
    } catch (err: any) {
      this.logger.error(`Error sending authorization message: ${err.message}`);
    }

    this.startHeartbeat();
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (!text || !text.trim()) return;

      const payload = JSON.parse(text);

      // Check for feed disconnect / code 50
      if (payload?.MsgCode === 50 || payload?.LoginResp?.MsgCode === 50) {
        this.logger.warn('Received Feed Disconnect (Code 50) from Dhan. Reconnecting...');
        this.scheduleReconnect(1000);
        return;
      }

      // Check if message is an order update or array of order updates
      const candidates = Array.isArray(payload) ? payload : [payload];
      for (const item of candidates) {
        const orderData = item.data || item.order || item;
        if (orderData && (orderData.orderId || orderData.orderStatus)) {
          this.processOrderUpdate(orderData).catch((err) => {
            this.logger.error(`Error processing order update: ${err.message}`);
          });
        }
      }
    } catch (err: any) {
      this.logger.debug(`Non-JSON or unhandled message from Dhan Order WebSocket: ${err.message}`);
    }
  }

  private handleError(err: Error): void {
    this.logger.warn(`Dhan Order WebSocket error: ${err.message}`);
  }

  private handleClose(code: number, reason: string): void {
    this.isConnected = false;
    this.isConnecting = false;
    this.disconnectCount++;
    this.logger.warn(
      `Dhan Order WebSocket closed (Code: ${code}, Reason: ${reason || 'None'}). Scheduling reconnect...`,
    );

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (!this.isDestroyed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(delayMs = 5000): void {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Ping every 20 seconds to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (e) {}
      }
    }, 20000);

    if (typeof this.heartbeatInterval.unref === 'function') {
      this.heartbeatInterval.unref();
    }
  }

  private handleConfigChange(): void {
    this.logger.log('Config updated (Credentials / Token). Refreshing Dhan Order WebSocket connection...');
    this.disconnect();
    if (!this.isDestroyed && process.env.NODE_ENV !== 'test') {
      this.scheduleReconnect(1000);
    }
  }

  /**
   * Processes an incoming order update from Dhan, deduplicates it,
   * and dispatches a comprehensive readable message to Telegram.
   */
  async processOrderUpdate(order: any): Promise<{ sent: boolean; reason?: string }> {
    if (!order || (!order.orderId && !order.orderStatus)) {
      return { sent: false, reason: 'INVALID_ORDER_PAYLOAD' };
    }

    const orderId = String(order.orderId || order.exchangeOrderId || 'UNKNOWN');
    const status = String(order.orderStatus || order.status || 'UNKNOWN').toUpperCase();
    const tradedQty = parseInt(order.tradedQuantity || order.filled_qty || 0, 10);

    // Deduplication key: orderId:status:tradedQty
    const dedupKey = `${orderId}:${status}:${tradedQty}`;
    if (this.notifiedEvents.has(dedupKey)) {
      this.logger.debug(`Duplicate order update skipped: ${dedupKey}`);
      return { sent: false, reason: 'DUPLICATE_EVENT' };
    }

    this.notifiedEvents.add(dedupKey);
    // Keep cache bounded to 1,000 entries
    if (this.notifiedEvents.size > 1000) {
      const items = Array.from(this.notifiedEvents);
      for (let i = 0; i < 500; i++) {
        this.notifiedEvents.delete(items[i]);
      }
    }

    this.lastEventTime = new Date();
    this.logger.log(
      `Processing order update event from WebSocket: Order #${orderId} -> Status: ${status}`,
    );

    // Send formatted Telegram notification
    const res = await this.telegramService.sendOrderEvent(order);
    return { sent: res?.success || false };
  }

  /**
   * Simulates an order event push — useful for testing or manual verification.
   */
  async simulateOrderEvent(sampleOrder?: any) {
    const mockOrder = sampleOrder || {
      orderId: `SIM-${Date.now()}`,
      exchangeOrderId: `EXCH-${Math.floor(Math.random() * 90000000 + 10000000)}`,
      correlationId: 'TEST-WS-EVENT',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      tradingSymbol: 'NIFTY 24500 CE',
      securityId: '45021',
      quantity: 50,
      tradedQuantity: 50,
      averagePrice: 142.5,
      drvStrikePrice: 24500.0,
      drvOptionsType: 'CE',
      drvExpiryDate: '2026-11-13',
    };

    const result = await this.processOrderUpdate(mockOrder);
    return {
      success: true,
      message: 'Simulated order update event processed',
      order: mockOrder,
      telegramResult: result,
    };
  }

  getStatus(): DhanOrderWebSocketStatus {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      url: this.getWsUrl(),
      lastConnectedTime: this.lastConnectedTime ? this.lastConnectedTime.toISOString() : null,
      lastEventTime: this.lastEventTime ? this.lastEventTime.toISOString() : null,
      clientId: this.config.clientId || 'Not configured',
      disconnectCount: this.disconnectCount,
      cachedEventsCount: this.notifiedEvents.size,
    };
  }
}
