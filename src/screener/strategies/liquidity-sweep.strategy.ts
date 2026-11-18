import { CandleData } from '../../yahoo/yahoo.service';
import {
  LiquidityLevelType,
  LiquiditySweepSignal,
  ScreenerCandle,
} from '../models/screener.models';

const IST_OFFSET_SEC = 5.5 * 3600; // UTC+05:30 = 19800 seconds
const FIVE_MIN_SEC = 300;
const LIVE_LOOKBACK_CLOSED_CANDLES = 3;

export interface SessionScanOptions {
  symbol: string;
  name: string;
  sessionDate: string;
  sessionCandles: ScreenerCandle[];
  pdh: number | null;
  pdl: number | null;
  /** When set (e.g., 3 in Live mode), only emit signals whose confirmation candle is in the latest N closed candles */
  onlyLatestClosedCount?: number;
}

export class LiquiditySweepStrategy {
  /**
   * Convert a UNIX epoch timestamp (seconds) into an IST calendar date string (YYYY-MM-DD).
   */
  public static toIstDateKey(unixSeconds: number): string {
    const istMs = (Math.floor(unixSeconds) + IST_OFFSET_SEC) * 1000;
    return new Date(istMs).toISOString().slice(0, 10);
  }

  /**
   * Convert an IST date string (YYYY-MM-DD) into UTC UNIX epoch seconds bounds [00:00:00 IST, 23:59:59 IST].
   */
  public static getIstDayBounds(dateStr: string): { startSec: number; endSec: number } {
    const startMs = Date.parse(`${dateStr}T00:00:00+05:30`);
    const endMs = Date.parse(`${dateStr}T23:59:59+05:30`);
    return {
      startSec: Math.floor(startMs / 1000),
      endSec: Math.floor(endMs / 1000),
    };
  }

  /**
   * Normalize Yahoo Finance candles:
   * - integer UNIX seconds
   * - valid OHLC numbers
   * - deduplicated by timestamp
   * - strictly ascending chronological order
   */
  public static normalizeCandles(rawCandles: CandleData[]): ScreenerCandle[] {
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      return [];
    }

    const byTime = new Map<number, ScreenerCandle>();
    for (const c of rawCandles) {
      const time = Math.floor(Number(c.time));
      if (
        !Number.isFinite(time) ||
        time <= 0 ||
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close)
      ) {
        continue;
      }
      if (!byTime.has(time)) {
        byTime.set(time, {
          time,
          open: Math.round(c.open * 100) / 100,
          high: Math.round(c.high * 100) / 100,
          low: Math.round(c.low * 100) / 100,
          close: Math.round(c.close * 100) / 100,
          volume: Number.isFinite(c.volume) ? c.volume : 0,
        });
      }
    }

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }

  /**
   * Keep only closed 5-minute candles (bar end time `time + 300 <= nowSec`).
   */
  public static filterClosedFiveMinCandles(
    candles: ScreenerCandle[],
    nowSec: number = Math.floor(Date.now() / 1000),
  ): ScreenerCandle[] {
    return candles.filter((c) => c.time + FIVE_MIN_SEC <= nowSec);
  }

  /**
   * Group normalized candles by IST trading date (YYYY-MM-DD).
   */
  public static groupByIstSession(candles: ScreenerCandle[]): Map<string, ScreenerCandle[]> {
    const grouped = new Map<string, ScreenerCandle[]>();
    for (const c of candles) {
      const key = this.toIstDateKey(c.time);
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(c);
      } else {
        grouped.set(key, [c]);
      }
    }
    return grouped;
  }

  /**
   * Resolve Previous Day High (PDH) and Previous Day Low (PDL) strictly prior to `sessionDate`.
   * Primary source: Yahoo daily (1d) candles.
   * Fallback: Prior trading session from the grouped 5m candles (if daily candle is delayed/missing).
   */
  public static resolvePriorDayLevels(
    sessionDate: string,
    dailyCandles: ScreenerCandle[],
    grouped5mSessions: Map<string, ScreenerCandle[]>,
  ): { pdh: number | null; pdl: number | null } {
    // 1. Prefer the latest daily bar strictly before `sessionDate`
    let priorDaily: ScreenerCandle | null = null;
    for (const bar of dailyCandles) {
      const barDate = this.toIstDateKey(bar.time);
      if (barDate < sessionDate) {
        priorDaily = bar;
      }
    }

    if (priorDaily) {
      return {
        pdh: priorDaily.high,
        pdl: priorDaily.low,
      };
    }

    // 2. Fallback to prior 5m session if daily data unavailable
    const priorDates = Array.from(grouped5mSessions.keys())
      .filter((d) => d < sessionDate)
      .sort();

    if (priorDates.length > 0) {
      const prevSession = grouped5mSessions.get(priorDates[priorDates.length - 1]) || [];
      if (prevSession.length > 0) {
        let high = -Infinity;
        let low = Infinity;
        for (const bar of prevSession) {
          if (bar.high > high) high = bar.high;
          if (bar.low < low) low = bar.low;
        }
        return {
          pdh: high > -Infinity ? high : null,
          pdl: low < Infinity ? low : null,
        };
      }
    }

    return { pdh: null, pdl: null };
  }

  /**
   * Live Mode Scan:
   * Evaluates ONLY the latest 2-3 closed 5-minute candles of the latest trading session
   * against PDH/PDL and running Intraday High/Low established prior to the sweep.
   */
  public static scanLive(
    symbol: string,
    name: string,
    raw5mCandles: CandleData[],
    rawDailyCandles: CandleData[],
    nowSec: number = Math.floor(Date.now() / 1000),
  ): LiquiditySweepSignal[] {
    const normalized5m = this.filterClosedFiveMinCandles(
      this.normalizeCandles(raw5mCandles),
      nowSec,
    );
    if (normalized5m.length === 0) {
      return [];
    }

    const normalizedDaily = this.normalizeCandles(rawDailyCandles);
    const grouped = this.groupByIstSession(normalized5m);
    const sortedDates = Array.from(grouped.keys()).sort();
    if (sortedDates.length === 0) {
      return [];
    }

    const latestDate = sortedDates[sortedDates.length - 1];
    const sessionCandles = grouped.get(latestDate) || [];
    const { pdh, pdl } = this.resolvePriorDayLevels(latestDate, normalizedDaily, grouped);

    return this.detectSessionSweeps({
      symbol,
      name,
      sessionDate: latestDate,
      sessionCandles,
      pdh,
      pdl,
      onlyLatestClosedCount: LIVE_LOOKBACK_CLOSED_CANDLES,
    });
  }

  /**
   * Historical / Backtest Mode Scan:
   * Scans every trading session in [startDate, endDate] from market open to close
   * using strictly causal running Intraday High/Low and each session's prior trading day PDH/PDL.
   */
  public static scanHistorical(
    symbol: string,
    name: string,
    raw5mCandles: CandleData[],
    rawDailyCandles: CandleData[],
    startDate: string,
    endDate: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): LiquiditySweepSignal[] {
    const normalized5m = this.filterClosedFiveMinCandles(
      this.normalizeCandles(raw5mCandles),
      nowSec,
    );
    if (normalized5m.length === 0) {
      return [];
    }

    const normalizedDaily = this.normalizeCandles(rawDailyCandles);
    const grouped = this.groupByIstSession(normalized5m);
    const targetDates = Array.from(grouped.keys())
      .filter((d) => d >= startDate && d <= endDate)
      .sort();

    const signals: LiquiditySweepSignal[] = [];

    for (const sessionDate of targetDates) {
      const sessionCandles = grouped.get(sessionDate) || [];
      if (sessionCandles.length === 0) continue;

      const { pdh, pdl } = this.resolvePriorDayLevels(sessionDate, normalizedDaily, grouped);

      const sessionSignals = this.detectSessionSweeps({
        symbol,
        name,
        sessionDate,
        sessionCandles,
        pdh,
        pdl,
      });

      signals.push(...sessionSignals);
    }

    return signals;
  }

  /**
   * Core causal 5-minute Liquidity Sweep & Reversal detector for a single trading session.
   *
   * Rules enforced:
   * - Pattern A (BUY): Sweep below PDL or prior running DAY_LOW (`low < level`),
   *   followed on the same candle or the immediately next candle by a 5m green candle
   *   (`close > open`) closing strictly above the broken level (`close > level`).
   * - Pattern B (SELL): Sweep above PDH or prior running DAY_HIGH (`high > level`),
   *   followed on the same candle or the immediately next candle by a 5m red candle
   *   (`close < open`) closing strictly below the broken level (`close < level`).
   * - Edge Case 1: Opening candle (index 0) is ignored for DAY_HIGH/DAY_LOW sweeps,
   *   but CAN still sweep PDH/PDL.
   * - Edge Case 2: Zero lookahead bias — running Intraday High & Low are updated
   *   strictly candle-by-candle using ONLY bars prior to the sweep candle.
   * - Supports multiple discrete BUY and SELL signals across the same session.
   */
  public static detectSessionSweeps(options: SessionScanOptions): LiquiditySweepSignal[] {
    const {
      symbol,
      name,
      sessionDate,
      sessionCandles,
      pdh,
      pdl,
      onlyLatestClosedCount,
    } = options;

    if (!sessionCandles || sessionCandles.length === 0) {
      return [];
    }

    const n = sessionCandles.length;
    const minEmitIndex =
      onlyLatestClosedCount && onlyLatestClosedCount > 0
        ? Math.max(0, n - onlyLatestClosedCount)
        : 0;

    // Precompute strictly causal running highs & lows BEFORE each index i:
    // priorDayHigh[i] = max(sessionCandles[0 .. i-1].high) for i >= 1, else null
    // priorDayLow[i]  = min(sessionCandles[0 .. i-1].low)  for i >= 1, else null
    const priorDayHigh: Array<number | null> = new Array(n).fill(null);
    const priorDayLow: Array<number | null> = new Array(n).fill(null);

    let runningHigh = -Infinity;
    let runningLow = Infinity;
    for (let i = 0; i < n; i++) {
      if (i >= 1) {
        priorDayHigh[i] = runningHigh;
        priorDayLow[i] = runningLow;
      }
      if (sessionCandles[i].high > runningHigh) runningHigh = sessionCandles[i].high;
      if (sessionCandles[i].low < runningLow) runningLow = sessionCandles[i].low;
    }

    const results: LiquiditySweepSignal[] = [];

    for (let c = minEmitIndex; c < n; c++) {
      const candle = sessionCandles[c];
      const prevCandle = c >= 1 ? sessionCandles[c - 1] : null;

      const isGreen = candle.close > candle.open;
      const isRed = candle.close < candle.open;

      // --- PATTERN A: BULLISH LIQUIDITY SWEEP & REVERSAL (BUY) ---
      if (isGreen) {
        const match = this.checkBullishReversal(
          c,
          candle,
          prevCandle,
          pdl,
          priorDayLow[c],
          c >= 1 ? priorDayLow[c - 1] : null,
        );

        if (match) {
          results.push(
            this.buildSignal({
              symbol,
              name,
              signalType: 'BUY',
              levelType: match.levelType,
              levelPrice: match.levelPrice,
              sweepPrice: match.sweepPrice,
              sweepTimestamp: match.sweepTimestamp,
              confirmationCandle: candle,
              sessionDate,
              sessionCandles,
            }),
          );
        }
      }

      // --- PATTERN B: BEARISH LIQUIDITY SWEEP & REVERSAL (SELL) ---
      if (isRed) {
        const match = this.checkBearishReversal(
          c,
          candle,
          prevCandle,
          pdh,
          priorDayHigh[c],
          c >= 1 ? priorDayHigh[c - 1] : null,
        );

        if (match) {
          results.push(
            this.buildSignal({
              symbol,
              name,
              signalType: 'SELL',
              levelType: match.levelType,
              levelPrice: match.levelPrice,
              sweepPrice: match.sweepPrice,
              sweepTimestamp: match.sweepTimestamp,
              confirmationCandle: candle,
              sessionDate,
              sessionCandles,
            }),
          );
        }
      }
    }

    return results;
  }

  /**
   * Evaluates whether green candle `c` confirms a Bullish Liquidity Sweep on PDL or prior DAY_LOW.
   * Priority when both levels are swept on the same confirmation bar: PDL > DAY_LOW.
   */
  private static checkBullishReversal(
    c: number,
    candle: ScreenerCandle,
    prevCandle: ScreenerCandle | null,
    pdl: number | null,
    dayLowBeforeC: number | null,
    dayLowBeforePrev: number | null,
  ): {
    levelType: LiquidityLevelType;
    levelPrice: number;
    sweepPrice: number;
    sweepTimestamp: number;
  } | null {
    // 1. Check PDL (allowed on any candle including opening candle c === 0)
    if (pdl !== null && candle.close > pdl) {
      const currSwept = candle.low < pdl;
      const prevSweptUnconfirmed =
        prevCandle !== null &&
        prevCandle.low < pdl &&
        !(prevCandle.close > prevCandle.open && prevCandle.close > pdl);

      if (currSwept || prevSweptUnconfirmed) {
        let sweepPrice = candle.low;
        let sweepTimestamp = candle.time;

        if (prevSweptUnconfirmed && prevCandle) {
          if (!currSwept || prevCandle.low <= candle.low) {
            sweepPrice = prevCandle.low;
            sweepTimestamp = prevCandle.time;
          }
        }

        return {
          levelType: 'PDL',
          levelPrice: pdl,
          sweepPrice,
          sweepTimestamp,
        };
      }
    }

    // 2. Check Running Intraday Low (DAY_LOW)
    // Edge case: ignore opening candle (index 0) as a sweep candle for Intraday Low
    // Case 2a: Single-candle sweep on candle c (c >= 1)
    if (c >= 1 && dayLowBeforeC !== null && candle.low < dayLowBeforeC && candle.close > dayLowBeforeC) {
      return {
        levelType: 'DAY_LOW',
        levelPrice: dayLowBeforeC,
        sweepPrice: candle.low,
        sweepTimestamp: candle.time,
      };
    }

    // Case 2b: Two-candle sweep where candle c-1 (c-1 >= 1, so c >= 2) swept prior DAY_LOW
    // and was NOT already confirmed as a bullish reversal, then candle c closes back above it
    if (
      c >= 2 &&
      prevCandle !== null &&
      dayLowBeforePrev !== null &&
      prevCandle.low < dayLowBeforePrev &&
      !(prevCandle.close > prevCandle.open && prevCandle.close > dayLowBeforePrev) &&
      candle.close > dayLowBeforePrev
    ) {
      const useCurr = candle.low < prevCandle.low;
      return {
        levelType: 'DAY_LOW',
        levelPrice: dayLowBeforePrev,
        sweepPrice: useCurr ? candle.low : prevCandle.low,
        sweepTimestamp: useCurr ? candle.time : prevCandle.time,
      };
    }

    return null;
  }

  /**
   * Evaluates whether red candle `c` confirms a Bearish Liquidity Sweep on PDH or prior DAY_HIGH.
   * Priority when both levels are swept on the same confirmation bar: PDH > DAY_HIGH.
   */
  private static checkBearishReversal(
    c: number,
    candle: ScreenerCandle,
    prevCandle: ScreenerCandle | null,
    pdh: number | null,
    dayHighBeforeC: number | null,
    dayHighBeforePrev: number | null,
  ): {
    levelType: LiquidityLevelType;
    levelPrice: number;
    sweepPrice: number;
    sweepTimestamp: number;
  } | null {
    // 1. Check PDH (allowed on any candle including opening candle c === 0)
    if (pdh !== null && candle.close < pdh) {
      const currSwept = candle.high > pdh;
      const prevSweptUnconfirmed =
        prevCandle !== null &&
        prevCandle.high > pdh &&
        !(prevCandle.close < prevCandle.open && prevCandle.close < pdh);

      if (currSwept || prevSweptUnconfirmed) {
        let sweepPrice = candle.high;
        let sweepTimestamp = candle.time;

        if (prevSweptUnconfirmed && prevCandle) {
          if (!currSwept || prevCandle.high >= candle.high) {
            sweepPrice = prevCandle.high;
            sweepTimestamp = prevCandle.time;
          }
        }

        return {
          levelType: 'PDH',
          levelPrice: pdh,
          sweepPrice,
          sweepTimestamp,
        };
      }
    }

    // 2. Check Running Intraday High (DAY_HIGH)
    // Edge case: ignore opening candle (index 0) as a sweep candle for Intraday High
    // Case 2a: Single-candle sweep on candle c (c >= 1)
    if (c >= 1 && dayHighBeforeC !== null && candle.high > dayHighBeforeC && candle.close < dayHighBeforeC) {
      return {
        levelType: 'DAY_HIGH',
        levelPrice: dayHighBeforeC,
        sweepPrice: candle.high,
        sweepTimestamp: candle.time,
      };
    }

    // Case 2b: Two-candle sweep where candle c-1 (c-1 >= 1, so c >= 2) swept prior DAY_HIGH
    // and was NOT already confirmed as a bearish reversal, then candle c closes back below it
    if (
      c >= 2 &&
      prevCandle !== null &&
      dayHighBeforePrev !== null &&
      prevCandle.high > dayHighBeforePrev &&
      !(prevCandle.close < prevCandle.open && prevCandle.close < dayHighBeforePrev) &&
      candle.close < dayHighBeforePrev
    ) {
      const useCurr = candle.high > prevCandle.high;
      return {
        levelType: 'DAY_HIGH',
        levelPrice: dayHighBeforePrev,
        sweepPrice: useCurr ? candle.high : prevCandle.high,
        sweepTimestamp: useCurr ? candle.time : prevCandle.time,
      };
    }

    return null;
  }

  private static buildSignal(params: {
    symbol: string;
    name: string;
    signalType: 'BUY' | 'SELL';
    levelType: LiquidityLevelType;
    levelPrice: number;
    sweepPrice: number;
    sweepTimestamp: number;
    confirmationCandle: ScreenerCandle;
    sessionDate: string;
    sessionCandles: ScreenerCandle[];
  }): LiquiditySweepSignal {
    const {
      symbol,
      name,
      signalType,
      levelType,
      levelPrice,
      sweepPrice,
      sweepTimestamp,
      confirmationCandle,
      sessionDate,
      sessionCandles,
    } = params;

    const cleanSymId = symbol.trim().toUpperCase().replace(/\s+/g, '_');
    const id = `${cleanSymId}_${confirmationCandle.time}_${signalType}`;

    // Always return the complete trading session (09:15 to 15:30 IST) for this signal's date
    // so both Live (today) and Historical charts display the entire intraday window without truncation.
    return {
      id,
      symbol,
      name,
      signalType,
      levelType,
      levelPrice: Math.round(levelPrice * 100) / 100,
      sweepPrice: Math.round(sweepPrice * 100) / 100,
      sweepTimestamp,
      confirmationClosePrice: Math.round(confirmationCandle.close * 100) / 100,
      confirmationTimestamp: confirmationCandle.time,
      sessionDate,
      timeframe: '5m',
      candles: sessionCandles.slice(),
    };
  }
}
