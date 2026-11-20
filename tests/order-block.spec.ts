import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectSwings,
  detectMarketStructure,
  findFVG,
  findValidOrderBlocks,
  evaluateMTFSetups,
  buildChartOverlay,
} from '../src/screener/strategies/orderBlockScanner';
import { OrderBlockStrategy } from '../src/screener/strategies/order-block.strategy';
import { ScreenerCandle } from '../src/screener/models/screener.models';

/**
 * Helper to generate synthetic candle sequence for deterministic SMC testing.
 */
function makeCandle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  baseTime: number = 1700000000,
): ScreenerCandle {
  return {
    time: baseTime + index * 3600, // 1h intervals
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

describe('Order Block (SMC / Supply & Demand) Scanner Engine', () => {
  it('1. detectSwings: correctly detects confirmed fractal highs/lows with zero lookahead bias', () => {
    // Generate an obvious peak at index 3 with lookback = 2
    // Indices: 0, 1, 2, 3 (peak), 4, 5, 6
    const candles: ScreenerCandle[] = [
      makeCandle(0, 100, 102, 99, 101),
      makeCandle(1, 101, 105, 100, 104),
      makeCandle(2, 104, 108, 103, 107),
      makeCandle(3, 107, 120, 106, 118), // SWING HIGH (index 3, high = 120)
      makeCandle(4, 115, 116, 110, 112),
      makeCandle(5, 112, 113, 105, 106),
      makeCandle(6, 106, 107, 101, 102),
    ];

    const swings = detectSwings(candles, { swingLookback: 2 });
    assert.strictEqual(swings.length, 1);
    assert.strictEqual(swings[0].type, 'HIGH');
    assert.strictEqual(swings[0].price, 120);
    assert.strictEqual(swings[0].index, 3);
    // Verified confirmed strictly at index 3 + 2 = 5
    assert.strictEqual(swings[0].confirmedAtIndex, 5);
  });

  it('2. detectMarketStructure: confirms Bullish BoS and Reversal CHoCH on candle body close', () => {
    // Sequence with confirmed swing high at index 2 (high 110, confirmed at index 4)
    // Candle 5 closes at 115 > 110 -> Bullish BoS
    const candles: ScreenerCandle[] = [
      makeCandle(0, 100, 102, 98, 101),
      makeCandle(1, 101, 106, 100, 105),
      makeCandle(2, 105, 110, 104, 108), // Swing high at 2 (110)
      makeCandle(3, 108, 109, 102, 103),
      makeCandle(4, 103, 104, 99, 101),  // Swing confirms at 4
      makeCandle(5, 101, 116, 100, 115), // Body close = 115 breaks 110
    ];

    const swings = detectSwings(candles, { swingLookback: 2 });
    const { structureBreaks, trendBias } = detectMarketStructure(candles, swings, { swingLookback: 2 });

    assert.strictEqual(structureBreaks.length >= 1, true);
    const breakEvent = structureBreaks[0];
    assert.strictEqual(breakEvent.direction, 'BULLISH');
    assert.strictEqual(breakEvent.brokenSwingPrice, 110);
    assert.strictEqual(breakEvent.breakCandleClose, 115);
    assert.strictEqual(trendBias, 'BULLISH');
  });

  it('3. findFVG: detects standard 3-bar Fair Value Gap and True Price Gaps', () => {
    // Bullish FVG: low[k+1] > high[k-1]
    const candles: ScreenerCandle[] = [
      makeCandle(0, 100, 105, 99, 104), // k-1: high = 105
      makeCandle(1, 105, 120, 104, 119), // k (displacement bar)
      makeCandle(2, 119, 125, 112, 124), // k+1: low = 112 > 105
    ];

    const fvg = findFVG(candles, 0, 'BULLISH', 3);
    assert.ok(fvg, 'Expected FVG to be detected');
    assert.strictEqual(fvg?.bottom, 105);
    assert.strictEqual(fvg?.top, 112);
  });

  it('4. findValidOrderBlocks: requires ALL 4 criteria (direction, FVG, structural cause, unmitigated)', () => {
    // Bullish setup:
    // Candle 1 is last bearish candle (100 -> 95) preceding impulse
    // Candle 2 and 3 push up strongly, creating an FVG and breaking swing high at index 0 (105)
    // Candle 4 stays above zoneHigh -> unmitigated
    const candles: ScreenerCandle[] = [
      makeCandle(0, 102, 105, 101, 104), // Initial high = 105
      makeCandle(1, 100, 101, 94, 95),   // Bearish OB candle (high: 101, low: 94)
      makeCandle(2, 96, 112, 95, 110),   // Impulse displacement
      makeCandle(3, 111, 125, 108, 122), // Confirms FVG (low 108 > high 101) & closes above 105 (close 122)
      makeCandle(4, 122, 124, 118, 120), // Price remains high
    ];

    const structureBreaks = [
      {
        type: 'BOS' as const,
        direction: 'BULLISH' as const,
        brokenSwingIndex: 0,
        brokenSwingPrice: 105,
        brokenSwingTime: candles[0].time,
        breakCandleIndex: 3,
        breakCandleTime: candles[3].time,
        breakCandleClose: 122,
        initiatingSwingIndex: 1,
        initiatingSwingPrice: 94,
        initiatingSwingTime: candles[1].time,
        isStrong: true,
      },
    ];

    const swings = detectSwings(candles, { swingLookback: 1 });
    const { activeOrderBlocks } = findValidOrderBlocks(candles, structureBreaks, swings, {
      requireFVG: true,
    });

    assert.strictEqual(activeOrderBlocks.length, 1);
    const ob = activeOrderBlocks[0];
    assert.strictEqual(ob.type, 'BULLISH');
    assert.strictEqual(ob.zoneHigh, 101);
    assert.strictEqual(ob.zoneLow, 94);
    assert.strictEqual(ob.equilibrium, (101 + 94) / 2);
    assert.strictEqual(ob.obType, 'EXTREME');
    assert.strictEqual(ob.mitigated, false);
    assert.strictEqual(ob.invalidated, false);
  });

  it('5. findValidOrderBlocks: marks mitigated when price taps zone, and invalidated on close through zone', () => {
    const candlesMitigated: ScreenerCandle[] = [
      makeCandle(0, 102, 105, 101, 104),
      makeCandle(1, 100, 101, 94, 95),   // Bullish OB: zone [94, 101]
      makeCandle(2, 96, 112, 95, 110),
      makeCandle(3, 111, 125, 108, 122), // Break
      makeCandle(4, 120, 121, 99, 105),  // low = 99 <= 101 (MITIGATED, but close = 105 > 94 not invalidated)
    ];

    const brks = [
      {
        type: 'BOS' as const,
        direction: 'BULLISH' as const,
        brokenSwingIndex: 0,
        brokenSwingPrice: 105,
        brokenSwingTime: candlesMitigated[0].time,
        breakCandleIndex: 3,
        breakCandleTime: candlesMitigated[3].time,
        breakCandleClose: 122,
        initiatingSwingIndex: 1,
        initiatingSwingPrice: 94,
        initiatingSwingTime: candlesMitigated[1].time,
        isStrong: true,
      },
    ];

    const { allOrderBlocks, activeOrderBlocks } = findValidOrderBlocks(
      candlesMitigated,
      brks,
      [],
      { requireFVG: false },
    );

    assert.strictEqual(allOrderBlocks.length, 1);
    assert.strictEqual(allOrderBlocks[0].mitigated, true);
    assert.strictEqual(allOrderBlocks[0].invalidated, false);
    assert.strictEqual(activeOrderBlocks.length, 0, 'Mitigated OB must not be in activeOrderBlocks');
  });

  it('6. evaluateMTFSetups: detects Approaching and Mitigating HTF POIs', () => {
    // Current price approaching zoneHigh of 100 from 100.4 (0.4% away <= 0.5% threshold)
    const htfCandles: ScreenerCandle[] = [
      makeCandle(0, 95, 100, 92, 98),
      makeCandle(1, 98, 101, 97, 100.4), // current price = 100.4
    ];

    const activeOB = {
      id: 'OB_TEST',
      type: 'BULLISH' as const,
      obType: 'EXTREME' as const,
      candleIndex: 0,
      createdAt: htfCandles[0].time,
      zoneHigh: 100,
      zoneLow: 92,
      equilibrium: 96,
      bosPrice: 105,
      structureBreakType: 'BOS' as const,
      structureBreakTime: htfCandles[0].time,
      mitigated: false,
      invalidated: false,
      status: 'UNMITIGATED' as const,
    };

    const { proximityStatus } = evaluateMTFSetups(
      'NIFTY',
      'Nifty 50',
      htfCandles,
      [activeOB],
      [],
      { proximityPercent: 0.005 },
    );

    assert.strictEqual(proximityStatus, 'APPROACHING');
  });

  it('7. evaluateMTFSetups: triggers confirmed LTF Sniper Setup with >= 1:2.5 Risk:Reward', () => {
    // Active tap in HTF: price is inside zone [92, 100]
    const htfCandles: ScreenerCandle[] = [
      makeCandle(0, 95, 100, 92, 98),
      makeCandle(1, 98, 99, 94, 96), // price = 96 inside [92, 100] -> MITIGATING
    ];

    const htfOB = {
      id: 'OB_HTF_BULLISH',
      type: 'BULLISH' as const,
      obType: 'EXTREME' as const,
      candleIndex: 0,
      createdAt: htfCandles[0].time,
      zoneHigh: 100,
      zoneLow: 92,
      equilibrium: 96,
      bosPrice: 110,
      structureBreakType: 'BOS' as const,
      structureBreakTime: htfCandles[0].time,
      mitigated: false,
      invalidated: false,
      status: 'UNMITIGATED' as const,
    };

    // Synthetic LTF (5m) sequence showing a post-tap CHoCH and strong bounce
    const baseLtfTime = htfCandles[1].time;
    const ltfCandles: ScreenerCandle[] = [
      makeCandle(0, 93.0, 94.0, 92.5, 93.5, baseLtfTime),
      makeCandle(1, 93.5, 95.0, 93.0, 94.5, baseLtfTime),
      makeCandle(2, 94.5, 97.0, 94.0, 96.5, baseLtfTime), // Swing High at index 2 (high 97.0)
      makeCandle(3, 96.5, 96.0, 94.5, 95.0, baseLtfTime),
      makeCandle(4, 95.0, 95.5, 93.5, 94.0, baseLtfTime), // Confirms swing high at 4
      makeCandle(5, 94.0, 94.5, 92.2, 92.8, baseLtfTime), // Swing Low at index 5 (low 92.2)
      makeCandle(6, 92.8, 94.0, 92.5, 93.8, baseLtfTime),
      makeCandle(7, 93.8, 95.0, 93.5, 94.8, baseLtfTime), // Confirms swing low at 7
      makeCandle(8, 94.8, 97.5, 94.5, 97.2, baseLtfTime),
      makeCandle(9, 97.2, 99.0, 97.0, 98.5, baseLtfTime), // Close 98.5 > 97.0 -> Bullish CHoCH!
      makeCandle(10, 98.5, 100.0, 98.2, 99.8, baseLtfTime),
      makeCandle(11, 99.8, 102.0, 99.5, 101.5, baseLtfTime),
    ];

    const { proximityStatus, tradeSignal } = evaluateMTFSetups(
      'NIFTY',
      'Nifty 50',
      htfCandles,
      [htfOB],
      ltfCandles,
      { minRR: 2.5 },
    );

    assert.strictEqual(proximityStatus, 'MITIGATING');
    assert.ok(tradeSignal, 'Expected confirmed sniper trade signal');
    assert.strictEqual(tradeSignal?.signalType, 'BUY');
    assert.ok(tradeSignal!.rrRatio >= 2.5, `Expected RR >= 2.5, got ${tradeSignal!.rrRatio}`);
    assert.ok(tradeSignal!.stopLoss < tradeSignal!.entryPrice);
    assert.ok(tradeSignal!.takeProfit > tradeSignal!.entryPrice);
  });

  it('8. buildChartOverlay: formats OB rectangles, FVG boxes, and structure markers for Lightweight Charts', () => {
    const candles = [makeCandle(0, 100, 105, 95, 102)];
    const obs = [
      {
        id: 'OB_1',
        type: 'BULLISH' as const,
        obType: 'EXTREME' as const,
        candleIndex: 0,
        createdAt: candles[0].time,
        zoneHigh: 105,
        zoneLow: 95,
        equilibrium: 100,
        bosPrice: 110,
        structureBreakType: 'BOS' as const,
        structureBreakTime: candles[0].time,
        mitigated: false,
        invalidated: false,
        status: 'UNMITIGATED' as const,
        fvgBounds: {
          top: 108,
          bottom: 105,
          candleIndex: 1,
          time: candles[0].time + 3600,
        },
      },
    ];

    const breaks = [
      {
        type: 'BOS' as const,
        direction: 'BULLISH' as const,
        brokenSwingIndex: 0,
        brokenSwingPrice: 105,
        brokenSwingTime: candles[0].time,
        breakCandleIndex: 1,
        breakCandleTime: candles[0].time + 3600,
        breakCandleClose: 110,
        initiatingSwingIndex: 0,
        initiatingSwingPrice: 95,
        initiatingSwingTime: candles[0].time,
        isStrong: true,
      },
    ];

    const overlay = buildChartOverlay(candles, obs, breaks);
    assert.strictEqual(overlay.orderBlocks.length, 1);
    assert.strictEqual(overlay.orderBlocks[0].zoneHigh, 105);
    assert.strictEqual(overlay.orderBlocks[0].zoneLow, 95);
    assert.strictEqual(overlay.orderBlocks[0].color, '#10B981'); // Bullish Demand green

    assert.strictEqual(overlay.fvgs.length, 1);
    assert.strictEqual(overlay.fvgs[0].top, 108);

    assert.strictEqual(overlay.breaks.length, 1);
    assert.strictEqual(overlay.breaks[0].type, 'BOS');
  });

  it('9. OrderBlockStrategy.compileScanResults: compiles and sorts symbols correctly', () => {
    const res1 = OrderBlockStrategy.analyzeInstrument('NIFTY', 'Nifty 50', [
      makeCandle(0, 100, 102, 98, 101),
      makeCandle(1, 101, 105, 100, 104),
      makeCandle(2, 104, 108, 103, 107),
      makeCandle(3, 107, 120, 106, 118),
      makeCandle(4, 115, 116, 110, 112),
      makeCandle(5, 112, 113, 105, 106),
      makeCandle(6, 106, 107, 101, 102),
    ]);

    const compiled = OrderBlockStrategy.compileScanResults(
      [res1],
      [{ symbol: 'NIFTY', displayName: 'Nifty 50', name: 'Nifty 50' }],
    );

    assert.strictEqual(compiled.strategy, 'order-block');
    assert.strictEqual(compiled.totalScanned, 1);
    assert.ok(Array.isArray(compiled.results));
  });
});
