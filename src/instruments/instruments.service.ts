import { Injectable, BadRequestException, Optional, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DhanService } from '../dhan/dhan.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import {
  FirestoreService,
  CachedIndexOption,
  SecIdMappingMetadata,
  IndexLotSizesConfig,
  IndexConfigItem,
  DEFAULT_LOT_SIZES,
  DEFAULT_INDICES,
} from '../firestore/firestore.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';
import { SyncInstrumentsDto } from './dto/sync-instruments.dto';
import { UpdateLotSizesDto } from './dto/update-lot-sizes.dto';

export { CachedIndexOption, SecIdMappingMetadata, IndexLotSizesConfig, IndexConfigItem, DEFAULT_LOT_SIZES, DEFAULT_INDICES };

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
  moneyness?: 'ITM' | 'ATM' | 'OTM';
}

export interface StrikeOptionPair {
  strikePrice: number;
  relativeStrike?: 'ATM-1' | 'ATM' | 'ATM+1';
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
  { symbol: 'NIFTY 50', name: 'Nifty 50 Index', securityId: '13', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 65 },
  { symbol: 'BANK NIFTY', name: 'Nifty Bank Index', securityId: '25', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 30 },
  { symbol: 'SENSEX', name: 'BSE Sensex Index', securityId: '51', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 20 },
  { symbol: 'MIDCAP NIFTY', name: 'Nifty Midcap Select', securityId: '442', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 120 },

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
export class InstrumentsService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentsService.name);
  private indexOptions: CachedIndexOption[] = [];
  private indexOptionsBySecId = new Map<string, CachedIndexOption>();
  private indexOptionsLoadingPromise: Promise<number> | null = null;
  private scripMaster: Omit<InstrumentItem, 'ltp'>[] = [];
  private scripMasterBySecId = new Map<string, Omit<InstrumentItem, 'ltp'>>();
  private scripMasterBySymbol = new Map<string, Omit<InstrumentItem, 'ltp'>>();
  private securityIdMap = new Map<string, string>();
  private lotSizes: IndexLotSizesConfig = { ...DEFAULT_LOT_SIZES };

  constructor(
    private readonly dhanService: DhanService,
    @Optional() private readonly yahooService?: YahooFinanceService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {
    this.loadScripMaster();
    // Eagerly trigger mapping fetch from Firestore in background
    this.loadFromFirestore().catch((err) => {
      this.logger.warn(`Initial Firestore sec_id_to_name_mapping load deferred: ${err.message}`);
    });
  }

  async onModuleInit() {
    await this.ensureDataLoaded();
  }

  /**
   * Ensure both options and scrip master data are loaded from Firestore.
   */
  public async ensureDataLoaded(): Promise<number> {
    if (this.indexOptions.length > 0 && this.scripMaster.length > 0) {
      return this.indexOptions.length;
    }
    if (this.indexOptionsLoadingPromise) {
      return this.indexOptionsLoadingPromise;
    }
    this.indexOptionsLoadingPromise = this.loadFromFirestore().then((res) => res.optionsCount);
    try {
      return await this.indexOptionsLoadingPromise;
    } finally {
      this.indexOptionsLoadingPromise = null;
    }
  }

  /**
   * Alias for backward compatibility with ensureIndexOptionsLoaded.
   */
  public async ensureIndexOptionsLoaded(): Promise<number> {
    return this.ensureDataLoaded();
  }

  /**
   * Fetch NSE security master & index options strictly from Google Cloud Firestore database.
   * Loads from collection 'sec_id_to_name_mapping', falling back to 'index_options' if needed.
   */
  public async loadFromFirestore(): Promise<{ optionsCount: number; scripCount: number }> {
    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      try {
        // 1. Load lot sizes configuration from Firestore (config/lot_sizes)
        try {
          const dbLotSizes = await this.firestoreService.getLotSizes();
          if (dbLotSizes) {
            this.lotSizes = dbLotSizes;
          }
        } catch (err: any) {
          this.logger.warn(`Could not load lot sizes from Firestore: ${err.message}`);
        }

        // 2. Try to load from sec_id_to_name_mapping collection
        const secMapping = await this.firestoreService.getSecIdMapping();
        if (secMapping.options.length > 0 || secMapping.scripMaster.length > 0) {
          if (secMapping.options.length > 0) {
            this.setIndexOptions(secMapping.options);
          }
          if (secMapping.scripMaster.length > 0) {
            this.setScripMaster(secMapping.scripMaster);
          }
          this.logger.log(
            `⚡ Loaded ${this.indexOptions.length} options & ${this.scripMaster.length} scrip items strictly from Firestore [sec_id_to_name_mapping]`,
          );
          return { optionsCount: this.indexOptions.length, scripCount: this.scripMaster.length };
        }

        // 3. Fallback to index_options collection if sec_id_to_name_mapping is not yet populated
        const legacyOptions = await this.firestoreService.getIndexOptions();
        if (legacyOptions && legacyOptions.length > 0) {
          this.setIndexOptions(legacyOptions);
          this.logger.log(`⚡ Loaded ${this.indexOptions.length} NSE index options from Firestore [index_options]`);
        }
      } catch (err: any) {
        this.logger.error(`Failed to fetch mapping from Firestore: ${err.message}`);
      }
    }
    return { optionsCount: this.indexOptions.length, scripCount: this.scripMaster.length };
  }

  /**
   * Legacy method signature for backward compatibility.
   */
  public async loadIndexOptions(): Promise<number> {
    const res = await this.loadFromFirestore();
    return res.optionsCount;
  }

  /**
   * Set index options in memory and update fast lookup maps.
   */
  public setIndexOptions(options: CachedIndexOption[]) {
    this.indexOptions = options;
    this.indexOptionsBySecId.clear();
    for (const opt of options) {
      if (opt.securityId) {
        this.indexOptionsBySecId.set(String(opt.securityId).trim(), opt);
      }
    }
  }

  /**
   * Set scrip master items in memory and update fast lookup maps.
   */
  public setScripMaster(items: Omit<InstrumentItem, 'ltp'>[]) {
    this.scripMaster = items;
    this.scripMasterBySecId.clear();
    this.scripMasterBySymbol.clear();
    for (const item of items) {
      if (item.securityId) {
        this.scripMasterBySecId.set(String(item.securityId).trim(), item);
      }
      if (item.symbol) {
        this.scripMasterBySymbol.set(item.symbol.trim().toUpperCase(), item);
      }
    }
  }

  /**
   * On-demand synchronization of NSE instruments and index options to Firestore collection 'sec_id_to_name_mapping'.
   */
  public async syncMaster(dto?: SyncInstrumentsDto) {
    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new BadRequestException('Firestore database is not connected or initialized');
    }

    // Determine options to sync
    let optionsToSync: CachedIndexOption[] =
      dto?.options && dto.options.length > 0 ? dto.options : this.indexOptions;
    if (optionsToSync.length === 0) {
      optionsToSync = await this.firestoreService.getIndexOptions();
    }

    // Determine scrip master to sync
    let scripToSync: any[] =
      dto?.scripMaster && dto.scripMaster.length > 0 ? dto.scripMaster : this.scripMaster;
    if (scripToSync.length === 0) {
      this.loadScripMaster();
      scripToSync = this.scripMaster;
    }

    const res = await this.firestoreService.saveSecIdMapping(optionsToSync, scripToSync);

    // Reload into memory
    await this.loadFromFirestore();

    return {
      ...res,
      message: `Successfully synced ${res.totalInstruments} NSE instruments to Firestore collection [sec_id_to_name_mapping]`,
    };
  }

  /**
   * Retrieve current index lot sizes configuration.
   */
  public getLotSizes(): IndexLotSizesConfig {
    return { ...this.lotSizes };
  }

  /**
   * Retrieve list of tradeable indices configured in Firestore for Conditional Alert Composer dropdown.
   * Enriches each index with live LTP from Dhan / Yahoo Finance.
   */
  public async getConfiguredIndices(onlyEnabled = true): Promise<InstrumentItem[]> {
    if (!this.lotSizes?.indices || this.lotSizes.indices.length === 0) {
      if (this.firestoreService && this.firestoreService.isReady()) {
        try {
          this.lotSizes = await this.firestoreService.getLotSizes();
        } catch {
          // ignore
        }
      }
    }

    const rawIndices = this.lotSizes?.indices && this.lotSizes.indices.length > 0
      ? this.lotSizes.indices
      : DEFAULT_INDICES;

    const filtered = onlyEnabled
      ? rawIndices.filter((idx) => idx.enabled !== false)
      : rawIndices;

    const items: (Omit<InstrumentItem, 'ltp'> & {
      defaultLots?: number;
      defaultQuantity?: number;
      defaultLotSize?: number;
      defaultQuantityInOneLot?: number;
      stopLossPoints?: number;
    })[] = filtered.map((idx) => {
      const defaultLotSize = idx.defaultLotSize ?? idx.defaultLots ?? 5;
      const defaultQuantityInOneLot = idx.defaultQuantityInOneLot ?? idx.lotSize ?? 1;
      return {
        symbol: idx.symbol,
        name: idx.name,
        securityId: idx.securityId,
        exchangeSegment: idx.exchangeSegment,
        instrumentType: 'INDEX',
        lotSize: defaultQuantityInOneLot,
        defaultLots: defaultLotSize,
        defaultQuantity: defaultLotSize * defaultQuantityInOneLot,
        defaultLotSize,
        defaultQuantityInOneLot,
        stopLossPoints: idx.stopLossPoints,
      };
    });

    return this.enrichWithLiveLtp(items);
  }

  /**
   * Resolve lot size for a specific index or symbol from database-driven config.
   */
  public getLotSizeForInstrument(instrument: string): number {
    const clean = (instrument || '').toUpperCase();
    if (this.lotSizes?.indices && this.lotSizes.indices.length > 0) {
      const match = this.lotSizes.indices.find((i) => clean.includes(i.symbol.toUpperCase()));
      if (match) return match.defaultQuantityInOneLot ?? match.lotSize ?? 1;
    }
    if (clean.includes('BANK')) return this.lotSizes.bankNifty || 30;
    if (clean.includes('MIDCP') || clean.includes('MIDCAP')) return this.lotSizes.midcapNifty || 120;
    if (clean.includes('FIN')) return this.lotSizes.finNifty || 65;
    if (clean.includes('SENSEX')) return this.lotSizes.sensex || 20;
    if (clean.includes('NIFTY')) return this.lotSizes.nifty50 || 65;
    return 1;
  }

  /**
   * Update index lot sizes configuration in Firestore and memory.
   */
  public async updateLotSizes(dto: UpdateLotSizesDto) {
    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      const res = await this.firestoreService.saveLotSizes(dto);
      this.lotSizes = res.data;
      return {
        success: true,
        data: this.lotSizes,
        message: 'Index lot sizes successfully saved to Firestore database (config/lot_sizes)',
      };
    }
    this.lotSizes = {
      nifty50: dto.nifty50 !== undefined ? Number(dto.nifty50) : this.lotSizes.nifty50,
      bankNifty: dto.bankNifty !== undefined ? Number(dto.bankNifty) : this.lotSizes.bankNifty,
      finNifty: dto.finNifty !== undefined ? Number(dto.finNifty) : this.lotSizes.finNifty,
      midcapNifty: dto.midcapNifty !== undefined ? Number(dto.midcapNifty) : this.lotSizes.midcapNifty,
      sensex: dto.sensex !== undefined ? Number(dto.sensex) : this.lotSizes.sensex,
      nifty50Lots: dto.nifty50Lots !== undefined ? Number(dto.nifty50Lots) : this.lotSizes.nifty50Lots,
      bankNiftyLots: dto.bankNiftyLots !== undefined ? Number(dto.bankNiftyLots) : this.lotSizes.bankNiftyLots,
      finNiftyLots: dto.finNiftyLots !== undefined ? Number(dto.finNiftyLots) : this.lotSizes.finNiftyLots,
      midcapNiftyLots: dto.midcapNiftyLots !== undefined ? Number(dto.midcapNiftyLots) : this.lotSizes.midcapNiftyLots,
      sensexLots: dto.sensexLots !== undefined ? Number(dto.sensexLots) : this.lotSizes.sensexLots,
      indices: dto.indices && Array.isArray(dto.indices) ? dto.indices : this.lotSizes.indices,
      updatedAt: new Date().toISOString(),
    };
    return {
      success: true,
      data: this.lotSizes,
      message: 'Index lot sizes updated in memory (Firestore offline)',
    };
  }

  /**
   * Reset index lot sizes to default values.
   */
  public async resetLotSizes() {
    return this.updateLotSizes(DEFAULT_LOT_SIZES);
  }

  /**
   * Sync security master from raw Dhan api-scrip-master.csv text.
   */
  public async syncCsv(csvContent: string) {
    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new BadRequestException('Firestore database is not connected or initialized');
    }
    if (!csvContent || typeof csvContent !== 'string') {
      throw new BadRequestException('CSV content string is required');
    }

    const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      throw new BadRequestException('CSV content is empty or contains no header row');
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const secIdIdx = headers.findIndex((h) => /SEM_SMST_SECURITY_ID|SECURITY_ID|SECURITYID|SEM_SECURITY_ID/i.test(h));
    const symbolIdx = headers.findIndex((h) => /SEM_TRADING_SYMBOL|SYMBOL|TRADING_SYMBOL/i.test(h));
    const nameIdx = headers.findIndex((h) => /SEM_CUSTOM_SYMBOL|COMPANY_NAME|NAME|INSTRUMENT_NAME/i.test(h));
    const segmentIdx = headers.findIndex((h) => /SEM_EXM_EXCH_ID|EXCHANGE_SEGMENT|SEGMENT/i.test(h));
    const instTypeIdx = headers.findIndex((h) => /SEM_INSTRUMENT_NAME|INSTRUMENT_TYPE|TYPE/i.test(h));
    const lotSizeIdx = headers.findIndex((h) => /SEM_LOT_UNITS|LOT_SIZE|LOTSIZE/i.test(h));

    const parsedScrip: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
      const segment = segmentIdx >= 0 ? parts[segmentIdx] : 'NSE_EQ';
      // Strictly NSE contracts only
      if (segment && !segment.startsWith('NSE') && segment !== 'IDX_I') {
        continue;
      }

      const secId = secIdIdx >= 0 ? parts[secIdIdx] : '';
      if (!secId) continue;

      const sym = symbolIdx >= 0 ? parts[symbolIdx] : parts[0];
      const name = nameIdx >= 0 ? parts[nameIdx] : sym;
      const instType = instTypeIdx >= 0 ? parts[instTypeIdx] : (segment === 'IDX_I' ? 'INDEX' : 'EQUITY');
      const lot = lotSizeIdx >= 0 ? parseInt(parts[lotSizeIdx], 10) || 1 : 1;

      parsedScrip.push({
        securityId: secId,
        symbol: sym,
        name: name,
        exchangeSegment: segment,
        instrumentType: instType,
        lotSize: lot,
      });
    }

    this.logger.log(`Parsed ${parsedScrip.length} NSE scrips from CSV content`);
    return this.syncMaster({ scripMaster: parsedScrip });
  }

  /**
   * Retrieve current sync status and metadata of sec_id_to_name_mapping from Firestore.
   */
  public async getSyncStatus() {
    const meta = this.firestoreService ? await this.firestoreService.getSecIdMappingMetadata() : null;
    return {
      storedInFirestore: !!meta,
      metadata: meta,
      inMemoryCounts: {
        indexOptions: this.indexOptions.length,
        scripMaster: this.scripMaster.length,
        total: this.indexOptions.length + this.scripMaster.length,
      },
    };
  }

  /**
   * Returns current count of cached index options.
   */
  public getIndexOptionsCount(): number {
    return this.indexOptions.length;
  }

  private loadScripMaster() {
    try {
      const candidatePaths = [
        path.resolve(__dirname, '..', '..', 'data', 'scrip-master.json'),
        path.resolve(__dirname, '..', 'data', 'scrip-master.json'),
        path.resolve(process.cwd(), 'data', 'scrip-master.json'),
        path.resolve(process.cwd(), '..', 'dhan-trader-api', 'data', 'scrip-master.json'),
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          this.scripMaster = JSON.parse(raw);
          for (const item of this.scripMaster) {
            if (item.securityId) {
              this.scripMasterBySecId.set(String(item.securityId).trim(), item);
            }
            if (item.symbol) {
              this.scripMasterBySymbol.set(item.symbol.trim().toUpperCase(), item);
            }
          }
          break;
        }
      }
    } catch {
      this.scripMaster = [];
    }
  }

  public findRealOption(symbolName: string, expiryDate: string, strikePrice: number, optionType: string): CachedIndexOption | undefined {
    let symKey = symbolName.toUpperCase();
    if (symKey.includes('BANK')) symKey = 'BANKNIFTY';
    else if (symKey.includes('MIDCP') || symKey.includes('MIDCAP')) symKey = 'MIDCPNIFTY';
    else if (symKey.includes('SENSEX')) symKey = 'SENSEX';
    else if (symKey.includes('NIFTY')) symKey = 'NIFTY';

    return this.indexOptions.find(
      (o) =>
        o.symbolName === symKey &&
        o.expiryDate === expiryDate &&
        Math.abs(o.strikePrice - strikePrice) < 0.1 &&
        o.optionType === optionType,
    );
  }

  async search(query?: string, limit = 10): Promise<InstrumentItem[]> {
    let matched: Omit<InstrumentItem, 'ltp'>[];
    if (!query || typeof query !== 'string') {
      matched = POPULAR_INSTRUMENTS.slice(0, limit);
    } else {
      const clean = query.trim().toUpperCase();
      const popMatches = POPULAR_INSTRUMENTS.filter(
        (item) => item.symbol.includes(clean) || item.name.toUpperCase().includes(clean),
      );

      if (popMatches.length >= limit) {
        matched = popMatches.slice(0, limit);
      } else {
        if (this.scripMasterBySecId.size === 0) {
          this.loadScripMaster();
        }
        const seenSecIds = new Set(popMatches.map((p) => p.securityId));
        const masterMatches: Omit<InstrumentItem, 'ltp'>[] = [];
        for (const item of this.scripMaster) {
          if (seenSecIds.has(item.securityId)) continue;
          if (item.symbol.includes(clean) || item.name.toUpperCase().includes(clean)) {
            masterMatches.push(item);
            if (popMatches.length + masterMatches.length >= limit) break;
          }
        }
        matched = [...popMatches, ...masterMatches].slice(0, limit);
      }
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
    if (!symbol) return undefined;
    const clean = symbol.trim().toUpperCase();
    if (clean === 'BANK NIFTY' || clean === 'NIFTY BANK' || clean === 'BANKNIFTY') {
      return (
        POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === 'BANK NIFTY') ||
        POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === 'NIFTY BANK')
      );
    }
    if (clean === 'MIDCAP NIFTY' || clean === 'MIDCP NIFTY' || clean === 'MIDCPNIFTY' || clean === 'NIFTY MIDCAP') {
      return (
        POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === 'MIDCAP NIFTY') ||
        POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === 'MIDCP NIFTY')
      );
    }

    const popMatch = POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === clean);
    if (popMatch) return popMatch;

    if (this.scripMasterBySymbol.size === 0) {
      this.loadScripMaster();
    }
    return this.scripMasterBySymbol.get(clean);
  }

  findBySecurityId(securityId: string): {
    symbol: string;
    tradingSymbol?: string;
    customSymbol?: string;
    name?: string;
    exchangeSegment?: string;
    expiryDate?: string;
    strikePrice?: number;
    optionType?: string;
    lotSize?: number;
  } | undefined {
    if (!securityId) return undefined;
    const cleanId = String(securityId).trim();

    if (this.scripMasterBySecId.size === 0) {
      this.loadScripMaster();
    }

    // 1. Search indexOptions (loaded from Firestore database)
    const matchedOpt =
      this.indexOptionsBySecId.get(cleanId) ||
      this.indexOptions.find((opt) => String(opt.securityId).trim() === cleanId);
    if (matchedOpt) {
      return {
        symbol: matchedOpt.customSymbol || matchedOpt.tradingSymbol,
        tradingSymbol: matchedOpt.tradingSymbol,
        customSymbol: matchedOpt.customSymbol,
        name: matchedOpt.customSymbol || matchedOpt.symbolName,
        exchangeSegment: matchedOpt.exchange,
        expiryDate: matchedOpt.expiryDate,
        strikePrice: matchedOpt.strikePrice,
        optionType: matchedOpt.optionType,
        lotSize: matchedOpt.lotSize,
      };
    }

    // 2. Search scripMaster (23,900+ equities and indices from Dhan scrip master)
    const matchedMaster = this.scripMasterBySecId.get(cleanId);
    if (matchedMaster) {
      return {
        symbol: matchedMaster.symbol,
        name: matchedMaster.name,
        customSymbol: matchedMaster.symbol,
        tradingSymbol: matchedMaster.symbol,
        exchangeSegment: matchedMaster.exchangeSegment,
        lotSize: matchedMaster.lotSize || 1,
      };
    }

    // 3. Search POPULAR_INSTRUMENTS (fallback)
    const matchedPop = POPULAR_INSTRUMENTS.find((item) => String(item.securityId).trim() === cleanId);
    if (matchedPop) {
      return {
        symbol: matchedPop.symbol,
        name: matchedPop.name,
        exchangeSegment: matchedPop.exchangeSegment,
        lotSize: matchedPop.lotSize,
      };
    }

    return undefined;
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
   * Get list of option expiries for an instrument
   */
  async getExpiries(instrument = 'NIFTY 50'): Promise<{ expiryDate: string; displayExpiry: string; shortExpiry: string }[]> {
    await this.ensureIndexOptionsLoaded();
    const raw = (instrument || 'NIFTY 50').trim().toUpperCase();
    let symKey = raw;
    if (symKey.includes('BANK')) symKey = 'BANKNIFTY';
    else if (symKey.includes('MIDCP') || symKey.includes('MIDCAP')) symKey = 'MIDCPNIFTY';
    else if (symKey.includes('SENSEX')) symKey = 'SENSEX';
    else if (symKey.includes('NIFTY')) symKey = 'NIFTY';

    const todayStr = this.formatExpiryDate(this.getIstDate()).expiryDate;
    const realExpiries = Array.from(
      new Set(
        this.indexOptions
          .filter((o) => o.symbolName === symKey && o.expiryDate >= todayStr)
          .map((o) => o.expiryDate),
      ),
    ).sort();

    if (realExpiries.length > 0) {
      return realExpiries.slice(0, 8).map((dStr: string) => {
        const d = this.parseDateString(dStr);
        const fmt = this.formatExpiryDate(d);
        return {
          expiryDate: fmt.expiryDate,
          displayExpiry: fmt.displayExpiry,
          shortExpiry: fmt.shortExpiry,
        };
      });
    }

    let securityId = '13';
    let exchangeSegment = 'IDX_I';
    let targetWeekday = 4; // Thursday

    if (raw.includes('BANK')) {
      securityId = '25';
      targetWeekday = 3;
    } else if (raw.includes('MIDCP') || raw.includes('MIDCAP')) {
      securityId = '442';
      targetWeekday = 1;
    } else if (raw.includes('SENSEX')) {
      securityId = '51';
      exchangeSegment = 'BSE_FNO';
      targetWeekday = 5;
    } else if (raw.includes('NIFTY')) {
      securityId = '13';
      targetWeekday = 4;
    }

    try {
      const secNum = parseInt(securityId, 10);
      if (!isNaN(secNum)) {
        const dhanExpRes = await this.dhanService.getOptionChainExpiryList(
          secNum,
          exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'IDX_I',
        );
        if (dhanExpRes.ok && Array.isArray(dhanExpRes.data) && dhanExpRes.data.length > 0) {
          const liveExpiries = dhanExpRes.data.filter((d: string) => typeof d === 'string' && d >= todayStr);
          if (liveExpiries.length > 0) {
            return liveExpiries.map((dStr: string) => {
              const d = this.parseDateString(dStr);
              const fmt = this.formatExpiryDate(d);
              return {
                expiryDate: fmt.expiryDate,
                displayExpiry: fmt.displayExpiry,
                shortExpiry: fmt.shortExpiry,
              };
            });
          }
        }
      }
    } catch {
      // offline fallback
    }

    const results: { expiryDate: string; displayExpiry: string; shortExpiry: string }[] = [];
    const ist = this.getIstDate();
    const currentDay = ist.getDay();
    let daysUntil = (targetWeekday - currentDay + 7) % 7;
    if (daysUntil === 0 && (ist.getHours() > 15 || (ist.getHours() === 15 && ist.getMinutes() >= 30))) {
      daysUntil = 7;
    }
    const firstDate = new Date(ist);
    firstDate.setDate(ist.getDate() + daysUntil);

    for (let i = 0; i < 5; i++) {
      const d = new Date(firstDate);
      d.setDate(firstDate.getDate() + i * 7);
      const fmt = this.formatExpiryDate(d);
      results.push({
        expiryDate: fmt.expiryDate,
        displayExpiry: fmt.displayExpiry,
        shortExpiry: fmt.shortExpiry,
      });
    }

    return results;
  }

  async getOptionContracts(dto: GetOptionContractsDto): Promise<OptionContractsResult> {
    await this.ensureIndexOptionsLoaded();
    if (!dto || !dto.instrument) {
      throw new BadRequestException('Instrument name or symbol is required');
    }

    const raw = dto.instrument.trim().toUpperCase();
    let normalizedName = 'NIFTY 50';
    let baseSymbol = 'NIFTY';
    let securityId = '13';
    let exchangeSegment = 'NSE_FNO';
    let lotSize = this.lotSizes.nifty50;
    let defaultStep = 50;
    let targetWeekday = 4; // Thursday

    if (raw.includes('BANK')) {
      normalizedName = 'NIFTY BANK';
      baseSymbol = 'BANKNIFTY';
      securityId = '25';
      lotSize = this.lotSizes.bankNifty;
      defaultStep = 100;
      targetWeekday = 3;
    } else if (raw.includes('MIDCP') || raw.includes('MIDCAP')) {
      normalizedName = 'MIDCAP NIFTY';
      baseSymbol = 'MIDCPNIFTY';
      securityId = '442';
      lotSize = this.lotSizes.midcapNifty;
      defaultStep = 25;
      targetWeekday = 1;
    } else if (raw.includes('FIN')) {
      normalizedName = 'FINNIFTY';
      baseSymbol = 'FINNIFTY';
      securityId = '27';
      lotSize = this.lotSizes.finNifty;
      defaultStep = 50;
      targetWeekday = 2;
    } else if (raw.includes('SENSEX')) {
      normalizedName = 'SENSEX';
      baseSymbol = 'SENSEX';
      securityId = '51';
      exchangeSegment = 'BSE_FNO';
      lotSize = this.lotSizes.sensex;
      defaultStep = 100;
      targetWeekday = 5;
    } else if (raw.includes('NIFTY')) {
      normalizedName = 'NIFTY 50';
      baseSymbol = 'NIFTY';
      securityId = '13';
      lotSize = this.lotSizes.nifty50;
      defaultStep = 50;
      targetWeekday = 4;
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

    // Reference spot price
    let spotPrice = typeof dto.price === 'string' ? parseFloat(dto.price) : dto.price;
    if (!spotPrice || isNaN(spotPrice) || spotPrice <= 0) {
      const ltpObj = await this.getLtp(normalizedName);
      spotPrice = (ltpObj.ltp && ltpObj.ltp > 0) ? ltpObj.ltp : (defaultStep === 100 ? 52000 : 25500);
    } else {
      spotPrice = parseFloat(String(spotPrice));
    }

    let step = defaultStep;
    if (!step || isNaN(step) || step <= 0) {
      if (spotPrice >= 5000) {
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
    }

    const atmStrike = Math.round(spotPrice / step) * step;
    const strikes = [atmStrike - step, atmStrike, atmStrike + step];

    // Determine current and next expiry
    let currentExpiryDate: Date;
    let nextExpiryDate: Date;

    const availableExpiries = await this.getExpiries(normalizedName);
    if (dto.expiry) {
      currentExpiryDate = this.parseDateString(dto.expiry);
      const curFmtStr = this.formatExpiryDate(currentExpiryDate).expiryDate;
      const matchIdx = availableExpiries.findIndex((e) => e.expiryDate === curFmtStr);
      if (matchIdx >= 0 && matchIdx + 1 < availableExpiries.length) {
        nextExpiryDate = this.parseDateString(availableExpiries[matchIdx + 1].expiryDate);
      } else {
        nextExpiryDate = new Date(currentExpiryDate);
        nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
      }
    } else if (availableExpiries.length >= 2) {
      currentExpiryDate = this.parseDateString(availableExpiries[0].expiryDate);
      nextExpiryDate = this.parseDateString(availableExpiries[1].expiryDate);
    } else if (availableExpiries.length === 1) {
      currentExpiryDate = this.parseDateString(availableExpiries[0].expiryDate);
      nextExpiryDate = new Date(currentExpiryDate);
      nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
    } else {
      const ist = this.getIstDate();
      const currentDay = ist.getDay();
      let daysUntil = (targetWeekday - currentDay + 7) % 7;
      if (daysUntil === 0 && (ist.getHours() > 15 || (ist.getHours() === 15 && ist.getMinutes() >= 30))) {
        daysUntil = 7;
      }
      currentExpiryDate = new Date(ist);
      currentExpiryDate.setDate(ist.getDate() + daysUntil);
      nextExpiryDate = new Date(currentExpiryDate);
      nextExpiryDate.setDate(currentExpiryDate.getDate() + 7);
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

        // Real Dhan security IDs from scrip master cache
        const realCall = this.findRealOption(baseSymbol, fmt.expiryDate, strike, 'CE');
        const realPut = this.findRealOption(baseSymbol, fmt.expiryDate, strike, 'PE');

        const callSecId = realCall ? realCall.securityId : `${securityId}${strike}CE`;
        const putSecId = realPut ? realPut.securityId : `${securityId}${strike}PE`;
        const callSym = realCall?.customSymbol || `${baseSymbol} ${fmt.tradingSymbolDate} ${strike} CE`;
        const putSym = realPut?.customSymbol || `${baseSymbol} ${fmt.tradingSymbolDate} ${strike} PE`;
        const callTradingSym = realCall?.tradingSymbol || `${baseSymbol}-${fmt.tradingSymbolDate}-${strike}-CE`;
        const putTradingSym = realPut?.tradingSymbol || `${baseSymbol}-${fmt.tradingSymbolDate}-${strike}-PE`;
        const callLot = realCall ? realCall.lotSize : lotSize;
        const putLot = realPut ? realPut.lotSize : lotSize;

        const callMoneyness: 'ITM' | 'ATM' | 'OTM' =
          strike < atmStrike ? 'ITM' : strike === atmStrike ? 'ATM' : 'OTM';
        const putMoneyness: 'ITM' | 'ATM' | 'OTM' =
          strike < atmStrike ? 'OTM' : strike === atmStrike ? 'ATM' : 'ITM';

        const callContract: OptionContractDetails = {
          symbol: callSym,
          tradingSymbol: callTradingSym,
          instrumentName: normalizedName,
          strikePrice: strike,
          optionType: 'CE',
          expiryDate: fmt.expiryDate,
          expiryType,
          securityId: callSecId,
          exchangeSegment: exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO',
          lotSize: callLot,
          ltp: callLtp,
          moneyness: callMoneyness,
        };

        const putContract: OptionContractDetails = {
          symbol: putSym,
          tradingSymbol: putTradingSym,
          instrumentName: normalizedName,
          strikePrice: strike,
          optionType: 'PE',
          expiryDate: fmt.expiryDate,
          expiryType,
          securityId: putSecId,
          exchangeSegment: exchangeSegment === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO',
          lotSize: putLot,
          ltp: putLtp,
          moneyness: putMoneyness,
        };

        // Cache in POPULAR_INSTRUMENTS so findBySymbol can resolve
        if (!POPULAR_INSTRUMENTS.some((p) => p.symbol === callSym)) {
          POPULAR_INSTRUMENTS.push({
            symbol: callSym,
            name: callSym,
            securityId: callSecId,
            exchangeSegment: callContract.exchangeSegment,
            instrumentType: 'OPTIDX',
            lotSize: callLot,
          });
        }
        if (!POPULAR_INSTRUMENTS.some((p) => p.symbol === putSym)) {
          POPULAR_INSTRUMENTS.push({
            symbol: putSym,
            name: putSym,
            securityId: putSecId,
            exchangeSegment: putContract.exchangeSegment,
            instrumentType: 'OPTIDX',
            lotSize: putLot,
          });
        }

        contracts.push(callContract);
        contracts.push(putContract);

        const relativeStrike: 'ATM-1' | 'ATM' | 'ATM+1' =
          strike < atmStrike ? 'ATM-1' : strike === atmStrike ? 'ATM' : 'ATM+1';

        strikePairs.push({
          strikePrice: strike,
          relativeStrike,
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
            for (const [secId, quote] of Object.entries(secObj as Record<string, any>)) {
              const livePrice = quote?.last_price || quote?.ltp;
              if (typeof livePrice === 'number') {
                priceMap.set(`${seg}:${secId}`, livePrice);
              }
            }
          }
        }
      }
    } catch {
      // Data API offline or unsubscribed
    }

    const missingItems = items.filter(
      (it) => !priceMap.has(`${it.exchangeSegment}:${it.securityId}`),
    );

    if (missingItems.length > 0 && this.yahooService) {
      try {
        const yahooQuotes = await this.yahooService.getBatchLtp(missingItems.map((it) => it.symbol));
        for (const it of missingItems) {
          const key = `${it.exchangeSegment}:${it.securityId}`;
          const yPrice = yahooQuotes[it.symbol] ?? yahooQuotes[it.symbol.toUpperCase()];
          if (typeof yPrice === 'number') {
            priceMap.set(key, yPrice);
          }
        }
      } catch {
        // Yahoo service error
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
