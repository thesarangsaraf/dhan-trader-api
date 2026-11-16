import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService, ScreenerWatchlistDoc, ScreenerSettingsDoc } from '../firestore/firestore.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { ScreenerScanDto } from './dto/screener-scan.dto';
import { UpdateWatchlistDto } from './dto/update-watchlist.dto';
import { ScreenerMatch, ScreenerScanResponse } from './models/screener.models';
import { OrderBlockStrategy } from './strategies/order-block.strategy';
import { LiquiditySweepStrategy } from './strategies/liquidity-sweep.strategy';

@Injectable()
export class ScreenerService {
  private readonly logger = new Logger(ScreenerService.name);

  constructor(
    private readonly firestore: FirestoreService,
    private readonly yahoo: YahooFinanceService,
  ) {}

  /**
   * Retrieve the configured stock universe watchlist from Firestore.
   */
  async getWatchlist(): Promise<ScreenerWatchlistDoc> {
    return this.firestore.getScreenerWatchlist();
  }

  /**
   * Update the watchlist stocks in Firestore.
   */
  async updateWatchlist(dto: UpdateWatchlistDto) {
    return this.firestore.saveScreenerWatchlist(dto.symbols);
  }

  /**
   * Reset the watchlist back to the default 28 large-cap NSE stocks.
   */
  async resetWatchlist() {
    return this.firestore.resetScreenerWatchlist();
  }

  /**
   * Retrieve configurable strategy settings from Firestore.
   */
  async getSettings(): Promise<ScreenerSettingsDoc> {
    return this.firestore.getScreenerSettings();
  }

  /**
   * Update configurable strategy settings in Firestore.
   */
  async updateSettings(dto: Partial<ScreenerSettingsDoc>) {
    return this.firestore.saveScreenerSettings(dto);
  }

  /**
   * Execute technical price action scan across the configured stock watchlist.
   * Scans for Supply/Demand Order Blocks and Liquidity Sweep Reversals.
   */
  async scan(dto: ScreenerScanDto): Promise<ScreenerScanResponse> {
    const timeframe = dto.timeframe || '15m';
    const startTime = Date.now();

    // 1. Fetch stock universe & strategy configuration from Firestore
    const [watchlistDoc, settings] = await Promise.all([
      this.getWatchlist(),
      this.getSettings(),
    ]);

    let targetStocks = watchlistDoc.symbols || [];

    // Filter to active stocks
    if (dto.symbols && dto.symbols.length > 0) {
      const allowed = new Set(dto.symbols.map((s) => s.toUpperCase()));
      targetStocks = targetStocks.filter((st) => allowed.has(st.symbol.toUpperCase()));
    } else {
      targetStocks = targetStocks.filter((st) => st.enabled !== false);
    }

    if (targetStocks.length === 0) {
      return {
        timeframe,
        scannedAt: new Date().toISOString(),
        totalScanned: 0,
        totalMatches: 0,
        bullishMatches: 0,
        bearishMatches: 0,
        matches: [],
      };
    }

    this.logger.log(`🔎 Starting technical scan on ${targetStocks.length} stocks (Timeframe: ${timeframe})...`);

    // 2. Prepare candle requests for Yahoo Finance
    const candleRequests = targetStocks.map((stock) => ({
      symbol: stock.symbol,
      interval: timeframe,
    }));

    // 3. Batch fetch historical candles with controlled concurrency
    const candleMap = await this.yahoo.getCandlesBatch(candleRequests, {
      batchSize: settings.batchSize || 5,
      throttleMs: settings.throttleMs || 150,
    });

    // 4. Run strategy detection on each stock's OHLCV series
    const matches: ScreenerMatch[] = [];

    for (const stock of targetStocks) {
      const candleResponse = candleMap.get(stock.symbol) || candleMap.get(stock.symbol.toUpperCase());
      if (!candleResponse || !candleResponse.candles || candleResponse.candles.length < 10) {
        continue;
      }

      const candles = candleResponse.candles;

      // Strategy A: Supply & Demand (Order Blocks)
      let match = OrderBlockStrategy.evaluate(
        candles,
        stock.symbol,
        stock.name,
        timeframe,
        settings,
      );

      // Strategy B: Liquidity Sweep Reversal (if Strategy A did not match)
      if (!match) {
        match = LiquiditySweepStrategy.evaluate(
          candles,
          stock.symbol,
          stock.name,
          timeframe,
          settings,
        );
      }

      if (match) {
        matches.push(match);
      }
    }

    // Sort: Bullish setups first, then lowest risk percentage
    matches.sort((a, b) => {
      if (a.signalType !== b.signalType) {
        return a.signalType === 'BUY' ? -1 : 1;
      }
      return a.riskPercent - b.riskPercent;
    });

    const bullishCount = matches.filter((m) => m.signalType === 'BUY').length;
    const bearishCount = matches.filter((m) => m.signalType === 'SELL').length;
    const elapsed = Date.now() - startTime;

    this.logger.log(
      `✅ Scan complete in ${elapsed}ms: ${matches.length} setups found (${bullishCount} Bullish, ${bearishCount} Bearish) across ${targetStocks.length} tickers.`,
    );

    return {
      timeframe,
      scannedAt: new Date().toISOString(),
      totalScanned: targetStocks.length,
      totalMatches: matches.length,
      bullishMatches: bullishCount,
      bearishMatches: bearishCount,
      matches,
    };
  }
}
