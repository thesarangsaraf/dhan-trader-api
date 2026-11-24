import { CandleData } from '../yahoo/yahoo.service';

export interface OrderBlockZone {
  top: number;
  bottom: number;
  startTime: number;
  endTime: number;
}

export interface ScreenerSignal {
  id: string;
  symbol: string;
  name: string;
  date: string;
  timeframe: '5m';

  // Step A: Liquidity Low
  swingLow: number;
  swingLowTime: number;
  swingLowTimeFormatted: string;

  // Step B: Liquidity Sweep
  sweepLow: number;
  sweepTime: number;
  sweepTimeFormatted: string;

  // Step C: Consolidation Base
  baseCandleTime: number;
  baseHigh: number;
  baseLow: number;

  // Step D: Bullish Impulse
  impulseTime: number;
  impulseClose: number;

  // Step E: Order Block & Trade Parameters
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  targetRr: number;
  riskPoints: number;
  rewardPoints: number;
  orderBlock: OrderBlockZone;

  // Step F: Retest & Forward Outcome
  entryTime: number;
  entryTimeFormatted: string;
  exitTime?: number;
  exitTimeFormatted?: string;
  exitPrice?: number;
  outcome: 'WIN' | 'LOSS' | 'EOD_EXIT' | 'OPEN';
  pnlPoints: number;
  rMultiple: number;

  // Candlestick sequence for interactive chart rendering
  candles?: CandleData[];
}

export interface BacktestSummary {
  totalSignals: number;
  wins: number;
  losses: number;
  eodExits: number;
  openTrades: number;
  winRate: number; // percentage e.g. 62.5
  netRMultiple: number;
  profitFactor: number;
  grossProfitPoints: number;
  grossLossPoints: number;
  totalPnlPoints: number;
}

export interface ScanResultResponse {
  success: boolean;
  timestamp: string;
  scannedSymbolsCount: number;
  matchedSymbolsCount: number;
  totalCandlesScanned: number;
  parameters: {
    lookbackPeriod: string;
    swingLookback: number;
    slBuffer: number;
    targetRr: number;
    maxRetestBars: number;
  };
  summary: BacktestSummary;
  signals: ScreenerSignal[];
}

export interface ScreenerInstrumentItem {
  symbol: string;
  name: string;
  displayName?: string;
  securityId: string;
  exchangeSegment: string;
  instrumentType: string;
  yahooSymbol: string;
  isIndex: boolean;
}
