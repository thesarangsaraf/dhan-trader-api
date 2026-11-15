process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { ChartsController } from '../src/charts/charts.controller';
import { ChartsService } from '../src/charts/charts.service';
import { YahooFinanceService } from '../src/yahoo/yahoo.service';

test('ChartsModule & ChartsController (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let controller: ChartsController;
  let service: ChartsService;

  const mockYahooService = {
    getCandles: async (opts: any) => ({
      symbol: opts.symbol || 'NIFTY 50',
      yahooSymbol: '^NSEI',
      interval: opts.interval || '5m',
      range: opts.range || '1d',
      currency: 'INR',
      exchange: 'NSE',
      lastPrice: 25144.3,
      count: 2,
      candles: [
        { time: 1700000000, open: 25100, high: 25150, low: 25090, close: 25140, volume: 100 },
        { time: 1700000300, open: 25140, high: 25160, low: 25130, close: 25144.3, volume: 150 },
      ],
    }),
  };

  moduleRef = await Test.createTestingModule({
    controllers: [ChartsController],
    providers: [
      ChartsService,
      { provide: YahooFinanceService, useValue: mockYahooService },
    ],
  }).compile();

  controller = moduleRef.get<ChartsController>(ChartsController);
  service = moduleRef.get<ChartsService>(ChartsService);

  await t.test('controller should return candlestick data for requested symbol', async () => {
    const res = await controller.getCandles({ symbol: 'NIFTY 50', interval: '5m', range: '1d', limit: 10 });
    assert.strictEqual(res.symbol, 'NIFTY 50');
    assert.strictEqual(res.yahooSymbol, '^NSEI');
    assert.strictEqual(res.count, 2);
    assert.strictEqual(res.candles.length, 2);
    assert.strictEqual(res.candles[0].open, 25100);
    assert.strictEqual(res.candles[1].close, 25144.3);
  });

  await t.test('service should handle limit parsing and default queries', async () => {
    const res = await service.getCandles({});
    assert.strictEqual(res.symbol, 'NIFTY 50');
    assert.strictEqual(res.interval, '5m');
    assert.strictEqual(res.range, '1d');
  });

  await t.test('service should pass period1 and period2 for historical queries', async () => {
    const res = await service.getCandles({ period1: 1700000000, period2: 1700100000 });
    assert.strictEqual(res.symbol, 'NIFTY 50');
  });
});
