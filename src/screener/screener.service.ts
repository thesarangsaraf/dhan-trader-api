import { Injectable, Logger, Optional } from '@nestjs/common';
import { YahooFinanceService, CandleData, ChartCandlesResponse } from '../yahoo/yahoo.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { ScanRequestDto } from './dto/scan-request.dto';
import {
  ScreenerSignal,
  BacktestSummary,
  ScanResultResponse,
  ScreenerInstrumentItem,
} from './screener.types';
import {
  scan5mCandles,
  calculateBacktestSummary,
} from './screener-scanner';

@Injectable()
export class ScreenerService {
  private readonly logger = new Logger(ScreenerService.name);

  constructor(
    private readonly yahooService: YahooFinanceService,
    @Optional() private readonly instrumentsService?: InstrumentsService,
  ) {}

  /**
   * Retrieve list of candidate instruments from Master Instrument List that can be screened on Yahoo Finance.
   */
  public async getAvailableInstruments(): Promise<ScreenerInstrumentItem[]> {
    const list: ScreenerInstrumentItem[] = [];
    const seenSymbols = new Set<string>();

    // 1. Configured Traded Indices
    let indices = this.instrumentsService?.getConfiguredIndicesSync() || [];
    if (indices.length === 0) {
      indices = [
        { symbol: 'NIFTY 50', name: 'NIFTY 50 Index', securityId: '13', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
        { symbol: 'BANK NIFTY', name: 'NIFTY BANK Index', securityId: '25', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
        { symbol: 'MIDCAP NIFTY', name: 'NIFTY MIDCAP SELECT Index', securityId: '442', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
        { symbol: 'SENSEX', name: 'BSE SENSEX Index', securityId: '51', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
      ];
    }

    for (const idx of indices) {
      let sym = (idx.symbol || '').trim();
      const upper = sym.toUpperCase();
      if (upper === 'NIFTY 50' || upper === 'NIFTY') sym = 'NIFTY 50';
      else if (upper === 'BANK NIFTY' || upper === 'BANKNIFTY') sym = 'BANK NIFTY';
      else if (upper === 'MIDCAP NIFTY' || upper === 'MIDCPNIFTY') sym = 'MIDCAP NIFTY';
      else if (upper === 'SENSEX') sym = 'SENSEX';

      const yahooSymbol = this.yahooService.mapToYahooSymbol(sym);
      if (yahooSymbol && !seenSymbols.has(sym.toUpperCase())) {
        seenSymbols.add(sym.toUpperCase());
        list.push({
          symbol: sym,
          name: idx.displayName || idx.name || sym,
          displayName: idx.displayName || sym,
          securityId: idx.securityId || '',
          exchangeSegment: idx.exchangeSegment || 'IDX_I',
          instrumentType: idx.instrumentType || 'INDEX',
          yahooSymbol,
          isIndex: true,
        });
      }
    }

    // 2. Cash Equities from Master Instrument List
    if (this.instrumentsService) {
      try {
        await this.instrumentsService.ensureDataLoaded();
      } catch {
        // Continue with available data
      }

      const popular = this.instrumentsService.getPopularInstruments() || [];
      for (const item of popular) {
        const sym = item.symbol.trim();
        if (seenSymbols.has(sym.toUpperCase())) continue;
        const yahooSymbol = this.yahooService.mapToYahooSymbol(sym);
        if (yahooSymbol) {
          seenSymbols.add(sym.toUpperCase());
          list.push({
            symbol: sym,
            name: item.name || sym,
            displayName: item.displayName || sym,
            securityId: item.securityId || '',
            exchangeSegment: item.exchangeSegment || 'NSE_EQ',
            instrumentType: item.instrumentType || 'EQUITY',
            yahooSymbol,
            isIndex: item.instrumentType === 'INDEX' || item.exchangeSegment === 'IDX_I',
          });
        }
      }
    }

    return list;
  }

  /**
   * Fetch 5m candles for a specific symbol using Yahoo Finance.
   */
  public async get5mCandles(symbol: string, range: '5d' | '15d' | '30d' | '60d' = '60d'): Promise<ChartCandlesResponse> {
    return this.yahooService.getCandles({
      symbol,
      interval: '5m',
      range,
    });
  }

  /**
   * Run the 5-minute trade screener & backtester across target instruments.
   */
  public async runScan(dto: ScanRequestDto): Promise<ScanResultResponse> {
    const lookbackPeriod = dto.lookbackPeriod || '60d';
    const swingLookback = dto.swingLookback ?? 20;
    const slBuffer = dto.slBuffer ?? 3;
    const targetRr = dto.targetRr ?? 2.0;
    const maxRetestBars = dto.maxRetestBars ?? 15;

    // Resolve target instruments
    const available = await this.getAvailableInstruments();
    const availableBySym = new Map<string, ScreenerInstrumentItem>();
    for (const item of available) {
      availableBySym.set(item.symbol.toUpperCase(), item);
      availableBySym.set(item.yahooSymbol.toUpperCase(), item);
    }

    let targetItems: ScreenerInstrumentItem[] = [];

    if (dto.symbols && dto.symbols.length > 0) {
      for (const sym of dto.symbols) {
        const clean = sym.trim().toUpperCase();
        const matched = availableBySym.get(clean);
        if (matched) {
          targetItems.push(matched);
        } else {
          const yahooSym = this.yahooService.mapToYahooSymbol(sym);
          if (yahooSym) {
            targetItems.push({
              symbol: sym.trim(),
              name: sym.trim(),
              securityId: '',
              exchangeSegment: 'NSE_EQ',
              instrumentType: 'EQUITY',
              yahooSymbol: yahooSym,
              isIndex: false,
            });
          }
        }
      }
    } else if (dto.scope === 'all') {
      targetItems = available;
    } else {
      // Default: Strictly Traded Indices Only (NIFTY 50, BANK NIFTY, MIDCAP NIFTY, SENSEX)
      targetItems = available.filter((item) => item.isIndex);
    }

    // De-duplicate target items
    const uniqueTargets: ScreenerInstrumentItem[] = [];
    const seen = new Set<string>();
    for (const item of targetItems) {
      const key = item.yahooSymbol.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTargets.push(item);
      }
    }

    this.logger.log(
      `🔍 Running 5m Screener on ${uniqueTargets.length} instrument(s) (Lookback: ${lookbackPeriod}, RR: ${targetRr})`,
    );

    const allSignals: ScreenerSignal[] = [];
    let scannedCount = 0;
    let matchedSymbolsCount = 0;
    let totalCandlesScanned = 0;

    // Batch fetching with concurrency throttling to prevent rate limiting
    const batchSize = 4;
    const throttleDelayMs = 120;

    for (let i = 0; i < uniqueTargets.length; i += batchSize) {
      const batch = uniqueTargets.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const chartData = await this.yahooService.getCandles({
              symbol: item.symbol,
              interval: '5m',
              range: lookbackPeriod,
            });
            return { item, candles: chartData.candles };
          } catch (err: any) {
            this.logger.warn(`Skipping ${item.symbol} (${item.yahooSymbol}): ${err.message}`);
            return null;
          }
        }),
      );

      for (const res of batchResults) {
        if (res.status === 'fulfilled' && res.value && res.value.candles.length > 0) {
          const { item, candles } = res.value;
          scannedCount++;
          totalCandlesScanned += candles.length;

          // Scan 5-minute candles
          const detected = scan5mCandles(candles, {
            symbol: item.symbol,
            name: item.name || item.displayName || item.symbol,
            swingLookback,
            slBuffer,
            targetRr,
            maxRetestBars,
          });

          if (detected.length > 0) {
            matchedSymbolsCount++;
            allSignals.push(...detected);
          }
        }
      }

      if (i + batchSize < uniqueTargets.length && throttleDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, throttleDelayMs));
      }
    }

    // Sort all detected signals descending by entryTime
    allSignals.sort((a, b) => b.entryTime - a.entryTime);

    // Compute backtest summary metrics
    const summary = calculateBacktestSummary(allSignals);

    this.logger.log(
      `✅ Scan completed: ${scannedCount} symbols scanned, ${allSignals.length} signals detected across ${matchedSymbolsCount} symbol(s), Win Rate: ${summary.winRate}%, Net R: ${summary.netRMultiple}`,
    );

    return {
      success: true,
      timestamp: new Date().toISOString(),
      scannedSymbolsCount: scannedCount,
      matchedSymbolsCount,
      totalCandlesScanned,
      parameters: {
        lookbackPeriod,
        swingLookback,
        slBuffer,
        targetRr,
        maxRetestBars,
      },
      summary,
      signals: allSignals,
    };
  }
}
