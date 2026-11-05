process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from '../src/orders/orders.service';
import { DhanService } from '../src/dhan/dhan.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { ConfigService } from '../src/config/config.service';

test('OrdersService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: OrdersService;

  const mockDhanService = {
    config: { clientId: '1106885516' },
    getOrders: async () => ({
      ok: true,
      data: [
        {
          orderId: 'DHAN-ORD-101',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'BUY',
          orderType: 'MARKET',
          productType: 'INTRADAY',
          quantity: 50,
          price: 130.0,
          orderStatus: 'EXECUTED',
        },
      ],
    }),
    getPositions: async () => ({
      ok: true,
      data: [
        {
          positionId: 'POS-45021',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
          netQty: 50,
          buyQty: 50,
          sellQty: 0,
          buyAvg: 130.0,
          sellAvg: 0,
          ltp: 135.0,
          realizedProfit: 0,
          unrealizedProfit: 250.0,
        },
      ],
    }),
    getFundLimits: async () => ({
      ok: true,
      data: {
        availMargin: 150000.0,
        utilizedMargin: 25000.0,
        collateralAmount: 0,
      },
    }),
    getHoldings: async () => ({
      ok: true,
      data: [
        {
          tradingSymbol: 'TCS',
          securityId: '11536',
          exchange: 'NSE_EQ',
          totalQty: 20,
          avgCostPrice: 3800.0,
          ltp: 4120.0,
        },
      ],
    }),
    placeOrder: async (orderPayload: any) => ({
      ok: true,
      data: {
        orderId: `DHAN-ORD-${Math.floor(Math.random() * 900000 + 100000)}`,
        orderStatus: 'EXECUTED',
        ...orderPayload,
      },
    }),
    cancelOrder: async (orderId: string) => ({
      ok: true,
      data: { orderId, orderStatus: 'CANCELLED' },
    }),
  };

  const mockTelegramService = {
    sendOrderNotification: async () => ({ success: true }),
    sendStrategyNotification: async () => ({ success: true }),
  };

  moduleRef = await Test.createTestingModule({
    providers: [
      OrdersService,
      ConfigService,
      { provide: DhanService, useValue: mockDhanService },
      { provide: TelegramService, useValue: mockTelegramService },
    ],
  }).compile();

  service = moduleRef.get<OrdersService>(OrdersService);

  await t.test('lists orders and positions directly from Dhan API', async () => {
    const orders = await service.getOrders();
    assert.ok(Array.isArray(orders));
    assert.strictEqual(orders[0].orderId, 'DHAN-ORD-101');

    const posData = await service.getPositions();
    assert.ok(Array.isArray(posData.positions));
    assert.ok(posData.summary);
    assert.strictEqual(typeof posData.summary.netPnL, 'number');
    assert.strictEqual(posData.funds.availableBalance, 150000.0);
  });

  await t.test('places manual order on Dhan API', async () => {
    const res = await service.placeOrder({
      symbol: 'NIFTY 24500 CE',
      securityId: '45021',
      exchangeSegment: 'NSE_FNO',
      transactionType: 'BUY',
      orderType: 'MARKET',
      productType: 'INTRADAY',
      quantity: 50,
      price: 130.0,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.source, 'dhan_api');
    assert.strictEqual(res.order.status, 'EXECUTED');
    assert.strictEqual(res.order.quantity, 50);
  });

  await t.test('executes Auto-SL (-7 pts) and Target (+30 pts) Strategy Runner', async () => {
    const runner = await service.executeAutoSLTarget({
      symbol: 'NIFTY 24600 CE',
      entryPrice: 140.0,
      quantity: 50,
    });

    assert.strictEqual(runner.strategy, 'NIFTY_LONG_AUTO_SL_TARGET');
    assert.strictEqual(runner.entryPrice, 140.0);
    assert.strictEqual(runner.slPrice, 133.0); // 140 - 7
    assert.strictEqual(runner.targetPrice, 170.0); // 140 + 30
    assert.strictEqual(runner.slPoints, 7.0);
    assert.strictEqual(runner.targetPoints, 30.0);
    assert.strictEqual(runner.riskRewardRatio, '1:4.29');

    assert.ok(runner.orders.entryOrder);
    assert.ok(runner.orders.stopLossOrder);
    assert.ok(runner.orders.targetOrder);
    assert.ok(runner.logs.length >= 4);
  });
});
