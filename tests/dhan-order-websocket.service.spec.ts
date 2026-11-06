process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { DhanOrderWebSocketService } from '../src/orders/dhan-order-websocket.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { ConfigService } from '../src/config/config.service';

test('DhanOrderWebSocketService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: DhanOrderWebSocketService;
  let telegramService: TelegramService;
  const sentTelegramMessages: string[] = [];

  const mockTelegramService = {
    isConfigured: () => true,
    sendMessage: async (text: string) => {
      sentTelegramMessages.push(text);
      return { success: true };
    },
    formatOrderEventHtml: (order: any) => {
      const realTg = new TelegramService({} as any);
      return realTg.formatOrderEventHtml(order);
    },
    sendOrderEvent: async (order: any) => {
      const realTg = new TelegramService({} as any);
      const text = realTg.formatOrderEventHtml(order);
      sentTelegramMessages.push(text);
      return { success: true };
    },
  };

  const mockConfigService = {
    clientId: '1106885516',
    accessToken: 'mock-jwt-token',
    dhanOrderWsUrl: 'wss://api-order-update.dhan.co',
    onChange: () => () => {},
  };

  moduleRef = await Test.createTestingModule({
    providers: [
      DhanOrderWebSocketService,
      { provide: ConfigService, useValue: mockConfigService },
      { provide: TelegramService, useValue: mockTelegramService },
    ],
  }).compile();

  service = moduleRef.get<DhanOrderWebSocketService>(DhanOrderWebSocketService);
  telegramService = moduleRef.get<TelegramService>(TelegramService);

  await t.test('initializes with correct default configuration and status', () => {
    const status = service.getStatus();
    assert.strictEqual(status.connected, false);
    assert.strictEqual(status.clientId, '1106885516');
    assert.strictEqual(status.url, 'wss://api-order-update.dhan.co');
    assert.strictEqual(status.cachedEventsCount, 0);
  });

  await t.test('formats and dispatches TRADED order event with complete execution details to Telegram', async () => {
    sentTelegramMessages.length = 0;

    const tradedOrder = {
      orderId: 'DHAN-ORD-9001',
      exchangeOrderId: 'EXCH-20261106-99',
      correlationId: 'AUTO-BUY-CE',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      tradingSymbol: 'NIFTY 24500 CE',
      securityId: '45021',
      quantity: 50,
      tradedQuantity: 50,
      averagePrice: 145.2,
      drvStrikePrice: 24500.0,
      drvOptionsType: 'CE',
      drvExpiryDate: '2026-11-13',
    };

    const res = await service.processOrderUpdate(tradedOrder);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentTelegramMessages.length, 1);

    const msg = sentTelegramMessages[0];
    assert.ok(msg.includes('DHAN ORDER EXECUTED (TRADED)'));
    assert.ok(msg.includes('NIFTY 24500 CE'));
    assert.ok(msg.includes('BUY'));
    assert.ok(msg.includes('50 shares (100% filled)'));
    assert.ok(msg.includes('₹145.20'));
    assert.ok(msg.includes('₹7,260.00')); // Executed value: 50 * 145.2
    assert.ok(msg.includes('Strike: ₹24500'));
    assert.ok(msg.includes('Exp: 2026-11-13'));
    assert.ok(msg.includes('DHAN-ORD-9001'));
    assert.ok(msg.includes('EXCH-20261106-99'));
    assert.ok(msg.includes('AUTO-BUY-CE'));
  });

  await t.test('deduplicates identical order events to prevent message spam', async () => {
    sentTelegramMessages.length = 0;

    const order = {
      orderId: 'DHAN-ORD-9001',
      orderStatus: 'TRADED',
      tradedQuantity: 50,
    };

    // First attempt should be skipped because DHAN-ORD-9001:TRADED:50 was already cached
    const res = await service.processOrderUpdate(order);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'DUPLICATE_EVENT');
    assert.strictEqual(sentTelegramMessages.length, 0);
  });

  await t.test('formats and dispatches REJECTED order event with explicit rejection description', async () => {
    sentTelegramMessages.length = 0;

    const rejectedOrder = {
      orderId: 'DHAN-ORD-9002',
      orderStatus: 'REJECTED',
      transactionType: 'BUY',
      tradingSymbol: 'BANKNIFTY 52000 PE',
      quantity: 150,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      omsErrorCode: '16004',
      omsErrorDescription: 'Insufficient funds for trade placement',
    };

    const res = await service.processOrderUpdate(rejectedOrder);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentTelegramMessages.length, 1);

    const msg = sentTelegramMessages[0];
    assert.ok(msg.includes('DHAN ORDER REJECTED'));
    assert.ok(msg.includes('BANKNIFTY 52000 PE'));
    assert.ok(msg.includes('Insufficient funds for trade placement'));
    assert.ok(msg.includes('16004'));
  });

  await t.test('formats and dispatches PENDING order event', async () => {
    sentTelegramMessages.length = 0;

    const pendingOrder = {
      orderId: 'DHAN-ORD-9003',
      orderStatus: 'PENDING',
      transactionType: 'SELL',
      tradingSymbol: 'RELIANCE',
      quantity: 25,
      price: 3100.0,
      orderType: 'LIMIT',
      productType: 'CNC',
      exchangeSegment: 'NSE_EQ',
    };

    const res = await service.processOrderUpdate(pendingOrder);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(sentTelegramMessages.length, 1);

    const msg = sentTelegramMessages[0];
    assert.ok(msg.includes('DHAN ORDER PLACED (PENDING)'));
    assert.ok(msg.includes('RELIANCE'));
    assert.ok(msg.includes('SELL'));
    assert.ok(msg.includes('25 shares'));
    assert.ok(msg.includes('₹3,100.00'));
    assert.ok(msg.includes('CNC (Delivery)'));
  });

  await t.test('simulateOrderEvent processes mock order event successfully', async () => {
    const simRes = await service.simulateOrderEvent();
    assert.strictEqual(simRes.success, true);
    assert.ok(simRes.order.orderId.startsWith('SIM-'));
  });

  await t.test('cleanly disconnects and tears down timers on module destroy', () => {
    service.onModuleDestroy();
    const status = service.getStatus();
    assert.strictEqual(status.connected, false);
    assert.strictEqual(status.connecting, false);
  });
});
