export type ScreenerScanMode = 'live' | 'historical';

export type ScreenerSignalType = 'BUY' | 'SELL';

export type LiquidityLevelType = 'PDL' | 'PDH' | 'DAY_LOW' | 'DAY_HIGH';

export interface ScreenerCandle {
  time: number; // UNIX epoch seconds (strictly ascending, deduplicated)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScreenerInstrumentItem {
  symbol: string;
  symbolName?: string;
  displayName: string;
  name: string;
  exchId?: string;
  securityId?: string;
  exchangeSegment?: string;
  lotSize?: number;
  smFreezeQty?: number;
  strikeStep?: number;
  expiryFlag?: string;
  stopLossPoints?: number;
}

export interface LiquiditySweepSignal {
  id: string;                     // Unique ID per signal, e.g. NIFTY_1763440500_BUY
  symbol: string;                 // Official Dhan symbolName (e.g., NIFTY, BANKNIFTY, MIDCPNIFTY, SENSEX)
  displayName?: string;           // Official Dhan friendly displayName (e.g., Nifty 50, Nifty Bank, Nifty Midcap Select, Sensex)
  name: string;                   // Friendly displayName
  signalType: ScreenerSignalType; // 'BUY' | 'SELL'
  levelType: LiquidityLevelType;  // 'PDL' | 'PDH' | 'DAY_LOW' | 'DAY_HIGH'
  levelPrice: number;             // Exact swept liquidity level price
  sweepPrice: number;             // Extreme low (BUY) or high (SELL) of the sweep
  sweepTimestamp: number;         // UNIX epoch seconds of the sweep candle
  confirmationClosePrice: number; // Close price of the green/red confirmation candle
  confirmationTimestamp: number;  // UNIX epoch seconds of the confirmation candle
  sessionDate: string;            // IST trading date YYYY-MM-DD
  timeframe: '5m';
  candles: ScreenerCandle[];      // Complete 5m OHLC session bars (09:15 to 15:30 IST)
}

export interface ScreenerScanResponse {
  mode: ScreenerScanMode;
  timeframe: '5m';
  startDate?: string;
  endDate?: string;
  scannedAt: string;
  instrumentsScanned: Array<{ symbol: string; displayName: string; name: string }>;
  totalScanned: number;
  totalRecommendations: number;
  bullishCount: number;
  bearishCount: number;
  recommendations: LiquiditySweepSignal[];
}
