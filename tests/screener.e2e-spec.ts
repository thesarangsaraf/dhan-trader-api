process.env.NODE_ENV = 'test';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { YahooFinanceService, CandleData } from '../src/yahoo/yahoo.service';

test('ScreenerController & Charts E2E (NestJS)', async (t) => {
  let app: INestApplication;

  const sampleCandles: CandleData[] = [];
  const baseTime = 1795147500; // 09:15 IST
  // 1. Initial drift downwards towards a swing low
  for (let i = 0; i < 20; i++) {
    sampleCandles.push({
      time: baseTime + i * 300,
      open: 25100 - i * 4,
      high: 25105 - i * 4,
      low: 25095 - i * 4,
      close: 25098 - i * 4,
      volume: 1000,
    });
  }
  // Bar 20: Swing Low at 25000
  sampleCandles.push({
    time: baseTime + 20 * 300,
    open: 25020,
    high: 25030,
    low: 25000,
    close: 25010,
    volume: 2500,
  });
  // Bars 21 to 28: Bounce back up
  for (let i = 21; i <= 28; i++) {
    sampleCandles.push({
      time: baseTime + i * 300,
      open: 25010 + (i - 20) * 5,
      high: 25020 + (i - 20) * 5,
      low: 25008,
      close: 25018 + (i - 20) * 5,
      volume: 1200,
    });
  }
  // Bar 29: Liquidity Sweep
  sampleCandles.push({
    time: baseTime + 29 * 300,
    open: 25040,
    high: 25045,
    low: 24985,
    close: 24995,
    volume: 4000,
  });
  // Bar 30: Consolidation Base
  sampleCandles.push({
    time: baseTime + 30 * 300,
    open: 24995,
    high: 25015,
    low: 24990,
    close: 25005,
    volume: 1500,
  });
  // Bar 31: Bullish Impulse Break
  sampleCandles.push({
    time: baseTime + 31 * 300,
    open: 25006,
    high: 25035,
    low: 25002,
    close: 25030,
    volume: 3200,
  });
  // Bar 32: Retest Fill
  sampleCandles.push({
    time: baseTime + 32 * 300,
    open: 25028,
    high: 25030,
    low: 25012,
    close: 25022,
    volume: 1800,
  });
  // Bar 33 to 34: Target Hit
  sampleCandles.push({
    time: baseTime + 33 * 300,
    open: 25022,
    high: 25050,
    low: 25020,
    close: 25045,
    volume: 2000,
  });
  sampleCandles.push({
    time: baseTime + 34 * 300,
    open: 25045,
    high: 25090,
    low: 25040,
    close: 25085,
    volume: 3500,
  });

  const mockYahooFinanceService = {
    mapToYahooSymbol: (sym: string) => {
      const clean = (sym || '').trim().toUpperCase();
      if (clean === 'NIFTY 50' || clean === 'NIFTY') return '^NSEI';
      if (clean === 'BANK NIFTY') return '^NSEBANK';
      return `${clean}.NS`;
    },
    getCandles: async (opts: any) => ({
      symbol: opts.symbol || 'NIFTY 50',
      yahooSymbol: '^NSEI',
      interval: '5m',
      range: opts.range || '60d',
      currency: 'INR',
      exchange: 'NSE',
      lastPrice: 25085,
      count: sampleCandles.length,
      candles: sampleCandles,
    }),
  };

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(YahooFinanceService)
    .useValue(mockYahooFinanceService)
    .compile();

  app = moduleFixture.createNestApplication();
  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();

  function makeMockRequest(method: string, url: string, body?: any, customHeaders: Record<string, string> = {}): Promise<any> {
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

  t.after(async () => {
    await app.close();
  });

  await t.test('GET /api/screener/instruments returns available instruments mapped to Yahoo', async () => {
    const res = await makeMockRequest('GET', '/api/screener/instruments');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.count > 0);
    const nifty = res.body.data.find((item: any) => item.symbol === 'NIFTY 50');
    assert.ok(nifty, 'Should include NIFTY 50');
    assert.strictEqual(nifty.yahooSymbol, '^NSEI');
  });

  await t.test('POST /api/screener/scan runs 5m state machine and returns detected signals + backtest summary', async () => {
    const res = await makeMockRequest('POST', '/api/screener/scan', {
      symbols: ['NIFTY 50'],
      lookbackPeriod: '60d',
      swingLookback: 10,
      slBuffer: 3,
      targetRr: 2.0,
      maxRetestBars: 10,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.scannedSymbolsCount, 1);
    assert.strictEqual(res.body.signals.length, 1);
    assert.strictEqual(res.body.signals[0].symbol, 'NIFTY 50');
    assert.strictEqual(res.body.signals[0].outcome, 'WIN');
    assert.strictEqual(res.body.summary.totalSignals, 1);
    assert.strictEqual(res.body.summary.wins, 1);
    assert.strictEqual(res.body.summary.winRate, 100);
    assert.strictEqual(res.body.summary.netRMultiple, 2.0);
  });

  await t.test('POST /api/screener/scan with scope="indices" strictly scans traded indices and not full master list', async () => {
    const res = await makeMockRequest('POST', '/api/screener/scan', {
      scope: 'indices',
      lookbackPeriod: '60d',
      swingLookback: 10,
      slBuffer: 3,
      targetRr: 2.0,
      maxRetestBars: 10,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.scannedSymbolsCount <= 4, 'Should strictly scan <= 4 traded indices');
  });

  await t.test('GET /api/charts/candles returns 5m OHLCV data', async () => {
    const res = await makeMockRequest('GET', '/api/charts/candles?symbol=NIFTY%2050&range=60d');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.symbol, 'NIFTY 50');
    assert.strictEqual(res.body.interval, '5m');
    assert.ok(res.body.candles.length > 0);
  });
});
