import {
  OrderBlockScanResponse,
  OrderBlockSymbolResult,
  ScreenerCandle,
  ScreenerScanMode,
} from '../models/screener.models';
import {
  buildChartOverlay,
  detectMarketStructure,
  detectSwings,
  evaluateMTFSetups,
  findValidOrderBlocks,
  ScannerEngineOptions,
} from './orderBlockScanner';

export interface OrderBlockStrategyOptions extends ScannerEngineOptions {
  mode?: ScreenerScanMode;
  htfTimeframe?: '1h' | '4h';
  ltfTimeframe?: '5m' | '15m';
  startDate?: string;
  endDate?: string;
}

export class OrderBlockStrategy {
  /**
   * Run Order Block (SMC / Supply & Demand) analysis on a single instrument.
   */
  public static analyzeInstrument(
    symbol: string,
    displayName: string,
    htfCandles: ScreenerCandle[],
    ltfCandles: ScreenerCandle[] = [],
    options: OrderBlockStrategyOptions = {},
  ): OrderBlockSymbolResult {
    const htfTf = options.htfTimeframe || '1h';
    const ltfTf = options.ltfTimeframe || '5m';
    const tfLabel = ltfCandles.length > 0 ? `${htfTf} + ${ltfTf}` : htfTf;

    if (!htfCandles || htfCandles.length < 5) {
      return {
        symbol,
        displayName,
        name: displayName,
        timeframe: tfLabel,
        trendBias: 'NEUTRAL',
        activeOrderBlocks: [],
        allOrderBlocks: [],
        swings: [],
        structureBreaks: [],
        candles: htfCandles || [],
        ltfCandles: ltfCandles || [],
        chartOverlay: {
          orderBlocks: [],
          fvgs: [],
          breaks: [],
        },
        proximityStatus: 'NONE',
      };
    }

    // 1. Detect Swings on HTF
    const swings = detectSwings(htfCandles, options);

    // 2. Detect Market Structure (BoS & CHoCH)
    const { structureBreaks, trendBias } = detectMarketStructure(htfCandles, swings, options);

    // 3. Find Valid Order Blocks (Extreme vs Decisional, unmitigated, with FVG confluence)
    const { activeOrderBlocks, allOrderBlocks } = findValidOrderBlocks(
      htfCandles,
      structureBreaks,
      swings,
      options,
    );

    // 4. Evaluate MTF setups (Proximity & LTF confirmation sniper setups)
    const { proximityStatus, tradeSignal } = evaluateMTFSetups(
      symbol,
      displayName,
      htfCandles,
      activeOrderBlocks,
      ltfCandles,
      options,
    );

    // 5. Generate Chart Overlay coordinates for TradingView Lightweight Charts
    const chartOverlay = buildChartOverlay(
      htfCandles,
      allOrderBlocks,
      structureBreaks,
      tradeSignal,
    );

    return {
      symbol,
      displayName,
      name: displayName,
      timeframe: tfLabel,
      trendBias,
      activeOrderBlocks,
      allOrderBlocks,
      swings,
      structureBreaks,
      candles: htfCandles,
      ltfCandles: ltfCandles.length > 0 ? ltfCandles : undefined,
      chartOverlay,
      proximityStatus,
      tradeSignal,
    };
  }

  /**
   * Run multi-instrument Order Block scan and compile aggregate response.
   */
  public static compileScanResults(
    results: OrderBlockSymbolResult[],
    instrumentsScanned: Array<{ symbol: string; displayName: string; name: string }>,
    options: OrderBlockStrategyOptions = {},
    nowSec: number = Math.floor(Date.now() / 1000),
  ): OrderBlockScanResponse {
    let totalActiveOrderBlocks = 0;
    let approachingCount = 0;
    let mitigatingCount = 0;
    let sniperSignalCount = 0;

    for (const r of results) {
      totalActiveOrderBlocks += r.activeOrderBlocks.length;
      if (r.proximityStatus === 'APPROACHING') approachingCount++;
      if (r.proximityStatus === 'MITIGATING') mitigatingCount++;
      if (r.tradeSignal) sniperSignalCount++;
    }

    // Sort results: Instruments with active sniper signals first, then mitigating/approaching, then symbol
    results.sort((a, b) => {
      const aScore = a.tradeSignal ? 3 : a.proximityStatus === 'MITIGATING' ? 2 : a.proximityStatus === 'APPROACHING' ? 1 : 0;
      const bScore = b.tradeSignal ? 3 : b.proximityStatus === 'MITIGATING' ? 2 : b.proximityStatus === 'APPROACHING' ? 1 : 0;
      if (bScore !== aScore) return bScore - aScore;
      return (a.displayName || a.symbol).localeCompare(b.displayName || b.symbol);
    });

    return {
      mode: options.mode || 'live',
      strategy: 'order-block',
      htf: options.htfTimeframe || '1h',
      ltf: options.ltfTimeframe || '5m',
      startDate: options.startDate,
      endDate: options.endDate,
      scannedAt: new Date(nowSec * 1000).toISOString(),
      instrumentsScanned,
      totalScanned: instrumentsScanned.length,
      totalActiveOrderBlocks,
      totalSignals: sniperSignalCount,
      approachingCount,
      mitigatingCount,
      sniperSignalCount,
      results,
    };
  }
}
