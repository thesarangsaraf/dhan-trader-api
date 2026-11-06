import { Injectable } from '@nestjs/common';

export interface OptionDetails {
  isOption: boolean;
  underlying?: string;
  strike?: number;
  type?: 'CE' | 'PE';
}

@Injectable()
export class YahooFinanceService {
  private readonly cache = new Map<string, { price: number; timestamp: number }>();
  private readonly cacheTtlMs = 3000; // 3 seconds TTL to avoid spamming Yahoo

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
   * Parse option strings like "NIFTY 24500 CE", "BANKNIFTY 52000 PE", etc.
   */
  parseOptionSymbol(symbol: string): OptionDetails {
    if (!symbol) return { isOption: false };

    // Matches e.g. "NIFTY 24500 CE", "BANKNIFTY 52000 PE", "NIFTY 24600 CE"
    const match = symbol.trim().toUpperCase().match(/^([A-Z\s]+?)\s*(\d{4,6})\s*(CE|PE)$/);
    if (!match) {
      return { isOption: false };
    }

    const rawUnderlying = match[1].trim();
    const strike = parseFloat(match[2]);
    const type = match[3] as 'CE' | 'PE';

    let underlying = rawUnderlying;
    if (rawUnderlying.includes('BANK')) {
      underlying = 'BANK NIFTY';
    } else if (rawUnderlying.includes('MIDCAP') || rawUnderlying.includes('MIDCP')) {
      underlying = 'MIDCAP NIFTY';
    } else if (rawUnderlying.includes('SENSEX')) {
      underlying = 'SENSEX';
    } else if (rawUnderlying.includes('NIFTY')) {
      underlying = 'NIFTY 50';
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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
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
      const underlyingLtp = await this.getLtp(opt.underlying);
      if (underlyingLtp !== null) {
        return this.calculateOptionLtp(opt.strike, opt.type, underlyingLtp);
      }
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
}
