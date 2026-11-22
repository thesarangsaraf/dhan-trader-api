process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { ScreenerController } from '../src/screener/screener.controller';
import { ScreenerService } from '../src/screener/screener.service';
import { FirestoreService, DEFAULT_INDICES, DEFAULT_LOT_SIZES } from '../src/firestore/firestore.service';
import { YahooFinanceService, CandleData } from '../src/yahoo/yahoo.service';
import { ScreenerCandle } from '../src/screener/models/screener.models';
import {
  analyzeInstrument,
  compileScanResults,
  computeATR,
  detectLiquidityPools,
  detectLiquiditySweeps,
  detectSwingPivots,
  generateSweepSignals,
} from '../src/screener/strategies/liquiditySweepScanner';

function makeCandle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
): ScreenerCandle {
  return { time, open, high, low, close, volume };
}

test('Standalone Liquidity Sweep Strategy Scanner Engine', async (t) => {
  // -------------------------------------------------------------------------
  // 1. PIVOT DETECTION (detectSwingPivots)
  // -------------------------------------------------------------------------
  await t.test('1. detectSwingPivots: detects swing highs and lows with zero lookahead bias', () => {
    // 11 bars with lookback 2:
    // index 2: high = 110 (greater than indices 0,1 and >= 3,4) -> Swing High confirmed at index 4
    // index 5: low = 90 (less than indices 3,4 and <= 6,7) -> Swing Low confirmed at index 7
    const candles: ScreenerCandle[] = [
      makeCandle(100, 100, 102, 98, 101),
      makeCandle(200, 101, 105, 100, 104),
      makeCandle(300, 104, 110, 103, 108), // Pivot High (j=2)
      makeCandle(400, 108, 106, 102, 103),
      makeCandle(500, 103, 104, 99, 100),
      makeCandle(600, 100, 101, 90, 92), // Pivot Low (j=5)
      makeCandle(700, 92, 98, 93, 97),
      makeCandle(800, 97, 102, 96, 101),
      makeCandle(900, 101, 103, 100, 102),
    ];

    const pivots = detectSwingPivots(candles, { swingLookback: 2 });
    assert.strictEqual(pivots.length, 2);

    const highPivot = pivots.find((p) => p.type === 'HIGH');
    assert.ok(highPivot);
    assert.strictEqual(highPivot.price, 110);
    assert.strictEqual(highPivot.index, 2);
    assert.strictEqual(highPivot.confirmedAtIndex, 4);
    assert.strictEqual(highPivot.confirmedAtTime, 500);

    const lowPivot = pivots.find((p) => p.type === 'LOW');
    assert.ok(lowPivot);
    assert.strictEqual(lowPivot.price, 90);
    assert.strictEqual(lowPivot.index, 5);
    assert.strictEqual(lowPivot.confirmedAtIndex, 7);
    assert.strictEqual(lowPivot.confirmedAtTime, 800);
  });

  // -------------------------------------------------------------------------
  // 2. LIQUIDITY POOL DETECTION (BSL, SSL, EQH, EQL, PDH, PDL)
  // -------------------------------------------------------------------------
  await t.test('2. detectLiquidityPools: identifies BSL/SSL and clusters Equal Highs/Lows', () => {
    const candles: ScreenerCandle[] = [];
    // 25 bars with two swing highs close in price (EQH) and one swing low
    for (let i = 0; i < 25; i++) {
      candles.push(makeCandle(i * 300, 24000, 24020, 23980, 24000));
    }
    // High at bar 5: 24500
    candles[5] = makeCandle(5 * 300, 24450, 24500, 24440, 24480);
    // Low at bar 10: 23800
    candles[10] = makeCandle(10 * 300, 23850, 23860, 23800, 23820);
    // High at bar 18: 24502 (within ATR tolerance of 24500 -> EQH)
    candles[18] = makeCandle(18 * 300, 24450, 24502, 24440, 24480);

    const pivots = detectSwingPivots(candles, { swingLookback: 3 });
    const pools = detectLiquidityPools(candles, pivots, {
      eqToleranceATR: 0.25,
      includeSessionExtremes: true,
      pdh: 24600,
      pdl: 23700,
    });

    // Check EQH pool
    const eqh = pools.find((p) => p.poolType === 'EQH');
    assert.ok(eqh, 'Should detect clustered Equal Highs (EQH)');
    assert.strictEqual(eqh.side, 'BSL');
    assert.strictEqual(eqh.touchCount, 2);
    assert.strictEqual(eqh.price, 24502);

    // Check SSL swing low pool
    const ssl = pools.find((p) => p.side === 'SSL' && p.poolType === 'SWING');
    assert.ok(ssl, 'Should detect Sell-Side Liquidity (SSL) swing low');
    assert.strictEqual(ssl.price, 23800);

    // Check PDH / PDL pools
    const pdhPool = pools.find((p) => p.poolType === 'PDH');
    const pdlPool = pools.find((p) => p.poolType === 'PDL');
    assert.ok(pdhPool && pdhPool.price === 24600);
    assert.ok(pdlPool && pdlPool.price === 23700);
  });

  // -------------------------------------------------------------------------
  // 3. SWEEP VS BREAKOUT (detectLiquiditySweeps)
  // -------------------------------------------------------------------------
  await t.test('3. detectLiquiditySweeps: Bullish sweep of SSL with rejection and reclaim', () => {
    const candles: ScreenerCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(1000 + i * 300, 24000, 24050, 23980, 24020));
    }
    // Bar 5: Pivot Low at 23900 (SSL)
    candles[5] = makeCandle(1000 + 5 * 300, 23950, 23960, 23900, 23930);

    const pivots = detectSwingPivots(candles, { swingLookback: 2 });
    const pools = detectLiquidityPools(candles, pivots, { includeSessionExtremes: false });

    // Bar 14: Sweeps below SSL 23900 (low 23875) and reclaims with green close 23925
    candles[14] = makeCandle(1000 + 14 * 300, 23910, 23935, 23875, 23925);

    const sweeps = detectLiquiditySweeps(candles, pools, {
      minSweepDepthATR: 0.02,
      maxReclaimBars: 2,
    });

    assert.strictEqual(sweeps.length, 1);
    assert.strictEqual(sweeps[0].direction, 'BULLISH');
    assert.strictEqual(sweeps[0].sweptPrice, 23900);
    assert.strictEqual(sweeps[0].sweepWickExtreme, 23875);
    assert.strictEqual(sweeps[0].reclaimClose, 23925);
  });

  await t.test('3b. detectLiquiditySweeps: Bearish sweep of BSL with rejection and reclaim', () => {
    const candles: ScreenerCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(1000 + i * 300, 24000, 24050, 23980, 24020));
    }
    // Bar 4: Pivot High at 24200 (BSL)
    candles[4] = makeCandle(1000 + 4 * 300, 24150, 24200, 24140, 24180);

    const pivots = detectSwingPivots(candles, { swingLookback: 2 });
    const pools = detectLiquidityPools(candles, pivots, { includeSessionExtremes: false });

    // Bar 12: Sweeps above BSL 24200 (high 24230) and closes red at 24175
    candles[12] = makeCandle(1000 + 12 * 300, 24190, 24230, 24170, 24175);

    const sweeps = detectLiquiditySweeps(candles, pools, {
      minSweepDepthATR: 0.02,
      maxReclaimBars: 2,
    });

    assert.strictEqual(sweeps.length, 1);
    assert.strictEqual(sweeps[0].direction, 'BEARISH');
    assert.strictEqual(sweeps[0].sweptPrice, 24200);
    assert.strictEqual(sweeps[0].sweepWickExtreme, 24230);
    assert.strictEqual(sweeps[0].reclaimClose, 24175);
  });

  await t.test('3c. detectLiquiditySweeps: Invalidates pool as BROKEN if sustained close beyond level without reclaim', () => {
    const candles: ScreenerCandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(1000 + i * 300, 24000, 24050, 23980, 24020));
    }
    // Bar 4: Pivot High at 24200
    candles[4] = makeCandle(1000 + 4 * 300, 24150, 24200, 24140, 24180);

    const pivots = detectSwingPivots(candles, { swingLookback: 2 });
    const pools = detectLiquidityPools(candles, pivots, { includeSessionExtremes: false });

    // Bars 10, 11, 12, 13 close well above 24200 (runaway breakout, not a sweep)
    candles[10] = makeCandle(1000 + 10 * 300, 24190, 24250, 24180, 24240);
    candles[11] = makeCandle(1000 + 11 * 300, 24240, 24300, 24230, 24290);
    candles[12] = makeCandle(1000 + 12 * 300, 24290, 24350, 24280, 24340);
    candles[13] = makeCandle(1000 + 13 * 300, 24340, 24400, 24330, 24390);

    const sweeps = detectLiquiditySweeps(candles, pools, {
      maxReclaimBars: 2,
    });

    assert.strictEqual(sweeps.length, 0, 'Breakout must not trigger a sweep event');
    assert.strictEqual(pools[0].status, 'BROKEN');
  });

  // -------------------------------------------------------------------------
  // 4. STANDALONE ENTRY, STOP LOSS & TAKE PROFIT (generateSweepSignals)
  // -------------------------------------------------------------------------
  await t.test('4. generateSweepSignals: calculates SL at sweep wick extreme and TP at opposing pool with >= 2.5 RR', () => {
    const candles: ScreenerCandle[] = [
      makeCandle(1000, 24000, 24050, 23950, 24000),
      makeCandle(1300, 24000, 24050, 23950, 24000),
    ];
    const pools = [
      {
        id: 'BSL_1',
        side: 'BSL' as const,
        poolType: 'SWING' as const,
        price: 24500, // Opposing target pool
        startTime: 1000,
        touchCount: 1,
        status: 'ACTIVE' as const,
      },
      {
        id: 'SSL_1',
        side: 'SSL' as const,
        poolType: 'SWING' as const,
        price: 24100,
        startTime: 1000,
        touchCount: 1,
        status: 'SWEPT' as const,
      },
    ];

    const sweeps = [
      {
        poolId: 'SSL_1',
        direction: 'BULLISH' as const,
        poolType: 'SWING' as const,
        sweptPrice: 24100,
        sweepWickExtreme: 24050,
        sweepTime: 1200,
        reclaimTime: 1300,
        reclaimClose: 24110,
        reclaimCandleIndex: 1,
      },
    ];

    const signal = generateSweepSignals(candles, sweeps, pools, [], {
      entryMode: 'RECLAIM_CLOSE',
      minRR: 2.5,
      bufferATRMultiplier: 0.1,
    });

    assert.ok(signal);
    assert.strictEqual(signal.action, 'BUY');
    assert.strictEqual(signal.entryMode, 'RECLAIM_CLOSE');
    assert.strictEqual(signal.entryPrice, 24110);
    assert.ok(signal.stopLoss <= 24050, 'Stop loss must be strictly beyond sweep wick extreme (24050)');
    assert.strictEqual(signal.targetPoolPrice, 24500);
    assert.strictEqual(signal.takeProfit, 24500);
    assert.ok(signal.rrRatio >= 2.5, `RR ratio must be >= 2.5, got ${signal.rrRatio}`);
  });

  // -------------------------------------------------------------------------
  // 5. STANDALONE INSTRUMENT ANALYSIS (analyzeInstrument & compileScanResults)
  // -------------------------------------------------------------------------
  await t.test('5. analyzeInstrument: returns decoupled standalone JSON payload', () => {
    const candles: ScreenerCandle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(1000 + i * 300, 24000, 24050, 23950, 24000));
    }
    // High at 5: 24400 (BSL)
    candles[5] = makeCandle(1000 + 5 * 300, 24350, 24400, 24340, 24380);
    // Low at 10: 23800 (SSL)
    candles[10] = makeCandle(1000 + 10 * 300, 23850, 23860, 23800, 23820);
    // Sweep of SSL at 18
    candles[18] = makeCandle(1000 + 18 * 300, 23810, 23840, 23780, 23825);

    const result = analyzeInstrument('NIFTY', 'Nifty 50', candles, [], {
      timeframe: '15m',
      minRR: 2.5,
    });

    assert.strictEqual(result.symbol, 'NIFTY');
    assert.strictEqual(result.strategy, 'LIQUIDITY_SWEEP');
    assert.strictEqual(result.timeframe, '15m');
    assert.ok(Array.isArray(result.activePools));
    assert.ok(Array.isArray(result.recentSweeps));
    assert.ok(result.chartOverlay);
    assert.ok(Array.isArray(result.chartOverlay.pools));
    assert.ok(Array.isArray(result.chartOverlay.sweeps));
  });

  // -------------------------------------------------------------------------
  // 6. CONTROLLER ENDPOINT INTEGRATION (/api/screener/scan)
  // -------------------------------------------------------------------------
  await t.test('6. POST /api/screener/scan executes sweep scan via controller', async () => {
    const mockFirestore = {
      isReady: () => true,
      getTradedInstruments: async () => ({
        ...DEFAULT_LOT_SIZES,
        instruments: DEFAULT_INDICES.map((i) => ({ ...i })),
        indices: DEFAULT_INDICES.map((i) => ({ ...i })),
      }),
    };

    const mockYahoo = {
      getCandlesBatch: async (requests: any[]) => {
        const map = new Map<string, any>();
        for (const req of requests) {
          map.set(req.symbol, {
            symbol: req.symbol,
            yahooSymbol: '^NSEI',
            interval: req.interval,
            candles: [
              makeCandle(1000, 24000, 24050, 23950, 24000),
              makeCandle(1300, 24000, 24100, 23900, 24020),
            ],
          });
        }
        return map;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ScreenerController],
      providers: [
        ScreenerService,
        { provide: FirestoreService, useValue: mockFirestore },
        { provide: YahooFinanceService, useValue: mockYahoo },
      ],
    }).compile();

    const controller = moduleRef.get<ScreenerController>(ScreenerController);
    const res = await controller.runScan({ timeframe: '15m' });

    assert.strictEqual(res.strategy, 'LIQUIDITY_SWEEP');
    assert.strictEqual(res.timeframe, '15m');
    assert.strictEqual(res.totalScanned, 4);
    assert.ok(Array.isArray(res.liquiditySweepData?.results));
  });
});
