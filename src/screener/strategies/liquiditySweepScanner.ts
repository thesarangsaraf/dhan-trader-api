import {
  LiquidityPool,
  LiquidityPoolStatus,
  LiquidityPoolType,
  LiquiditySide,
  LiquiditySweepChartOverlay,
  LiquiditySweepDirection,
  LiquiditySweepEvent,
  LiquiditySweepScanResponse,
  LiquiditySweepSymbolResult,
  LiquiditySweepTradeSignal,
  ScreenerCandle,
  ScreenerScanMode,
  ScreenerSignalType,
  SweepEntryMode,
  SwingPivot,
} from '../models/screener.models';

export interface LiquiditySweepScannerOptions {
  swingLookback?: number; // default 5 bars left/right
  eqToleranceATR?: number; // default 0.15 ATR multiplier for EQH/EQL clustering
  minSweepDepthATR?: number; // default 0.05 ATR multiplier for wick rejection filter
  maxReclaimBars?: number; // default 2 candles allowed to reclaim after piercing
  includeSessionExtremes?: boolean; // default true (include PDH/PDL pools)
  pdh?: number | null; // Previous Day High
  pdl?: number | null; // Previous Day Low
  entryMode?: SweepEntryMode; // 'RECLAIM_CLOSE' | 'LTF_STRUCTURE_SHIFT' (default 'RECLAIM_CLOSE')
  minRR?: number; // default 2.5
  bufferATRMultiplier?: number; // default 0.1 ATR buffer for Stop Loss
  timeframe?: string; // e.g. '15m', '5m', '1h'
  mode?: ScreenerScanMode; // 'live' | 'historical'
  startDate?: string;
  endDate?: string;
}

/**
 * Compute 14-period Average True Range (ATR) across the candle series.
 */
export function computeATR(candles: ScreenerCandle[], period = 14): number[] {
  if (!candles || candles.length === 0) return [];
  const tr: number[] = new Array(candles.length);
  tr[0] = Math.max(0.01, candles[0].high - candles[0].low);

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const hl = cur.high - cur.low;
    const hpc = Math.abs(cur.high - prev.close);
    const lpc = Math.abs(cur.low - prev.close);
    tr[i] = Math.max(0.01, hl, hpc, lpc);
  }

  const atr: number[] = new Array(candles.length);
  let sum = 0;
  const initialPeriod = Math.min(period, candles.length);

  for (let i = 0; i < initialPeriod; i++) {
    sum += tr[i];
    atr[i] = sum / (i + 1);
  }

  for (let i = initialPeriod; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  return atr;
}

/**
 * Returns latest average true range value.
 */
export function getLatestATR(candles: ScreenerCandle[], period = 14): number {
  const atrs = computeATR(candles, period);
  if (atrs.length === 0) return 1.0;
  return atrs[atrs.length - 1] || 1.0;
}

/**
 * 1. PIVOT DETECTION (detectSwingPivots)
 * Identify confirmed swing pivots using swingLookback (default 5 bars left/right).
 * Zero lookahead bias: confirmedAtIndex = j + lookback.
 */
export function detectSwingPivots(
  candles: ScreenerCandle[],
  options: LiquiditySweepScannerOptions = {},
): SwingPivot[] {
  const lookback = Math.max(2, Math.floor(options.swingLookback ?? 5));
  const pivots: SwingPivot[] = [];

  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) {
    return pivots;
  }

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
      pivots.push({
        index: j,
        time: cur.time,
        price: cur.high,
        type: 'HIGH',
        confirmedAtIndex,
        confirmedAtTime,
      });
    }

    if (isLow) {
      pivots.push({
        index: j,
        time: cur.time,
        price: cur.low,
        type: 'LOW',
        confirmedAtIndex,
        confirmedAtTime,
      });
    }
  }

  return pivots.sort((a, b) => a.index - b.index);
}

/**
 * 2. LIQUIDITY POOL DETECTION (detectLiquidityPools)
 * - Swing High & Swing Low Pools (BSL / SSL).
 * - Equal Highs (EQH) & Equal Lows (EQL) Pools clustered within ATR tolerance:
 *   Math.abs(priceA - priceB) <= atr * eqToleranceATR (default 0.15).
 * - Optional Range / Session Extremes (PDH / PDL).
 */
export function detectLiquidityPools(
  candles: ScreenerCandle[],
  pivots: SwingPivot[],
  options: LiquiditySweepScannerOptions = {},
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  if (!candles || candles.length === 0) return pools;

  const currentATR = getLatestATR(candles, 14);
  const eqTolerance = currentATR * (options.eqToleranceATR ?? 0.15);

  const swingHighs = pivots.filter((p) => p.type === 'HIGH').sort((a, b) => a.index - b.index);
  const swingLows = pivots.filter((p) => p.type === 'LOW').sort((a, b) => a.index - b.index);

  // Cluster Swing Highs into Equal Highs (EQH)
  const usedHighIndices = new Set<number>();
  for (let i = 0; i < swingHighs.length; i++) {
    if (usedHighIndices.has(i)) continue;
    const cluster = [swingHighs[i]];
    usedHighIndices.add(i);

    for (let j = i + 1; j < swingHighs.length; j++) {
      if (usedHighIndices.has(j)) continue;
      const refPrice = cluster[0].price;
      if (Math.abs(swingHighs[j].price - refPrice) <= eqTolerance) {
        cluster.push(swingHighs[j]);
        usedHighIndices.add(j);
      }
    }

    if (cluster.length >= 2) {
      const maxPrice = Math.max(...cluster.map((c) => c.price));
      const firstPivot = cluster[0];
      pools.push({
        id: `EQH_${firstPivot.time}_${Math.round(maxPrice)}`,
        side: 'BSL',
        poolType: 'EQH',
        price: Math.round(maxPrice * 100) / 100,
        startTime: firstPivot.time,
        startIndex: firstPivot.index,
        touchCount: cluster.length,
        status: 'ACTIVE',
      });
    } else {
      const p = cluster[0];
      pools.push({
        id: `BSL_${p.time}_${Math.round(p.price)}`,
        side: 'BSL',
        poolType: 'SWING',
        price: Math.round(p.price * 100) / 100,
        startTime: p.time,
        startIndex: p.index,
        touchCount: 1,
        status: 'ACTIVE',
      });
    }
  }

  // Cluster Swing Lows into Equal Lows (EQL)
  const usedLowIndices = new Set<number>();
  for (let i = 0; i < swingLows.length; i++) {
    if (usedLowIndices.has(i)) continue;
    const cluster = [swingLows[i]];
    usedLowIndices.add(i);

    for (let j = i + 1; j < swingLows.length; j++) {
      if (usedLowIndices.has(j)) continue;
      const refPrice = cluster[0].price;
      if (Math.abs(swingLows[j].price - refPrice) <= eqTolerance) {
        cluster.push(swingLows[j]);
        usedLowIndices.add(j);
      }
    }

    if (cluster.length >= 2) {
      const minPrice = Math.min(...cluster.map((c) => c.price));
      const firstPivot = cluster[0];
      pools.push({
        id: `EQL_${firstPivot.time}_${Math.round(minPrice)}`,
        side: 'SSL',
        poolType: 'EQL',
        price: Math.round(minPrice * 100) / 100,
        startTime: firstPivot.time,
        startIndex: firstPivot.index,
        touchCount: cluster.length,
        status: 'ACTIVE',
      });
    } else {
      const p = cluster[0];
      pools.push({
        id: `SSL_${p.time}_${Math.round(p.price)}`,
        side: 'SSL',
        poolType: 'SWING',
        price: Math.round(p.price * 100) / 100,
        startTime: p.time,
        startIndex: p.index,
        touchCount: 1,
        status: 'ACTIVE',
      });
    }
  }

  // Range / Session Extremes (PDH / PDL)
  if (options.includeSessionExtremes !== false) {
    if (options.pdh != null && Number.isFinite(options.pdh)) {
      pools.push({
        id: `BSL_PDH_${Math.round(options.pdh)}`,
        side: 'BSL',
        poolType: 'PDH',
        price: Math.round(options.pdh * 100) / 100,
        startTime: candles[0]?.time ?? 0,
        startIndex: 0,
        touchCount: 1,
        status: 'ACTIVE',
      });
    }
    if (options.pdl != null && Number.isFinite(options.pdl)) {
      pools.push({
        id: `SSL_PDL_${Math.round(options.pdl)}`,
        side: 'SSL',
        poolType: 'PDL',
        price: Math.round(options.pdl * 100) / 100,
        startTime: candles[0]?.time ?? 0,
        startIndex: 0,
        touchCount: 1,
        status: 'ACTIVE',
      });
    }
  }

  return pools.sort((a, b) => a.startTime - b.startTime);
}

/**
 * 3. SWEEP VS TRUE BREAKOUT FILTER (detectLiquiditySweeps)
 * A valid Liquidity Sweep occurs ONLY when price runs past a liquidity pool to trigger stops
 * and immediately fails/rejects back inside the range:
 * - Bullish Sweep (SSL / EQL / PDL):
 *   low[i] < poolPrice, reclaims close > poolPrice within maxReclaimBars (default 2),
 *   rejection filter (poolPrice - low >= atr * minSweepDepthATR), close in top 50% of candle range,
 *   bullish displacement.
 * - Bearish Sweep (BSL / EQH / PDH):
 *   high[i] > poolPrice, reclaims close < poolPrice within maxReclaimBars (default 2),
 *   rejection filter (high - poolPrice >= atr * minSweepDepthATR), close in bottom 50% of candle range,
 *   bearish displacement.
 * - If price closes beyond poolPrice without reclaiming within maxReclaimBars, status = "BROKEN".
 * - Once valid sweep occurs, status = "SWEPT" (at most 1 signal per pool).
 */
export function detectLiquiditySweeps(
  candles: ScreenerCandle[],
  pools: LiquidityPool[],
  options: LiquiditySweepScannerOptions = {},
): LiquiditySweepEvent[] {
  const sweeps: LiquiditySweepEvent[] = [];
  if (!candles || candles.length === 0 || !pools || pools.length === 0) {
    return sweeps;
  }

  const atrs = computeATR(candles, 14);
  const maxReclaimBars = Math.max(0, options.maxReclaimBars ?? 2);
  const minSweepDepthATR = options.minSweepDepthATR ?? 0.05;

  for (const pool of pools) {
    if (pool.status !== 'ACTIVE') continue;

    const startIdx = Math.max(0, (pool.startIndex ?? 0) + 1);
    let isEvaluated = false;

    for (let i = startIdx; i < candles.length && !isEvaluated; i++) {
      const candle = candles[i];
      const atr = atrs[i] || atrs[atrs.length - 1] || 1.0;
      const minRequiredDepth = atr * minSweepDepthATR;

      // -----------------------------------------------------------
      // BULLISH SWEEP: SSL / EQL / PDL
      // -----------------------------------------------------------
      if (pool.side === 'SSL') {
        if (candle.low < pool.price) {
          // Check if candle pierces below
          const maxLook = Math.min(candles.length - 1, i + maxReclaimBars);
          let reclaimIndex = -1;
          let sweepLow = candle.low;

          for (let r = i; r <= maxLook; r++) {
            if (candles[r].low < sweepLow) {
              sweepLow = candles[r].low;
            }
            if (candles[r].close > pool.price) {
              reclaimIndex = r;
              break;
            }
          }

          if (reclaimIndex === -1) {
            // Sustained close below without reclaim: broken pool
            const allClosedBelow = candles
              .slice(i, maxLook + 1)
              .some((c) => c.close < pool.price);
            if (allClosedBelow && maxLook === i + maxReclaimBars) {
              pool.status = 'BROKEN';
              pool.brokenTime = candle.time;
              isEvaluated = true;
            }
          } else {
            // Reclaimed within maxReclaimBars!
            const reclaimCandle = candles[reclaimIndex];
            const sweepDepth = pool.price - sweepLow;
            const candleRange = reclaimCandle.high - reclaimCandle.low;

            // Rejection & Absorption Filter:
            // 1. Lower wick beyond poolPrice shows clear rejection >= minSweepDepthATR
            // 2. Upper reclaim close in top 50% of candle range
            // 3. Bullish displacement away from the low
            const hasDepth = sweepDepth >= minRequiredDepth - 0.001;
            const inTop50 =
              candleRange > 0
                ? (reclaimCandle.close - reclaimCandle.low) / candleRange >= 0.45
                : true;
            const hasBullishDisplacement =
              reclaimCandle.close >= reclaimCandle.open ||
              reclaimCandle.close > pool.price;

            if (hasDepth && inTop50 && hasBullishDisplacement) {
              pool.status = 'SWEPT';
              pool.sweptTime = reclaimCandle.time;
              sweeps.push({
                poolId: pool.id,
                direction: 'BULLISH',
                poolType: pool.poolType,
                sweptPrice: pool.price,
                sweepWickExtreme: Math.round(sweepLow * 100) / 100,
                sweepTime: candle.time,
                reclaimTime: reclaimCandle.time,
                reclaimClose: Math.round(reclaimCandle.close * 100) / 100,
                reclaimCandleIndex: reclaimIndex,
              });
              isEvaluated = true;
            } else if (reclaimIndex === maxLook) {
              pool.status = 'BROKEN';
              pool.brokenTime = candle.time;
              isEvaluated = true;
            }
          }
        }
      }

      // -----------------------------------------------------------
      // BEARISH SWEEP: BSL / EQH / PDH
      // -----------------------------------------------------------
      if (pool.side === 'BSL') {
        if (candle.high > pool.price) {
          const maxLook = Math.min(candles.length - 1, i + maxReclaimBars);
          let reclaimIndex = -1;
          let sweepHigh = candle.high;

          for (let r = i; r <= maxLook; r++) {
            if (candles[r].high > sweepHigh) {
              sweepHigh = candles[r].high;
            }
            if (candles[r].close < pool.price) {
              reclaimIndex = r;
              break;
            }
          }

          if (reclaimIndex === -1) {
            const allClosedAbove = candles
              .slice(i, maxLook + 1)
              .some((c) => c.close > pool.price);
            if (allClosedAbove && maxLook === i + maxReclaimBars) {
              pool.status = 'BROKEN';
              pool.brokenTime = candle.time;
              isEvaluated = true;
            }
          } else {
            const reclaimCandle = candles[reclaimIndex];
            const sweepDepth = sweepHigh - pool.price;
            const candleRange = reclaimCandle.high - reclaimCandle.low;

            const hasDepth = sweepDepth >= minRequiredDepth - 0.001;
            const inBottom50 =
              candleRange > 0
                ? (reclaimCandle.high - reclaimCandle.close) / candleRange >= 0.45
                : true;
            const hasBearishDisplacement =
              reclaimCandle.close <= reclaimCandle.open ||
              reclaimCandle.close < pool.price;

            if (hasDepth && inBottom50 && hasBearishDisplacement) {
              pool.status = 'SWEPT';
              pool.sweptTime = reclaimCandle.time;
              sweeps.push({
                poolId: pool.id,
                direction: 'BEARISH',
                poolType: pool.poolType,
                sweptPrice: pool.price,
                sweepWickExtreme: Math.round(sweepHigh * 100) / 100,
                sweepTime: candle.time,
                reclaimTime: reclaimCandle.time,
                reclaimClose: Math.round(reclaimCandle.close * 100) / 100,
                reclaimCandleIndex: reclaimIndex,
              });
              isEvaluated = true;
            } else if (reclaimIndex === maxLook) {
              pool.status = 'BROKEN';
              pool.brokenTime = candle.time;
              isEvaluated = true;
            }
          }
        }
      }
    }
  }

  return sweeps.sort((a, b) => a.reclaimTime - b.reclaimTime);
}

/**
 * 4. STANDALONE ENTRY, STOP LOSS & TAKE PROFIT (generateSweepSignals)
 * - RECLAIM_CLOSE (Immediate Post-Sweep Entry): Enter on reclaim candle close.
 * - LTF_STRUCTURE_SHIFT (Confirmation Entry): Wait for LTF swing structure break (CHoCH) in reversal direction.
 * - Stop Loss: Strictly beyond extreme wick (sweepWickLow - atrBuffer for Longs, sweepWickHigh + atrBuffer for Shorts).
 * - Take Profit: Nearest opposing un-swept liquidity pool, enforcing rrRatio >= minRR (default 2.5).
 */
export function generateSweepSignals(
  candles: ScreenerCandle[],
  sweeps: LiquiditySweepEvent[],
  pools: LiquidityPool[],
  ltfCandles?: ScreenerCandle[],
  options: LiquiditySweepScannerOptions = {},
): LiquiditySweepTradeSignal | null {
  if (!sweeps || sweeps.length === 0) return null;

  const latestSweep = sweeps[sweeps.length - 1];
  const currentATR = getLatestATR(candles, 14);
  const atrBuffer = currentATR * (options.bufferATRMultiplier ?? 0.1);
  const minRR = options.minRR ?? 2.5;
  const entryMode: SweepEntryMode = options.entryMode ?? 'RECLAIM_CLOSE';

  // -------------------------------------------------------------
  // LONG SETUP (BULLISH SWEEP of SSL / EQL / PDL)
  // -------------------------------------------------------------
  if (latestSweep.direction === 'BULLISH') {
    const stopLoss = Math.round((latestSweep.sweepWickExtreme - atrBuffer) * 100) / 100;
    let entryPrice = latestSweep.reclaimClose;

    // Optional LTF Structure Shift (CHoCH) confirmation
    if (entryMode === 'LTF_STRUCTURE_SHIFT' && ltfCandles && ltfCandles.length > 5) {
      const ltfSwings = detectSwingPivots(ltfCandles, { swingLookback: 3 });
      const recentLtfHigh = ltfSwings
        .filter((s) => s.type === 'HIGH' && s.time >= latestSweep.sweepTime - 3600)
        .pop();

      if (recentLtfHigh) {
        const ltfChochCandle = ltfCandles.find(
          (c) => c.time >= recentLtfHigh.confirmedAtTime && c.close > recentLtfHigh.price,
        );
        if (ltfChochCandle) {
          entryPrice = ltfChochCandle.close;
        }
      }
    }

    const risk = Math.max(0.01, entryPrice - stopLoss);

    // Opposing un-swept liquidity pools (BSL / EQH / PDH above entry)
    const opposingPools = pools
      .filter((p) => p.side === 'BSL' && p.price > entryPrice && p.status !== 'SWEPT')
      .sort((a, b) => a.price - b.price);

    let targetPool = opposingPools.find((p) => (p.price - entryPrice) / risk >= minRR);
    if (!targetPool && opposingPools.length > 0) {
      targetPool = opposingPools[opposingPools.length - 1]; // Highest available
    }

    const targetPoolPrice = targetPool
      ? targetPool.price
      : Math.round((entryPrice + minRR * risk) * 100) / 100;
    const takeProfit = targetPoolPrice;
    const rrRatio = Math.round(((takeProfit - entryPrice) / risk) * 10) / 10;

    return {
      action: 'BUY',
      entryMode,
      entryPrice: Math.round(entryPrice * 100) / 100,
      stopLoss,
      takeProfit,
      rrRatio: Math.max(1.0, rrRatio),
      targetPoolPrice,
    };
  }

  // -------------------------------------------------------------
  // SHORT SETUP (BEARISH SWEEP of BSL / EQH / PDH)
  // -------------------------------------------------------------
  if (latestSweep.direction === 'BEARISH') {
    const stopLoss = Math.round((latestSweep.sweepWickExtreme + atrBuffer) * 100) / 100;
    let entryPrice = latestSweep.reclaimClose;

    if (entryMode === 'LTF_STRUCTURE_SHIFT' && ltfCandles && ltfCandles.length > 5) {
      const ltfSwings = detectSwingPivots(ltfCandles, { swingLookback: 3 });
      const recentLtfLow = ltfSwings
        .filter((s) => s.type === 'LOW' && s.time >= latestSweep.sweepTime - 3600)
        .pop();

      if (recentLtfLow) {
        const ltfChochCandle = ltfCandles.find(
          (c) => c.time >= recentLtfLow.confirmedAtTime && c.close < recentLtfLow.price,
        );
        if (ltfChochCandle) {
          entryPrice = ltfChochCandle.close;
        }
      }
    }

    const risk = Math.max(0.01, stopLoss - entryPrice);

    // Opposing un-swept liquidity pools (SSL / EQL / PDL below entry)
    const opposingPools = pools
      .filter((p) => p.side === 'SSL' && p.price < entryPrice && p.status !== 'SWEPT')
      .sort((a, b) => b.price - a.price);

    let targetPool = opposingPools.find((p) => (entryPrice - p.price) / risk >= minRR);
    if (!targetPool && opposingPools.length > 0) {
      targetPool = opposingPools[opposingPools.length - 1]; // Lowest available
    }

    const targetPoolPrice = targetPool
      ? targetPool.price
      : Math.round((entryPrice - minRR * risk) * 100) / 100;
    const takeProfit = targetPoolPrice;
    const rrRatio = Math.round(((entryPrice - takeProfit) / risk) * 10) / 10;

    return {
      action: 'SELL',
      entryMode,
      entryPrice: Math.round(entryPrice * 100) / 100,
      stopLoss,
      takeProfit,
      rrRatio: Math.max(1.0, rrRatio),
      targetPoolPrice,
    };
  }

  return null;
}

/**
 * 5. CHART OVERLAY BUILDER (buildSweepChartOverlay)
 * Generates horizontal liquidity lines, distinct sweep markers, and trade setup lines
 * for TradingView Lightweight Charts rendering.
 */
export function buildSweepChartOverlay(
  candles: ScreenerCandle[],
  pools: LiquidityPool[],
  sweeps: LiquiditySweepEvent[],
  signal: LiquiditySweepTradeSignal | null,
): LiquiditySweepChartOverlay {
  const lastTime = candles[candles.length - 1]?.time ?? 0;

  const overlayPools = pools.map((p) => {
    let color = '#F59E0B'; // default Amber
    if (p.side === 'BSL') {
      color = p.poolType === 'EQH' ? '#FB7185' : '#F59E0B';
    } else {
      color = p.poolType === 'EQL' ? '#00D2C4' : '#10B981';
    }

    const lineStyle: 'dashed' | 'dotted' | 'solid' =
      p.status === 'SWEPT' ? 'dotted' : p.status === 'BROKEN' ? 'solid' : 'dashed';

    return {
      id: p.id,
      side: p.side,
      poolType: p.poolType,
      price: p.price,
      startTime: p.startTime,
      endTime: p.sweptTime || p.brokenTime || lastTime,
      status: p.status,
      touchCount: p.touchCount,
      color,
      lineStyle,
    };
  });

  return {
    pools: overlayPools,
    sweeps: sweeps.map((s) => ({
      direction: s.direction,
      poolType: s.poolType,
      sweptPrice: s.sweptPrice,
      sweepWickExtreme: s.sweepWickExtreme,
      sweepTime: s.sweepTime,
      reclaimTime: s.reclaimTime,
    })),
    signal: signal || undefined,
  };
}

/**
 * 6. STANDALONE INSTRUMENT ANALYSIS (analyzeInstrument)
 * Self-contained orchestration running all Liquidity Sweep modules.
 */
export function analyzeInstrument(
  symbol: string,
  displayName: string,
  candles: ScreenerCandle[],
  ltfCandles: ScreenerCandle[] = [],
  options: LiquiditySweepScannerOptions = {},
): LiquiditySweepSymbolResult {
  const timeframe = options.timeframe || '15m';

  if (!candles || candles.length < 5) {
    return {
      symbol,
      displayName,
      name: displayName,
      strategy: 'LIQUIDITY_SWEEP',
      timeframe,
      activePools: [],
      allPools: [],
      recentSweeps: [],
      signal: null,
      candles: candles || [],
      ltfCandles,
      chartOverlay: {
        pools: [],
        sweeps: [],
      },
    };
  }

  // 1. Detect Swing Pivots
  const pivots = detectSwingPivots(candles, options);

  // 2. Detect Liquidity Pools (BSL, SSL, EQH, EQL, PDH, PDL)
  const pools = detectLiquidityPools(candles, pivots, options);

  // 3. Detect Liquidity Sweeps vs True Breakouts
  const sweeps = detectLiquiditySweeps(candles, pools, options);

  // 4. Generate Standalone Entry, SL & TP Signals
  const signal = generateSweepSignals(candles, sweeps, pools, ltfCandles, options);

  // 5. Build Chart Overlays for TradingView Lightweight Charts
  const chartOverlay = buildSweepChartOverlay(candles, pools, sweeps, signal);

  const activePools = pools
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => ({
      id: p.id,
      side: p.side,
      poolType: p.poolType,
      price: p.price,
      startTime: p.startTime,
      touchCount: p.touchCount,
    }));

  const recentSweeps = sweeps.slice(-5).map((s) => ({
    direction: s.direction,
    poolType: s.poolType,
    sweptPrice: s.sweptPrice,
    sweepWickExtreme: s.sweepWickExtreme,
    sweepTime: s.sweepTime,
    reclaimTime: s.reclaimTime,
  }));

  return {
    symbol,
    displayName,
    name: displayName,
    strategy: 'LIQUIDITY_SWEEP',
    timeframe,
    activePools,
    allPools: pools,
    recentSweeps,
    signal,
    candles,
    ltfCandles,
    chartOverlay,
  };
}

/**
 * 7. SCAN RESULT COMPILER (compileScanResults)
 */
export function compileScanResults(
  results: LiquiditySweepSymbolResult[],
  instruments: Array<{ symbol: string; displayName: string; name: string }>,
  options: LiquiditySweepScannerOptions = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): LiquiditySweepScanResponse {
  const mode = options.mode || 'live';
  const timeframe = options.timeframe || '15m';

  // Sort results: symbols with actionable signals first, then by recent sweeps count, then symbol name
  results.sort((a, b) => {
    if (a.signal && !b.signal) return -1;
    if (!a.signal && b.signal) return 1;
    if (b.recentSweeps.length !== a.recentSweeps.length) {
      return b.recentSweeps.length - a.recentSweeps.length;
    }
    return (a.displayName || a.symbol).localeCompare(b.displayName || b.symbol);
  });

  const totalActivePools = results.reduce((sum, r) => sum + r.activePools.length, 0);
  const totalSignals = results.filter((r) => r.signal != null).length;
  const bullishCount = results.filter((r) => r.signal?.action === 'BUY').length;
  const bearishCount = results.filter((r) => r.signal?.action === 'SELL').length;

  return {
    mode,
    strategy: 'LIQUIDITY_SWEEP',
    timeframe,
    startDate: options.startDate,
    endDate: options.endDate,
    scannedAt: new Date(nowSec * 1000).toISOString(),
    instrumentsScanned: instruments,
    totalScanned: instruments.length,
    totalActivePools,
    totalSignals,
    bullishCount,
    bearishCount,
    results,
  };
}
