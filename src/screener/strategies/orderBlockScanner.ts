import {
  FvgBounds,
  OrderBlock,
  OrderBlockClassification,
  OrderBlockConfirmationType,
  OrderBlockTradeSignal,
  OrderBlockType,
  ScreenerCandle,
  StructureBreak,
  StructureBreakType,
  SwingPoint,
  SwingType,
  TrendBias,
} from '../models/screener.models';

export interface ScannerEngineOptions {
  swingLookback?: number; // default 5 bars left/right
  requireFVG?: boolean; // default true
  minImpulseATRMultiplier?: number; // default 1.0 (or 0 for disabled)
  entryMode?: 'LIMIT_TAP' | 'LTF_CHOCH'; // default 'LTF_CHOCH'
  minRR?: number; // default 2.5
  proximityPercent?: number; // default 0.005 (0.5%)
  bufferPercent?: number; // default 0.001 (0.1% beyond distal edge)
}

/**
 * 1. DETERMINISTIC SWING DETECTION (Fractal Pivot Highs and Lows)
 * - Configurable swingLookback (default 5 bars left / 5 bars right).
 * - A pivot at candle j is confirmed ONLY once candle (j + swingLookback) has closed.
 * - Zero lookahead bias: confirmedAtIndex = j + swingLookback.
 */
export function detectSwings(
  candles: ScreenerCandle[],
  options: ScannerEngineOptions = {},
): SwingPoint[] {
  const lookback = Math.max(2, Math.floor(options.swingLookback ?? 5));
  const swings: SwingPoint[] = [];

  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) {
    return swings;
  }

  let lastHighPrice: number | null = null;
  let lastLowPrice: number | null = null;

  for (let j = lookback; j < candles.length - lookback; j++) {
    const cur = candles[j];
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= lookback; k++) {
      if (candles[j - k].high >= cur.high || candles[j + k].high > cur.high) {
        isHigh = false;
      }
      if (candles[j - k].low <= cur.low || candles[j + k].low < cur.low) {
        isLow = false;
      }
      if (!isHigh && !isLow) break;
    }

    const confirmedAtIndex = j + lookback;
    const confirmedAtTime = candles[confirmedAtIndex]?.time ?? cur.time;

    if (isHigh) {
      const classification =
        lastHighPrice === null ? 'HH' : cur.high > lastHighPrice ? 'HH' : 'LH';
      lastHighPrice = cur.high;

      swings.push({
        index: j,
        time: cur.time,
        price: cur.high,
        type: 'HIGH',
        classification,
        confirmedAtIndex,
        confirmedAtTime,
        broken: false,
      });
    }

    if (isLow) {
      const classification =
        lastLowPrice === null ? 'LL' : cur.low < lastLowPrice ? 'LL' : 'HL';
      lastLowPrice = cur.low;

      swings.push({
        index: j,
        time: cur.time,
        price: cur.low,
        type: 'LOW',
        classification,
        confirmedAtIndex,
        confirmedAtTime,
        broken: false,
      });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

/**
 * 2. MARKET STRUCTURE DETECTION (BoS & CHoCH)
 * - Break of Structure (BoS): continuation break of recent confirmed swing point in current trend.
 * - Change of Character (CHoCH): reversal break of last Lower High (downtrend) or Higher Low (uptrend).
 * - Body Close rule: confirmed strictly when candle.close breaks the swing price.
 * - Initiating swing is Strong (protected); broken swing is Weak (target).
 */
export function detectMarketStructure(
  candles: ScreenerCandle[],
  swings: SwingPoint[],
  options: ScannerEngineOptions = {},
): { structureBreaks: StructureBreak[]; trendBias: TrendBias } {
  const structureBreaks: StructureBreak[] = [];
  let trendBias: TrendBias = 'NEUTRAL';

  if (!candles || candles.length === 0 || !swings || swings.length === 0) {
    return { structureBreaks, trendBias };
  }

  // Map to track broken state of swings so we do not re-break the same swing repeatedly
  const brokenSwings = new Set<number>();

  for (let c = 0; c < candles.length; c++) {
    const candle = candles[c];

    // Swings confirmed at or before candle c
    const confirmedSwings = swings.filter((s) => s.confirmedAtIndex <= c && !brokenSwings.has(s.index));
    const confirmedHighs = confirmedSwings.filter((s) => s.type === 'HIGH');
    const confirmedLows = confirmedSwings.filter((s) => s.type === 'LOW');

    const lastConfirmedHigh = confirmedHighs.length > 0 ? confirmedHighs[confirmedHighs.length - 1] : null;
    const lastConfirmedLow = confirmedLows.length > 0 ? confirmedLows[confirmedLows.length - 1] : null;

    // Check for Bullish Breaks (candle body close above swing high)
    if (lastConfirmedHigh && candle.close > lastConfirmedHigh.price) {
      const isReversal = trendBias === 'BEARISH' || (lastConfirmedHigh.classification === 'LH' && trendBias !== 'BULLISH');
      const breakType: StructureBreakType = isReversal ? 'CHOCH' : 'BOS';

      // Initiating swing low: find the lowest confirmed swing low between the swing high and this break
      const initiatingLow = confirmedLows
        .filter((l) => l.index >= lastConfirmedHigh.index && l.index <= c)
        .sort((a, b) => a.price - b.price)[0] ||
        confirmedLows.slice(-1)[0] ||
        { index: Math.max(0, lastConfirmedHigh.index - 1), price: candle.low, time: candle.time };

      brokenSwings.add(lastConfirmedHigh.index);
      trendBias = 'BULLISH';

      structureBreaks.push({
        type: breakType,
        direction: 'BULLISH',
        brokenSwingIndex: lastConfirmedHigh.index,
        brokenSwingPrice: lastConfirmedHigh.price,
        brokenSwingTime: lastConfirmedHigh.time,
        breakCandleIndex: c,
        breakCandleTime: candle.time,
        breakCandleClose: candle.close,
        initiatingSwingIndex: initiatingLow.index,
        initiatingSwingPrice: initiatingLow.price,
        initiatingSwingTime: initiatingLow.time,
        isStrong: true,
      });
      continue;
    }

    // Check for Bearish Breaks (candle body close below swing low)
    if (lastConfirmedLow && candle.close < lastConfirmedLow.price) {
      const isReversal = trendBias === 'BULLISH' || (lastConfirmedLow.classification === 'HL' && trendBias !== 'BEARISH');
      const breakType: StructureBreakType = isReversal ? 'CHOCH' : 'BOS';

      // Initiating swing high: find the highest confirmed swing high between the swing low and this break
      const initiatingHigh = confirmedHighs
        .filter((h) => h.index >= lastConfirmedLow.index && h.index <= c)
        .sort((a, b) => b.price - a.price)[0] ||
        confirmedHighs.slice(-1)[0] ||
        { index: Math.max(0, lastConfirmedLow.index - 1), price: candle.high, time: candle.time };

      brokenSwings.add(lastConfirmedLow.index);
      trendBias = 'BEARISH';

      structureBreaks.push({
        type: breakType,
        direction: 'BEARISH',
        brokenSwingIndex: lastConfirmedLow.index,
        brokenSwingPrice: lastConfirmedLow.price,
        brokenSwingTime: lastConfirmedLow.time,
        breakCandleIndex: c,
        breakCandleTime: candle.time,
        breakCandleClose: candle.close,
        initiatingSwingIndex: initiatingHigh.index,
        initiatingSwingPrice: initiatingHigh.price,
        initiatingSwingTime: initiatingHigh.time,
        isStrong: true,
      });
    }
  }

  // Update swings with broken status
  for (const s of swings) {
    if (brokenSwings.has(s.index)) {
      s.broken = true;
    }
  }

  return { structureBreaks, trendBias };
}

/**
 * Helper to detect Fair Value Gap (FVG) or True Price Gap leaving candle originIndex.
 */
export function findFVG(
  candles: ScreenerCandle[],
  originIndex: number,
  type: OrderBlockType,
  maxSearchBars = 3,
): FvgBounds | undefined {
  const start = originIndex + 1;
  const end = Math.min(candles.length - 1, originIndex + maxSearchBars + 1);

  for (let k = start; k <= end; k++) {
    if (type === 'BULLISH') {
      // 1. Standard Bullish FVG (gap between wick before displacement k-1 and wick after displacement k+1)
      if (k + 1 < candles.length && candles[k + 1].low > candles[k - 1].high) {
        return {
          bottom: candles[k - 1].high,
          top: candles[k + 1].low,
          candleIndex: k,
          time: candles[k].time,
          isGap: false,
        };
      }
      // 2. True Gap Up (open/low of candle k is higher than high of k-1)
      if (candles[k].low > candles[k - 1].high) {
        return {
          bottom: candles[k - 1].high,
          top: candles[k].low,
          candleIndex: k,
          time: candles[k].time,
          isGap: true,
        };
      }
    } else {
      // 1. Standard Bearish FVG (gap between low of k-1 and high of k+1)
      if (k + 1 < candles.length && candles[k + 1].high < candles[k - 1].low) {
        return {
          top: candles[k - 1].low,
          bottom: candles[k + 1].high,
          candleIndex: k,
          time: candles[k].time,
          isGap: false,
        };
      }
      // 2. True Gap Down (open/high of candle k is lower than low of k-1)
      if (candles[k].high < candles[k - 1].low) {
        return {
          top: candles[k - 1].low,
          bottom: candles[k].high,
          candleIndex: k,
          time: candles[k].time,
          isGap: true,
        };
      }
    }
  }

  return undefined;
}

/**
 * 3. IDENTIFY VALID ORDER BLOCKS (ALL 4 CRITERIA REQUIRED)
 * 1. Candle Direction (Bullish: last bearish candle; Bearish: last bullish candle; fallback: smallest body).
 * 2. Imbalance / FVG presence in next 1-3 bars.
 * 3. Structural cause (directly produced confirmed BoS or CHoCH).
 * 4. Unmitigated status (low <= zoneHigh for Bullish; high >= zoneLow for Bearish).
 * Also tags EXTREME vs DECISIONAL.
 */
export function findValidOrderBlocks(
  candles: ScreenerCandle[],
  structureBreaks: StructureBreak[],
  swings: SwingPoint[],
  options: ScannerEngineOptions = {},
): { activeOrderBlocks: OrderBlock[]; allOrderBlocks: OrderBlock[] } {
  const requireFVG = options.requireFVG ?? true;
  const allOrderBlocks: OrderBlock[] = [];
  const seenZones = new Set<string>();

  for (const brk of structureBreaks) {
    const isBullish = brk.direction === 'BULLISH';
    const type: OrderBlockType = isBullish ? 'BULLISH' : 'BEARISH';
    const originStartIndex = Math.max(0, Math.min(brk.initiatingSwingIndex, brk.breakCandleIndex - 1));
    const originEndIndex = Math.max(originStartIndex, brk.breakCandleIndex - 1);

    // 1. Locate the Extreme Order Block (Origin of the impulse leg)
    let extremeCandleIndex = originStartIndex;
    let foundExtremeDirectionCandle = false;

    // Scan near the initiating swing for the directional base candle
    const searchEnd = Math.min(originEndIndex, originStartIndex + 3);
    for (let i = originStartIndex; i <= searchEnd; i++) {
      const c = candles[i];
      if (isBullish && c.close < c.open) {
        // Last bearish candle before bullish move
        extremeCandleIndex = i;
        foundExtremeDirectionCandle = true;
      } else if (!isBullish && c.close > c.open) {
        // Last bullish candle before bearish move
        extremeCandleIndex = i;
        foundExtremeDirectionCandle = true;
      }
    }

    // Fallback: If move started from doji/neutral candles, pick smallest body
    if (!foundExtremeDirectionCandle) {
      let minBody = Infinity;
      for (let i = originStartIndex; i <= searchEnd; i++) {
        const body = Math.abs(candles[i].close - candles[i].open);
        if (body < minBody) {
          minBody = body;
          extremeCandleIndex = i;
        }
      }
    }

    const extremeCandle = candles[extremeCandleIndex];
    if (extremeCandle) {
      const fvg = findFVG(candles, extremeCandleIndex, type, 3);
      if (!requireFVG || fvg) {
        const zoneHigh = extremeCandle.high;
        const zoneLow = extremeCandle.low;
        const equilibrium = Math.round(((zoneHigh + zoneLow) / 2) * 100) / 100;
        const key = `${type}_${Math.round(zoneLow)}_${Math.round(zoneHigh)}`;

        if (!seenZones.has(key)) {
          seenZones.add(key);
          const ob: OrderBlock = {
            id: `OB_${type}_EXTREME_${extremeCandle.time}`,
            type,
            obType: 'EXTREME',
            candleIndex: extremeCandleIndex,
            createdAt: extremeCandle.time,
            zoneHigh,
            zoneLow,
            equilibrium,
            fvgBounds: fvg,
            bosPrice: brk.brokenSwingPrice,
            structureBreakType: brk.type,
            structureBreakTime: brk.breakCandleTime,
            mitigated: false,
            invalidated: false,
            status: 'UNMITIGATED',
          };

          checkOrderBlockMitigation(candles, ob, extremeCandleIndex);
          allOrderBlocks.push(ob);
        }
      }
    }

    // 2. Locate Decisional Order Block (Consolidation/base candle formed right before the break level)
    if (originEndIndex - originStartIndex >= 3) {
      let decisionalCandleIndex = -1;
      const decStart = Math.max(originStartIndex + 2, originEndIndex - 3);

      for (let i = decStart; i <= originEndIndex; i++) {
        if (i === extremeCandleIndex) continue;
        const c = candles[i];
        if (isBullish && c.close < c.open) {
          decisionalCandleIndex = i;
        } else if (!isBullish && c.close > c.open) {
          decisionalCandleIndex = i;
        }
      }

      if (decisionalCandleIndex > 0 && decisionalCandleIndex !== extremeCandleIndex) {
        const decCandle = candles[decisionalCandleIndex];
        const fvg = findFVG(candles, decisionalCandleIndex, type, 3);
        if (!requireFVG || fvg) {
          const zoneHigh = decCandle.high;
          const zoneLow = decCandle.low;
          const equilibrium = Math.round(((zoneHigh + zoneLow) / 2) * 100) / 100;
          const key = `${type}_${Math.round(zoneLow)}_${Math.round(zoneHigh)}`;

          if (!seenZones.has(key)) {
            seenZones.add(key);
            const ob: OrderBlock = {
              id: `OB_${type}_DECISIONAL_${decCandle.time}`,
              type,
              obType: 'DECISIONAL',
              candleIndex: decisionalCandleIndex,
              createdAt: decCandle.time,
              zoneHigh,
              zoneLow,
              equilibrium,
              fvgBounds: fvg,
              bosPrice: brk.brokenSwingPrice,
              structureBreakType: brk.type,
              structureBreakTime: brk.breakCandleTime,
              mitigated: false,
              invalidated: false,
              status: 'UNMITIGATED',
            };

            checkOrderBlockMitigation(candles, ob, decisionalCandleIndex);
            allOrderBlocks.push(ob);
          }
        }
      }
    }
  }

  // Active unmitigated order blocks only
  const activeOrderBlocks = allOrderBlocks.filter((ob) => !ob.mitigated && !ob.invalidated);

  return { activeOrderBlocks, allOrderBlocks };
}

/**
 * Scan subsequent candles to evaluate mitigation and invalidation.
 */
function checkOrderBlockMitigation(
  candles: ScreenerCandle[],
  ob: OrderBlock,
  fromIndex: number,
): void {
  // Check candles after the OB was formed (from fromIndex + 2 to the latest bar)
  for (let k = fromIndex + 2; k < candles.length; k++) {
    const c = candles[k];

    if (ob.type === 'BULLISH') {
      // Invalidation: candle body closes below zoneLow
      if (c.close < ob.zoneLow) {
        ob.invalidated = true;
        ob.invalidatedAt = c.time;
        ob.status = 'INVALIDATED';
        break;
      }
      // Mitigation: wick taps into zoneHigh or lower
      if (c.low <= ob.zoneHigh) {
        ob.mitigated = true;
        ob.mitigatedAt = c.time;
        ob.status = 'MITIGATED';
      }
    } else {
      // Bearish
      // Invalidation: candle body closes above zoneHigh
      if (c.close > ob.zoneHigh) {
        ob.invalidated = true;
        ob.invalidatedAt = c.time;
        ob.status = 'INVALIDATED';
        break;
      }
      // Mitigation: wick taps into zoneLow or higher
      if (c.high >= ob.zoneLow) {
        ob.mitigated = true;
        ob.mitigatedAt = c.time;
        ob.status = 'MITIGATED';
      }
    }
  }
}

/**
 * 4. MULTI-TIMEFRAME (MTF) EVALUATION & SNIPER SETUP
 * Mode 1: HTF POI Proximity & Tap Scanner (1H/4H).
 * Mode 2: LTF Confirmation Sniper Setup (1H/4H POI + 5m/15m CHoCH).
 */
export function evaluateMTFSetups(
  symbol: string,
  displayName: string,
  htfCandles: ScreenerCandle[],
  activeHtfOBs: OrderBlock[],
  ltfCandles: ScreenerCandle[] = [],
  options: ScannerEngineOptions = {},
): {
  proximityStatus: 'APPROACHING' | 'MITIGATING' | 'NONE';
  tradeSignal?: OrderBlockTradeSignal;
  activeOrderBlocks: OrderBlock[];
} {
  const proximityThreshold = options.proximityPercent ?? 0.005; // 0.5%
  const minRR = options.minRR ?? 2.5;
  const entryMode = options.entryMode ?? 'LTF_CHOCH';
  const bufferPercent = options.bufferPercent ?? 0.001; // 0.1% buffer beyond distal wick

  if (!htfCandles || htfCandles.length === 0 || activeHtfOBs.length === 0) {
    return { proximityStatus: 'NONE', activeOrderBlocks: activeHtfOBs };
  }

  const currentPrice = htfCandles[htfCandles.length - 1].close;
  let overallProximity: 'APPROACHING' | 'MITIGATING' | 'NONE' = 'NONE';
  let bestSignal: OrderBlockTradeSignal | undefined;

  for (const ob of activeHtfOBs) {
    let isMitigating = false;
    let isApproaching = false;
    let distPercent = 0;

    if (ob.type === 'BULLISH') {
      if (currentPrice >= ob.zoneLow && currentPrice <= ob.zoneHigh) {
        isMitigating = true;
        ob.status = 'MITIGATING';
      } else if (currentPrice > ob.zoneHigh) {
        distPercent = (currentPrice - ob.zoneHigh) / currentPrice;
        if (distPercent <= proximityThreshold) {
          isApproaching = true;
          ob.status = 'APPROACHING';
        }
      }
    } else {
      // BEARISH
      if (currentPrice <= ob.zoneHigh && currentPrice >= ob.zoneLow) {
        isMitigating = true;
        ob.status = 'MITIGATING';
      } else if (currentPrice < ob.zoneLow) {
        distPercent = (ob.zoneLow - currentPrice) / currentPrice;
        if (distPercent <= proximityThreshold) {
          isApproaching = true;
          ob.status = 'APPROACHING';
        }
      }
    }

    ob.proximityPercent = Math.round(distPercent * 10000) / 100;

    if (isMitigating) {
      overallProximity = 'MITIGATING';
    } else if (isApproaching && overallProximity !== 'MITIGATING') {
      overallProximity = 'APPROACHING';
    }

    // If active tap/mitigating and LTF candles provided, check for LTF Confirmation Sniper Setup
    if (isMitigating && ltfCandles.length >= 10 && !bestSignal) {
      // Find tap time in LTF (when LTF price entered [zoneLow, zoneHigh])
      const tapCandle = ltfCandles.find((c) =>
        ob.type === 'BULLISH'
          ? c.low <= ob.zoneHigh && c.close >= ob.zoneLow
          : c.high >= ob.zoneLow && c.close <= ob.zoneHigh,
      );

      const tapTimestamp = tapCandle ? tapCandle.time : ob.createdAt;
      const postTapLTFCandles = ltfCandles.filter((c) => c.time >= tapTimestamp);

      if (postTapLTFCandles.length >= 6) {
        // Run swing & structure detection on LTF candles
        const ltfLookback = Math.max(2, Math.min(options.swingLookback ?? 3, Math.floor(postTapLTFCandles.length / 5)));
        const ltfSwings = detectSwings(postTapLTFCandles, { swingLookback: ltfLookback });
        const { structureBreaks: ltfBreaks } = detectMarketStructure(postTapLTFCandles, ltfSwings);

        // Look for LTF CHoCH in the HTF OB direction
        const matchingLTFBreak = ltfBreaks.find(
          (b) => b.direction === ob.type && (b.type === 'CHOCH' || b.type === 'BOS'),
        );

        if (matchingLTFBreak) {
          const { activeOrderBlocks: ltfOBs } = findValidOrderBlocks(
            postTapLTFCandles,
            [matchingLTFBreak],
            ltfSwings,
            { requireFVG: false },
          );

          const ltfOB = ltfOBs[0];
          const isBuy = ob.type === 'BULLISH';

          // Risk Management Levels
          let entryPrice = isBuy
            ? (ltfOB?.zoneHigh ?? ob.equilibrium)
            : (ltfOB?.zoneLow ?? ob.equilibrium);

          if (entryMode === 'LIMIT_TAP') {
            entryPrice = ob.equilibrium;
          }

          const buffer = entryPrice * bufferPercent;
          const stopLoss = isBuy
            ? Math.round((Math.min(ltfOB?.zoneLow ?? ob.zoneLow, ob.zoneLow) - buffer) * 100) / 100
            : Math.round((Math.max(ltfOB?.zoneHigh ?? ob.zoneHigh, ob.zoneHigh) + buffer) * 100) / 100;

          // Target opposing weak high/low or opposing HTF OB
          const riskDistance = Math.abs(entryPrice - stopLoss);
          let takeProfit = isBuy
            ? matchingLTFBreak.brokenSwingPrice + riskDistance * 2
            : matchingLTFBreak.brokenSwingPrice - riskDistance * 2;

          // Ensure minimum 1:2.5 RR filter
          const potentialRR = Math.abs(takeProfit - entryPrice) / Math.max(0.01, riskDistance);
          if (potentialRR < minRR) {
            takeProfit = isBuy
              ? Math.round((entryPrice + riskDistance * minRR) * 100) / 100
              : Math.round((entryPrice - riskDistance * minRR) * 100) / 100;
          }

          const finalRR = Math.round((Math.abs(takeProfit - entryPrice) / Math.max(0.01, riskDistance)) * 10) / 10;

          if (finalRR >= minRR) {
            bestSignal = {
              id: `${symbol}_${matchingLTFBreak.breakCandleTime}_${isBuy ? 'BUY' : 'SELL'}`,
              symbol,
              displayName,
              signalType: isBuy ? 'BUY' : 'SELL',
              confirmationType: entryMode as OrderBlockConfirmationType,
              entryPrice: Math.round(entryPrice * 100) / 100,
              stopLoss,
              takeProfit,
              rrRatio: finalRR,
              htfTimeframe: '1h',
              ltfTimeframe: '5m',
              htfOrderBlock: ob,
              ltfOrderBlock: ltfOB,
              triggerTimestamp: matchingLTFBreak.breakCandleTime,
              triggerPrice: matchingLTFBreak.breakCandleClose,
              sessionDate: new Date(matchingLTFBreak.breakCandleTime * 1000).toISOString().slice(0, 10),
            };
          }
        }
      }
    }
  }

  return {
    proximityStatus: overallProximity,
    tradeSignal: bestSignal,
    activeOrderBlocks: activeHtfOBs,
  };
}

/**
 * 5. CHART OVERLAY PAYLOAD GENERATOR (TradingView Lightweight Charts)
 */
export function buildChartOverlay(
  candles: ScreenerCandle[],
  orderBlocks: OrderBlock[],
  structureBreaks: StructureBreak[],
  tradeSignal?: OrderBlockTradeSignal,
): {
  orderBlocks: Array<{
    id: string;
    type: OrderBlockType;
    obType: OrderBlockClassification;
    zoneHigh: number;
    zoneLow: number;
    equilibrium: number;
    startTime: number;
    endTime: number;
    color: string;
    status: string;
  }>;
  fvgs: Array<{
    top: number;
    bottom: number;
    startTime: number;
    endTime: number;
    type: OrderBlockType;
  }>;
  breaks: Array<{
    type: StructureBreakType;
    price: number;
    startTime: number;
    endTime: number;
    direction: 'BULLISH' | 'BEARISH';
    label: string;
  }>;
  tradeSignal?: {
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    rrRatio: number;
    signalType: 'BUY' | 'SELL';
  };
} {
  const latestTime = candles.length > 0 ? candles[candles.length - 1].time : Math.floor(Date.now() / 1000);

  const obPayload = orderBlocks.map((ob) => ({
    id: ob.id,
    type: ob.type,
    obType: ob.obType,
    zoneHigh: ob.zoneHigh,
    zoneLow: ob.zoneLow,
    equilibrium: ob.equilibrium,
    startTime: ob.createdAt,
    endTime: ob.mitigatedAt || ob.invalidatedAt || latestTime,
    color: ob.type === 'BULLISH' ? '#10B981' : '#F43F5E',
    status: ob.status,
  }));

  const fvgs = orderBlocks
    .filter((ob) => Boolean(ob.fvgBounds))
    .map((ob) => ({
      top: ob.fvgBounds!.top,
      bottom: ob.fvgBounds!.bottom,
      startTime: ob.fvgBounds!.time,
      endTime: latestTime,
      type: ob.type,
    }));

  const breaks = structureBreaks.map((b) => ({
    type: b.type,
    price: b.brokenSwingPrice,
    startTime: b.brokenSwingTime,
    endTime: b.breakCandleTime,
    direction: b.direction,
    label: `${b.type} (${b.direction === 'BULLISH' ? '+' : '-'})`,
  }));

  const signalPayload = tradeSignal
    ? {
        entryPrice: tradeSignal.entryPrice,
        stopLoss: tradeSignal.stopLoss,
        takeProfit: tradeSignal.takeProfit,
        rrRatio: tradeSignal.rrRatio,
        signalType: tradeSignal.signalType,
      }
    : undefined;

  return {
    orderBlocks: obPayload,
    fvgs,
    breaks,
    tradeSignal: signalPayload,
  };
}
