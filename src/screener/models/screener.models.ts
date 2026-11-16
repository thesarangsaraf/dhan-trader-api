export type ScreenerStrategyType =
  | 'DEMAND_ORDER_BLOCK'
  | 'SUPPLY_ORDER_BLOCK'
  | 'BULLISH_LIQUIDITY_SWEEP'
  | 'BEARISH_LIQUIDITY_SWEEP';

export type ScreenerSignalType = 'BUY' | 'SELL';

export interface ScreenerMatch {
  symbol: string;             // NSE Symbol without .NS (e.g., RELIANCE)
  name: string;               // Company Name
  cmp: number;                // Current Market Price (₹)
  strategy: ScreenerStrategyType;
  strategyLabel: string;      // Human-readable (e.g., "Demand OB (Bullish)")
  signalType: ScreenerSignalType;
  entryPrice: number;         // Suggested Entry (₹)
  stopLossPrice: number;      // Suggested Stop Loss (₹)
  riskPoints: number;         // |Entry - StopLoss| (₹)
  riskPercent: number;        // (Risk / Entry) * 100
  timeframe: string;          // e.g. 15m, 1h, 1d, 1wk
  matchedAt: string;          // ISO timestamp
  candleTime?: number;        // Time of setup candle
  details?: {
    zoneHigh?: number;
    zoneLow?: number;
    impulseTime?: number;
    swingLevel?: number;
    wickPercent?: number;
    notes?: string;
  };
}

export interface ScreenerScanResponse {
  timeframe: string;
  scannedAt: string;
  totalScanned: number;
  totalMatches: number;
  bullishMatches: number;
  bearishMatches: number;
  matches: ScreenerMatch[];
}
