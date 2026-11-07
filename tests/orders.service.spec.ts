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
          tradingSymbol: 'RELIANCE',
          totalQty: 100,
          currentValue: 250000.0,
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
    getTrades: async () => ({
      ok: true,
      data: [
        {
          tradeId: 'TR-101',
          orderId: 'DHAN-ORD-101',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'BUY',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 130.0,
          tradeValue: 6500.0,
          createTime: '2026-11-07 10:15:00',
        },
      ],
    }),
    getTradeHistory: async (fromDate: string, toDate: string, page = 0) => ({
      ok: true,
      data: [
        {
          tradeId: 'TR-HIST-1',
          orderId: 'DHAN-ORD-101',
          exchangeOrderId: 'EX-ORD-1',
          exchangeTradeId: 'EX-TR-1',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'BUY',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 130.0,
          tradeValue: 6500.0,
          tradeDate: '2026-05-10',
          createTime: '2026-05-10 10:15:00',
        },
        {
          tradeId: 'TR-HIST-2',
          orderId: 'DHAN-ORD-102',
          exchangeOrderId: 'EX-ORD-2',
          exchangeTradeId: 'EX-TR-2',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'SELL',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 145.0,
          tradeValue: 7250.0,
          tradeDate: '2026-05-10',
          createTime: '2026-05-10 11:20:00',
        },
      ],
    }),
    getLtp: async () => ({
      ok: true,
      data: { status: 'success', data: {} },
    }),
  };

  const mockTelegramService = {
    sendOrderNotification: async () => ({ success: true }),
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

    const funds = await service.getFunds();
    assert.strictEqual(funds.availableBalance, 150000.0);
    assert.strictEqual(funds.utilizedMargin, 25000.0);
    assert.strictEqual(funds.collateralAmount, 0);
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

  await t.test('fetches historical trades by financial year and consolidates buy and sell into single trade row', async () => {
    const res = await service.getTradeHistory({ financialYear: '2026-2027' });
    assert.ok(res);
    assert.strictEqual(res.financialYear, '2026-2027');
    assert.strictEqual(res.fromDate, '2026-04-01');
    assert.strictEqual(res.summary.totalTrades, 1);
    assert.strictEqual(res.summary.closedTradesCount, 1);
    assert.strictEqual(res.summary.profitableTradesCount, 1);
    assert.strictEqual(res.summary.totalRealizedPnL, 750.0);
    assert.strictEqual(res.summary.totalQuantity, 50);
    assert.strictEqual(res.summary.winRate, 100);
    assert.strictEqual(res.trades.length, 1);
    assert.strictEqual(res.trades[0].symbol, 'NIFTY 24500 CE');
    assert.strictEqual(res.trades[0].buyPrice, 130.0);
    assert.strictEqual(res.trades[0].sellPrice, 145.0);
    assert.strictEqual(res.trades[0].pnl, 750.0);
    assert.strictEqual(res.trades[0].status, 'CLOSED');
    assert.ok(res.trades[0].executionTime);
  });

  await t.test('returns available financial years including current and historic FYs', async () => {
    const years = service.getFinancialYears();
    assert.ok(Array.isArray(years));
    assert.ok(years.length >= 5);
    assert.strictEqual(years[0].isCurrent, true);
    assert.ok(years[0].label.includes('Current'));
    assert.strictEqual(years[1].isCurrent, false);
  });
});
