process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ScreenerController } from '../src/screener/screener.controller';
import { ScreenerService } from '../src/screener/screener.service';
import { FirestoreService, DEFAULT_INDICES, DEFAULT_LOT_SIZES } from '../src/firestore/firestore.service';
import { YahooFinanceService, CandleData } from '../src/yahoo/yahoo.service';
import { LiquiditySweepStrategy } from '../src/screener/strategies/liquidity-sweep.strategy';

/** Helper to create UNIX epoch seconds for an IST date & time (e.g. '2026-11-17', '09:15') */
function istUnix(dateStr: string, hhmm: string): number {
  return Math.floor(Date.parse(`${dateStr}T${hhmm}:00+05:30`) / 1000);
}

test('Liquidity Sweep & Reversal Screener (5m, Configured Indices)', async (t) => {
  // --- UNIT TESTS FOR LIQUIDITY SWEEP STRATEGY ---

  await t.test('Pattern A (BUY): detects single-candle PDL sweep & green close confirmation', () => {
    const day = '2026-11-17';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 24550, high: 24700, low: 24500, close: 24620, volume: 1000 },
    ];
    const fiveMinCandles: CandleData[] = [
      { time: istUnix(day, '09:15'), open: 24560, high: 24580, low: 24530, close: 24540, volume: 100 },
      { time: istUnix(day, '09:20'), open: 24540, high: 24550, low: 24510, close: 24515, volume: 120 },
      // Sweep candle & green confirmation candle: sweeps below PDL 24500 (low 24482) & closes green above 24500 (24525)
      { time: istUnix(day, '09:25'), open: 24505, high: 24530, low: 24482, close: 24525, volume: 300 },
    ];

    const signals = LiquiditySweepStrategy.scanHistorical(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinCandles,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );

    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0].signalType, 'BUY');
    assert.strictEqual(signals[0].levelType, 'PDL');
    assert.strictEqual(signals[0].levelPrice, 24500);
    assert.strictEqual(signals[0].sweepPrice, 24482);
    assert.strictEqual(signals[0].sweepTimestamp, istUnix(day, '09:25'));
    assert.strictEqual(signals[0].confirmationClosePrice, 24525);
    assert.strictEqual(signals[0].confirmationTimestamp, istUnix(day, '09:25'));
    assert.strictEqual(signals[0].id, `NIFTY_50_${istUnix(day, '09:25')}_BUY`);
    assert.strictEqual(signals[0].candles.length, 3);
  });

  await t.test('Pattern A (BUY): detects 2-candle PDL sweep (push down red bar -> next green confirmation close above PDL)', () => {
    const day = '2026-11-17';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 24550, high: 24700, low: 24500, close: 24620, volume: 1000 },
    ];
    const fiveMinCandles: CandleData[] = [
      { time: istUnix(day, '09:15'), open: 24560, high: 24580, low: 24520, close: 24530, volume: 100 },
      // Bar 1 (09:20): pushes down below PDL 24500 and closes red at 24490
      { time: istUnix(day, '09:20'), open: 24530, high: 24535, low: 24475, close: 24490, volume: 200 },
      // Bar 2 (09:25): green reversal candle closes back above PDL 24500 at 24518
      { time: istUnix(day, '09:25'), open: 24490, high: 24522, low: 24488, close: 24518, volume: 250 },
      // Bar 3 (09:30): continuation green candle — must NOT re-trigger
      { time: istUnix(day, '09:30'), open: 24518, high: 24550, low: 24515, close: 24545, volume: 180 },
    ];

    const signals = LiquiditySweepStrategy.scanHistorical(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinCandles,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );

    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0].signalType, 'BUY');
    assert.strictEqual(signals[0].levelType, 'PDL');
    assert.strictEqual(signals[0].levelPrice, 24500);
    assert.strictEqual(signals[0].sweepPrice, 24475);
    assert.strictEqual(signals[0].sweepTimestamp, istUnix(day, '09:20'));
    assert.strictEqual(signals[0].confirmationClosePrice, 24518);
    assert.strictEqual(signals[0].confirmationTimestamp, istUnix(day, '09:25'));
  });

  await t.test('Pattern B (SELL): detects PDH sweep & red close confirmation and multiple independent BUY+SELL signals in one session', () => {
    const day = '2026-11-17';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 52000, high: 52500, low: 51800, close: 52200, volume: 1000 },
    ];
    const fiveMinCandles: CandleData[] = [
      // 09:15 opening candle
      { time: istUnix(day, '09:15'), open: 51900, high: 52000, low: 51850, close: 51920, volume: 100 },
      // 09:20 Morning PDL sweep (low 51770 < 51800) + green close 51860 > 51800 -> Signal 1: BUY (PDL)
      { time: istUnix(day, '09:20'), open: 51820, high: 51880, low: 51770, close: 51860, volume: 300 },
      // Rally up
      { time: istUnix(day, '11:00'), open: 52200, high: 52450, low: 52180, close: 52430, volume: 200 },
      // 11:05 Push above PDH 52500 (high 52545), closes green at 52520
      { time: istUnix(day, '11:05'), open: 52430, high: 52545, low: 52420, close: 52520, volume: 350 },
      // 11:10 Red reversal candle closes below PDH 52500 at 52465 -> Signal 2: SELL (PDH)
      { time: istUnix(day, '11:10'), open: 52520, high: 52530, low: 52450, close: 52465, volume: 400 },
    ];

    const signals = LiquiditySweepStrategy.scanHistorical(
      'BANK NIFTY',
      'Bank Nifty Index',
      fiveMinCandles,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );

    assert.strictEqual(signals.length, 2, 'Should emit two independent signals in the same session');
    assert.strictEqual(signals[0].signalType, 'BUY');
    assert.strictEqual(signals[0].levelType, 'PDL');
    assert.strictEqual(signals[0].levelPrice, 51800);

    assert.strictEqual(signals[1].signalType, 'SELL');
    assert.strictEqual(signals[1].levelType, 'PDH');
    assert.strictEqual(signals[1].levelPrice, 52500);
    assert.strictEqual(signals[1].sweepPrice, 52545);
    assert.strictEqual(signals[1].sweepTimestamp, istUnix(day, '11:05'));
    assert.strictEqual(signals[1].confirmationClosePrice, 52465);
    assert.strictEqual(signals[1].confirmationTimestamp, istUnix(day, '11:10'));
    assert.notStrictEqual(signals[0].id, signals[1].id);
  });

  await t.test('Edge Case: opening candle ignored for Intraday High/Low sweeps, but allowed for PDH/PDL sweeps', () => {
    const day = '2026-11-17';
    // Prior day range 24000-24500. Opening candle sweeps PDL 24000 and closes green at 24040 -> SHOULD trigger PDL BUY.
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 24200, high: 24500, low: 24000, close: 24100, volume: 1000 },
    ];
    const fiveMinWithPdlSweepOnOpen: CandleData[] = [
      { time: istUnix(day, '09:15'), open: 24010, high: 24060, low: 23980, close: 24040, volume: 500 },
    ];

    const pdlSignals = LiquiditySweepStrategy.scanHistorical(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinWithPdlSweepOnOpen,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );
    assert.strictEqual(pdlSignals.length, 1);
    assert.strictEqual(pdlSignals[0].levelType, 'PDL');
    assert.strictEqual(pdlSignals[0].signalType, 'BUY');

    // Now test opening candle with NO PDH/PDL breach: must NOT trigger DAY_LOW or DAY_HIGH
    const fiveMinInsidePriorRange: CandleData[] = [
      { time: istUnix(day, '09:15'), open: 24200, high: 24250, low: 24180, close: 24230, volume: 500 },
    ];
    const openOnlySignals = LiquiditySweepStrategy.scanHistorical(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinInsidePriorRange,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );
    assert.strictEqual(openOnlySignals.length, 0);
  });

  await t.test('Edge Case: zero lookahead bias — running Intraday Low/High computed strictly from prior candles', () => {
    const day = '2026-11-17';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 24500, high: 25500, low: 23500, close: 24500, volume: 1000 },
    ];
    const fiveMinCandles: CandleData[] = [
      // 09:15 establishes initial Day Low = 24400, Day High = 24500
      { time: istUnix(day, '09:15'), open: 24450, high: 24500, low: 24400, close: 24480, volume: 100 },
      // 09:20 sweeps below Day Low 24400 (low 24385) and closes green at 24420 -> BUY on DAY_LOW 24400
      { time: istUnix(day, '09:20'), open: 24405, high: 24430, low: 24385, close: 24420, volume: 200 },
      // 09:25 later drops way lower to 24200 — must NOT retroactively alter 09:20's prior Day Low (24400)
      { time: istUnix(day, '09:25'), open: 24420, high: 24420, low: 24200, close: 24220, volume: 300 },
      // 09:30 sweeps above prior Day High 24500 (high 24525) and closes red at 24470 -> SELL on DAY_HIGH 24500
      { time: istUnix(day, '09:30'), open: 24495, high: 24525, low: 24460, close: 24470, volume: 350 },
    ];

    const signals = LiquiditySweepStrategy.scanHistorical(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinCandles,
      dailyCandles,
      day,
      day,
      istUnix(day, '15:35'),
    );

    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0].signalType, 'BUY');
    assert.strictEqual(signals[0].levelType, 'DAY_LOW');
    assert.strictEqual(signals[0].levelPrice, 24400);

    assert.strictEqual(signals[1].signalType, 'SELL');
    assert.strictEqual(signals[1].levelType, 'DAY_HIGH');
    assert.strictEqual(signals[1].levelPrice, 24500);
  });

  await t.test('Live mode evaluates ONLY the latest 3 closed 5m candles and excludes stale morning sweeps & unclosed forming candle', () => {
    const day = '2026-11-17';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-16', '09:15'), open: 24550, high: 24700, low: 24500, close: 24620, volume: 1000 },
    ];
    const fiveMinCandles: CandleData[] = [
      // 09:15
      { time: istUnix(day, '09:15'), open: 24550, high: 24600, low: 24510, close: 24540, volume: 100 },
      // 09:20 STALE PDL sweep (index 1, 5 closed candles ago -> must be IGNORED in live mode)
      { time: istUnix(day, '09:20'), open: 24505, high: 24530, low: 24480, close: 24520, volume: 200 },
      // 09:25
      { time: istUnix(day, '09:25'), open: 24520, high: 24560, low: 24515, close: 24550, volume: 100 },
      // 09:30
      { time: istUnix(day, '09:30'), open: 24550, high: 24590, low: 24540, close: 24580, volume: 100 },
      // 09:35 (3rd latest closed)
      { time: istUnix(day, '09:35'), open: 24580, high: 24650, low: 24570, close: 24640, volume: 100 },
      // 09:40 (2nd latest closed)
      { time: istUnix(day, '09:40'), open: 24640, high: 24690, low: 24630, close: 24685, volume: 100 },
      // 09:45 (latest closed): sweeps PDH 24700 (high 24722) & closes red at 24680 -> SHOULD fire
      { time: istUnix(day, '09:45'), open: 24695, high: 24722, low: 24675, close: 24680, volume: 300 },
      // 09:50 (still forming at nowSec = 09:52:00 IST -> must be EXCLUDED)
      { time: istUnix(day, '09:50'), open: 24680, high: 24735, low: 24670, close: 24675, volume: 50 },
    ];

    const nowSec = istUnix(day, '09:52'); // 09:45 bar closed at 09:50; 09:50 bar closes at 09:55 (unclosed)
    const signals = LiquiditySweepStrategy.scanLive(
      'NIFTY 50',
      'Nifty 50 Index',
      fiveMinCandles,
      dailyCandles,
      nowSec,
    );

    assert.strictEqual(signals.length, 1, 'Only the fresh 09:45 SELL sweep should fire (stale 09:20 & unclosed 09:50 excluded)');
    assert.strictEqual(signals[0].signalType, 'SELL');
    assert.strictEqual(signals[0].levelType, 'PDH');
    assert.strictEqual(signals[0].confirmationTimestamp, istUnix(day, '09:45'));
  });

  await t.test('Live mode returns complete 09:15 to 15:30 session candles even when sweep fires near market close', () => {
    const day = '2026-11-18';
    const dailyCandles: CandleData[] = [
      { time: istUnix('2026-11-17', '09:15'), open: 24550, high: 24700, low: 24500, close: 24620, volume: 1000 },
    ];
    const openUnix = istUnix(day, '09:15');
    // Build a complete 75-candle session from 09:15 to 15:25 IST
    const fullDayCandles: CandleData[] = [];
    for (let i = 0; i < 74; i++) {
      fullDayCandles.push({
        time: openUnix + i * 300,
        open: 24580,
        high: 24640,
        low: 24540,
        close: 24600,
        volume: 100,
      });
    }
    // Final candle at 15:25 sweeps PDH 24700 and reverses red below 24700
    const closeBarTime = openUnix + 74 * 300;
    fullDayCandles.push({
      time: closeBarTime,
      open: 24695,
      high: 24720,
      low: 24670,
      close: 24680,
      volume: 400,
    });

    const signals = LiquiditySweepStrategy.scanLive(
      'NIFTY 50',
      'Nifty 50 Index',
      fullDayCandles,
      dailyCandles,
      istUnix(day, '19:00'),
    );

    assert.strictEqual(signals.length, 1);
    assert.strictEqual(signals[0].candles.length, 75, 'Must include all 75 candles from 09:15 to 15:25');
    assert.strictEqual(signals[0].candles[0].time, openUnix, 'Chart must start at 09:15 IST, not 12:00 PM');
    assert.strictEqual(signals[0].candles[signals[0].candles.length - 1].time, closeBarTime);
  });

  await t.test('Timestamp normalization deduplicates and sorts candles strictly ascending in UNIX seconds', () => {
    const raw: CandleData[] = [
      { time: 1700000600.8, open: 102, high: 105, low: 101, close: 104, volume: 10 },
      { time: 1700000300, open: 100, high: 103, low: 99, close: 102, volume: 10 },
      { time: 1700000300, open: 999, high: 999, low: 999, close: 999, volume: 10 }, // duplicate timestamp
      { time: 1700000900, open: 104, high: 106, low: 103, close: 105, volume: 10 },
    ];

    const normalized = LiquiditySweepStrategy.normalizeCandles(raw);
    assert.strictEqual(normalized.length, 3);
    assert.deepStrictEqual(
      normalized.map((c) => c.time),
      [1700000300, 1700000600, 1700000900],
    );
  });

  // --- INTEGRATION TESTS FOR CONTROLLER & SERVICE ---

  let moduleRef: TestingModule;
  let controller: ScreenerController;
  let service: ScreenerService;

  const mockFirestoreService = {
    isReady: () => true,
    getTradedInstruments: async () => ({
      ...DEFAULT_LOT_SIZES,
      instruments: DEFAULT_INDICES.map((i) => ({ ...i })),
      indices: DEFAULT_INDICES.map((i) => ({ ...i })),
    }),
    getLotSizes: async () => ({
      ...DEFAULT_LOT_SIZES,
      instruments: DEFAULT_INDICES.map((i) => ({ ...i })),
      indices: DEFAULT_INDICES.map((i) => ({ ...i })),
    }),
  };

  const sampleDay = '2026-11-17';
  const mockYahooFinanceService = {
    getCandlesBatch: async (requests: any[]) => {
      const map = new Map<string, any>();
      for (const req of requests) {
        if (req.interval === '1d') {
          map.set(req.symbol, {
            symbol: req.symbol,
            yahooSymbol: '^NSEI',
            interval: '1d',
            candles: [
              { time: istUnix('2026-11-16', '09:15'), open: 24550, high: 24700, low: 24500, close: 24600, volume: 10000 },
            ],
          });
        } else if (req.interval === '1h') {
          // Synthetic 1h candles for Order Block scanning
          const baseT = istUnix(sampleDay, '09:15');
          const candles: CandleData[] = [
            { time: baseT - 6 * 3600, open: 24400, high: 24500, low: 24350, close: 24450, volume: 1000 },
            { time: baseT - 5 * 3600, open: 24450, high: 24650, low: 24420, close: 24620, volume: 1500 },
            { time: baseT - 4 * 3600, open: 24620, high: 24700, low: 24600, close: 24680, volume: 1800 },
            { time: baseT - 3 * 3600, open: 24680, high: 24800, low: 24650, close: 24780, volume: 2000 },
            { time: baseT - 2 * 3600, open: 24780, high: 24790, low: 24620, close: 24640, volume: 1200 },
            { time: baseT - 1 * 3600, open: 24640, high: 24660, low: 24580, close: 24600, volume: 900 },
            { time: baseT, open: 24600, high: 24650, low: 24590, close: 24620, volume: 800 },
          ];
          map.set(req.symbol, {
            symbol: req.symbol,
            yahooSymbol: '^NSEI',
            interval: '1h',
            candles,
          });
        } else {
          // 5m candles with a fresh BUY PDL sweep for NIFTY only
          const candles: CandleData[] =
            req.symbol === 'NIFTY' || req.symbol === 'NIFTY 50'
              ? [
                  { time: istUnix(sampleDay, '09:15'), open: 24560, high: 24590, low: 24520, close: 24530, volume: 100 },
                  { time: istUnix(sampleDay, '09:20'), open: 24530, high: 24540, low: 24480, close: 24492, volume: 200 },
                  { time: istUnix(sampleDay, '09:25'), open: 24492, high: 24530, low: 24490, close: 24522, volume: 300 },
                ]
              : [
                  { time: istUnix(sampleDay, '09:15'), open: 24580, high: 24610, low: 24560, close: 24590, volume: 100 },
                  { time: istUnix(sampleDay, '09:20'), open: 24590, high: 24620, low: 24570, close: 24605, volume: 100 },
                ];

          map.set(req.symbol, {
            symbol: req.symbol,
            yahooSymbol: '^NSEI',
            interval: '5m',
            candles,
          });
        }
      }
      return map;
    },
  };

  moduleRef = await Test.createTestingModule({
    controllers: [ScreenerController],
    providers: [
      ScreenerService,
      { provide: FirestoreService, useValue: mockFirestoreService },
      { provide: YahooFinanceService, useValue: mockYahooFinanceService },
    ],
  }).compile();

  controller = moduleRef.get<ScreenerController>(ScreenerController);
  service = moduleRef.get<ScreenerService>(ScreenerService);

  await t.test('GET /api/screener/instruments returns configured traded instruments with Dhan displayName', async () => {
    const res = await controller.getInstruments();
    assert.strictEqual(res.instruments.length, 4);
    assert.deepStrictEqual(
      res.instruments.map((i) => i.displayName),
      ['Nifty 50', 'Nifty Bank', 'Nifty Midcap Select', 'Sensex'],
    );
    assert.deepStrictEqual(
      res.instruments.map((i) => i.symbol),
      ['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'SENSEX'],
    );
  });

  await t.test('POST /api/screener/scan executes Live mode across configured traded instruments and returns sweep signals with candles', async () => {
    const res = await service.scan({ mode: 'live' }, istUnix(sampleDay, '09:35'));
    assert.strictEqual(res.mode, 'live');
    assert.strictEqual(res.timeframe, '5m');
    assert.strictEqual(res.totalScanned, 4);
    assert.strictEqual(res.totalRecommendations, 1);
    assert.strictEqual(res.bullishCount, 1);
    assert.strictEqual(res.bearishCount, 0);
    assert.strictEqual(res.recommendations[0].symbol, 'NIFTY');
    assert.strictEqual(res.recommendations[0].displayName, 'Nifty 50');
    assert.strictEqual(res.recommendations[0].levelType, 'PDL');
    assert.strictEqual(res.recommendations[0].levelPrice, 24500);
    assert.strictEqual(res.recommendations[0].sweepPrice, 24480);
    assert.strictEqual(res.recommendations[0].confirmationClosePrice, 24522);
    assert.ok(Array.isArray(res.recommendations[0].candles) && res.recommendations[0].candles.length === 3);
  });

  await t.test('POST /api/screener/scan executes Historical mode for a selected date', async () => {
    const res = await service.scan({ mode: 'historical', date: sampleDay }, istUnix('2026-11-18', '18:00'));
    assert.strictEqual(res.mode, 'historical');
    assert.strictEqual(res.startDate, sampleDay);
    assert.strictEqual(res.endDate, sampleDay);
    assert.strictEqual(res.totalRecommendations, 1);
    assert.strictEqual(res.recommendations[0].sessionDate, sampleDay);
  });

  await t.test('Historical mode rejects missing date, reversed range, and dates older than 59 days', async () => {
    const refNow = istUnix('2026-11-18', '18:00');
    await assert.rejects(
      () => service.scan({ mode: 'historical' }, refNow),
      BadRequestException,
    );
    await assert.rejects(
      () => service.scan({ mode: 'historical', startDate: '2026-11-17', endDate: '2026-11-15' }, refNow),
      BadRequestException,
    );
    await assert.rejects(
      () => service.scan({ mode: 'historical', date: '2026-08-01' }, refNow),
      BadRequestException,
    );
  });

  await t.test('POST /api/screener/scan executes Order Block (SMC) scan when strategy is order-block', async () => {
    const res = await service.scan({ strategy: 'order-block', htfTimeframe: '1h', ltfTimeframe: '5m' }, istUnix(sampleDay, '12:00'));
    assert.strictEqual(res.strategy, 'order-block');
    assert.strictEqual(res.totalScanned, 4);
    assert.ok(res.orderBlockData);
    assert.strictEqual(res.orderBlockData?.strategy, 'order-block');
    assert.strictEqual(res.orderBlockData?.results.length, 4);
  });

  await t.test('POST /api/screener/scan with order-block strategy executes Order Block scan', async () => {
    const res = await controller.runScan({ strategy: 'order-block', htfTimeframe: '1h', ltfTimeframe: '5m' });
    assert.strictEqual(res.strategy, 'order-block');
    assert.strictEqual(res.orderBlockData?.totalScanned, 4);
    assert.ok(Array.isArray(res.orderBlockData?.results));
  });
});
