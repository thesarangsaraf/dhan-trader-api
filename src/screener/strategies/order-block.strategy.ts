import { CandleData } from '../../yahoo/yahoo.service';
import { ScreenerSettingsDoc } from '../../firestore/firestore.service';
import { ScreenerMatch } from '../models/screener.models';

export class OrderBlockStrategy {
  /**
   * Scans a series of OHLCV candles for Supply & Demand Order Block setups.
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
    const currentCandle = candles[n - 1];
    const cmp = currentCandle.close;

    // 1. Calculate average candle body size over lookback window
    const lookback = Math.min(n - 1, config.obLookbackCandles || 30);
    const startIdx = n - 1 - lookback;

    let totalBody = 0;
    for (let i = startIdx; i < n - 1; i++) {
      totalBody += Math.abs(candles[i].close - candles[i].open);
    }
    const avgBody = totalBody / lookback;
    if (avgBody <= 0) return null;

    const bufferPercent = (config.obProximityBufferPercent || 1.0) / 100;
    const minImpulseBodyPercent = (config.obMinImpulseBodyPercent || 0.8) / 100;
    const impulseMultiplier = config.obImpulseMultiplier || 1.8;

    // We scan backward from most recent impulse candles to find the freshest unmitigated setup
    // Evaluate Bullish Demand Order Block first
    const demandMatch = this.findDemandOrderBlock(
      candles,
      startIdx,
      n,
      cmp,
      avgBody,
      impulseMultiplier,
      minImpulseBodyPercent,
      bufferPercent,
      symbol,
      name,
      timeframe,
    );
    if (demandMatch) {
      return demandMatch;
    }

    // Evaluate Bearish Supply Order Block
    const supplyMatch = this.findSupplyOrderBlock(
      candles,
      startIdx,
      n,
      cmp,
      avgBody,
      impulseMultiplier,
      minImpulseBodyPercent,
      bufferPercent,
      symbol,
      name,
      timeframe,
    );

    return supplyMatch;
  }

  /**
   * Identify Bullish Demand Order Block:
   * 1. Strong upward impulse move.
   * 2. Preceded by last bearish candle (Demand OB).
   * 3. Price has not broken below OB Low (unmitigated).
   * 4. CMP has pulled back to test OB High (or within proximity buffer).
   */
  private static findDemandOrderBlock(
    candles: CandleData[],
    startIdx: number,
    n: number,
    cmp: number,
    avgBody: number,
    impulseMultiplier: number,
    minImpulseBodyPercent: number,
    bufferPercent: number,
    symbol: string,
    name: string,
    timeframe: string,
  ): ScreenerMatch | null {
    // Scan backward for the most recent impulse candle
    for (let i = n - 2; i >= Math.max(startIdx + 2, n - 20); i--) {
      const candle = candles[i];
      const body = candle.close - candle.open;

      // Check upward impulse: strong bullish candle or 2-candle expansion
      const isSingleImpulse =
        body > 0 &&
        body >= impulseMultiplier * avgBody &&
        body / candle.open >= minImpulseBodyPercent;

      const prevCandle = candles[i - 1];
      const prevBody = prevCandle.close - prevCandle.open;
      const isDoubleImpulse =
        !isSingleImpulse &&
        body > 0 &&
        prevBody > 0 &&
        body + prevBody >= impulseMultiplier * 1.5 * avgBody &&
        (body + prevBody) / prevCandle.open >= minImpulseBodyPercent;

      if (!isSingleImpulse && !isDoubleImpulse) {
        continue;
      }

      // Locate the last bearish candle preceding this impulse
      const impulseStartIdx = isDoubleImpulse ? i - 1 : i;
      let obIndex = -1;
      for (let j = impulseStartIdx - 1; j >= Math.max(0, impulseStartIdx - 4); j--) {
        if (candles[j].close < candles[j].open) {
          obIndex = j;
          break;
        }
      }

      // Fallback: If no red candle immediately before, use the lowest candle before impulse
      if (obIndex === -1 && impulseStartIdx > 0) {
        obIndex = impulseStartIdx - 1;
      }

      if (obIndex === -1) continue;

      const obCandle = candles[obIndex];
      const obHigh = obCandle.high;
      const obLow = obCandle.low;

      // Freshness Check: Has price traded below obLow between impulse and current candle?
      let isMitigated = false;
      for (let k = impulseStartIdx + 1; k < n - 1; k++) {
        if (candles[k].low < obLow) {
          isMitigated = true;
          break;
        }
      }

      if (isMitigated) {
        continue; // OB violated / mitigated
      }

      // Retest / Proximity Check:
      // CMP is testing the OB zone: within buffer of obHigh, and above or inside zone
      const minAcceptablePrice = obLow * (1 - bufferPercent * 0.5);
      const maxAcceptablePrice = obHigh * (1 + bufferPercent);

      if (cmp >= minAcceptablePrice && cmp <= maxAcceptablePrice) {
        const entryPrice = Math.round(obHigh * 100) / 100;
        const stopLossPrice = Math.round(obLow * 100) / 100;
        const riskPoints = Math.round(Math.abs(entryPrice - stopLossPrice) * 100) / 100;
        const riskPercent = Math.round((riskPoints / entryPrice) * 10000) / 100;

        return {
          symbol,
          name,
          cmp,
          strategy: 'DEMAND_ORDER_BLOCK',
          strategyLabel: 'Demand OB (Bullish)',
          signalType: 'BUY',
          entryPrice,
          stopLossPrice,
          riskPoints,
          riskPercent,
          timeframe,
          matchedAt: new Date().toISOString(),
          candleTime: obCandle.time,
          details: {
            zoneHigh: obHigh,
            zoneLow: obLow,
            impulseTime: candle.time,
            notes: `Demand zone at ₹${obLow} - ₹${obHigh} formed before upward impulse move`,
          },
        };
      }
    }

    return null;
  }

  /**
   * Identify Bearish Supply Order Block:
   * 1. Strong downward impulse move.
   * 2. Preceded by last bullish candle (Supply OB).
   * 3. Price has not broken above OB High (unmitigated).
   * 4. CMP has rallied up to test OB Low (or within proximity buffer).
   */
  private static findSupplyOrderBlock(
    candles: CandleData[],
    startIdx: number,
    n: number,
    cmp: number,
    avgBody: number,
    impulseMultiplier: number,
    minImpulseBodyPercent: number,
    bufferPercent: number,
    symbol: string,
    name: string,
    timeframe: string,
  ): ScreenerMatch | null {
    for (let i = n - 2; i >= Math.max(startIdx + 2, n - 20); i--) {
      const candle = candles[i];
      const body = candle.open - candle.close; // Bearish body

      const isSingleImpulse =
        body > 0 &&
        body >= impulseMultiplier * avgBody &&
        body / candle.open >= minImpulseBodyPercent;

      const prevCandle = candles[i - 1];
      const prevBody = prevCandle.open - prevCandle.close;
      const isDoubleImpulse =
        !isSingleImpulse &&
        body > 0 &&
        prevBody > 0 &&
        body + prevBody >= impulseMultiplier * 1.5 * avgBody &&
        (body + prevBody) / prevCandle.open >= minImpulseBodyPercent;

      if (!isSingleImpulse && !isDoubleImpulse) {
        continue;
      }

      // Locate the last bullish candle preceding this impulse
      const impulseStartIdx = isDoubleImpulse ? i - 1 : i;
      let obIndex = -1;
      for (let j = impulseStartIdx - 1; j >= Math.max(0, impulseStartIdx - 4); j--) {
        if (candles[j].close > candles[j].open) {
          obIndex = j;
          break;
        }
      }

      // Fallback: If no green candle immediately before, use the highest candle before impulse
      if (obIndex === -1 && impulseStartIdx > 0) {
        obIndex = impulseStartIdx - 1;
      }

      if (obIndex === -1) continue;

      const obCandle = candles[obIndex];
      const obHigh = obCandle.high;
      const obLow = obCandle.low;

      // Freshness Check: Has price traded above obHigh between impulse and current candle?
      let isMitigated = false;
      for (let k = impulseStartIdx + 1; k < n - 1; k++) {
        if (candles[k].high > obHigh) {
          isMitigated = true;
          break;
        }
      }

      if (isMitigated) {
        continue; // Supply zone violated / mitigated
      }

      // Retest / Proximity Check:
      // CMP is testing the OB zone: within buffer of obLow, and below or inside zone
      const minAcceptablePrice = obLow * (1 - bufferPercent);
      const maxAcceptablePrice = obHigh * (1 + bufferPercent * 0.5);

      if (cmp >= minAcceptablePrice && cmp <= maxAcceptablePrice) {
        const entryPrice = Math.round(obLow * 100) / 100;
        const stopLossPrice = Math.round(obHigh * 100) / 100;
        const riskPoints = Math.round(Math.abs(stopLossPrice - entryPrice) * 100) / 100;
        const riskPercent = Math.round((riskPoints / entryPrice) * 10000) / 100;

        return {
          symbol,
          name,
          cmp,
          strategy: 'SUPPLY_ORDER_BLOCK',
          strategyLabel: 'Supply OB (Bearish)',
          signalType: 'SELL',
          entryPrice,
          stopLossPrice,
          riskPoints,
          riskPercent,
          timeframe,
          matchedAt: new Date().toISOString(),
          candleTime: obCandle.time,
          details: {
            zoneHigh: obHigh,
            zoneLow: obLow,
            impulseTime: candle.time,
            notes: `Supply zone at ₹${obLow} - ₹${obHigh} formed before downward impulse move`,
          },
        };
      }
    }

    return null;
  }
}
