process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { ScreenerController } from '../src/screener/screener.controller';
import { ScreenerService } from '../src/screener/screener.service';
import { FirestoreService, DEFAULT_SCREENER_SETTINGS, DEFAULT_LARGE_CAP_STOCKS } from '../src/firestore/firestore.service';
import { YahooFinanceService, CandleData } from '../src/yahoo/yahoo.service';
import { OrderBlockStrategy } from '../src/screener/strategies/order-block.strategy';
import { LiquiditySweepStrategy } from '../src/screener/strategies/liquidity-sweep.strategy';

test('Screener Module & Technical Strategies (NestJS)', async (t) => {
  // --- UNIT TESTS FOR STRATEGY ENGINES ---

  await t.test('OrderBlockStrategy detects Bullish Demand Zone setup', () => {
    // Construct series: baseline candles, last bearish candle (OB), strong upward impulse, then pullback testing OB High
    const candles: CandleData[] = [
      { time: 100, open: 2500, high: 2510, low: 2495, close: 2505, volume: 100 },
      { time: 200, open: 2505, high: 2515, low: 2500, close: 2510, volume: 100 },
      { time: 300, open: 2510, high: 2515, low: 2502, close: 2508, volume: 100 },
      { time: 400, open: 2508, high: 2512, low: 2501, close: 2506, volume: 100 },
      { time: 500, open: 2506, high: 2510, low: 2500, close: 2504, volume: 100 },
      { time: 600, open: 2504, high: 2508, low: 2498, close: 2502, volume: 100 },
      { time: 700, open: 2502, high: 2505, low: 2495, close: 2500, volume: 100 },
      { time: 800, open: 2500, high: 2502, low: 2490, close: 2495, volume: 100 },
      // Index 8: The last bearish candle before impulse (OB Candle: Low=2480, High=2495)
      { time: 900, open: 2495, high: 2495, low: 2480, close: 2482, volume: 150 },
      // Index 9: Strong upward impulse candle (+60 pts move, huge body)
      { time: 1000, open: 2482, high: 2545, low: 2482, close: 2542, volume: 800 },
      // Index 10: Continuation higher
      { time: 1100, open: 2542, high: 2560, low: 2535, close: 2555, volume: 400 },
      // Index 11-13: Pullback toward OB High (2495) without breaching OB Low (2480)
      { time: 1200, open: 2555, high: 2555, low: 2520, close: 2525, volume: 200 },
      { time: 1300, open: 2525, high: 2530, low: 2505, close: 2510, volume: 180 },
      // Index 14: Current testing candle near 2496 (testing OB High 2495)
      { time: 1400, open: 2510, high: 2512, low: 2490, close: 2496, volume: 250 },
    ];

    const match = OrderBlockStrategy.evaluate(
      candles,
      'RELIANCE',
      'Reliance Industries Ltd',
      '15m',
      DEFAULT_SCREENER_SETTINGS,
    );

    assert.ok(match, 'Expected Bullish Demand Order Block match');
    assert.strictEqual(match.symbol, 'RELIANCE');
    assert.strictEqual(match.strategy, 'DEMAND_ORDER_BLOCK');
    assert.strictEqual(match.signalType, 'BUY');
    assert.strictEqual(match.entryPrice, 2495); // High of the last bearish candle before impulse
    assert.strictEqual(match.stopLossPrice, 2480); // Low of the OB candle
    assert.strictEqual(match.riskPoints, 15);
  });

  await t.test('OrderBlockStrategy detects Bearish Supply Zone setup', () => {
    // Construct series: baseline candles, last bullish candle (Supply OB), strong downward impulse, rally back testing OB Low
    const candles: CandleData[] = [
      { time: 100, open: 1500, high: 1510, low: 1495, close: 1505, volume: 100 },
      { time: 200, open: 1505, high: 1515, low: 1500, close: 1510, volume: 100 },
      { time: 300, open: 1510, high: 1518, low: 1505, close: 1515, volume: 100 },
      { time: 400, open: 1515, high: 1520, low: 1510, close: 1518, volume: 100 },
      { time: 500, open: 1518, high: 1525, low: 1512, close: 1520, volume: 100 },
      { time: 600, open: 1520, high: 1525, low: 1515, close: 1522, volume: 100 },
      { time: 700, open: 1522, high: 1528, low: 1518, close: 1525, volume: 100 },
      { time: 800, open: 1525, high: 1530, low: 1520, close: 1528, volume: 100 },
      // Index 8: Last bullish candle before drop (Supply OB: Low=1525, High=1545)
      { time: 900, open: 1528, high: 1545, low: 1525, close: 1542, volume: 150 },
      // Index 9: Strong downward impulse (-50 pts drop)
      { time: 1000, open: 1542, high: 1542, low: 1488, close: 1490, volume: 800 },
      // Index 10: Follow through lower
      { time: 1100, open: 1490, high: 1495, low: 1470, close: 1475, volume: 400 },
      // Index 11-13: Rally back up toward OB Low (1525)
      { time: 1200, open: 1475, high: 1500, low: 1472, close: 1498, volume: 200 },
      { time: 1300, open: 1498, high: 1518, low: 1495, close: 1515, volume: 180 },
      // Index 14: Retesting supply at 1524 (near OB Low 1525)
      { time: 1400, open: 1515, high: 1526, low: 1512, close: 1524, volume: 250 },
    ];

    const match = OrderBlockStrategy.evaluate(
      candles,
      'INFY',
      'Infosys Ltd',
      '15m',
      DEFAULT_SCREENER_SETTINGS,
    );

    assert.ok(match, 'Expected Bearish Supply Order Block match');
    assert.strictEqual(match.symbol, 'INFY');
    assert.strictEqual(match.strategy, 'SUPPLY_ORDER_BLOCK');
    assert.strictEqual(match.signalType, 'SELL');
    assert.strictEqual(match.entryPrice, 1525); // Low of the last bullish candle before impulse
    assert.strictEqual(match.stopLossPrice, 1545); // High of the OB candle
    assert.strictEqual(match.riskPoints, 20);
  });

  await t.test('OrderBlockStrategy rejects mitigated (violated) Order Blocks', () => {
    // If intervening price broke below Demand OB Low (2480), it must NOT match
    const candles: CandleData[] = [
      { time: 100, open: 2500, high: 2510, low: 2495, close: 2505, volume: 100 },
      { time: 200, open: 2505, high: 2515, low: 2500, close: 2510, volume: 100 },
      { time: 300, open: 2510, high: 2515, low: 2502, close: 2508, volume: 100 },
      { time: 400, open: 2508, high: 2512, low: 2501, close: 2506, volume: 100 },
      { time: 500, open: 2506, high: 2510, low: 2500, close: 2504, volume: 100 },
      { time: 600, open: 2504, high: 2508, low: 2498, close: 2502, volume: 100 },
      { time: 700, open: 2502, high: 2505, low: 2495, close: 2500, volume: 100 },
      { time: 800, open: 2500, high: 2502, low: 2490, close: 2495, volume: 100 },
      { time: 900, open: 2495, high: 2495, low: 2480, close: 2482, volume: 150 },
      { time: 1000, open: 2482, high: 2545, low: 2482, close: 2542, volume: 800 },
      { time: 1100, open: 2542, high: 2560, low: 2535, close: 2555, volume: 400 },
      // Index 12: VIOLATION candle breaking down to 2470 (below 2480 OB Low)
      { time: 1200, open: 2555, high: 2555, low: 2470, close: 2475, volume: 500 },
      { time: 1300, open: 2475, high: 2500, low: 2475, close: 2490, volume: 180 },
      { time: 1400, open: 2490, high: 2498, low: 2488, close: 2495, volume: 250 },
    ];

    const match = OrderBlockStrategy.evaluate(
      candles,
      'RELIANCE',
      'Reliance Industries Ltd',
      '15m',
      DEFAULT_SCREENER_SETTINGS,
    );

    assert.strictEqual(match, null, 'Mitigated Order Block should not return a setup');
  });

  await t.test('LiquiditySweepStrategy detects Bullish Liquidity Sweep (sell-side stop run)', () => {
    // Key swing low formed at 1000 (Index 4: low=1000).
    // Later at index 14, price wicks down to 990 (sweeping 1000) and closes at 1010 with large lower wick.
    const candles: CandleData[] = [
      { time: 100, open: 1020, high: 1030, low: 1015, close: 1025, volume: 100 },
      { time: 200, open: 1025, high: 1035, low: 1010, close: 1012, volume: 100 },
      { time: 300, open: 1012, high: 1018, low: 1005, close: 1008, volume: 100 },
      // Index 3: Swing Low at 1000
      { time: 400, open: 1008, high: 1015, low: 1000, close: 1006, volume: 150 },
      { time: 500, open: 1006, high: 1025, low: 1004, close: 1022, volume: 200 },
      { time: 600, open: 1022, high: 1030, low: 1018, close: 1025, volume: 120 },
      { time: 700, open: 1025, high: 1032, low: 1020, close: 1028, volume: 100 },
      { time: 800, open: 1028, high: 1035, low: 1022, close: 1025, volume: 100 },
      { time: 900, open: 1025, high: 1030, low: 1015, close: 1018, volume: 100 },
      { time: 1000, open: 1018, high: 1020, low: 1008, close: 1010, volume: 110 },
      { time: 1100, open: 1010, high: 1015, low: 1005, close: 1008, volume: 120 },
      { time: 1200, open: 1008, high: 1012, low: 1003, close: 1005, volume: 130 },
      { time: 1300, open: 1005, high: 1010, low: 1002, close: 1004, volume: 140 },
      // Index 13: Sweep Rejection Candle: low=990 (< 1000), close=1012 (> 1000), high=1015
      // Lower wick: min(1004, 1012) - 990 = 1004 - 990 = 14. Total range = 1015 - 990 = 25. Wick ratio = 14/25 = 56%
      { time: 1400, open: 1004, high: 1015, low: 990, close: 1012, volume: 500 },
    ];

    const match = LiquiditySweepStrategy.evaluate(
      candles,
      'TCS',
      'Tata Consultancy Services Ltd',
      '15m',
      DEFAULT_SCREENER_SETTINGS,
    );

    assert.ok(match, 'Expected Bullish Liquidity Sweep match');
    assert.strictEqual(match.symbol, 'TCS');
    assert.strictEqual(match.strategy, 'BULLISH_LIQUIDITY_SWEEP');
    assert.strictEqual(match.signalType, 'BUY');
    assert.strictEqual(match.entryPrice, 1015); // High of sweep candle
    assert.strictEqual(match.stopLossPrice, 990); // Low of sweep candle
    assert.strictEqual(match.riskPoints, 25);
  });

  await t.test('LiquiditySweepStrategy detects Bearish Liquidity Sweep (buy-side stop run)', () => {
    // Key swing high formed at 500 (Index 3: high=500).
    // Later at index 13, price wicks up to 510 (sweeping 500) and closes at 492 with large upper wick.
    const candles: CandleData[] = [
      { time: 100, open: 480, high: 490, low: 475, close: 485, volume: 100 },
      { time: 200, open: 485, high: 495, low: 482, close: 492, volume: 100 },
      // Index 2: Swing High at 500
      { time: 300, open: 492, high: 500, low: 488, close: 495, volume: 200 },
      { time: 400, open: 495, high: 497, low: 478, close: 482, volume: 150 },
      { time: 500, open: 482, high: 485, low: 475, close: 478, volume: 100 },
      { time: 600, open: 478, high: 482, low: 472, close: 475, volume: 100 },
      { time: 700, open: 475, high: 480, low: 470, close: 473, volume: 100 },
      { time: 800, open: 473, high: 478, low: 468, close: 472, volume: 100 },
      { time: 900, open: 472, high: 485, low: 470, close: 482, volume: 120 },
      { time: 1000, open: 482, high: 492, low: 480, close: 490, volume: 130 },
      { time: 1100, open: 490, high: 496, low: 488, close: 492, volume: 140 },
      { time: 1200, open: 492, high: 498, low: 490, close: 495, volume: 150 },
      // Index 12: Sweep Rejection Candle: high=510 (> 500), close=492 (< 500), low=488
      // Upper wick: 510 - max(495, 492) = 510 - 495 = 15. Total range = 510 - 488 = 22. Wick ratio = 15/22 = 68%
      { time: 1300, open: 495, high: 510, low: 488, close: 492, volume: 600 },
      { time: 1400, open: 492, high: 494, low: 485, close: 487, volume: 200 },
    ];

    const match = LiquiditySweepStrategy.evaluate(
      candles,
      'SBIN',
      'State Bank of India',
      '15m',
      DEFAULT_SCREENER_SETTINGS,
    );

    assert.ok(match, 'Expected Bearish Liquidity Sweep match');
    assert.strictEqual(match.symbol, 'SBIN');
    assert.strictEqual(match.strategy, 'BEARISH_LIQUIDITY_SWEEP');
    assert.strictEqual(match.signalType, 'SELL');
    assert.strictEqual(match.entryPrice, 488); // Low of sweep candle
    assert.strictEqual(match.stopLossPrice, 510); // High of sweep candle
    assert.strictEqual(match.riskPoints, 22);
  });

  // --- INTEGRATION TESTS FOR CONTROLLER & SERVICE ---

  let moduleRef: TestingModule;
  let controller: ScreenerController;
  let service: ScreenerService;

  let mockWatchlistStore: any = null;
  let mockSettingsStore: any = null;

  const mockFirestoreService = {
    isReady: () => true,
    getScreenerWatchlist: async () => {
      if (!mockWatchlistStore) {
        mockWatchlistStore = {
          symbols: [...DEFAULT_LARGE_CAP_STOCKS],
          updatedAt: new Date().toISOString(),
          version: 1,
        };
      }
      return mockWatchlistStore;
    },
    saveScreenerWatchlist: async (symbols: any[]) => {
      mockWatchlistStore = {
        symbols,
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      return { success: true, data: mockWatchlistStore, writeTime: new Date().toISOString() };
    },
    resetScreenerWatchlist: async () => {
      mockWatchlistStore = {
        symbols: [...DEFAULT_LARGE_CAP_STOCKS],
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      return { success: true, data: mockWatchlistStore, writeTime: new Date().toISOString() };
    },
    getScreenerSettings: async () => mockSettingsStore || DEFAULT_SCREENER_SETTINGS,
    saveScreenerSettings: async (settings: any) => {
      mockSettingsStore = { ...DEFAULT_SCREENER_SETTINGS, ...settings };
      return { success: true, data: mockSettingsStore, writeTime: new Date().toISOString() };
    },
  };

  const mockYahooFinanceService = {
    getCandlesBatch: async (requests: any[]) => {
      const map = new Map<string, any>();
      for (const req of requests) {
        // Return dummy candles for each requested ticker
        map.set(req.symbol, {
          symbol: req.symbol,
          yahooSymbol: `${req.symbol}.NS`,
          interval: req.interval || '15m',
          lastPrice: 2500,
          count: 20,
          candles: [
            { time: 100, open: 2500, high: 2510, low: 2495, close: 2505, volume: 100 },
            { time: 200, open: 2505, high: 2515, low: 2500, close: 2510, volume: 100 },
            { time: 300, open: 2510, high: 2515, low: 2502, close: 2508, volume: 100 },
            { time: 400, open: 2508, high: 2512, low: 2501, close: 2506, volume: 100 },
            { time: 500, open: 2506, high: 2510, low: 2500, close: 2504, volume: 100 },
            { time: 600, open: 2504, high: 2508, low: 2498, close: 2502, volume: 100 },
            { time: 700, open: 2502, high: 2505, low: 2495, close: 2500, volume: 100 },
            { time: 800, open: 2500, high: 2502, low: 2490, close: 2495, volume: 100 },
            { time: 900, open: 2495, high: 2495, low: 2480, close: 2482, volume: 150 },
            { time: 1000, open: 2482, high: 2545, low: 2482, close: 2542, volume: 800 },
            { time: 1100, open: 2542, high: 2560, low: 2535, close: 2555, volume: 400 },
            { time: 1200, open: 2555, high: 2555, low: 2520, close: 2525, volume: 200 },
            { time: 1300, open: 2525, high: 2530, low: 2505, close: 2510, volume: 180 },
            { time: 1400, open: 2510, high: 2512, low: 2490, close: 2496, volume: 250 },
          ],
        });
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

  await t.test('GET /api/screener/watchlist retrieves auto-seeded large-cap watchlist', async () => {
    const res = await controller.getWatchlist();
    assert.ok(res.symbols.length >= 28, 'Should return at least 28 seeded stocks');
    assert.strictEqual(res.symbols[0].symbol, 'RELIANCE');
    assert.strictEqual(res.symbols[1].symbol, 'TCS');
  });

  await t.test('PUT /api/screener/watchlist updates and toggles stock universe', async () => {
    const updatedList = [
      { symbol: 'RELIANCE', name: 'Reliance Industries', enabled: true, order: 1 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', enabled: false, order: 2 },
    ];
    const res = await controller.updateWatchlist({ symbols: updatedList });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.symbols.length, 2);
  });

  await t.test('POST /api/screener/watchlist/reset restores default universe', async () => {
    const res = await controller.resetWatchlist();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.symbols.length, 28);
  });

  await t.test('POST /api/screener/scan executes scan and returns technical setups', async () => {
    const res = await controller.runScan({ timeframe: '15m', symbols: ['RELIANCE'] });
    assert.strictEqual(res.timeframe, '15m');
    assert.strictEqual(res.totalScanned, 1);
    assert.ok(res.matches.length >= 1, 'Should find Demand OB match from mock candle data');
    assert.strictEqual(res.matches[0].symbol, 'RELIANCE');
    assert.strictEqual(res.matches[0].signalType, 'BUY');
    assert.strictEqual(res.matches[0].entryPrice, 2495);
    assert.strictEqual(res.matches[0].stopLossPrice, 2480);
  });
});
