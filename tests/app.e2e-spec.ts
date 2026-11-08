process.env.NODE_ENV = 'test';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DhanService } from '../src/dhan/dhan.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { FirestoreService } from '../src/firestore/firestore.service';

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
      data: [{ tradingSymbol: 'RELIANCE', totalQty: 100, currentValue: 250000.0 }],
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
          tradeId: 'TR-E2E-1',
          orderId: 'DHAN-ORD-201',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'BUY',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 130.0,
          tradeValue: 6500.0,
        },
      ],
    }),
    getTradeHistory: async (fromDate: string, toDate: string, page = 0) => ({
      ok: true,
      data: [
        {
          tradeId: 'TR-E2E-1',
          orderId: 'DHAN-ORD-201',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'BUY',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 130.0,
          tradeValue: 6500.0,
          tradeDate: '2026-05-15',
          createTime: '2026-05-15 09:30:00',
        },
        {
          tradeId: 'TR-E2E-2',
          orderId: 'DHAN-ORD-202',
          tradingSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          transactionType: 'SELL',
          productType: 'INTRADAY',
          tradedQuantity: 50,
          tradedPrice: 145.0,
          tradeValue: 7250.0,
          tradeDate: '2026-05-15',
          createTime: '2026-05-15 10:15:00',
        },
      ],
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
          'NSE_FNO': {
            '45021': { last_price: 135.0 },
          },
        },
      },
    }),
    getAlerts: async () => ({
      ok: true,
      data: [],
    }),
    createDhanAlert: async (payload: any) => ({
      ok: true,
      data: { alertId: 'DHAN-ALT-555', ...payload },
    }),
    cancelDhanAlert: async () => ({
      ok: true,
    }),
    getOptionChainExpiryList: async () => ({
      ok: true,
      data: ['2026-11-05', '2026-11-12', '2026-11-19'],
    }),
    getOptionChain: async () => ({
      ok: true,
      data: {},
    }),
    renewToken: async () => ({
      ok: true,
      data: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTA2ODg1NTE2IiwiY2xpZW50SWQiOiIxMTA2ODg1NTE2IiwiaWF0IjoxNzMwODAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.mock_renewed',
      },
    }),
  };

  const mockTelegramService = {
    sendAlertNotification: async () => ({ success: true }),
    sendOrderNotification: async () => ({ success: true }),
    sendOrderEvent: async () => ({ success: true }),
    formatOrderEventHtml: () => 'formatted',
    getStatus: () => ({ configured: true, chatId: '895***469', botConfigured: true }),
    sendTestNotification: async () => ({ success: true, test: true }),
  };

  const mockFirestoreService = {
    isReady: () => true,
    getDhanToken: async () => null,
    saveDhanToken: async () => ({ success: true, writeTime: new Date().toISOString() }),
    getTelegramConfig: async () => ({ botToken: 'test_token', chatId: 'test_chat' }),
    saveTelegramConfig: async () => ({ success: true, writeTime: new Date().toISOString() }),
    getAppConfig: async () => ({ port: 8000, host: '127.0.0.1', pollIntervalMs: 4000, dhanApiBase: 'https://api.dhan.co/v2' }),
    saveAppConfig: async () => ({ success: true, writeTime: new Date().toISOString() }),
    syncAllConfigFromFirestore: async () => {},
    getStatus: () => ({
      configured: true,
      projectId: 'dhan-trader-514002',
      databaseId: 'dhan-trader-firebase-db',
      keyFile: 'google-service-account-key.json',
      keyFileFound: true,
      clientEmail: 'dhan-trader-sv-account@dhan-trader-514002.iam.gserviceaccount.com',
    }),
    testConnection: async () => ({
      success: true,
      message: 'Successfully connected to Firestore database [dhan-trader-firebase-db] in project [dhan-trader-514002]',
      projectId: 'dhan-trader-514002',
      databaseId: 'dhan-trader-firebase-db',
      latencyMs: 15,
      collections: ['orders'],
    }),
    getIndexOptions: async () => [
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45021',
        tradingSymbol: 'NIFTY 24500 CE',
        customSymbol: 'NIFTY 24500 CE',
        expiryDate: '2026-11-12',
        strikePrice: 25500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45022',
        tradingSymbol: 'NIFTY-Nov2026-25500-PE',
        customSymbol: 'NIFTY 12 NOV 25500 PUT',
        expiryDate: '2026-11-12',
        strikePrice: 25500,
        optionType: 'PE',
        lotSize: 50,
      },
      {
        symbolName: 'BANKNIFTY',
        exchange: 'NSE_FNO',
        securityId: '52010',
        tradingSymbol: 'BANKNIFTY-Nov2026-52000-CE',
        customSymbol: 'BANKNIFTY 12 NOV 52000 CALL',
        expiryDate: '2026-11-12',
        strikePrice: 52000,
        optionType: 'CE',
        lotSize: 30,
      },
      {
        symbolName: 'BANKNIFTY',
        exchange: 'NSE_FNO',
        securityId: '52011',
        tradingSymbol: 'BANKNIFTY-Nov2026-52000-PE',
        customSymbol: 'BANKNIFTY 12 NOV 52000 PUT',
        expiryDate: '2026-11-12',
        strikePrice: 52000,
        optionType: 'PE',
        lotSize: 30,
      },
    ],
    getIndexOptionsMetadata: async () => ({
      totalItems: 4,
      totalChunks: 1,
      chunkSize: 500,
      updatedAt: '2026-11-08T03:00:00.000Z',
    }),
    getSecIdMapping: async () => ({
      options: [
        {
          symbolName: 'NIFTY',
          exchange: 'NSE_FNO',
          securityId: '45021',
          tradingSymbol: 'NIFTY 24500 CE',
          customSymbol: 'NIFTY 24500 CE',
          expiryDate: '2026-11-12',
          strikePrice: 25500,
          optionType: 'CE',
          lotSize: 50,
        },
        {
          symbolName: 'NIFTY',
          exchange: 'NSE_FNO',
          securityId: '45022',
          tradingSymbol: 'NIFTY-Nov2026-25500-PE',
          customSymbol: 'NIFTY 12 NOV 25500 PUT',
          expiryDate: '2026-11-12',
          strikePrice: 25500,
          optionType: 'PE',
          lotSize: 50,
        },
      ],
      scripMaster: [
        {
          symbol: 'NIFTY 50',
          name: 'Nifty 50 Index',
          securityId: '13',
          exchangeSegment: 'IDX_I',
          instrumentType: 'INDEX',
          lotSize: 65,
        },
        {
          symbol: 'RELIANCE',
          name: 'Reliance Industries Ltd',
          securityId: '2885',
          exchangeSegment: 'NSE_EQ',
          instrumentType: 'EQUITY',
          lotSize: 1,
        },
      ],
    }),
    saveSecIdMapping: async (options: any[], scripMaster: any[]) => ({
      success: true,
      collection: 'sec_id_to_name_mapping',
      totalInstruments: options.length + scripMaster.length,
      totalOptions: options.length,
      totalIndices: scripMaster.filter((s: any) => s.instrumentType === 'INDEX').length,
      totalEquities: scripMaster.filter((s: any) => s.instrumentType === 'EQUITY').length,
      documents: ['nifty_50_options', 'indices', 'equities_chunk_01'],
      syncedAt: new Date().toISOString(),
    }),
    getSecIdMappingMetadata: async () => ({
      collection: 'sec_id_to_name_mapping',
      totalInstruments: 4,
      totalOptions: 2,
      totalIndices: 1,
      totalEquities: 1,
      documentsCount: 3,
      documentIds: ['nifty_50_options', 'indices', 'equities_chunk_01'],
      updatedAt: '2026-11-08T03:00:00.000Z',
    }),
    getLotSizes: async () => ({
      nifty50: 65,
      bankNifty: 30,
      midcapNifty: 120,
      sensex: 20,
      nifty50Lots: 5,
      bankNiftyLots: 5,
      midcapNiftyLots: 5,
      sensexLots: 5,
      indices: [
        { symbol: 'NIFTY 50', name: 'Nifty 50 Index', securityId: '13', exchangeSegment: 'IDX_I', lotSize: 65, defaultLots: 5, defaultQuantity: 325, enabled: true },
        { symbol: 'BANK NIFTY', name: 'Bank Nifty Index', securityId: '25', exchangeSegment: 'IDX_I', lotSize: 30, defaultLots: 5, defaultQuantity: 150, enabled: true },
      ],
      updatedAt: '2026-11-08T03:00:00.000Z',
    }),
    saveLotSizes: async (cfg: any) => ({
      success: true,
      data: {
        nifty50: cfg.nifty50 ?? 65,
        bankNifty: cfg.bankNifty ?? 30,
        midcapNifty: cfg.midcapNifty ?? 120,
        sensex: cfg.sensex ?? 20,
        nifty50Lots: cfg.nifty50Lots ?? 5,
        bankNiftyLots: cfg.bankNiftyLots ?? 5,
        indices: cfg.indices ?? [],
        updatedAt: new Date().toISOString(),
      },
      writeTime: new Date().toISOString(),
    }),
  };

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DhanService)
    .useValue(mockDhanService)
    .overrideProvider(TelegramService)
    .useValue(mockTelegramService)
    .overrideProvider(FirestoreService)
    .useValue(mockFirestoreService)
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

      let bodyData = '';
      res.write = (chunk: any) => {
        if (chunk) bodyData += chunk.toString();
        return true;
      };

      res.end = (chunk?: any) => {
        if (chunk) bodyData += chunk.toString();
        let parsed: any;
        try {
          parsed = JSON.parse(bodyData);
        } catch {
          parsed = bodyData;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      };

      expressApp.handle(req, res);
    });
  }

  await t.test('GET / returns NestJS framework root metadata', async () => {
    const res = await makeMockRequest('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.framework, 'NestJS');
    assert.strictEqual(res.body.status, 'ONLINE');
  });

  await t.test('GET /api returns NestJS framework root metadata', async () => {
    const res = await makeMockRequest('GET', '/api');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ONLINE');
  });

  await t.test('GET /api/auth/status returns token status in IST', async () => {
    const res = await makeMockRequest('GET', '/api/auth/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.isExpired, 'boolean');
    assert.ok(res.body.expiresAtIST);
  });

  await t.test('POST /api/auth/renew renews Dhan token via POST', async () => {
    const res = await makeMockRequest('POST', '/api/auth/renew');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.inspection?.expiresAtIST);
  });

  await t.test('GET /api/alerts returns active alerts array', async () => {
    const res = await makeMockRequest('GET', '/api/alerts');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  await t.test('GET /api/alerts/indices returns popular NSE indices with live prices', async () => {
    const res = await makeMockRequest('GET', '/api/alerts/indices');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 4);
    assert.ok(res.body.some((i: any) => i.name === 'NIFTY 50'));
    assert.ok(res.body.some((i: any) => i.name === 'BANK NIFTY'));
    assert.ok(res.body.some((i: any) => i.name === 'SENSEX'));
    assert.ok(res.body.some((i: any) => i.name === 'MIDCAP NIFTY'));
    assert.ok(!res.body.some((i: any) => i.name.includes('FIN')));
    assert.ok(!res.body.some((i: any) => i.name.includes('NEXT')));
    assert.ok(!res.body.some((i: any) => i.name.includes('VIX')));
  });

  await t.test('POST /api/alerts creates new alert', async () => {
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

  await t.test('GET /api/alerts/instrument-name/:securityId returns instrument metadata', async () => {
    const res = await makeMockRequest('GET', '/api/alerts/instrument-name/13');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.securityId, '13');
    assert.strictEqual(res.body.instrumentName, 'NIFTY 50');
    assert.strictEqual(res.body.exchangeSegment, 'IDX_I');

    const resEq = await makeMockRequest('GET', '/api/alerts/instrument-name/2885');
    assert.strictEqual(resEq.status, 200);
    assert.strictEqual(resEq.body.securityId, '2885');
    assert.strictEqual(resEq.body.symbol, 'RELIANCE');
    assert.strictEqual(resEq.body.exchangeSegment, 'NSE_EQ');

    const resNotFound = await makeMockRequest('GET', '/api/alerts/instrument-name/999999');
    assert.strictEqual(resNotFound.status, 404);
  });

  await t.test('POST /api/alerts/conditional-order creates alert with conditional order', async () => {
    const res = await makeMockRequest('POST', '/api/alerts/conditional-order', {
      instrument: 'NIFTY 50',
      targetPrice: 25500.0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Buy Call option when Nifty breaks 25500',
      conditionalOrder: {
        symbol: 'NIFTY 25500 CE',
        transactionType: 'BUY',
        orderType: 'MARKET',
        productType: 'INTRADAY',
        quantity: 50,
      },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.alert.instrument, 'NIFTY 50');
    assert.strictEqual(res.body.alert.targetPrice, 25500.0);
    assert.strictEqual(res.body.alert.hasConditionalOrder, true);
    assert.strictEqual(res.body.alert.conditionalOrders.length, 1);
    assert.strictEqual(res.body.alert.conditionalOrders[0].symbol, 'NIFTY 25500 CE');
    assert.strictEqual(res.body.alert.conditionalOrders[0].quantity, 50);
  });

  await t.test('GET /api/instruments/option-contracts returns 3 option contracts (ATM-1, ATM, ATM+1) for current and next expiry', async () => {
    const res = await makeMockRequest('GET', '/api/instruments/option-contracts?instrument=nifty%2050&price=25500');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.instrument, 'NIFTY 50');
    assert.strictEqual(res.body.spotPrice, 25500);
    assert.strictEqual(res.body.strikeStep, 50);
    assert.deepStrictEqual(res.body.strikes, [25450, 25500, 25550]);

    // Current expiry assertions
    assert.ok(res.body.currentExpiry);
    assert.ok(res.body.currentExpiry.expiryDate);
    assert.strictEqual(res.body.currentExpiry.strikes.length, 3);
    assert.strictEqual(res.body.currentExpiry.strikes[0].strikePrice, 25450);
    assert.strictEqual(res.body.currentExpiry.strikes[1].strikePrice, 25500);
    assert.strictEqual(res.body.currentExpiry.strikes[2].strikePrice, 25550);
    assert.strictEqual(res.body.currentExpiry.strikes[0].call.optionType, 'CE');
    assert.strictEqual(res.body.currentExpiry.strikes[0].put.optionType, 'PE');
    assert.strictEqual(res.body.currentExpiry.strikes[0].call.moneyness, 'ITM');
    assert.strictEqual(res.body.currentExpiry.strikes[0].put.moneyness, 'OTM');
    assert.strictEqual(res.body.currentExpiry.strikes[1].call.moneyness, 'ATM');
    assert.strictEqual(res.body.currentExpiry.strikes[1].put.moneyness, 'ATM');
    assert.strictEqual(res.body.currentExpiry.strikes[2].call.moneyness, 'OTM');
    assert.strictEqual(res.body.currentExpiry.strikes[2].put.moneyness, 'ITM');
    assert.strictEqual(typeof res.body.currentExpiry.strikes[0].call.ltp, 'number');

    // Next expiry assertions
    assert.ok(res.body.nextExpiry);
    assert.ok(res.body.nextExpiry.expiryDate);
    assert.strictEqual(res.body.nextExpiry.strikes.length, 3);
    assert.deepStrictEqual(
      res.body.nextExpiry.strikes.map((s: any) => s.strikePrice),
      [25450, 25500, 25550],
    );

    // Flat contracts list
    assert.ok(Array.isArray(res.body.contracts));
    assert.strictEqual(res.body.contracts.length, 12); // 3 strikes * 2 types * 2 expiries
  });

  await t.test('GET /api/instruments/option-contracts accepts target expiry string and returns 3 contracts', async () => {
    const res = await makeMockRequest('GET', '/api/instruments/option-contracts?instrument=nifty%2050&price=25500&expiry=2026-11-12');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.currentExpiry.expiryDate, '2026-11-12');
    assert.strictEqual(res.body.strikes.length, 3);
    assert.deepStrictEqual(res.body.strikes, [25450, 25500, 25550]);
  });

  await t.test('POST /api/instruments/option-contracts returns option contracts via body payload', async () => {
    const res = await makeMockRequest('POST', '/api/instruments/option-contracts', {
      instrument: 'NIFTY 50',
      price: 25500,
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.strikes, [25450, 25500, 25550]);
  });

  await t.test('POST /api/instruments/option-contracts accepts instrument, price, expiry and returns 3 contracts', async () => {
    const res = await makeMockRequest('POST', '/api/instruments/option-contracts', {
      instrument: 'BANKNIFTY',
      price: 52000,
      expiry: '2026-11-12',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.instrument, 'NIFTY BANK');
    assert.strictEqual(res.body.strikeStep, 100);
    assert.strictEqual(res.body.currentExpiry.expiryDate, '2026-11-12');
    assert.deepStrictEqual(res.body.strikes, [51900, 52000, 52100]);
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

  await t.test('GET /api/funds returns available balance and funds from Dhan API', async () => {
    const res = await makeMockRequest('GET', '/api/funds');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.availableBalance, 150000.0);
    assert.strictEqual(res.body.utilizedMargin, 25000.0);
  });

  await t.test('GET /api/trades/history returns trade history with consolidated paired trades', async () => {
    const res = await makeMockRequest('GET', '/api/trades/history?financialYear=2026-2027');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.financialYear, '2026-2027');
    assert.strictEqual(res.body.summary.totalTrades, 1);
    assert.strictEqual(res.body.summary.closedTradesCount, 1);
    assert.strictEqual(res.body.summary.totalRealizedPnL, 750.0);
    assert.strictEqual(res.body.trades.length, 1);
    assert.strictEqual(res.body.trades[0].buyPrice, 130.0);
    assert.strictEqual(res.body.trades[0].sellPrice, 145.0);
    assert.strictEqual(res.body.trades[0].pnl, 750.0);
    assert.strictEqual(res.body.trades[0].status, 'CLOSED');
    assert.ok(res.body.trades[0].executionTime);
  });

  await t.test('GET /api/trades/financial-years returns selectable FYs list', async () => {
    const res = await makeMockRequest('GET', '/api/trades/financial-years');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 5);
    assert.strictEqual(res.body[0].isCurrent, true);
  });

  await t.test('GET /api/trades returns active session trades', async () => {
    const res = await makeMockRequest('GET', '/api/trades');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].symbol, 'NIFTY 24500 CE');
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

  await t.test('GET /api/firestore/status returns firestore configuration state', async () => {
    const res = await makeMockRequest('GET', '/api/firestore/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.configured, true);
    assert.strictEqual(res.body.projectId, 'dhan-trader-514002');
    assert.strictEqual(res.body.databaseId, 'dhan-trader-firebase-db');
  });

  await t.test('POST /api/firestore/test triggers connectivity test', async () => {
    const res = await makeMockRequest('POST', '/api/firestore/test');
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.projectId, 'dhan-trader-514002');
  });

  await t.test('GET /api/firestore/index-options/status returns metadata of index options stored in Firestore', async () => {
    const res = await makeMockRequest('GET', '/api/firestore/index-options/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.storedInFirestore, true);
    assert.strictEqual(res.body.metadata.totalItems, 4);
    assert.strictEqual(res.body.metadata.totalChunks, 1);
  });

  await t.test('POST /api/instruments/sync syncs security master and index options into Firestore', async () => {
    const res = await makeMockRequest('POST', '/api/instruments/sync', {
      force: true,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.collection, 'sec_id_to_name_mapping');
    assert.ok(res.body.totalInstruments >= 4);
    assert.ok(Array.isArray(res.body.documents));
  });

  await t.test('GET /api/instruments/sync/status returns current Firestore sec_id_to_name_mapping sync status', async () => {
    const res = await makeMockRequest('GET', '/api/instruments/sync/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.storedInFirestore, true);
    assert.strictEqual(res.body.metadata.collection, 'sec_id_to_name_mapping');
    assert.strictEqual(res.body.metadata.totalInstruments, 4);
  });

  await t.test('GET /api/firestore/sec-id-mapping/status returns metadata of sec_id_to_name_mapping stored in Firestore', async () => {
    const res = await makeMockRequest('GET', '/api/firestore/sec-id-mapping/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.storedInFirestore, true);
    assert.strictEqual(res.body.metadata.collection, 'sec_id_to_name_mapping');
  });

  await t.test('GET /api/instruments/lot-sizes returns index lot sizes config', async () => {
    const res = await makeMockRequest('GET', '/api/instruments/lot-sizes');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.nifty50, 65);
    assert.strictEqual(res.body.data.bankNifty, 30);
  });

  await t.test('PUT /api/instruments/lot-sizes updates index lot sizes in Firestore', async () => {
    const res = await makeMockRequest('PUT', '/api/instruments/lot-sizes', {
      nifty50: 75,
      bankNifty: 35,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.nifty50, 75);
    assert.strictEqual(res.body.data.bankNifty, 35);
  });

  await t.test('POST /api/instruments/lot-sizes/reset restores default lot sizes', async () => {
    const res = await makeMockRequest('POST', '/api/instruments/lot-sizes/reset');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.nifty50, 65);
    assert.strictEqual(res.body.data.bankNifty, 30);
  });

  await t.test('GET /api/instruments/indices returns configurable indices with live prices from Firestore', async () => {
    const res = await makeMockRequest('GET', '/api/instruments/indices');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 2);
    assert.strictEqual(res.body[0].symbol, 'NIFTY 50');
    assert.strictEqual(res.body[0].lotSize, 65);
    assert.strictEqual(res.body[0].defaultLots, 5);
  });

  await app.close();
});
