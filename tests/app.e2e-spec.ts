process.env.NODE_ENV = 'test';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DhanService } from '../src/dhan/dhan.service';
import { TelegramService } from '../src/telegram/telegram.service';

test('AppController & Routers E2E (NestJS)', async (t) => {
  let app: INestApplication;

  const mockDhanService = {
    config: { clientId: '1106885516' },
    getProfile: async () => ({
      ok: true,
      data: { dhanClientId: '1106885516', userName: 'TRADER' },
    }),
    getOrders: async () => ({
      ok: true,
      data: [
        {
          orderId: 'DHAN-ORD-201',
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
      data: { availMargin: 150000.0, utilizedMargin: 25000.0, collateralAmount: 0 },
    }),
    getHoldings: async () => ({
      ok: true,
      data: [
        { tradingSymbol: 'TCS', securityId: '11536', exchange: 'NSE_EQ', totalQty: 20, avgCostPrice: 3800.0, ltp: 4120.0 },
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
    getLtp: async () => ({
      ok: true,
      data: {
        status: 'success',
        data: {
          'IDX_I': {
            '13': { last_price: 24520.5 },
            '25': { last_price: 51850.0 },
          },
        },
      },
    }),
  };

  const mockTelegramService = {
    sendAlertNotification: async () => ({ success: true }),
    sendOrderNotification: async () => ({ success: true }),
    sendStrategyNotification: async () => ({ success: true }),
    getStatus: () => ({ configured: true, chatId: '895***469', botConfigured: true }),
    sendTestNotification: async () => ({ success: true, test: true }),
  };

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DhanService)
    .useValue(mockDhanService)
    .overrideProvider(TelegramService)
    .useValue(mockTelegramService)
    .compile();

  app = moduleFixture.createNestApplication();
  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();

  function makeMockRequest(method: string, url: string, body?: any): Promise<any> {
    return new Promise((resolve) => {
      const { EventEmitter } = require('events');
      const req = new EventEmitter();
      req.method = method;
      req.url = url;
      req.headers = { host: '127.0.0.1:8000' };

      if (body) {
        req.body = body;
        req._body = true;
        req.headers['content-type'] = 'application/json';
      }

      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
      res.getHeader = (k: string) => res.headers[k.toLowerCase()];
      res.writeHead = (status: number, hdrs: Record<string, string> = {}) => {
        res.statusCode = status;
        for (const [k, v] of Object.entries(hdrs)) {
          res.headers[k.toLowerCase()] = v;
        }
      };

      let responseBody = '';
      res.write = (chunk: any) => { responseBody += chunk; };
      res.end = (chunk: any) => {
        if (chunk) responseBody += chunk;
        let parsed = responseBody;
        try {
          parsed = JSON.parse(responseBody);
        } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      };

      expressApp(req, res);
    });
  }

  await t.test('GET / returns NestJS framework root metadata', async () => {
    const res = await makeMockRequest('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Dhan Trader Backend API');
    assert.strictEqual(res.body.framework, 'NestJS');
    assert.strictEqual(res.body.status, 'ONLINE');
    assert.ok(res.body.endpoints);
  });

  await t.test('GET /health returns health check status', async () => {
    const res = await makeMockRequest('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ONLINE');
  });

  await t.test('GET /api/auth/status returns token status in IST', async () => {
    const res = await makeMockRequest('GET', '/api/auth/status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.configured);
    assert.ok(res.body.expiresAtIST.includes('IST'));
  });

  await t.test('GET /api/alerts/indices returns popular NSE indices', async () => {
    const res = await makeMockRequest('GET', '/api/alerts/indices');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((i: any) => i.name === 'NIFTY 50'));
  });

  await t.test('POST /api/alerts creates new alert without static IP requirement', async () => {
    const res = await makeMockRequest('POST', '/api/alerts', {
      instrument: 'NIFTY BANK',
      targetPrice: 53200.0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Breakout watch',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.alert.instrument, 'NIFTY BANK');
  });

  await t.test('GET /api/orders returns orders book from Dhan API', async () => {
    const res = await makeMockRequest('GET', '/api/orders');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body[0].orderId, 'DHAN-ORD-201');
  });

  await t.test('GET /api/positions returns positions from Dhan API', async () => {
    const res = await makeMockRequest('GET', '/api/positions');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.positions));
    assert.strictEqual(typeof res.body.summary.netPnL, 'number');
  });

  await t.test('POST /api/strategy/auto-sl executes Nifty FNO Long -7/+30 bracket runner on Dhan API', async () => {
    const res = await makeMockRequest('POST', '/api/strategy/auto-sl', {
      symbol: 'NIFTY 24500 CE',
      entryPrice: 130.0,
      quantity: 50,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.strategy, 'NIFTY_LONG_AUTO_SL_TARGET');
    assert.strictEqual(res.body.slPrice, 123.0);
    assert.strictEqual(res.body.targetPrice, 160.0);
  });

  await t.test('GET /api/holdings returns demat holdings from Dhan API', async () => {
    const res = await makeMockRequest('GET', '/api/holdings');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  await t.test('GET /api/instruments returns security lookup results', async () => {
    const res = await makeMockRequest('GET', '/api/instruments?q=NIFTY');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);
  });

  await t.test('GET /api/telegram/status returns telegram connection state', async () => {
    const res = await makeMockRequest('GET', '/api/telegram/status');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.configured);
  });

  await app.close();
});
