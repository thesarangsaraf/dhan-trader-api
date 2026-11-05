import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { DhanService } from '../dhan/dhan.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';

export interface InstrumentItem {
  symbol: string;
  name: string;
  securityId: string;
  exchangeSegment: string;
  instrumentType: string;
  ltp?: number;
  lotSize?: number;
}

export interface OptionContractDetails {
  symbol: string;
  tradingSymbol: string;
  instrumentName: string;
  strikePrice: number;
  optionType: 'CE' | 'PE';
  expiryDate: string;
  expiryType: 'CURRENT' | 'NEXT';
  securityId: string;
  exchangeSegment: string;
  lotSize: number;
  ltp: number;
}

export interface StrikeOptionPair {
  strikePrice: number;
  call: OptionContractDetails;
  put: OptionContractDetails;
}

export interface ExpiryOptionChain {
  expiryDate: string;
  displayExpiry: string;
  shortExpiry: string;
  strikes: StrikeOptionPair[];
}

export interface OptionContractsResult {
  instrument: string;
  spotPrice: number;
  strikeStep: number;
  strikes: number[];
  currentExpiry: ExpiryOptionChain;
  nextExpiry: ExpiryOptionChain;
  contracts: OptionContractDetails[];
}

const POPULAR_INSTRUMENTS: Omit<InstrumentItem, 'ltp'>[] = [
  // Indices
  { symbol: 'NIFTY 50', name: 'Nifty 50 Index', securityId: '13', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 50 },
  { symbol: 'NIFTY BANK', name: 'Nifty Bank Index', securityId: '25', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 30 },
  { symbol: 'SENSEX', name: 'BSE Sensex Index', securityId: '51', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 20 },
  { symbol: 'NIFTY FIN SERVICE', name: 'Nifty Financial Services', securityId: '27', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 40 },
  { symbol: 'MIDCP NIFTY', name: 'Nifty Midcap Select', securityId: '442', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 75 },
  { symbol: 'NIFTY NEXT 50', name: 'Nifty Next 50', securityId: '18', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 25 },
  { symbol: 'INDIA VIX', name: 'India Volatility Index', securityId: '21', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
  { symbol: 'NIFTY IT', name: 'Nifty IT Index', securityId: '29', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
  { symbol: 'NIFTY AUTO', name: 'Nifty Auto Index', securityId: '31', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
  { symbol: 'NIFTY FMCG', name: 'Nifty FMCG Index', securityId: '30', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
  { symbol: 'NIFTY PHARMA', name: 'Nifty Pharma Index', securityId: '32', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },
  { symbol: 'NIFTY METAL', name: 'Nifty Metal Index', securityId: '33', exchangeSegment: 'IDX_I', instrumentType: 'INDEX' },

  // FNO Options
  { symbol: 'NIFTY 24500 CE', name: 'Nifty 24500 Call', securityId: '45021', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 50 },
  { symbol: 'NIFTY 24500 PE', name: 'Nifty 24500 Put', securityId: '45022', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 50 },
  { symbol: 'NIFTY 24600 CE', name: 'Nifty 24600 Call', securityId: '45023', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 50 },
  { symbol: 'NIFTY 24600 PE', name: 'Nifty 24600 Put', securityId: '45024', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 50 },
  { symbol: 'BANKNIFTY 52000 CE', name: 'Bank Nifty 52000 Call', securityId: '52010', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 30 },
  { symbol: 'BANKNIFTY 52000 PE', name: 'Bank Nifty 52000 Put', securityId: '52011', exchangeSegment: 'NSE_FNO', instrumentType: 'OPTIDX', lotSize: 30 },

  // Equities
  { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', securityId: '2885', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', securityId: '1333', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'INFY', name: 'Infosys Ltd', securityId: '1594', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', securityId: '11536', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', securityId: '4963', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'SBIN', name: 'State Bank of India', securityId: '3045', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', securityId: '10604', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'ITC', name: 'ITC Ltd', securityId: '1660', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', securityId: '11483', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', securityId: '1922', exchangeSegment: 'NSE_EQ', instrumentType: 'EQUITY', lotSize: 1 },
];

@Injectable()
export class InstrumentsService {
  constructor(
    private readonly dhanService: DhanService,
    @Optional() private readonly yahooService?: YahooFinanceService,
  ) {}

  async search(query?: string, limit = 10): Promise<InstrumentItem[]> {
    let matched: Omit<InstrumentItem, 'ltp'>[];
    if (!query || typeof query !== 'string') {
      matched = POPULAR_INSTRUMENTS.slice(0, limit);
    } else {
      const clean = query.trim().toUpperCase();
      matched = POPULAR_INSTRUMENTS.filter(
        (item) => item.symbol.includes(clean) || item.name.toUpperCase().includes(clean),
      ).slice(0, limit);
    }

    return this.enrichWithLiveLtp(matched);
  }

  async getAll(): Promise<InstrumentItem[]> {
    return this.enrichWithLiveLtp(POPULAR_INSTRUMENTS);
  }

  getAllSync(): Omit<InstrumentItem, 'ltp'>[] {
    return POPULAR_INSTRUMENTS;
  }

  findBySymbol(symbol: string): Omit<InstrumentItem, 'ltp'> | undefined {
    const clean = symbol.trim().toUpperCase();
    return POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === clean);
  }

  async getLtp(symbol: string): Promise<{ symbol: string; ltp: number | null }> {
    if (!symbol) return { symbol: '', ltp: null };
    const clean = symbol.trim().toUpperCase();

    const matched = this.findBySymbol(clean);
    if (matched) {
      const enriched = await this.enrichWithLiveLtp([matched]);
      return { symbol: clean, ltp: enriched[0]?.ltp ?? null };
    }

    if (this.yahooService) {
      const price = await this.yahooService.getLtp(clean);
      return { symbol: clean, ltp: price };
    }

    return { symbol: clean, ltp: null };
  }

  /**
   * Fetch 3 option contracts (ATM-1, ATM, ATM+1) for current and next expiry.
   */
  async getOptionContracts(dto: GetOptionContractsDto): Promise<OptionContractsResult> {
    if (!dto.instrument || typeof dto.instrument !== 'string') {
      throw new BadRequestException('Instrument name is required');
    }

    const raw = dto.instrument.trim().toUpperCase();
    let normalizedName = raw;
    let baseSymbol = raw;
    let securityId = '13';
    let exchangeSegment = 'IDX_I';
    let lotSize = 50;
    let defaultStep = 50;
    let targetWeekday = 4; // Thursday

    if (raw.includes('BANK')) {
      normalizedName = 'NIFTY BANK';
      baseSymbol = 'BANKNIFTY';
      securityId = '25';
      lotSize = 30;
      defaultStep = 100;
      targetWeekday = 3; // Wednesday
    } else if (raw.includes('FIN')) {
      normalizedName = 'NIFTY FIN SERVICE';
      baseSymbol = 'FINNIFTY';
      securityId = '27';
      lotSize = 40;
      defaultStep = 50;
      targetWeekday = 2; // Tuesday
    } else if (raw.includes('MIDCP')) {
      normalizedName = 'MIDCP NIFTY';
      baseSymbol = 'MIDCPNIFTY';
      securityId = '442';
      lotSize = 75;
      defaultStep = 25;
      targetWeekday = 1; // Monday
    } else if (raw.includes('SENSEX')) {
      normalizedName = 'SENSEX';
      baseSymbol = 'SENSEX';
      securityId = '51';
      exchangeSegment = 'BSE_FNO';
      lotSize = 20;
      defaultStep = 100;
      targetWeekday = 5; // Friday
    } else if (raw.includes('NIFTY')) {
      normalizedName = 'NIFTY 50';
      baseSymbol = 'NIFTY';
      securityId = '13';
      lotSize = 50;
      defaultStep = 50;
      targetWeekday = 4; // Thursday
    } else {
      const match = POPULAR_INSTRUMENTS.find(
        (it) => it.symbol.toUpperCase() === raw || it.name.toUpperCase() === raw,
      );
      if (match) {
        normalizedName = match.name;
        baseSymbol = match.symbol;
        securityId = match.securityId;
        lotSize = match.lotSize || 1;
        exchangeSegment = match.exchangeSegment === 'NSE_EQ' ? 'NSE_FNO' : match.exchangeSegment;
      }
    }

    // Determine reference spot price (strictly numeric)
    let spotPrice = typeof dto.price === 'string' ? parseFloat(dto.price) : dto.price;
    if (!spotPrice || isNaN(spotPrice) || spotPrice <= 0) {
      const ltpObj = await this.getLtp(normalizedName);
      spotPrice = (ltpObj.ltp && ltpObj.ltp > 0) ? ltpObj.ltp : (defaultStep === 100 ? 52000 : 25500);
    } else {
      spotPrice = parseFloat(String(spotPrice));
    }

    // Determine strike step (strictly numeric)
    let step = typeof dto.strikeStep === 'string' ? parseFloat(dto.strikeStep) : dto.strikeStep;
    if (!step || isNaN(step) || step <= 0) {
      if (defaultStep) {
        step = defaultStep;
      } else if (spotPrice >= 5000) {
        step = 100;
      } else if (spotPrice >= 2000) {
        step = 50;
      } else if (spotPrice >= 1000) {
        step = 20;
      } else if (spotPrice >= 500) {
        step = 10;
      } else {
        step = 5;
      }
    } else {
      step = parseFloat(String(step));
    }

    // Calculate strikes (strictly numeric, default count: 3 -> ATM-1, ATM, ATM+1)
    const rawCount = typeof dto.strikeCount === 'string' ? parseInt(dto.strikeCount, 10) : dto.strikeCount;
    const strikeCount = rawCount && rawCount > 0 ? rawCount : 3;
    const atmStrike = Math.round(spotPrice / step) * step;
    const strikes: number[] = [];
    const half = Math.floor(strikeCount / 2);
    for (let i = -half; i <= half; i++) {
      strikes.push(atmStrike + i * step);
    }

    // Determine current and next expiry
    let currentExpiryDate: Date;
    let nextExpiryDate: Date;

    if (dto.expiry) {
      currentExpiryDate = this.parseDateString(dto.expiry);
      nextExpiryDate = new Date(currentExpiryDate);
      nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
    } else {
      // Try Dhan API live expiry list
      let liveExpiries: string[] = [];
      try {
        const secNum = parseInt(securityId, 10);
        if (!isNaN(secNum)) {
          const dhanExpRes = await this.dhanService.getOptionChainExpiryList(
            secNum,
            exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'IDX_I',
          );
          if (dhanExpRes.ok && Array.isArray(dhanExpRes.data)) {
            const todayStr = this.formatExpiryDate(this.getIstDate()).expiryDate;
            liveExpiries = dhanExpRes.data.filter((d: string) => typeof d === 'string' && d >= todayStr);
          }
        }
      } catch {
        // Dhan API offline or Data API not subscribed
      }

      if (liveExpiries.length >= 2) {
        currentExpiryDate = this.parseDateString(liveExpiries[0]);
        nextExpiryDate = this.parseDateString(liveExpiries[1]);
      } else if (liveExpiries.length === 1) {
        currentExpiryDate = this.parseDateString(liveExpiries[0]);
        nextExpiryDate = new Date(currentExpiryDate);
        nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
      } else {
        // Fallback calendar logic
        const ist = this.getIstDate();
        const currentDay = ist.getDay();
        let daysUntil = (targetWeekday - currentDay + 7) % 7;
        // If today is target weekday, but market has closed (after 15:30 IST), roll to next week
        if (daysUntil === 0 && (ist.getHours() > 15 || (ist.getHours() === 15 && ist.getMinutes() >= 30))) {
          daysUntil = 7;
        }
        currentExpiryDate = new Date(ist);
        currentExpiryDate.setDate(ist.getDate() + daysUntil);
        nextExpiryDate = new Date(currentExpiryDate);
        nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
      }
    }

    const curFmt = this.formatExpiryDate(currentExpiryDate);
    const nxtFmt = this.formatExpiryDate(nextExpiryDate);

    const contracts: OptionContractDetails[] = [];

    const buildChainForExpiry = (
      fmt: ReturnType<typeof this.formatExpiryDate>,
      expiryType: 'CURRENT' | 'NEXT',
    ): ExpiryOptionChain => {
      const strikePairs: StrikeOptionPair[] = [];

      for (const strike of strikes) {
        const callLtp = this.yahooService
          ? this.yahooService.calculateOptionLtp(strike, 'CE', spotPrice)
          : Math.max(5, Math.round((Math.max(0, spotPrice - strike) + 50) * 10) / 10);

        const putLtp = this.yahooService
          ? this.yahooService.calculateOptionLtp(strike, 'PE', spotPrice)
          : Math.max(5, Math.round((Math.max(0, strike - spotPrice) + 50) * 10) / 10);

        // Deterministic security IDs for options
        const callSecId = `${securityId}${strike}CE`;
        const putSecId = `${securityId}${strike}PE`;

        const callContract: OptionContractDetails = {
          symbol: `${baseSymbol} ${fmt.tradingSymbolDate} ${strike} CE`,
          tradingSymbol: `${baseSymbol}-${fmt.tradingSymbolDate}-${strike}-CE`,
          instrumentName: normalizedName,
          strikePrice: strike,
          optionType: 'CE',
          expiryDate: fmt.expiryDate,
          expiryType,
          securityId: callSecId,
          exchangeSegment: exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO',
          lotSize,
          ltp: callLtp,
        };

        const putContract: OptionContractDetails = {
          symbol: `${baseSymbol} ${fmt.tradingSymbolDate} ${strike} PE`,
          tradingSymbol: `${baseSymbol}-${fmt.tradingSymbolDate}-${strike}-PE`,
          instrumentName: normalizedName,
          strikePrice: strike,
          optionType: 'PE',
          expiryDate: fmt.expiryDate,
          expiryType,
          securityId: putSecId,
          exchangeSegment: exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO',
          lotSize,
          ltp: putLtp,
        };

        contracts.push(callContract);
        contracts.push(putContract);

        strikePairs.push({
          strikePrice: strike,
          call: callContract,
          put: putContract,
        });
      }

      return {
        expiryDate: fmt.expiryDate,
        displayExpiry: fmt.displayExpiry,
        shortExpiry: fmt.shortExpiry,
        strikes: strikePairs,
      };
    };

    const currentExpiry = buildChainForExpiry(curFmt, 'CURRENT');
    const nextExpiry = buildChainForExpiry(nxtFmt, 'NEXT');

    return {
      instrument: normalizedName,
      spotPrice,
      strikeStep: step,
      strikes,
      currentExpiry,
      nextExpiry,
      contracts,
    };
  }

  private getIstDate(): Date {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utc + 3600000 * 5.5);
  }

  private formatExpiryDate(d: Date): { expiryDate: string; displayExpiry: string; shortExpiry: string; tradingSymbolDate: string } {
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const mon = months[d.getMonth()];
    const yy = String(yyyy).slice(-2);

    return {
      expiryDate: `${yyyy}-${mm}-${dd}`,
      displayExpiry: `${dd} ${mon} ${yyyy}`,
      shortExpiry: `${dd}${mon}`,
      tradingSymbolDate: `${dd}${mon}${yy}`,
    };
  }

  private parseDateString(dateStr: string): Date {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 15, 30, 0);
    }
    return new Date(dateStr);
  }

  private async enrichWithLiveLtp(items: Omit<InstrumentItem, 'ltp'>[]): Promise<InstrumentItem[]> {
    if (items.length === 0) return [];

    const segmentsMap: Record<string, number[]> = {};
    for (const it of items) {
      if (it.exchangeSegment && it.securityId) {
        if (!segmentsMap[it.exchangeSegment]) {
          segmentsMap[it.exchangeSegment] = [];
        }
        const numId = parseInt(it.securityId, 10);
        if (!isNaN(numId) && !segmentsMap[it.exchangeSegment].includes(numId)) {
          segmentsMap[it.exchangeSegment].push(numId);
        }
      }
    }

    const priceMap = new Map<string, number>();
    try {
      const ltpRes = await this.dhanService.getLtp(segmentsMap);
      if (ltpRes.ok && ltpRes.data && ltpRes.data.data) {
        for (const [seg, secObj] of Object.entries(ltpRes.data.data)) {
          if (typeof secObj === 'object' && secObj !== null) {
            for (const [secId, quote] of Object.entries(secObj as any)) {
              const livePrice = (quote as any)?.last_price || (quote as any)?.ltp;
              if (typeof livePrice === 'number') {
                priceMap.set(`${seg}:${secId}`, livePrice);
              }
            }
          }
        }
      }
    } catch {
      // If live feed unavailable from Dhan, fallback to Yahoo Finance
    }

    // Identify instruments that still need real LTP
    const missingItems = items.filter(
      (it) => !priceMap.has(`${it.exchangeSegment}:${it.securityId}`),
    );

    if (missingItems.length > 0 && this.yahooService) {
      try {
        const yahooQuotes = await this.yahooService.getBatchLtp(
          missingItems.map((it) => it.symbol),
        );
        for (const it of missingItems) {
          const key = `${it.exchangeSegment}:${it.securityId}`;
          const yPrice = yahooQuotes[it.symbol] ?? yahooQuotes[it.symbol.toUpperCase()];
          if (typeof yPrice === 'number') {
            priceMap.set(key, yPrice);
          }
        }
      } catch {
        // Yahoo fetch error ignored
      }
    }

    return items.map((it) => {
      const livePrice = priceMap.get(`${it.exchangeSegment}:${it.securityId}`);
      if (livePrice !== undefined) {
        return { ...it, ltp: livePrice };
      }
      return { ...it };
    });
  }
}
