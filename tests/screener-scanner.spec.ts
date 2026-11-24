import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  scan5mCandles,
  calculateBacktestSummary,
  calculateSlBuffer,
  isEodCandle,
  formatIstTime,
} from '../src/screener/screener-scanner';
import { CandleData } from '../src/yahoo/yahoo.service';

describe('ScreenerScanner (Deterministic 5m State Machine)', () => {
  it('correctly calculates dynamic SL buffer for indices and equities', () => {
    // Index price 25000 -> default 3 points
    assert.strictEqual(calculateSlBuffer(25000, 3), 3);
    // Equity price 2500 -> 0.05% = 1.25 points
    assert.strictEqual(calculateSlBuffer(2500, 3), 1.25);
    // Low-price equity 200 -> 0.05% = 0.1 points
    assert.strictEqual(calculateSlBuffer(200, 3), 0.1);
  });

  it('identifies 15:25 IST EOD candles accurately', () => {
    // 15:25 IST is 09:55 UTC.
    // 2026-11-20 09:55:00 UTC = 1795168500
    const eodUtcDate = new Date('2026-11-20T09:55:00Z');
    const eodTimestamp = Math.floor(eodUtcDate.getTime() / 1000);
    assert.strictEqual(isEodCandle(eodTimestamp), true);

    const midDayUtcDate = new Date('2026-11-20T06:00:00Z'); // 11:30 IST
    const midDayTimestamp = Math.floor(midDayUtcDate.getTime() / 1000);
    assert.strictEqual(isEodCandle(midDayTimestamp), false);
  });

  it('detects a complete WIN signal with Swing Low -> Sweep -> Base -> Impulse -> Retest -> Target Hit', () => {
    // Generate synthetic 5m candles
    const baseTime = 1795147500; // 03:45 UTC = 09:15 IST
    const candles: CandleData[] = [];

    // 1. Initial drift downwards towards a swing low
    // Bars 0 to 20: Prices around 25100 dropping to 25000 at bar 20
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: baseTime + i * 300,
        open: 25100 - i * 4,
        high: 25105 - i * 4,
        low: 25095 - i * 4,
        close: 25098 - i * 4,
        volume: 1000,
      });
    }

    // Bar 20: Prominent Swing Low at 25000
    candles.push({
      time: baseTime + 20 * 300,
      open: 25020,
      high: 25030,
      low: 25000, // Marked LOW
      close: 25010,
      volume: 2500,
    });

    // Bars 21 to 28: Price bounces back up to 25050 (unbroken swing low)
    for (let i = 21; i <= 28; i++) {
      candles.push({
        time: baseTime + i * 300,
        open: 25010 + (i - 20) * 5,
        high: 25020 + (i - 20) * 5,
        low: 25008, // Always > 25000
        close: 25018 + (i - 20) * 5,
        volume: 1200,
      });
    }

    // Bar 29: Step B - Liquidity Sweep (breaks below 25000)
    // Low drops to 24985 (sweep_low)
    candles.push({
      time: baseTime + 29 * 300,
      open: 25040,
      high: 25045,
      low: 24985, // SWEEP LOW (< 25000)
      close: 24995,
      volume: 4000,
    });

    // Bar 30: Step C - Consolidation Base candle (holds >= 24985)
    // High = 25015, Low = 24990
    candles.push({
      time: baseTime + 30 * 300,
      open: 24995,
      high: 25015, // Base High = 25015 -> Entry Price
      low: 24990, // >= 24985
      close: 25005,
      volume: 1500,
    });

    // Bar 31: Step D - Bullish Impulse Break & Close
    // Bullish (close > open), breaks and closes above 25015
    candles.push({
      time: baseTime + 31 * 300,
      open: 25006,
      high: 25035, // > 25015
      low: 25002,
      close: 25030, // Closes above 25015!
      volume: 3200,
    });

    // Bar 32: Step F - Retest pullback touches entry_price (25015)
    // Low dips to 25012 <= 25015 (FILLED!)
    candles.push({
      time: baseTime + 32 * 300,
      open: 25028,
      high: 25030,
      low: 25012, // Retest Fill at 25015
      close: 25022,
      volume: 1800,
    });

    // Risk = 25015 - (24985 - 3) = 25015 - 24982 = 33 points
    // Target 2.0 RR = 25015 + 2 * 33 = 25081
    // Bar 33 to 35: Target hit!
    candles.push({
      time: baseTime + 33 * 300,
      open: 25022,
      high: 25050,
      low: 25020,
      close: 25045,
      volume: 2000,
    });
    candles.push({
      time: baseTime + 34 * 300,
      open: 25045,
      high: 25090, // Reaches > 25081 (WIN!)
      low: 25040,
      close: 25085,
      volume: 3500,
    });

    const signals = scan5mCandles(candles, {
      symbol: 'NIFTY 50',
      swingLookback: 10,
      slBuffer: 3,
      targetRr: 2.0,
      maxRetestBars: 10,
    });

    assert.strictEqual(signals.length, 1, 'Should detect exactly 1 setup');
    const s = signals[0];
    assert.strictEqual(s.symbol, 'NIFTY 50');
    assert.strictEqual(s.swingLow, 25000);
    assert.strictEqual(s.sweepLow, 24985);
    assert.strictEqual(s.entryPrice, 25015);
    assert.strictEqual(s.stopLoss, 24982); // 24985 - 3
    assert.strictEqual(s.riskPoints, 33);
    assert.strictEqual(s.targetPrice, 25081); // 25015 + 2 * 33
    assert.strictEqual(s.outcome, 'WIN');
    assert.strictEqual(s.rMultiple, 2.0);
    assert.strictEqual(s.pnlPoints, 66);

    const summary = calculateBacktestSummary(signals);
    assert.strictEqual(summary.totalSignals, 1);
    assert.strictEqual(summary.wins, 1);
    assert.strictEqual(summary.losses, 0);
    assert.strictEqual(summary.winRate, 100);
    assert.strictEqual(summary.netRMultiple, 2.0);
  });

  it('discards setup if stop loss is breached before retest fill', () => {
    const baseTime = 1795147500;
    const candles: CandleData[] = [];

    // Bars 0 to 20
    for (let i = 0; i < 20; i++) {
      candles.push({
        time: baseTime + i * 300,
        open: 25100 - i * 4,
        high: 25105 - i * 4,
        low: 25095 - i * 4,
        close: 25098 - i * 4,
        volume: 1000,
      });
    }

    // Bar 20: Swing Low at 25000
    candles.push({
      time: baseTime + 20 * 300,
      open: 25020,
      high: 25030,
      low: 25000,
      close: 25010,
      volume: 2500,
    });

    // Bars 21 to 28: Unbroken above 25000
    for (let i = 21; i <= 28; i++) {
      candles.push({
        time: baseTime + i * 300,
        open: 25010 + (i - 20) * 5,
        high: 25020 + (i - 20) * 5,
        low: 25005,
        close: 25015 + (i - 20) * 5,
        volume: 1200,
      });
    }

    // Bar 29: Sweep Low to 24980
    candles.push({
      time: baseTime + 29 * 300,
      open: 25040,
      high: 25045,
      low: 24980,
      close: 24990,
      volume: 4000,
    });

    // Bar 30: Base candle (High = 25010, Low = 24985)
    candles.push({
      time: baseTime + 30 * 300,
      open: 24990,
      high: 25010,
      low: 24985,
      close: 25000,
      volume: 1500,
    });

    // Bar 31: Bullish Impulse candle
    candles.push({
      time: baseTime + 31 * 300,
      open: 25002,
      high: 25025,
      low: 25001,
      close: 25020, // Closes above 25010
      volume: 3000,
    });

    // Bar 32: Immediate flash crash below SL (24977) before touching entry (25010)
    // Low drops to 24950, high is only 25005 < 25010
    candles.push({
      time: baseTime + 32 * 300,
      open: 25005,
      high: 25005,
      low: 24950,
      close: 24960,
      volume: 5000,
    });

    const signals = scan5mCandles(candles, {
      symbol: 'NIFTY 50',
      swingLookback: 10,
      slBuffer: 3,
      targetRr: 2.0,
      maxRetestBars: 10,
    });

    assert.strictEqual(signals.length, 0, 'Invalidated setup must be discarded');
  });
});
