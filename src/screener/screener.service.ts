import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { ScreenerScanDto } from './dto/screener-scan.dto';
import {
  LiquiditySweepSignal,
  ScreenerInstrumentItem,
  ScreenerScanMode,
  ScreenerScanResponse,
} from './models/screener.models';
import { LiquiditySweepStrategy } from './strategies/liquidity-sweep.strategy';

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
   * Execute strictly on-demand 5-minute Liquidity Sweep & Reversal scan
   * across the configured indices from Firestore config/lot_sizes.
   */
  async scan(dto: ScreenerScanDto, nowSec?: number): Promise<ScreenerScanResponse> {
    const mode: ScreenerScanMode = dto?.mode === 'historical' ? 'historical' : 'live';
    const currentNowSec = nowSec ?? Math.floor(Date.now() / 1000);
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

    this.logger.log(
      `✅ 5m Liquidity Sweep scan finished in ${elapsedMs}ms [mode=${mode}]: ${recommendations.length} signals (${bullishCount} BUY, ${bearishCount} SELL) across ${targetInstruments.length} traded instruments.`,
    );

    return {
      mode,
      timeframe: '5m',
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
    };
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
}
