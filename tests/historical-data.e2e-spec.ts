process.env.NODE_ENV = 'test';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HistoricalDataService } from '../src/historical-data/historical-data.service';
import { UserJwtUtil } from '../src/user-auth/utils/user-jwt.util';

test('HistoricalDataController E2E (NestJS)', async (t) => {
  let app: INestApplication;

  const mockHistoricalDataService = {
    getStatus: async (indexKey = 'NIFTY50') => {
      if (indexKey === 'BANKNIFTY') {
        return {
          storedInFirestore: true,
          syncInProgress: false,
          sourceRepo: 'https://github.com/technovusin/banknifty-historical-data',
          collection: 'historical_candles/BANKNIFTY_5M',
          metadata: {
            symbol: 'BANK NIFTY',
            securityId: '25',
            timeframe: '5m',
            sourceRepo: 'https://github.com/technovusin/banknifty-historical-data',
            collection: 'historical_candles/BANKNIFTY_5M',
            totalCandles: 98210,
            totalMonths: 64,
            firstEpoch: 1628051400,
            lastEpoch: 1795427700,
            firstMonth: '2021-08',
            lastMonth: '2026-11',
            months: ['2021-08', '2026-11'],
            monthCounts: { '2021-08': 1425, '2026-11': 1245 },
            updatedAt: '2026-11-25T14:00:00.000Z',
          },
        };
      }
      return {
        storedInFirestore: true,
        syncInProgress: false,
        sourceRepo: 'https://github.com/technovusin/nifty50-historical-data',
        collection: 'historical_candles/NIFTY50_5M',
        metadata: {
          symbol: 'NIFTY 50',
          securityId: '13',
          timeframe: '5m',
          sourceRepo: 'https://github.com/technovusin/nifty50-historical-data',
          collection: 'historical_candles/NIFTY50_5M',
          totalCandles: 178452,
          totalMonths: 116,
          firstEpoch: 1491191100,
          lastEpoch: 1795427700,
          firstMonth: '2017-04',
          lastMonth: '2026-11',
          months: ['2017-04', '2026-11'],
          monthCounts: { '2017-04': 1425, '2026-11': 1245 },
          updatedAt: '2026-11-24T17:00:00.000Z',
        },
      };
    },
    syncNifty50FiveMin: async (force: boolean) => ({
      success: true,
      collection: 'historical_candles/NIFTY50_5M',
      symbol: 'NIFTY 50',
      timeframe: '5m',
      sourceRepo: 'https://github.com/technovusin/nifty50-historical-data',
      mode: force ? 'full' : 'incremental',
      filesProcessed: force ? 20 : 1,
      filesSkipped: force ? 0 : 19,
      total1MinRows: force ? 892000 : 6200,
      totalCandlesSynced: force ? 178452 : 1245,
      totalCandlesInDb: 178452,
      monthsWritten: force ? ['2017-04', '2026-11'] : ['2026-11'],
      totalMonthsInDb: 116,
      firstMonth: '2017-04',
      lastMonth: '2026-11',
      firstEpoch: 1491191100,
      lastEpoch: 1795427700,
      durationMs: 420,
      syncedAt: '2026-11-24T17:05:00.000Z',
      message: force ? 'Full sync completed' : 'Incremental sync completed',
    }),
    syncBankNiftyFiveMin: async (force: boolean) => ({
      success: true,
      collection: 'historical_candles/BANKNIFTY_5M',
      symbol: 'BANK NIFTY',
      timeframe: '5m',
      sourceRepo: 'https://github.com/technovusin/banknifty-historical-data',
      mode: force ? 'full' : 'incremental',
      filesProcessed: force ? 16 : 1,
      filesSkipped: force ? 0 : 15,
      total1MinRows: force ? 491000 : 6200,
      totalCandlesSynced: force ? 98210 : 1245,
      totalCandlesInDb: 98210,
      monthsWritten: force ? ['2021-08', '2026-11'] : ['2026-11'],
      totalMonthsInDb: 64,
      firstMonth: '2021-08',
      lastMonth: '2026-11',
      firstEpoch: 1628051400,
      lastEpoch: 1795427700,
      durationMs: 380,
      syncedAt: '2026-11-25T14:05:00.000Z',
      message: force ? 'Full sync completed' : 'Incremental sync completed',
    }),
    getNifty50FiveMinCandles: async (query: any) => ({
      success: true,
      symbol: 'NIFTY 50',
      timeframe: '5m',
      monthsRead: [query.fromMonth || '2026-11'],
      count: 1,
      candles: [
        {
          epoch: 1795427100,
          timestampIST: '2026-11-23T15:15:00',
          open: 25366.4,
          high: 25366.4,
          low: 25366.4,
          close: 25366.4,
          volume: 4580,
        },
      ],
    }),
    getBankNiftyFiveMinCandles: async (query: any) => ({
      success: true,
      symbol: 'BANK NIFTY',
      timeframe: '5m',
      monthsRead: [query.fromMonth || '2026-11'],
      count: 1,
      candles: [
        {
          epoch: 1793591100,
          timestampIST: '2026-11-02T09:15:00',
          open: 54837.2,
          high: 54978.7,
          low: 54834.85,
          close: 54981.45,
          volume: 17962230,
        },
      ],
    }),
  };

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(HistoricalDataService)
    .useValue(mockHistoricalDataService)
    .compile();

  app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
    }),
  );
  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();

  function makeMockRequest(
    method: string,
    url: string,
    body?: any,
    customHeaders: Record<string, string> = {},
  ): Promise<any> {
    return new Promise((resolve) => {
      const req = new EventEmitter() as any;
      req.method = method;
      req.url = url;
      req.headers = { host: '127.0.0.1:8000', ...customHeaders };

      if (body) {
        req.body = body;
        req._body = true;
        req.headers['content-type'] = 'application/json';
      }

      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.headers = {};
      res.setHeader = (k: string, v: string) => {
        res.headers[k.toLowerCase()] = v;
      };
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

  t.after(async () => {
    await app.close();
  });

  const adminToken = UserJwtUtil.sign({ sub: 'sarang', username: 'sarang', role: 'admin' }, 60);
  const traderToken = UserJwtUtil.sign({ sub: 'trader1', username: 'trader1', role: 'trader' }, 60);

  await t.test('GET /api/historical-data/nifty50-5m/status returns Firestore metadata', async () => {
    const res = await makeMockRequest('GET', '/api/historical-data/nifty50-5m/status', undefined, {
      authorization: `Bearer ${traderToken}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.storedInFirestore, true);
    assert.strictEqual(res.body.metadata.totalCandles, 178452);
    assert.strictEqual(res.body.metadata.totalMonths, 116);
  });

  await t.test('POST /api/historical-data/nifty50-5m/sync rejects non-admin users with 403', async () => {
    const res = await makeMockRequest(
      'POST',
      '/api/historical-data/nifty50-5m/sync',
      { force: false },
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(res.status, 403);
  });

  await t.test('POST /api/historical-data/nifty50-5m/sync allows admin for incremental and full sync', async () => {
    const incRes = await makeMockRequest(
      'POST',
      '/api/historical-data/nifty50-5m/sync',
      { force: false },
      { authorization: `Bearer ${adminToken}` },
    );
    assert.strictEqual(incRes.status, 200);
    assert.strictEqual(incRes.body.success, true);
    assert.strictEqual(incRes.body.mode, 'incremental');
    assert.strictEqual(incRes.body.filesProcessed, 1);

    const fullRes = await makeMockRequest(
      'POST',
      '/api/historical-data/nifty50-5m/sync',
      { force: true },
      { authorization: `Bearer ${adminToken}` },
    );
    assert.strictEqual(fullRes.status, 200);
    assert.strictEqual(fullRes.body.success, true);
    assert.strictEqual(fullRes.body.mode, 'full');
    assert.strictEqual(fullRes.body.filesProcessed, 20);
  });

  await t.test('GET /api/historical-data/nifty50-5m/candles returns parsed candles and validates query', async () => {
    const res = await makeMockRequest(
      'GET',
      '/api/historical-data/nifty50-5m/candles?fromMonth=2026-11&toMonth=2026-11',
      undefined,
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.candles[0].epoch, 1795427100);

    const badRes = await makeMockRequest(
      'GET',
      '/api/historical-data/nifty50-5m/candles?fromMonth=invalid',
      undefined,
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(badRes.status, 400);
  });

  await t.test('GET /api/historical-data/banknifty-5m/status returns Firestore metadata', async () => {
    const res = await makeMockRequest('GET', '/api/historical-data/banknifty-5m/status', undefined, {
      authorization: `Bearer ${traderToken}`,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.storedInFirestore, true);
    assert.strictEqual(res.body.collection, 'historical_candles/BANKNIFTY_5M');
    assert.strictEqual(res.body.metadata.symbol, 'BANK NIFTY');
    assert.strictEqual(res.body.metadata.totalCandles, 98210);
  });

  await t.test('POST /api/historical-data/banknifty-5m/sync enforces admin role and supports incremental/full sync', async () => {
    const forbiddenRes = await makeMockRequest(
      'POST',
      '/api/historical-data/banknifty-5m/sync',
      { force: false },
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(forbiddenRes.status, 403);

    const incRes = await makeMockRequest(
      'POST',
      '/api/historical-data/banknifty-5m/sync',
      { force: false },
      { authorization: `Bearer ${adminToken}` },
    );
    assert.strictEqual(incRes.status, 200);
    assert.strictEqual(incRes.body.success, true);
    assert.strictEqual(incRes.body.symbol, 'BANK NIFTY');
    assert.strictEqual(incRes.body.mode, 'incremental');
    assert.strictEqual(incRes.body.filesProcessed, 1);

    const fullRes = await makeMockRequest(
      'POST',
      '/api/historical-data/banknifty-5m/sync',
      { force: true },
      { authorization: `Bearer ${adminToken}` },
    );
    assert.strictEqual(fullRes.status, 200);
    assert.strictEqual(fullRes.body.success, true);
    assert.strictEqual(fullRes.body.mode, 'full');
    assert.strictEqual(fullRes.body.filesProcessed, 16);
  });

  await t.test('GET /api/historical-data/banknifty-5m/candles returns parsed candles and validates query', async () => {
    const res = await makeMockRequest(
      'GET',
      '/api/historical-data/banknifty-5m/candles?fromMonth=2026-11&toMonth=2026-11',
      undefined,
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.symbol, 'BANK NIFTY');
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.candles[0].epoch, 1793591100);

    const badRes = await makeMockRequest(
      'GET',
      '/api/historical-data/banknifty-5m/candles?fromMonth=invalid',
      undefined,
      { authorization: `Bearer ${traderToken}` },
    );
    assert.strictEqual(badRes.status, 400);
  });
});
