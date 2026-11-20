import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { ScreenerScanDto } from './dto/screener-scan.dto';
import {
  LiquiditySweepScanResponse,
  LiquiditySweepSignal,
  LiquiditySweepSymbolResult,
  OrderBlockScanResponse,
  OrderBlockSymbolResult,
  ScreenerCandle,
  ScreenerInstrumentItem,
  ScreenerScanMode,
  ScreenerScanResponse,
} from './models/screener.models';
import { LiquiditySweepStrategy } from './strategies/liquidity-sweep.strategy';
import {
  analyzeInstrument as analyzeLiquiditySweep,
  compileScanResults as compileLiquiditySweepResults,
} from './strategies/liquiditySweepScanner';
import { OrderBlockStrategy } from './strategies/order-block.strategy';

const MAX_YAHOO_5M_LOOKBACK_DAYS = 59;
const MAX_HISTORICAL_RANGE_DAYS = 14;
const ONE_DAY_SEC = 86400;

@Injectable()
export class ScreenerService {
  private readonly logger = new Logger(ScreenerService.name);

  constructor(
    private readonly firestore: FirestoreService,
    private readonly yahoo: YahooFinanceService,
  ) {}

  /**
   * Retrieve the configured traded instruments strictly from Firestore master_data/traded_instruments.
   */
  async getConfiguredInstruments(force = false): Promise<ScreenerInstrumentItem[]> {
    const masterDoc =
      typeof this.firestore.getTradedInstruments === 'function'
        ? await this.firestore.getTradedInstruments(force)
        : await this.firestore.getLotSizes(force);
    const records = masterDoc?.instruments || masterDoc?.indices || [];

    return records
      .filter((idx) => Boolean(idx.symbolName || idx.displayName || idx.symbol))
      .map((idx) => {
        const displayName = idx.displayName || idx.name || idx.symbolName || idx.symbol || '';
        const symbolName = idx.symbolName || idx.underlyingSymbol || idx.symbol || displayName;
        return {
          symbol: symbolName,
          symbolName,
          displayName,
          name: displayName,
          exchId: idx.exchId,
          securityId: idx.securityId,
          exchangeSegment: idx.exchangeSegment,
          lotSize: idx.lotSize ?? idx.defaultQuantityInOneLot,
          smFreezeQty: idx.smFreezeQty,
          strikeStep: idx.strikeStep,
          expiryFlag: idx.expiryFlag,
          stopLossPoints: idx.stopLossPoints,
        };
      });
  }

  /**
   * Execute strictly on-demand market scan across the configured indices from Firestore.
   * Supports both 'liquidity-sweep' (default) and 'order-block' (SMC / Supply & Demand).
   */
  async scan(dto: ScreenerScanDto, nowSec?: number): Promise<ScreenerScanResponse> {
    const mode: ScreenerScanMode = dto?.mode === 'historical' ? 'historical' : 'live';
    const currentNowSec = nowSec ?? Math.floor(Date.now() / 1000);

    // If strategy is Order Block (SMC), delegate to scanOrderBlocks
    if (dto?.strategy === 'order-block') {
      const obResponse = await this.scanOrderBlocks(dto, currentNowSec);
      return {
        mode,
        strategy: 'order-block',
        timeframe: (dto.htfTimeframe || '1h') as any,
        startDate: obResponse.startDate,
        endDate: obResponse.endDate,
        scannedAt: obResponse.scannedAt,
        instrumentsScanned: obResponse.instrumentsScanned,
        totalScanned: obResponse.totalScanned,
        totalRecommendations: obResponse.totalSignals,
        bullishCount: obResponse.results.filter((r) => r.tradeSignal?.signalType === 'BUY').length,
        bearishCount: obResponse.results.filter((r) => r.tradeSignal?.signalType === 'SELL').length,
        recommendations: [],
        orderBlockData: obResponse,
      };
    }

    const startTimeMs = Date.now();

    // 1. Validate historical dates if applicable
    let startDate: string | undefined;
    let endDate: string | undefined;

    if (mode === 'historical') {
      const resolved = this.validateAndResolveHistoricalDates(dto, currentNowSec);
      startDate = resolved.startDate;
      endDate = resolved.endDate;
    }

    // 2. Load configured traded instruments strictly from Firestore master_data/traded_instruments
    let targetInstruments = await this.getConfiguredInstruments();

    if (dto?.symbols && dto.symbols.length > 0) {
      const allowed = new Set(dto.symbols.map((s) => s.trim().toUpperCase()));
      targetInstruments = targetInstruments.filter(
        (inst) =>
          allowed.has(inst.symbol.trim().toUpperCase()) ||
          allowed.has(inst.displayName.trim().toUpperCase()),
      );
    }

    if (targetInstruments.length === 0) {
      return {
        mode,
        timeframe: '5m',
        startDate,
        endDate,
        scannedAt: new Date(currentNowSec * 1000).toISOString(),
        instrumentsScanned: [],
        totalScanned: 0,
        totalRecommendations: 0,
        bullishCount: 0,
        bearishCount: 0,
        recommendations: [],
      };
    }

    this.logger.log(
      `🔎 Starting on-demand 5m Liquidity Sweep scan [mode=${mode}${startDate ? `, range=${startDate}..${endDate}` : ''}] across ${targetInstruments.length} configured indices...`,
    );

    // 3. Build Yahoo Finance daily (PDH/PDL) & 5m candle batch requests
    const dailyRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        return {
          symbol: inst.symbol,
          interval: '1d',
          // Fetch 14 calendar days prior so weekends/market holidays always have a valid prior trading day
          period1: startBounds.startSec - 14 * ONE_DAY_SEC,
          period2: endBounds.endSec + ONE_DAY_SEC,
        };
      }
      return {
        symbol: inst.symbol,
        interval: '1d',
        range: '1mo',
      };
    });

    const fiveMinRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        // Fetch ~4 days prior (for prior session context/chart bars) and +1 day after (for post-signal chart bars)
        const period1 = startBounds.startSec - 4 * ONE_DAY_SEC;
        const period2 = Math.min(currentNowSec, endBounds.endSec + ONE_DAY_SEC);
        return {
          symbol: inst.symbol,
          interval: '5m',
          period1,
          period2,
        };
      }
      return {
        symbol: inst.symbol,
        interval: '5m',
        range: '5d',
      };
    });

    const [dailyMap, fiveMinMap] = await Promise.all([
      this.yahoo.getCandlesBatch(dailyRequests, { batchSize: 4, throttleMs: 100 }),
      this.yahoo.getCandlesBatch(fiveMinRequests, { batchSize: 4, throttleMs: 100 }),
    ]);

    // 4. Evaluate Liquidity Sweep & Reversal on each configured index
    const recommendations: LiquiditySweepSignal[] = [];

    for (const inst of targetInstruments) {
      const fiveMinResp =
        fiveMinMap.get(inst.symbol) || fiveMinMap.get(inst.symbol.toUpperCase());
      const dailyResp =
        dailyMap.get(inst.symbol) || dailyMap.get(inst.symbol.toUpperCase());

      const raw5m = fiveMinResp?.candles || [];
      const rawDaily = dailyResp?.candles || [];

      if (raw5m.length === 0) {
        continue;
      }

      const detected =
        mode === 'historical' && startDate && endDate
          ? LiquiditySweepStrategy.scanHistorical(
              inst.symbol,
              inst.displayName,
              raw5m,
              rawDaily,
              startDate,
              endDate,
              currentNowSec,
            )
          : LiquiditySweepStrategy.scanLive(
              inst.symbol,
              inst.displayName,
              raw5m,
              rawDaily,
              currentNowSec,
            );

      for (const sig of detected) {
        sig.displayName = inst.displayName;
        recommendations.push(sig);
      }
    }

    // 5. Sort recommendations newest confirmation first, then by displayName
    recommendations.sort((a, b) => {
      if (b.confirmationTimestamp !== a.confirmationTimestamp) {
        return b.confirmationTimestamp - a.confirmationTimestamp;
      }
      return (a.displayName || a.symbol).localeCompare(b.displayName || b.symbol);
    });

    const bullishCount = recommendations.filter((r) => r.signalType === 'BUY').length;
    const bearishCount = recommendations.filter((r) => r.signalType === 'SELL').length;
    const elapsedMs = Date.now() - startTimeMs;

    // 6. Generate Standalone Liquidity Sweep data via liquiditySweepScanner module
    const standaloneResults: LiquiditySweepSymbolResult[] = [];
    for (const inst of targetInstruments) {
      const fiveMinResp =
        fiveMinMap.get(inst.symbol) || fiveMinMap.get(inst.symbol.toUpperCase());
      const dailyResp =
        dailyMap.get(inst.symbol) || dailyMap.get(inst.symbol.toUpperCase());

      const raw5m = LiquiditySweepStrategy.normalizeCandles(fiveMinResp?.candles || []);
      const rawDaily = LiquiditySweepStrategy.normalizeCandles(dailyResp?.candles || []);

      if (raw5m.length === 0) continue;

      const grouped = LiquiditySweepStrategy.groupByIstSession(raw5m);
      const sortedDates = Array.from(grouped.keys()).sort();
      const latestDate =
        sortedDates[sortedDates.length - 1] || LiquiditySweepStrategy.toIstDateKey(currentNowSec);
      const { pdh, pdl } = LiquiditySweepStrategy.resolvePriorDayLevels(
        latestDate,
        rawDaily,
        grouped,
      );

      const analyzed = analyzeLiquiditySweep(
        inst.symbol,
        inst.displayName,
        raw5m,
        [],
        {
          mode,
          timeframe: (dto?.timeframe as any) || '5m',
          startDate,
          endDate,
          swingLookback: dto?.swingLookback,
          eqToleranceATR: dto?.eqToleranceATR,
          minSweepDepthATR: dto?.minSweepDepthATR,
          maxReclaimBars: dto?.maxReclaimBars,
          includeSessionExtremes: dto?.includeSessionExtremes,
          pdh,
          pdl,
          entryMode: dto?.entryMode,
          minRR: dto?.minRR,
        },
      );
      standaloneResults.push(analyzed);
    }

    const liquiditySweepData = compileLiquiditySweepResults(
      standaloneResults,
      targetInstruments.map((i) => ({
        symbol: i.symbol,
        displayName: i.displayName,
        name: i.displayName,
      })),
      { mode, timeframe: (dto?.timeframe as any) || '5m', startDate, endDate },
      currentNowSec,
    );

    this.logger.log(
      `✅ 5m Liquidity Sweep scan finished in ${elapsedMs}ms [mode=${mode}]: ${recommendations.length} signals (${bullishCount} BUY, ${bearishCount} SELL) across ${targetInstruments.length} traded instruments.`,
    );

    return {
      mode,
      strategy: 'LIQUIDITY_SWEEP',
      timeframe: (dto?.timeframe as any) || '5m',
      startDate,
      endDate,
      scannedAt: new Date(currentNowSec * 1000).toISOString(),
      instrumentsScanned: targetInstruments.map((i) => ({
        symbol: i.symbol,
        displayName: i.displayName,
        name: i.displayName,
      })),
      totalScanned: targetInstruments.length,
      totalRecommendations: recommendations.length,
      bullishCount,
      bearishCount,
      recommendations,
      liquiditySweepData,
    };
  }

  /**
   * Execute dedicated on-demand Standalone Liquidity Sweep Strategy scan.
   * Completely decoupled from Order Block SMC module.
   */
  async scanLiquiditySweeps(
    dto: ScreenerScanDto,
    nowSec?: number,
  ): Promise<LiquiditySweepScanResponse> {
    const mode: ScreenerScanMode = dto?.mode === 'historical' ? 'historical' : 'live';
    const currentNowSec = nowSec ?? Math.floor(Date.now() / 1000);
    const startTimeMs = Date.now();
    const timeframe = dto?.timeframe || '15m';

    let startDate: string | undefined;
    let endDate: string | undefined;

    if (mode === 'historical') {
      const resolved = this.validateAndResolveHistoricalDates(dto, currentNowSec);
      startDate = resolved.startDate;
      endDate = resolved.endDate;
    }

    let targetInstruments = await this.getConfiguredInstruments();
    if (dto?.symbols && dto.symbols.length > 0) {
      const allowed = new Set(dto.symbols.map((s) => s.trim().toUpperCase()));
      targetInstruments = targetInstruments.filter(
        (inst) =>
          allowed.has(inst.symbol.trim().toUpperCase()) ||
          allowed.has(inst.displayName.trim().toUpperCase()),
      );
    }

    if (targetInstruments.length === 0) {
      return compileLiquiditySweepResults(
        [],
        [],
        { mode, timeframe, startDate, endDate },
        currentNowSec,
      );
    }

    this.logger.log(
      `🔎 Starting dedicated Standalone Liquidity Sweep scan [mode=${mode}, timeframe=${timeframe}] across ${targetInstruments.length} instruments...`,
    );

    const dailyRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        return {
          symbol: inst.symbol,
          interval: '1d',
          period1: startBounds.startSec - 14 * ONE_DAY_SEC,
          period2: endBounds.endSec + ONE_DAY_SEC,
        };
      }
      return {
        symbol: inst.symbol,
        interval: '1d',
        range: '1mo',
      };
    });

    const primaryRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        const period1 = startBounds.startSec - 4 * ONE_DAY_SEC;
        const period2 = Math.min(currentNowSec, endBounds.endSec + ONE_DAY_SEC);
        return {
          symbol: inst.symbol,
          interval: timeframe,
          period1,
          period2,
        };
      }
      return {
        symbol: inst.symbol,
        interval: timeframe,
        range: '5d',
      };
    });

    let ltfMap = new Map<string, any>();
    if (dto?.entryMode === 'LTF_STRUCTURE_SHIFT' && timeframe !== '5m') {
      const ltfRequests = targetInstruments.map((inst) => {
        if (mode === 'historical' && startDate && endDate) {
          const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
          const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
          return {
            symbol: inst.symbol,
            interval: '5m',
            period1: startBounds.startSec - 2 * ONE_DAY_SEC,
            period2: Math.min(currentNowSec, endBounds.endSec + ONE_DAY_SEC),
          };
        }
        return {
          symbol: inst.symbol,
          interval: '5m',
          range: '5d',
        };
      });
      ltfMap = await this.yahoo.getCandlesBatch(ltfRequests, { batchSize: 4, throttleMs: 100 });
    }

    const [dailyMap, primaryMap] = await Promise.all([
      this.yahoo.getCandlesBatch(dailyRequests, { batchSize: 4, throttleMs: 100 }),
      this.yahoo.getCandlesBatch(primaryRequests, { batchSize: 4, throttleMs: 100 }),
    ]);

    const results: LiquiditySweepSymbolResult[] = [];

    for (const inst of targetInstruments) {
      const primaryResp =
        primaryMap.get(inst.symbol) || primaryMap.get(inst.symbol.toUpperCase());
      const dailyResp = dailyMap.get(inst.symbol) || dailyMap.get(inst.symbol.toUpperCase());
      const ltfResp = ltfMap.get(inst.symbol) || ltfMap.get(inst.symbol.toUpperCase());

      const rawPrimary = LiquiditySweepStrategy.normalizeCandles(primaryResp?.candles || []);
      const rawDaily = LiquiditySweepStrategy.normalizeCandles(dailyResp?.candles || []);
      const rawLtf = LiquiditySweepStrategy.normalizeCandles(ltfResp?.candles || []);

      if (rawPrimary.length === 0) continue;

      const grouped = LiquiditySweepStrategy.groupByIstSession(rawPrimary);
      const sortedDates = Array.from(grouped.keys()).sort();
      const latestDate =
        sortedDates[sortedDates.length - 1] || LiquiditySweepStrategy.toIstDateKey(currentNowSec);
      const { pdh, pdl } = LiquiditySweepStrategy.resolvePriorDayLevels(
        latestDate,
        rawDaily,
        grouped,
      );

      const analyzed = analyzeLiquiditySweep(
        inst.symbol,
        inst.displayName,
        rawPrimary,
        rawLtf,
        {
          mode,
          timeframe,
          startDate,
          endDate,
          swingLookback: dto?.swingLookback,
          eqToleranceATR: dto?.eqToleranceATR,
          minSweepDepthATR: dto?.minSweepDepthATR,
          maxReclaimBars: dto?.maxReclaimBars,
          includeSessionExtremes: dto?.includeSessionExtremes,
          pdh,
          pdl,
          entryMode: dto?.entryMode,
          minRR: dto?.minRR,
        },
      );

      results.push(analyzed);
    }

    const compiled = compileLiquiditySweepResults(
      results,
      targetInstruments.map((i) => ({
        symbol: i.symbol,
        displayName: i.displayName,
        name: i.displayName,
      })),
      { mode, timeframe, startDate, endDate },
      currentNowSec,
    );

    const elapsedMs = Date.now() - startTimeMs;
    this.logger.log(
      `✅ Dedicated Standalone Liquidity Sweep scan finished in ${elapsedMs}ms: ${compiled.totalActivePools} active pools, ${compiled.totalSignals} signals (${compiled.bullishCount} BUY, ${compiled.bearishCount} SELL).`,
    );

    return compiled;
  }

  private validateAndResolveHistoricalDates(
    dto: ScreenerScanDto,
    nowSec: number,
  ): { startDate: string; endDate: string } {
    const startDate = dto.startDate || dto.date;
    const endDate = dto.endDate || dto.date || dto.startDate;

    if (!startDate || !endDate) {
      throw new BadRequestException(
        'Historical scan requires a date (YYYY-MM-DD) or startDate/endDate range.',
      );
    }

    const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
    const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);

    if (Number.isNaN(startBounds.startSec) || Number.isNaN(endBounds.endSec)) {
      throw new BadRequestException('Invalid date format. Expected YYYY-MM-DD.');
    }

    if (startDate > endDate) {
      throw new BadRequestException('startDate must be earlier than or equal to endDate.');
    }

    const todayIst = LiquiditySweepStrategy.toIstDateKey(nowSec);
    if (startDate > todayIst) {
      throw new BadRequestException('Historical scan date cannot be in the future.');
    }

    const rangeDays = Math.round((endBounds.startSec - startBounds.startSec) / ONE_DAY_SEC) + 1;
    if (rangeDays > MAX_HISTORICAL_RANGE_DAYS) {
      throw new BadRequestException(
        `Historical date range cannot exceed ${MAX_HISTORICAL_RANGE_DAYS} days per scan.`,
      );
    }

    const minAllowedSec = nowSec - MAX_YAHOO_5M_LOOKBACK_DAYS * ONE_DAY_SEC;
    if (startBounds.startSec < minAllowedSec) {
      throw new BadRequestException(
        'Yahoo Finance provides 5-minute intraday history for up to the past 59 days. Please choose a more recent date.',
      );
    }

    return { startDate, endDate };
  }

  /**
   * Execute on-demand Multi-Timeframe Order Block (SMC / Supply & Demand) scan.
   * Scans configured indices using HTF (1H/4H) + LTF (5m/15m) candles.
   */
  async scanOrderBlocks(
    dto: ScreenerScanDto,
    nowSec?: number,
  ): Promise<OrderBlockScanResponse> {
    const mode: ScreenerScanMode = dto?.mode === 'historical' ? 'historical' : 'live';
    const currentNowSec = nowSec ?? Math.floor(Date.now() / 1000);
    const startTimeMs = Date.now();
    const htfTimeframe = dto.htfTimeframe || '1h';
    const ltfTimeframe = dto.ltfTimeframe || '5m';

    let startDate: string | undefined;
    let endDate: string | undefined;

    if (mode === 'historical') {
      const resolved = this.validateAndResolveHistoricalDates(dto, currentNowSec);
      startDate = resolved.startDate;
      endDate = resolved.endDate;
    }

    let targetInstruments = await this.getConfiguredInstruments();
    if (dto?.symbols && dto.symbols.length > 0) {
      const allowed = new Set(dto.symbols.map((s) => s.trim().toUpperCase()));
      targetInstruments = targetInstruments.filter(
        (inst) =>
          allowed.has(inst.symbol.trim().toUpperCase()) ||
          allowed.has(inst.displayName.trim().toUpperCase()),
      );
    }

    if (targetInstruments.length === 0) {
      return OrderBlockStrategy.compileScanResults(
        [],
        [],
        {
          mode,
          htfTimeframe,
          ltfTimeframe,
          startDate,
          endDate,
        },
        currentNowSec,
      );
    }

    this.logger.log(
      `🔎 Starting on-demand Multi-Timeframe Order Block scan [mode=${mode}, HTF=${htfTimeframe}, LTF=${ltfTimeframe}] across ${targetInstruments.length} instruments...`,
    );

    // Fetch HTF candles (1h) and LTF candles (5m or 15m)
    const htfRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        return {
          symbol: inst.symbol,
          interval: '1h',
          period1: startBounds.startSec - 30 * ONE_DAY_SEC,
          period2: endBounds.endSec + ONE_DAY_SEC,
        };
      }
      return {
        symbol: inst.symbol,
        interval: '1h',
        range: '1mo',
      };
    });

    const ltfRequests = targetInstruments.map((inst) => {
      if (mode === 'historical' && startDate && endDate) {
        const startBounds = LiquiditySweepStrategy.getIstDayBounds(startDate);
        const endBounds = LiquiditySweepStrategy.getIstDayBounds(endDate);
        return {
          symbol: inst.symbol,
          interval: ltfTimeframe,
          period1: startBounds.startSec - 2 * ONE_DAY_SEC,
          period2: Math.min(currentNowSec, endBounds.endSec + ONE_DAY_SEC),
        };
      }
      return {
        symbol: inst.symbol,
        interval: ltfTimeframe,
        range: '5d',
      };
    });

    const [htfMap, ltfMap] = await Promise.all([
      this.yahoo.getCandlesBatch(htfRequests, { batchSize: 4, throttleMs: 100 }),
      this.yahoo.getCandlesBatch(ltfRequests, { batchSize: 4, throttleMs: 100 }),
    ]);

    const results: OrderBlockSymbolResult[] = [];

    for (const inst of targetInstruments) {
      const htfResp = htfMap.get(inst.symbol) || htfMap.get(inst.symbol.toUpperCase());
      const ltfResp = ltfMap.get(inst.symbol) || ltfMap.get(inst.symbol.toUpperCase());

      let htfCandles = LiquiditySweepStrategy.normalizeCandles(htfResp?.candles || []);
      const ltfCandles = LiquiditySweepStrategy.normalizeCandles(ltfResp?.candles || []);

      // If HTF is 4h, aggregate 1h candles into 4h bars
      if (htfTimeframe === '4h' && htfCandles.length > 0) {
        htfCandles = this.aggregateCandles(htfCandles, 4);
      }

      const analyzed = OrderBlockStrategy.analyzeInstrument(
        inst.symbol,
        inst.displayName,
        htfCandles,
        ltfCandles,
        {
          mode,
          htfTimeframe,
          ltfTimeframe,
          startDate,
          endDate,
          swingLookback: dto.swingLookback,
          requireFVG: dto.requireFVG,
          minRR: dto.minRR,
          entryMode: dto.entryMode,
          proximityPercent: dto.proximityPercent,
        },
      );

      results.push(analyzed);
    }

    const compiled = OrderBlockStrategy.compileScanResults(
      results,
      targetInstruments.map((i) => ({ symbol: i.symbol, displayName: i.displayName, name: i.displayName })),
      {
        mode,
        htfTimeframe,
        ltfTimeframe,
        startDate,
        endDate,
      },
      currentNowSec,
    );

    const elapsedMs = Date.now() - startTimeMs;
    this.logger.log(
      `✅ Order Block scan finished in ${elapsedMs}ms: ${compiled.totalActiveOrderBlocks} active OBs, ${compiled.approachingCount} approaching, ${compiled.mitigatingCount} mitigating, ${compiled.sniperSignalCount} sniper setups.`,
    );

    return compiled;
  }

  /**
   * Helper to aggregate N candles into 1 higher-timeframe candle.
   */
  private aggregateCandles(candles: ScreenerCandle[], groupSize: number): ScreenerCandle[] {
    const aggregated: ScreenerCandle[] = [];
    for (let i = 0; i < candles.length; i += groupSize) {
      const slice = candles.slice(i, i + groupSize);
      if (slice.length === 0) continue;

      const first = slice[0];
      const last = slice[slice.length - 1];
      const high = Math.max(...slice.map((c) => c.high));
      const low = Math.min(...slice.map((c) => c.low));
      const volume = slice.reduce((sum, c) => sum + (c.volume || 0), 0);

      aggregated.push({
        time: first.time,
        open: first.open,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: last.close,
        volume,
      });
    }
    return aggregated;
  }
}
