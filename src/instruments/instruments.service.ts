import { Injectable } from '@nestjs/common';

export interface InstrumentItem {
  symbol: string;
  name: string;
  securityId: string;
  exchangeSegment: string;
  instrumentType: string;
  ltp?: number;
  lotSize?: number;
}

const POPULAR_INSTRUMENTS: InstrumentItem[] = [
  // Indices
  { symbol: 'NIFTY 50', name: 'Nifty 50 Index', securityId: '13', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 24520.5 },
  { symbol: 'NIFTY BANK', name: 'Nifty Bank Index', securityId: '25', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 51850.0 },
  { symbol: 'NIFTY FIN SERVICE', name: 'Nifty Financial Services', securityId: '27', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 23200.0 },
  { symbol: 'MIDCP NIFTY', name: 'Nifty Midcap Select', securityId: '442', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 13150.0 },
  { symbol: 'NIFTY NEXT 50', name: 'Nifty Next 50', securityId: '18', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 71200.0 },
  { symbol: 'INDIA VIX', name: 'India Volatility Index', securityId: '21', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 14.35 },
  { symbol: 'NIFTY IT', name: 'Nifty IT Index', securityId: '29', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 42100.0 },
  { symbol: 'NIFTY AUTO', name: 'Nifty Auto Index', securityId: '31', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 26400.0 },
  { symbol: 'NIFTY FMCG', name: 'Nifty FMCG Index', securityId: '30', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 62800.0 },
  { symbol: 'NIFTY PHARMA', name: 'Nifty Pharma Index', securityId: '32', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 22900.0 },
  { symbol: 'NIFTY METAL', name: 'Nifty Metal Index', securityId: '33', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', ltp: 9450.0 },

  // FNO Options
  { symbol: 'NIFTY 24500 CE', name: 'Nifty 24500 Call', securityId: '45021', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 135.0, lotSize: 50 },
  { symbol: 'NIFTY 24500 PE', name: 'Nifty 24500 Put', securityId: '45022', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 110.0, lotSize: 50 },
  { symbol: 'NIFTY 24600 CE', name: 'Nifty 24600 Call', securityId: '45023', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 85.0, lotSize: 50 },
  { symbol: 'NIFTY 24600 PE', name: 'Nifty 24600 Put', securityId: '45024', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 160.0, lotSize: 50 },
  { symbol: 'BANKNIFTY 52000 CE', name: 'Bank Nifty 52000 Call', securityId: '52010', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 280.0, lotSize: 30 },
  { symbol: 'BANKNIFTY 52000 PE', name: 'Bank Nifty 52000 Put', securityId: '52011', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', ltp: 210.0, lotSize: 30 },

  // Equities
  { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', securityId: '2885', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 2980.5 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', securityId: '1333', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 1720.0 },
  { symbol: 'INFY', name: 'Infosys Ltd', securityId: '1594', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 1845.0 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', securityId: '11536', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 4120.0 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', securityId: '4963', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 1260.0 },
  { symbol: 'SBIN', name: 'State Bank of India', securityId: '3045', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 815.0 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors Ltd', securityId: '3456', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', ltp: 920.0 },
];

@Injectable()
export class InstrumentsService {
  search(query?: string, limit = 10): InstrumentItem[] {
    if (!query || typeof query !== 'string') {
      return POPULAR_INSTRUMENTS.slice(0, limit);
    }
    const clean = query.trim().toUpperCase();
    const results = POPULAR_INSTRUMENTS.filter(
      (item) => item.symbol.includes(clean) || item.name.toUpperCase().includes(clean),
    );
    return results.slice(0, limit);
  }

  getAll(): InstrumentItem[] {
    return POPULAR_INSTRUMENTS;
  }
}
