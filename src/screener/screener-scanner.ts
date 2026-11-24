import { CandleData } from '../yahoo/yahoo.service';
import { ScreenerSignal, OrderBlockZone } from './screener.types';

export interface ScanOptions {
  symbol: string;
  name?: string;
  swingLookback?: number; // default 20
  slBuffer?: number; // default 3
  targetRr?: number; // default 2.0
  maxRetestBars?: number; // default 15
}

/**
 * Format unix timestamp (seconds) into human-readable IST string.
 * Indian Standard Time is UTC + 5:30 (+19800 seconds).
 */
export function formatIstTime(timestampSeconds: number): string {
  const d = new Date((timestampSeconds + 19800) * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} IST`;
}

export function formatIstTimeShort(timestampSeconds: number): string {
  const d = new Date((timestampSeconds + 19800) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${min} IST`;
}

export function formatIstDate(timestampSeconds: number): string {
  const d = new Date((timestampSeconds + 19800) * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Check if a 5m candle is at or after 15:25 IST (the final 5m intraday candle before 15:30 market close).
 */
export function isEodCandle(timestampSeconds: number): boolean {
  const d = new Date((timestampSeconds + 19800) * 1000);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  return (hours === 15 && minutes >= 25) || hours > 15;
}

/**
 * Calculate dynamic SL buffer points:
 * Uses configured buffer (default 3 pts), or 0.05% of price if price is low (< 5000) and buffer is higher.
 */
export function calculateSlBuffer(price: number, configuredBuffer = 3): number {
  if (price > 5000) {
    return Math.max(1, configuredBuffer);
  }
  // For equities under 5000, 0.05% is e.g. 1.25 pts on Reliance (2500)
  const pctBuffer = Math.round(price * 0.0005 * 100) / 100;
  return Math.min(configuredBuffer, Math.max(0.1, pctBuffer));
}

/**
 * Scan 5-minute candles for the Liquidity Sweep -> Base -> Bullish Impulse -> Retest setup.
 */
export function scan5mCandles(candles: CandleData[], options: ScanOptions): ScreenerSignal[] {
  if (!candles || candles.length < 30) {
    return [];
  }

  const swingLookback = Math.max(5, options.swingLookback ?? 20);
  const slBufferParam = options.slBuffer ?? 3;
  const targetRr = Math.max(0.5, options.targetRr ?? 2.0);
  const maxRetestBars = Math.max(3, options.maxRetestBars ?? 15);
  const symbol = options.symbol || 'UNKNOWN';
  const name = options.name || symbol;

  const n = candles.length;
  const signals: ScreenerSignal[] = [];
  const processedEntryBars = new Set<number>();

  // Pre-calculate daily low boundaries to detect Previous Day Low (PDL) as well as swing lows
  const dailyLows = new Map<string, number>();
  for (const c of candles) {
    const dt = formatIstDate(c.time);
    const existing = dailyLows.get(dt);
    if (existing === undefined || c.low < existing) {
      dailyLows.set(dt, c.low);
    }
  }

  // Iterate through candles to find valid candidate swing lows
  for (let i = swingLookback; i < n - 6; i++) {
    const candidate = candles[i];
    const candidateLow = candidate.low;

    // Check if candle i is an N-bar swing low:
    // candidateLow must be <= low of all bars in [i - swingLookback, i - 1]
    let isSwingLow = true;
    for (let j = i - swingLookback; j < i; j++) {
      if (candles[j].low < candidateLow) {
        isSwingLow = false;
        break;
      }
    }
    if (!isSwingLow) continue;

    // candidateLow must also be <= low of bars in [i + 1, min(n - 1, i + swingLookback)]
    // or hold for at least 5 bars before the sweep
    const rightLookback = Math.min(swingLookback, 5);
    for (let j = i + 1; j <= Math.min(n - 1, i + rightLookback); j++) {
      if (candles[j].low < candidateLow) {
        isSwingLow = false;
        break;
      }
    }
    if (!isSwingLow) continue;

    const swingLow = candidateLow;
    const swingLowIndex = i;
    const swingLowTime = candidate.time;

    // Step A -> Step B: Follow price forward from swingLowIndex + 1
    // It must remain unbroken (candle.low >= swingLow) until a candle breaks below swingLow
    let sweepStartIndex = -1;
    for (let k = swingLowIndex + 1; k < n - 4; k++) {
      if (candles[k].low < swingLow) {
        sweepStartIndex = k;
        break;
      }
    }

    if (sweepStartIndex === -1) continue;

    // Separation check: Ensure at least 3 bars elapsed between swing low and sweep
    if (sweepStartIndex - swingLowIndex < 3) continue;

    // Step B: Detect Liquidity Sweep (LOW SWEEP)
    // Check if sweep sequence spans 1 or 2 candles to find lowest wick
    let sweepLowIndex = sweepStartIndex;
    let sweepLow = candles[sweepStartIndex].low;

    if (
      sweepStartIndex + 1 < n - 3 &&
      candles[sweepStartIndex + 1].low < sweepLow
    ) {
      sweepLowIndex = sweepStartIndex + 1;
      sweepLow = candles[sweepStartIndex + 1].low;
    }

    const sweepCandle = candles[sweepLowIndex];
    const sweepTime = sweepCandle.time;

    // Step C: Consolidation Base (1-2 Candles immediately following sweep low candle)
    // Lows must hold at or above sweep_low
    const base1Index = sweepLowIndex + 1;
    if (base1Index >= n - 2) continue;

    const base1 = candles[base1Index];
    if (base1.low < sweepLow) continue;

    // Check candidate base structures:
    // Option 1: 1 base candle (base1)
    // Option 2: 2 base candles (base1, base2)
    const baseCandidates: Array<{ lastBaseIndex: number; baseCandle: CandleData }> = [];

    // 1-candle base candidate
    baseCandidates.push({ lastBaseIndex: base1Index, baseCandle: base1 });

    // 2-candle base candidate
    const base2Index = sweepLowIndex + 2;
    if (base2Index < n - 1) {
      const base2 = candles[base2Index];
      if (base2.low >= sweepLow) {
        baseCandidates.push({ lastBaseIndex: base2Index, baseCandle: base2 });
      }
    }

    let detectedSignal: ScreenerSignal | null = null;

    // Evaluate base candidates
    for (const { lastBaseIndex, baseCandle } of baseCandidates) {
      const baseHigh = baseCandle.high;
      const baseStartTime = candles[sweepLowIndex + 1].time;

      // Step D: Bullish Impulse Break & Close
      // Within 1-2 candles after base, detect bullish candle (close > open)
      // that breaks above baseHigh and closes above it (impulse.close > baseHigh)
      let impulseIndex = -1;
      for (let impOffset = 1; impOffset <= 2; impOffset++) {
        const candidateImpIndex = lastBaseIndex + impOffset;
        if (candidateImpIndex >= n) break;
        const impCandle = candles[candidateImpIndex];

        // Must hold above sweep_low
        if (impCandle.low < sweepLow) break;

        if (
          impCandle.close > impCandle.open && // Bullish candle
          impCandle.high > baseHigh && // Breaks above base high
          impCandle.close > baseHigh // Closes above base high
        ) {
          impulseIndex = candidateImpIndex;
          break;
        }
      }

      if (impulseIndex === -1) continue;

      const impulseCandle = candles[impulseIndex];
      const impulseTime = impulseCandle.time;

      // Step E: Define Order Block Zone & Entry Trigger
      const entryPrice = Math.round(baseHigh * 100) / 100;
      const buffer = calculateSlBuffer(entryPrice, slBufferParam);
      const stopLoss = Math.round((sweepLow - buffer) * 100) / 100;
      const riskPoints = Math.round((entryPrice - stopLoss) * 100) / 100;

      if (riskPoints <= 0) continue;

      const targetPrice = Math.round((entryPrice + targetRr * riskPoints) * 100) / 100;
      const rewardPoints = Math.round((targetPrice - entryPrice) * 100) / 100;

      const orderBlock: OrderBlockZone = {
        top: entryPrice,
        bottom: sweepLow,
        startTime: baseStartTime,
        endTime: impulseTime,
      };

      // Step F: Retest Execution & Trade Simulation
      // Monitor subsequent candles (up to maxRetestBars) for price to pull back and touch entryPrice
      let fillIndex = -1;
      let isInvalidated = false;

      const maxSearchIndex = Math.min(n - 1, impulseIndex + maxRetestBars);
      for (let r = impulseIndex + 1; r <= maxSearchIndex; r++) {
        const retestCandle = candles[r];

        // Invalidation: Stop Loss breached before entry price touched
        if (retestCandle.low <= stopLoss && retestCandle.high < entryPrice) {
          isInvalidated = true;
          break;
        }

        // Fill condition: Price pulls back and touches entry_price
        if (retestCandle.low <= entryPrice) {
          fillIndex = r;
          break;
        }
      }

      if (isInvalidated || fillIndex === -1) {
        continue;
      }

      if (processedEntryBars.has(fillIndex)) {
        continue; // Avoid duplicate signals at the exact same fill bar
      }

      const fillCandle = candles[fillIndex];
      const entryTime = fillCandle.time;
      const dateStr = formatIstDate(entryTime);

      // Forward Outcome Simulation:
      // Track bar-by-bar until stop_loss hit, Target hit, or 15:25 IST EOD close
      let outcome: 'WIN' | 'LOSS' | 'EOD_EXIT' | 'OPEN' = 'OPEN';
      let exitTime = fillCandle.time;
      let exitPrice = fillCandle.close;
      let pnlPoints = 0;
      let rMultiple = 0;
      let resolved = false;

      // Check fill candle itself
      if (fillCandle.low <= stopLoss && fillCandle.high >= targetPrice) {
        // Both hit on same bar -> conservative loss
        outcome = 'LOSS';
        exitTime = fillCandle.time;
        exitPrice = stopLoss;
        pnlPoints = -riskPoints;
        rMultiple = -1.0;
        resolved = true;
      } else if (fillCandle.low <= stopLoss) {
        outcome = 'LOSS';
        exitTime = fillCandle.time;
        exitPrice = stopLoss;
        pnlPoints = -riskPoints;
        rMultiple = -1.0;
        resolved = true;
      } else if (fillCandle.high >= targetPrice) {
        outcome = 'WIN';
        exitTime = fillCandle.time;
        exitPrice = targetPrice;
        pnlPoints = rewardPoints;
        rMultiple = targetRr;
        resolved = true;
      } else if (isEodCandle(fillCandle.time)) {
        outcome = 'EOD_EXIT';
        exitTime = fillCandle.time;
        exitPrice = fillCandle.close;
        pnlPoints = Math.round((fillCandle.close - entryPrice) * 100) / 100;
        rMultiple = Math.round(((fillCandle.close - entryPrice) / riskPoints) * 100) / 100;
        resolved = true;
      }

      // Check subsequent candles if still unresolved
      if (!resolved) {
        for (let post = fillIndex + 1; post < n; post++) {
          const c = candles[post];

          if (c.low <= stopLoss && c.high >= targetPrice) {
            outcome = 'LOSS';
            exitTime = c.time;
            exitPrice = stopLoss;
            pnlPoints = -riskPoints;
            rMultiple = -1.0;
            resolved = true;
            break;
          } else if (c.low <= stopLoss) {
            outcome = 'LOSS';
            exitTime = c.time;
            exitPrice = stopLoss;
            pnlPoints = -riskPoints;
            rMultiple = -1.0;
            resolved = true;
            break;
          } else if (c.high >= targetPrice) {
            outcome = 'WIN';
            exitTime = c.time;
            exitPrice = targetPrice;
            pnlPoints = rewardPoints;
            rMultiple = targetRr;
            resolved = true;
            break;
          } else if (isEodCandle(c.time)) {
            outcome = 'EOD_EXIT';
            exitTime = c.time;
            exitPrice = c.close;
            pnlPoints = Math.round((c.close - entryPrice) * 100) / 100;
            rMultiple = Math.round(((c.close - entryPrice) / riskPoints) * 100) / 100;
            resolved = true;
            break;
          }
        }
      }

      // If still unresolved at dataset end:
      if (!resolved) {
        const lastCandle = candles[n - 1];
        outcome = 'OPEN';
        exitTime = lastCandle.time;
        exitPrice = lastCandle.close;
        pnlPoints = Math.round((lastCandle.close - entryPrice) * 100) / 100;
        rMultiple = Math.round(((lastCandle.close - entryPrice) / riskPoints) * 100) / 100;
      }

      // Slice surrounding candles for chart visualization (e.g. 40 bars before swing low to 30 bars after exit)
      const chartStart = Math.max(0, swingLowIndex - 30);
      const chartEnd = Math.min(n, (outcome === 'OPEN' ? n : candles.findIndex((c) => c.time === exitTime) + 25));
      const chartCandles = candles.slice(chartStart, Math.max(chartEnd, fillIndex + 20));

      // Update OrderBlockZone endTime to entryTime
      orderBlock.endTime = entryTime;

      detectedSignal = {
        id: `${symbol.replace(/[^A-Za-z0-9]/g, '_')}_${dateStr}_${entryTime}`,
        symbol,
        name,
        date: dateStr,
        timeframe: '5m',
        swingLow,
        swingLowTime,
        swingLowTimeFormatted: formatIstTimeShort(swingLowTime),
        sweepLow,
        sweepTime,
        sweepTimeFormatted: formatIstTimeShort(sweepTime),
        baseCandleTime: baseStartTime,
        baseHigh,
        baseLow: baseCandle.low,
        impulseTime,
        impulseClose: impulseCandle.close,
        entryPrice,
        stopLoss,
        targetPrice,
        targetRr,
        riskPoints,
        rewardPoints,
        orderBlock,
        entryTime,
        entryTimeFormatted: formatIstTimeShort(entryTime),
        exitTime,
        exitTimeFormatted: formatIstTimeShort(exitTime),
        exitPrice,
        outcome,
        pnlPoints,
        rMultiple,
        candles: chartCandles,
      };

      processedEntryBars.add(fillIndex);
      break; // Successfully formed signal for this swing low
    }

    if (detectedSignal) {
      signals.push(detectedSignal);
      // Skip forward past the entry index to look for new setups
      i = Math.max(i, sweepStartIndex + 3);
    }
  }

  // Sort signals descending by entryTime (most recent first)
  signals.sort((a, b) => b.entryTime - a.entryTime);
  return signals;
}

/**
 * Compute aggregate backtest metrics from a list of detected signals.
 */
export function calculateBacktestSummary(signals: ScreenerSignal[]): {
  totalSignals: number;
  wins: number;
  losses: number;
  eodExits: number;
  openTrades: number;
  winRate: number;
  netRMultiple: number;
  profitFactor: number;
  grossProfitPoints: number;
  grossLossPoints: number;
  totalPnlPoints: number;
} {
  const totalSignals = signals.length;
  let wins = 0;
  let losses = 0;
  let eodExits = 0;
  let openTrades = 0;
  let netRMultiple = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalPnl = 0;

  for (const s of signals) {
    if (s.outcome === 'WIN') wins++;
    else if (s.outcome === 'LOSS') losses++;
    else if (s.outcome === 'EOD_EXIT') eodExits++;
    else if (s.outcome === 'OPEN') openTrades++;

    netRMultiple += s.rMultiple;
    totalPnl += s.pnlPoints;

    if (s.pnlPoints > 0) {
      grossProfit += s.pnlPoints;
    } else if (s.pnlPoints < 0) {
      grossLoss += Math.abs(s.pnlPoints);
    }
  }

  const closedTrades = wins + losses + eodExits;
  const winRate = closedTrades > 0 ? Math.round((wins / closedTrades) * 1000) / 10 : 0;
  const profitFactor = grossLoss > 0
    ? Math.round((grossProfit / grossLoss) * 100) / 100
    : grossProfit > 0 ? 99.99 : 0;

  return {
    totalSignals,
    wins,
    losses,
    eodExits,
    openTrades,
    winRate,
    netRMultiple: Math.round(netRMultiple * 100) / 100,
    profitFactor,
    grossProfitPoints: Math.round(grossProfit * 100) / 100,
    grossLossPoints: Math.round(grossLoss * 100) / 100,
    totalPnlPoints: Math.round(totalPnl * 100) / 100,
  };
}
