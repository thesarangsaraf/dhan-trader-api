import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

export interface OptionDetails {
  isOption: boolean;
  underlying?: string;
  strike?: number;
  type?: 'CE' | 'PE';
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartCandlesResponse {
  symbol: string;
  yahooSymbol: string;
  interval: string;
  range: string;
  period1?: number;
  period2?: number;
  currency: string;
  exchange: string;
  lastPrice: number;
  count: number;
  candles: CandleData[];
}

@Injectable()
export class YahooFinanceService {
  private readonly cache = new Map<string, { price: number; timestamp: number }>();
  private readonly cacheTtlMs = 3000; // 3 seconds TTL to avoid spamming Yahoo
  private readonly candleCache = new Map<string, { data: ChartCandlesResponse; timestamp: number }>();
  private readonly candleCacheTtlMs = 60000; // 60 seconds TTL for candle charts & scans

  constructor(@Optional() private readonly config?: ConfigService) {}

  private getBaseUrl(): string {
    return (this.config?.yahooFinanceBaseUrl || process.env.YAHOO_FINANCE_BASE_URL || '').trim();
  }

  private readonly INDEX_MAP: Record<string, string> = {
    'NIFTY 50': '^NSEI',
    'NIFTY': '^NSEI',
    'NIFTY BANK': '^NSEBANK',
    'BANK NIFTY': '^NSEBANK',
    'BANKNIFTY': '^NSEBANK',
    'SENSEX': '^BSESN',
    'BSE SENSEX': '^BSESN',
    'MIDCAP NIFTY': 'NIFTY_MID_SELECT.NS',
    'MIDCP NIFTY': 'NIFTY_MID_SELECT.NS',
    'MIDCPNIFTY': 'NIFTY_MID_SELECT.NS',
    'NIFTY MIDCAP SELECT': 'NIFTY_MID_SELECT.NS',
    'FINNIFTY': 'NIFTY_FIN_SERVICE.NS',
    'NIFTY FIN SERVICE': 'NIFTY_FIN_SERVICE.NS',
    'NIFTY FINANCIAL SERVICES': 'NIFTY_FIN_SERVICE.NS',
  };

  /**
   * Map internal symbol / name to Yahoo Finance ticker.
   */
  mapToYahooSymbol(symbol: string): string | null {
    if (!symbol) return null;
    const clean = symbol.trim().toUpperCase();

    // Check predefined index map
    if (this.INDEX_MAP[clean]) {
      return this.INDEX_MAP[clean];
    }

    // Direct Yahoo symbol passes
    if (clean.startsWith('^') || clean.endsWith('.NS') || clean.endsWith('.BO')) {
      return clean;
    }

    // If it is standard equity ticker without spaces (e.g. RELIANCE, TCS, INFY)
    if (/^[A-Z0-9&-]+$/.test(clean)) {
      return `${clean}.NS`;
    }

    return null;
  }

  /**
   * Parse option strings like:
   * - "NIFTY 24500 CE", "BANKNIFTY 52000 PE"
   * - "NIFTY 01 DEC 25300 CALL", "NIFTY 01 DEC 25300 PUT"
   * - "NIFTY-Dec2026-25300-CE", "NIFTY-01Dec2026-25300-PE"
   * - "RELIANCE 3000 CE", "SENSEX 28 NOV 80000 CALL"
   */
  parseOptionSymbol(symbol: string): OptionDetails {
    if (!symbol) return { isOption: false };

    const clean = symbol.trim().toUpperCase();

    // 1. Identify option type from the end of the symbol: CE, PE, CALL, PUT
    const typeMatch = clean.match(/[\s\-_](CE|PE|CALL|PUT)$/);
    if (!typeMatch) {
      return { isOption: false };
    }

    const typeStr = typeMatch[1];
    const type: 'CE' | 'PE' = typeStr === 'CALL' || typeStr === 'CE' ? 'CE' : 'PE';

    // 2. Extract strike price: the last sequence of digits preceding the option type
    const beforeType = clean.slice(0, typeMatch.index).trim();
    const strikeMatch = beforeType.match(/(\d{3,6})(?:[^\d]*)$/);
    if (!strikeMatch) {
      return { isOption: false };
    }

    const strike = parseFloat(strikeMatch[1]);
    if (isNaN(strike) || strike <= 0) {
      return { isOption: false };
    }

    // 3. Resolve underlying symbol
    let underlying = 'NIFTY 50';
    if (clean.includes('BANK')) {
      underlying = 'BANK NIFTY';
    } else if (clean.includes('MIDCAP') || clean.includes('MIDCP')) {
      underlying = 'MIDCAP NIFTY';
    } else if (clean.includes('FINNIFTY') || clean.includes('FIN NIFTY')) {
      underlying = 'FINNIFTY';
    } else if (clean.includes('SENSEX') || clean.includes('BSX')) {
      underlying = 'SENSEX';
    } else if (clean.includes('NIFTY')) {
      underlying = 'NIFTY 50';
    } else {
      const stockMatch = beforeType.match(/^([A-Z0-9&-]+)/);
      if (stockMatch) {
        underlying = stockMatch[1];
      }
    }

    return {
      isOption: true,
      underlying,
      strike,
      type,
    };
  }

  /**
   * Calculate realistic option LTP from underlying spot and strike when market feed is offline.
   */
  calculateOptionLtp(strike: number, type: 'CE' | 'PE', underlyingLtp: number): number {
    if (!underlyingLtp || underlyingLtp <= 0 || !strike || strike <= 0) {
      return 0;
    }

    const intrinsic = type === 'CE'
      ? Math.max(0, underlyingLtp - strike)
      : Math.max(0, strike - underlyingLtp);

    const distanceRatio = Math.abs(underlyingLtp - strike) / underlyingLtp;
    const baseAtmPremium = Math.round(underlyingLtp * 0.0035 * 10) / 10; // ~85 for Nifty, ~200 for BankNifty
    const timeValue = Math.max(2.0, baseAtmPremium * Math.exp(-distanceRatio * 60));

    return Math.round((intrinsic + timeValue) * 100) / 100;
  }

  /**
   * Fetch live price for Yahoo ticker symbol using v8 chart API.
   */
  async fetchChartPrice(yahooSymbol: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.cache.get(yahooSymbol);
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return cached.price;
    }

    try {
      const baseUrl = this.getBaseUrl();
      if (!baseUrl) {
        throw new Error('Yahoo Finance API base URL is not configured in .env or environment');
      }
      const url = `${baseUrl}/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return null;
      }

      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice ?? meta?.chartPreviousClose ?? meta?.previousClose ?? null;

      if (typeof price === 'number' && !isNaN(price)) {
        this.cache.set(yahooSymbol, { price, timestamp: now });
        return price;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch LTP for any instrument symbol (Index, Stock, or Option).
   */
  async getLtp(symbol: string): Promise<number | null> {
    if (!symbol) return null;

    // Check if it's an option contract
    const opt = this.parseOptionSymbol(symbol);
    if (opt.isOption && opt.underlying && opt.strike && opt.type) {
      // Yahoo Finance does not provide Indian NSE option chains. Never return synthetic fake values (Rule 1).
      return null;
    }

    const yahooSymbol = this.mapToYahooSymbol(symbol);
    if (!yahooSymbol) return null;

    return this.fetchChartPrice(yahooSymbol);
  }

  /**
   * Batch fetch LTP for multiple symbols concurrently.
   */
  async getBatchLtp(symbols: string[]): Promise<Record<string, number>> {
    const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
    const results: Record<string, number> = {};

    const settled = await Promise.allSettled(
      uniqueSymbols.map(async (sym) => {
        const price = await this.getLtp(sym);
        return { sym, price };
      }),
    );

    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value.price !== null) {
        results[item.value.sym] = item.value.price;
        results[item.value.sym.toUpperCase()] = item.value.price;
      }
    }

    return results;
  }

  /**
   * Fetch historical and intraday candle OHLC data for a symbol.
   */
  async getCandles(options: {
    symbol?: string;
    interval?: string;
    range?: string;
    period1?: number;
    period2?: number;
    limit?: number;
  }): Promise<ChartCandlesResponse> {
    const rawSymbol = options.symbol?.trim() || 'NIFTY 50';
    const yahooSymbol = this.mapToYahooSymbol(rawSymbol) || '^NSEI';

    const interval = options.interval || '5m';
    let range = options.range;

    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error('Yahoo Finance API base URL is not configured in .env or environment');
    }

    let url: string;
    if (options.period1 && options.period2) {
      url = `${baseUrl}/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&period1=${options.period1}&period2=${options.period2}`;
      range = `${options.period1}-${options.period2}`;
    } else {
      if (!range) {
        if (interval === '1m' || interval === '2m' || interval === '5m') range = '5d';
        else if (interval === '15m' || interval === '30m' || interval === '60m' || interval === '1h') range = '1mo';
        else if (interval === '1d') range = '1y';
        else if (interval === '1wk') range = '2y';
        else range = '1y';
      }
      url = `${baseUrl}/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    }

    const cacheKey = `${yahooSymbol}_${interval}_${range || ''}_${options.period1 || 0}_${options.period2 || 0}_${options.limit || 0}`;
    const now = Date.now();
    const cachedCandles = this.candleCache.get(cacheKey);
    if (cachedCandles && now - cachedCandles.timestamp < this.candleCacheTtlMs) {
      return cachedCandles.data;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Yahoo Finance API responded with status ${res.status}`);
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      const err = json?.chart?.error?.description || 'No chart data available';
      throw new Error(err);
    }

    const meta = result.meta || {};
    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    const seenTimes = new Set<number>();
    let candles: CandleData[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const rawT = timestamps[i];
      const t = typeof rawT === 'number' && !isNaN(rawT) ? Math.floor(rawT) : 0;
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;

      if (
        t > 0 &&
        typeof o === 'number' && !isNaN(o) &&
        typeof h === 'number' && !isNaN(h) &&
        typeof l === 'number' && !isNaN(l) &&
        typeof c === 'number' && !isNaN(c) &&
        !seenTimes.has(t)
      ) {
        seenTimes.add(t);
        candles.push({
          time: t,
          open: Math.round(o * 100) / 100,
          high: Math.round(h * 100) / 100,
          low: Math.round(l * 100) / 100,
          close: Math.round(c * 100) / 100,
          volume: typeof v === 'number' && !isNaN(v) ? v : 0,
        });
      }
    }

    // Ensure strictly ascending by time for TradingView lightweight-charts
    candles.sort((a, b) => a.time - b.time);

    if (options.limit && options.limit > 0 && candles.length > options.limit) {
      candles = candles.slice(-options.limit);
    }

    const lastPrice = candles.length > 0
      ? candles[candles.length - 1].close
      : (meta.regularMarketPrice ?? 0);

    const responsePayload: ChartCandlesResponse = {
      symbol: rawSymbol,
      yahooSymbol,
      interval,
      range: range || '1y',
      period1: options.period1,
      period2: options.period2,
      currency: meta.currency || 'INR',
      exchange: meta.fullExchangeName || meta.exchangeName || 'NSE',
      lastPrice,
      count: candles.length,
      candles,
    };

    this.candleCache.set(cacheKey, { data: responsePayload, timestamp: now });
    return responsePayload;
  }

  /**
   * Batch fetch candles for multiple symbols with concurrency throttling to prevent rate limiting.
   */
  async getCandlesBatch(
    requests: Array<{
      symbol: string;
      interval?: string;
      range?: string;
      period1?: number;
      period2?: number;
      limit?: number;
    }>,
    options: { batchSize?: number; throttleMs?: number } = {},
  ): Promise<Map<string, ChartCandlesResponse>> {
    const batchSize = Math.max(1, options.batchSize || 5);
    const throttleMs = Math.max(0, options.throttleMs || 150);
    const results = new Map<string, ChartCandlesResponse>();

    for (let i = 0; i < requests.length; i += batchSize) {
      const slice = requests.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        slice.map(async (req) => {
          const candles = await this.getCandles(req);
          return { symbol: req.symbol, candles };
        }),
      );

      for (const item of settled) {
        if (item.status === 'fulfilled') {
          results.set(item.value.symbol, item.value.candles);
          results.set(item.value.symbol.toUpperCase(), item.value.candles);
        }
      }

      if (i + batchSize < requests.length && throttleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }
    }

    return results;
  }
}
