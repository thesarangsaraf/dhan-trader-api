import { CandleData } from '../../yahoo/yahoo.service';
import { ScreenerSettingsDoc } from '../../firestore/firestore.service';
import { ScreenerMatch } from '../models/screener.models';

export class LiquiditySweepStrategy {
  /**
   * Scans OHLCV candles for Liquidity Sweep Reversals (Buy-side or Sell-side stop runs).
   */
  public static evaluate(
    candles: CandleData[],
    symbol: string,
    name: string,
    timeframe: string,
    config: ScreenerSettingsDoc,
  ): ScreenerMatch | null {
    if (!candles || candles.length < 10) {
      return null;
    }

    const n = candles.length;
    const cmp = candles[n - 1].close;
    const lookback = Math.min(n - 3, config.sweepLookbackCandles || 20);
    const minWickRatio = config.sweepMinWickRatio || 0.4;

    // Check both current candle (n-1) and just-closed candle (n-2) for sweeps
    for (let testIdx = n - 1; testIdx >= n - 2; testIdx--) {
      const sweepCandle = candles[testIdx];
      const totalRange = sweepCandle.high - sweepCandle.low;
      if (totalRange <= 0) continue;

      // 1. Check Bullish Liquidity Sweep (Sell-Side Sweep)
      const bullishMatch = this.checkBullishSweep(
        candles,
        testIdx,
        sweepCandle,
        totalRange,
        lookback,
        minWickRatio,
        cmp,
        symbol,
        name,
        timeframe,
      );
      if (bullishMatch) {
        return bullishMatch;
      }

      // 2. Check Bearish Liquidity Sweep (Buy-Side Sweep)
      const bearishMatch = this.checkBearishSweep(
        candles,
        testIdx,
        sweepCandle,
        totalRange,
        lookback,
        minWickRatio,
        cmp,
        symbol,
        name,
        timeframe,
      );
      if (bearishMatch) {
        return bearishMatch;
      }
    }

    return null;
  }

  /**
   * Bullish Liquidity Sweep:
   * Price breaches below a prior significant swing low, sweeps stops, and closes back above it with strong rejection wick.
   */
  private static checkBullishSweep(
    candles: CandleData[],
    testIdx: number,
    sweepCandle: CandleData,
    totalRange: number,
    lookback: number,
    minWickRatio: number,
    cmp: number,
    symbol: string,
    name: string,
    timeframe: string,
  ): ScreenerMatch | null {
    const lowerWick = Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low;
    const wickRatio = lowerWick / totalRange;

    if (wickRatio < minWickRatio) {
      return null;
    }

    // Look for a prominent swing low in the prior window (excluding the sweep candle itself)
    let bestSwingLow: number | null = null;
    const startIdx = Math.max(0, testIdx - lookback);

    for (let i = testIdx - 2; i >= startIdx; i--) {
      const prevLow = candles[i].low;
      const isLocalLow =
        i > 0 &&
        i < testIdx - 1 &&
        prevLow <= candles[i - 1].low &&
        prevLow <= candles[i + 1].low;

      if (isLocalLow) {
        // Did the sweep candle breach below this swing low, but close back above it?
        if (sweepCandle.low < prevLow && sweepCandle.close > prevLow) {
          bestSwingLow = prevLow;
          break; // Found the swept swing level
        }
      }
    }

    // If no strict 3-candle fractal low matched, check the lowest low in the lookback window
    if (bestSwingLow === null) {
      let lowestLow = Infinity;
      for (let i = testIdx - 2; i >= startIdx; i--) {
        if (candles[i].low < lowestLow) {
          lowestLow = candles[i].low;
        }
      }
      if (lowestLow < Infinity && sweepCandle.low < lowestLow && sweepCandle.close > lowestLow) {
        bestSwingLow = lowestLow;
      }
    }

    if (bestSwingLow !== null) {
      const entryPrice = Math.round(sweepCandle.high * 100) / 100;
      const stopLossPrice = Math.round(sweepCandle.low * 100) / 100;
      const riskPoints = Math.round(Math.abs(entryPrice - stopLossPrice) * 100) / 100;
      const riskPercent = Math.round((riskPoints / entryPrice) * 10000) / 100;

      return {
        symbol,
        name,
        cmp,
        strategy: 'BULLISH_LIQUIDITY_SWEEP',
        strategyLabel: 'Bullish Liquidity Sweep',
        signalType: 'BUY',
        entryPrice,
        stopLossPrice,
        riskPoints,
        riskPercent,
        timeframe,
        matchedAt: new Date().toISOString(),
        candleTime: sweepCandle.time,
        details: {
          swingLevel: bestSwingLow,
          wickPercent: Math.round(wickRatio * 100),
          notes: `Swept sell-side liquidity below ₹${bestSwingLow} with ${Math.round(wickRatio * 100)}% rejection wick`,
        },
      };
    }

    return null;
  }

  /**
   * Bearish Liquidity Sweep:
   * Price breaches above a prior significant swing high, sweeps stops, and closes back below it with strong upper rejection wick.
   */
  private static checkBearishSweep(
    candles: CandleData[],
    testIdx: number,
    sweepCandle: CandleData,
    totalRange: number,
    lookback: number,
    minWickRatio: number,
    cmp: number,
    symbol: string,
    name: string,
    timeframe: string,
  ): ScreenerMatch | null {
    const upperWick = sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
    const wickRatio = upperWick / totalRange;

    if (wickRatio < minWickRatio) {
      return null;
    }

    let bestSwingHigh: number | null = null;
    const startIdx = Math.max(0, testIdx - lookback);

    for (let i = testIdx - 2; i >= startIdx; i--) {
      const prevHigh = candles[i].high;
      const isLocalHigh =
        i > 0 &&
        i < testIdx - 1 &&
        prevHigh >= candles[i - 1].high &&
        prevHigh >= candles[i + 1].high;

      if (isLocalHigh) {
        if (sweepCandle.high > prevHigh && sweepCandle.close < prevHigh) {
          bestSwingHigh = prevHigh;
          break;
        }
      }
    }

    if (bestSwingHigh === null) {
      let highestHigh = -Infinity;
      for (let i = testIdx - 2; i >= startIdx; i--) {
        if (candles[i].high > highestHigh) {
          highestHigh = candles[i].high;
        }
      }
      if (highestHigh > -Infinity && sweepCandle.high > highestHigh && sweepCandle.close < highestHigh) {
        bestSwingHigh = highestHigh;
      }
    }

    if (bestSwingHigh !== null) {
      const entryPrice = Math.round(sweepCandle.low * 100) / 100;
      const stopLossPrice = Math.round(sweepCandle.high * 100) / 100;
      const riskPoints = Math.round(Math.abs(stopLossPrice - entryPrice) * 100) / 100;
      const riskPercent = Math.round((riskPoints / entryPrice) * 10000) / 100;

      return {
        symbol,
        name,
        cmp,
        strategy: 'BEARISH_LIQUIDITY_SWEEP',
        strategyLabel: 'Bearish Liquidity Sweep',
        signalType: 'SELL',
        entryPrice,
        stopLossPrice,
        riskPoints,
        riskPercent,
        timeframe,
        matchedAt: new Date().toISOString(),
        candleTime: sweepCandle.time,
        details: {
          swingLevel: bestSwingHigh,
          wickPercent: Math.round(wickRatio * 100),
          notes: `Swept buy-side liquidity above ₹${bestSwingHigh} with ${Math.round(wickRatio * 100)}% upper rejection wick`,
        },
      };
    }

    return null;
  }
}
