import { Injectable, BadRequestException, NotFoundException, Optional, Logger, OnModuleInit } from '@nestjs/common';
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
import { QueryEquitiesDto } from './dto/query-equities.dto';
import { QueryOptionsDto } from './dto/query-options.dto';

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

// Cold-start fallback used ONLY when Firestore database is uninitialized or in isolated unit tests
const FALLBACK_POPULAR_INSTRUMENTS: Omit<InstrumentItem, 'ltp'>[] = [
  // Indices
  { symbol: 'NIFTY 50', name: 'Nifty 50 Index', securityId: '13', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 65 },
  { symbol: 'BANK NIFTY', name: 'Nifty Bank Index', securityId: '25', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 30 },
  { symbol: 'SENSEX', name: 'BSE Sensex Index', securityId: '51', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 20 },
  { symbol: 'MIDCAP NIFTY', name: 'Nifty Midcap Select', securityId: '442', exchangeSegment: 'IDX_I', instrumentType: 'INDEX', lotSize: 120 },

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

  /**
   * Traded index symbols strictly tracked and stored in collection 'index_options'.
   * All other options (stock options, non-traded indices) are strictly excluded.
   */
  public static readonly TRADED_INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'SENSEX']);

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
    // Eagerly trigger mapping fetch strictly from Firestore database in background
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

        // 2. Load NSE equities & indices from collection 'sec_id_to_name_mapping'
        const secMapping = await this.firestoreService.getSecIdMapping();
        this.setScripMaster(secMapping.scripMaster);

        // 3. Load NSE index options strictly from dedicated collection 'index_options'
        // (falling back to secMapping.options if legacy collection holds them)
        let options = await this.firestoreService.getIndexOptions();
        if (options.length === 0 && secMapping.options.length > 0) {
          options = secMapping.options;
        }
        this.setIndexOptions(options);

        this.logger.log(
          `⚡ Loaded ${this.indexOptions.length} index options [index_options] & ${this.scripMaster.length} scrip items [sec_id_to_name_mapping] strictly from Firestore`,
        );
        return { optionsCount: this.indexOptions.length, scripCount: this.scripMaster.length };
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
   * Download official Dhan scrip master CSV with timeout and error handling.
   */
  private async downloadDhanCsv(csvUrl?: string): Promise<string> {
    const url = csvUrl || 'https://images.dhan.co/api-data/api-scrip-master.csv';
    this.logger.log(`Downloading latest official Dhan scrip master from ${url}...`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!resp.ok) {
      throw new BadRequestException(`Dhan scrip master download returned HTTP ${resp.status}`);
    }
    const csvText = await resp.text();
    this.logger.log(`Successfully downloaded Dhan scrip master (${(csvText.length / 1024 / 1024).toFixed(1)} MB)`);
    return csvText;
  }

  /**
   * Parse Dhan CSV content, strictly extracting NSE cash equities & indices,
   * and traded index options (NIFTY, BANKNIFTY, MIDCPNIFTY, SENSEX).
   */
  public parseCsv(csvContent: string): {
    parsedScrip: Omit<InstrumentItem, 'ltp'>[];
    parsedOptions: CachedIndexOption[];
  } {
    if (!csvContent || typeof csvContent !== 'string') {
      throw new BadRequestException('CSV content string is required');
    }

    const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      throw new BadRequestException('CSV content is empty or contains no header row');
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const exchIdx = headers.findIndex((h) => /^SEM_EXM_EXCH_ID$|^EXCH_ID$|^EXCHANGE$/i.test(h));
    const segmentIdx = headers.findIndex((h) => /^SEM_SEGMENT$|^EXCHANGE_SEGMENT$|^SEGMENT$/i.test(h));
    const secIdIdx = headers.findIndex((h) => /^SEM_SMST_SECURITY_ID$|^SECURITY_ID$|^SECURITYID$|^SEM_SECURITY_ID$/i.test(h));
    const instNameIdx = headers.findIndex((h) => /^SEM_INSTRUMENT_NAME$|^INSTRUMENT_TYPE$|^TYPE$/i.test(h));
    const symbolIdx = headers.findIndex((h) => /^SEM_TRADING_SYMBOL$|^SYMBOL$|^TRADING_SYMBOL$/i.test(h));
    const nameIdx = headers.findIndex((h) => /^SEM_CUSTOM_SYMBOL$|^COMPANY_NAME$|^NAME$/i.test(h));
    const lotSizeIdx = headers.findIndex((h) => /^SEM_LOT_UNITS$|^LOT_SIZE$|^LOTSIZE$/i.test(h));
    const expiryIdx = headers.findIndex((h) => /^SEM_EXPIRY_DATE$|^EXPIRY_DATE$/i.test(h));
    const strikeIdx = headers.findIndex((h) => /^SEM_STRIKE_PRICE$|^STRIKE_PRICE$|^STRIKE$/i.test(h));
    const optTypeIdx = headers.findIndex((h) => /^SEM_OPTION_TYPE$|^OPTION_TYPE$|^OPT_TYPE$/i.test(h));
    const symNameIdx = headers.findIndex((h) => /^SM_SYMBOL_NAME$|^UNDERLYING_SYMBOL$/i.test(h));

    const parsedOptions: CachedIndexOption[] = [];
    const parsedScrip: Omit<InstrumentItem, 'ltp'>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
      const exch = exchIdx >= 0 ? parts[exchIdx] : '';
      const secId = secIdIdx >= 0 ? parts[secIdIdx] : '';
      if (!secId) continue;

      const instName = instNameIdx >= 0 ? parts[instNameIdx] : '';
      const rawSegment = segmentIdx >= 0 ? parts[segmentIdx] : '';
      const sym = symbolIdx >= 0 ? parts[symbolIdx] : parts[0];
      const customSym = nameIdx >= 0 && parts[nameIdx] ? parts[nameIdx] : sym;
      const lot = lotSizeIdx >= 0 ? parseInt(parts[lotSizeIdx], 10) || 1 : 1;
      const rawSymName = symNameIdx >= 0 ? parts[symNameIdx] : '';

      // Strictly NSE instruments only - except SENSEX index options (from BSE)
      const isSensexOption = instName === 'OPTIDX' && (sym.startsWith('SENSEX') || rawSymName === 'BSXOPT');
      if (exch && exch !== 'NSE' && exch !== 'IDX_I' && !exch.startsWith('NSE') && !isSensexOption) {
        continue;
      }

      // 1. Index Options (OPTIDX)
      if (instName === 'OPTIDX') {
        const rawExpiry = expiryIdx >= 0 ? parts[expiryIdx] : '';
        const expiryDate = rawExpiry ? rawExpiry.split(' ')[0].trim() : '';
        const strikePrice = strikeIdx >= 0 ? parseFloat(parts[strikeIdx]) || 0 : 0;
        const optType = optTypeIdx >= 0 && parts[optTypeIdx] === 'PE' ? 'PE' : 'CE';
        let root = (rawSymName || sym.split('-')[0].trim()).toUpperCase();
        if (root === 'BANKNIFTY' || root.includes('BANK')) root = 'BANKNIFTY';
        else if (root === 'MIDCPNIFTY' || root.includes('MIDCP') || root.includes('MIDCAP')) root = 'MIDCPNIFTY';
        else if (root === 'SENSEX' || root === 'BSXOPT' || root.includes('SENSEX') || sym.startsWith('SENSEX-')) root = 'SENSEX';
        else if (root === 'NIFTY' || root === 'NIFTY 50') root = 'NIFTY';
        else root = '';

        // Filter strictly to user's traded indices: NIFTY, BANKNIFTY, MIDCPNIFTY, SENSEX
        if (root && InstrumentsService.TRADED_INDEX_SYMBOLS.has(root)) {
          parsedOptions.push({
            symbolName: root,
            exchange: root === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
            securityId: secId,
            tradingSymbol: sym,
            customSymbol: customSym,
            expiryDate,
            strikePrice,
            optionType: optType as 'CE' | 'PE',
            lotSize: lot,
          });
        }
        continue;
      }

      // 2. Benchmark Indices
      const isIndex = instName === 'INDEX' || rawSegment === 'I' || exch === 'IDX_I';
      if (isIndex) {
        parsedScrip.push({
          securityId: secId,
          symbol: sym,
          name: customSym,
          exchangeSegment: 'IDX_I',
          instrumentType: 'INDEX',
          lotSize: lot,
        });
        continue;
      }

      // 3. NSE Equities
      if (instName === 'EQUITY' || rawSegment === 'E') {
        parsedScrip.push({
          securityId: secId,
          symbol: sym,
          name: customSym,
          exchangeSegment: 'NSE_EQ',
          instrumentType: 'EQUITY',
          lotSize: lot,
        });
      }
    }

    return { parsedScrip, parsedOptions };
  }

  /**
   * Synchronize cash equities and benchmark indices into Firestore collection 'sec_id_to_name_mapping'.
   * Purely stores equities & indices; guarantees zero option contracts in this collection.
   */
  public async syncEquities(dto?: SyncInstrumentsDto) {
    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new BadRequestException('Firestore database is not connected or initialized');
    }

    let scripToSync: any[] = [];

    if (dto?.csvContent) {
      const { parsedScrip } = this.parseCsv(dto.csvContent);
      scripToSync = parsedScrip;
    } else if (dto?.scripMaster && dto.scripMaster.length > 0) {
      scripToSync = dto.scripMaster;
    } else if (process.env.NODE_ENV !== 'test') {
      try {
        const csvText = await this.downloadDhanCsv(dto?.csvUrl);
        const { parsedScrip } = this.parseCsv(csvText);
        scripToSync = parsedScrip;
      } catch (err: any) {
        this.logger.warn(`Failed downloading live CSV: ${err.message}. Using in-memory scripMaster.`);
        scripToSync = this.scripMaster;
      }
    } else {
      scripToSync = this.scripMaster;
    }

    if (scripToSync.length === 0 && this.firestoreService.isReady()) {
      const existing = await this.firestoreService.getSecIdMapping();
      scripToSync = existing.scripMaster;
    }

    if (scripToSync.length === 0) {
      throw new BadRequestException('No equity or index instruments found to sync');
    }

    // Save strictly to sec_id_to_name_mapping with EMPTY options (removes any stale options docs)
    const res = await this.firestoreService.saveSecIdMapping([], scripToSync);

    // Update in-memory cache
    this.setScripMaster(scripToSync);

    return {
      success: true,
      collection: 'sec_id_to_name_mapping',
      totalInstruments: res.totalInstruments,
      totalEquities: res.totalEquities,
      totalIndices: res.totalIndices,
      documents: res.documents,
      syncedAt: res.syncedAt,
      message: `Successfully synced ${res.totalInstruments} NSE instruments (${res.totalIndices} indices, ${res.totalEquities} equities) to Firestore collection [sec_id_to_name_mapping]`,
    };
  }

  /**
   * Synchronize traded index options (NIFTY, BANKNIFTY, MIDCPNIFTY, SENSEX) into Firestore collection 'index_options'.
   * Purely stores options contracts for the traded indices in chunks of 500.
   */
  public async syncOptions(dto?: SyncInstrumentsDto) {
    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new BadRequestException('Firestore database is not connected or initialized');
    }

    let optionsToSync: CachedIndexOption[] = [];

    if (dto?.csvContent) {
      const { parsedOptions } = this.parseCsv(dto.csvContent);
      optionsToSync = parsedOptions;
    } else if (dto?.options && dto.options.length > 0) {
      optionsToSync = dto.options.filter((o) => {
        let sym = (o.symbolName || '').toUpperCase();
        if (sym.includes('BANK')) sym = 'BANKNIFTY';
        else if (sym.includes('MIDCP') || sym.includes('MIDCAP')) sym = 'MIDCPNIFTY';
        else if (sym.includes('SENSEX') || sym.includes('BSX')) sym = 'SENSEX';
        else if (sym.includes('NIFTY')) sym = 'NIFTY';
        return InstrumentsService.TRADED_INDEX_SYMBOLS.has(sym);
      });
    } else if (process.env.NODE_ENV !== 'test') {
      try {
        const csvText = await this.downloadDhanCsv(dto?.csvUrl);
        const { parsedOptions } = this.parseCsv(csvText);
        optionsToSync = parsedOptions;
      } catch (err: any) {
        this.logger.warn(`Failed downloading live CSV: ${err.message}. Using in-memory indexOptions.`);
        optionsToSync = this.indexOptions;
      }
    } else {
      optionsToSync = this.indexOptions;
    }

    if (optionsToSync.length === 0 && this.firestoreService.isReady()) {
      optionsToSync = await this.firestoreService.getIndexOptions();
    }

    if (optionsToSync.length === 0) {
      throw new BadRequestException('No traded index options found to sync');
    }

    // Save strictly to index_options collection in dedicated documents per index (max 2 expiries)
    const res = await this.firestoreService.saveIndexOptions(optionsToSync, 2);

    // Update in-memory cache strictly with filtered options
    this.setIndexOptions(res.items && res.items.length > 0 ? res.items : optionsToSync);

    return {
      success: true,
      collection: 'index_options',
      totalItems: res.totalItems,
      totalChunks: res.totalChunks,
      documentsCount: res.documentsCount || res.totalChunks,
      documentIds: res.documentIds,
      writeTime: res.writeTime,
      tradedIndices: Array.from(InstrumentsService.TRADED_INDEX_SYMBOLS),
      message: `Successfully synced ${res.totalItems} traded index options across dedicated documents [${res.documentIds?.join(', ') || Array.from(InstrumentsService.TRADED_INDEX_SYMBOLS).join(', ')}] (max 2 expiries) in Firestore collection [index_options]`,
    };
  }

  /**
   * On-demand synchronization of NSE instruments and index options to Firestore.
   */
  public async syncMaster(dto?: SyncInstrumentsDto) {
    if (dto?.target === 'equities') {
      return this.syncEquities(dto);
    }
    if (dto?.target === 'options') {
      return this.syncOptions(dto);
    }

    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new BadRequestException('Firestore database is not connected or initialized');
    }

    // If raw CSV content is passed directly, parse and sync both
    if (dto?.csvContent) {
      const { parsedScrip, parsedOptions } = this.parseCsv(dto.csvContent);
      const eqRes = await this.firestoreService.saveSecIdMapping([], parsedScrip);
      const optRes = await this.firestoreService.saveIndexOptions(parsedOptions, 2);
      this.setScripMaster(parsedScrip);
      this.setIndexOptions(optRes.items && optRes.items.length > 0 ? optRes.items : parsedOptions);
      return {
        success: true,
        collection: 'sec_id_to_name_mapping',
        totalInstruments: eqRes.totalInstruments + optRes.totalItems,
        totalEquities: eqRes.totalEquities,
        totalIndices: eqRes.totalIndices,
        totalOptions: optRes.totalItems,
        documents: eqRes.documents,
        syncedAt: eqRes.syncedAt,
        message: `Successfully synced ${eqRes.totalInstruments} NSE instruments to sec_id_to_name_mapping and ${optRes.totalItems} traded index options to index_options`,
      };
    }

    // When requested via sync button and not in test suite, download official Dhan CSV
    if (!dto?.scripMaster && !dto?.options && process.env.NODE_ENV !== 'test') {
      try {
        const csvText = await this.downloadDhanCsv(dto?.csvUrl);
        const { parsedScrip, parsedOptions } = this.parseCsv(csvText);
        const eqRes = await this.firestoreService.saveSecIdMapping([], parsedScrip);
        const optRes = await this.firestoreService.saveIndexOptions(parsedOptions, 2);
        this.setScripMaster(parsedScrip);
        this.setIndexOptions(optRes.items && optRes.items.length > 0 ? optRes.items : parsedOptions);
        return {
          success: true,
          collection: 'sec_id_to_name_mapping',
          totalInstruments: eqRes.totalInstruments + optRes.totalItems,
          totalEquities: eqRes.totalEquities,
          totalIndices: eqRes.totalIndices,
          totalOptions: optRes.totalItems,
          documents: eqRes.documents,
          syncedAt: eqRes.syncedAt,
          message: `Successfully synced ${eqRes.totalInstruments} NSE instruments to sec_id_to_name_mapping and ${optRes.totalItems} traded index options to index_options`,
        };
      } catch (err: any) {
        this.logger.warn(`Failed to download live Dhan scrip master (${err.message}). Falling back to cached data.`);
      }
    }

    // Fallback: sync equities and options from provided or in-memory data
    let scripToSync: any[] = dto?.scripMaster && dto.scripMaster.length > 0 ? dto.scripMaster : this.scripMaster;
    let optionsToSync: CachedIndexOption[] = dto?.options && dto.options.length > 0 ? dto.options : this.indexOptions;

    if (scripToSync.length === 0 && this.firestoreService.isReady()) {
      const existing = await this.firestoreService.getSecIdMapping();
      scripToSync = existing.scripMaster;
    }
    if (optionsToSync.length === 0 && this.firestoreService.isReady()) {
      optionsToSync = await this.firestoreService.getIndexOptions();
    }

    const eqRes = await this.firestoreService.saveSecIdMapping([], scripToSync);
    let totalOptions = 0;
    if (optionsToSync.length > 0) {
      const optRes = await this.firestoreService.saveIndexOptions(optionsToSync, 2);
      totalOptions = optRes.totalItems;
      this.setIndexOptions(optRes.items && optRes.items.length > 0 ? optRes.items : optionsToSync);
    }
    this.setScripMaster(scripToSync);

    const totalInstruments = eqRes.totalInstruments + totalOptions;
    return {
      success: true,
      collection: 'sec_id_to_name_mapping',
      totalInstruments,
      totalEquities: eqRes.totalEquities,
      totalIndices: eqRes.totalIndices,
      totalOptions,
      documents: eqRes.documents,
      syncedAt: eqRes.syncedAt,
      message: `Successfully synced ${eqRes.totalInstruments} NSE instruments to Firestore collection [sec_id_to_name_mapping]`,
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
   * Retrieve list of tradeable indices synchronously from in-memory cache / database config.
   */
  public getConfiguredIndicesSync(onlyEnabled = true): (Omit<InstrumentItem, 'ltp'> & {
    defaultLots?: number;
    defaultQuantity?: number;
    defaultLotSize?: number;
    defaultQuantityInOneLot?: number;
    stopLossPoints?: number;
  })[] {
    const rawIndices = this.lotSizes?.indices && this.lotSizes.indices.length > 0
      ? this.lotSizes.indices
      : (this.scripMaster.filter((i) => i.instrumentType === 'INDEX').slice(0, 5));

    const filtered = onlyEnabled
      ? rawIndices.filter((idx) => (idx as any).enabled !== false)
      : rawIndices;

    if (filtered.length === 0) {
      return FALLBACK_POPULAR_INSTRUMENTS.filter((i) => i.instrumentType === 'INDEX') as any;
    }

    return filtered.map((idx) => {
      const defaultLotSize = (idx as any).defaultLotSize ?? (idx as any).defaultLots ?? 5;
      const defaultQuantityInOneLot = (idx as any).defaultQuantityInOneLot ?? idx.lotSize ?? 1;
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
        stopLossPoints: (idx as any).stopLossPoints,
      };
    });
  }

  /**
   * Retrieve popular instruments dynamically from master data (configured indices + top active equities).
   */
  public getPopularInstruments(): Omit<InstrumentItem, 'ltp'>[] {
    const configured = this.getConfiguredIndicesSync(true);
    if (this.scripMaster.length > 0) {
      const equities = this.scripMaster
        .filter((item) => item.exchangeSegment === 'NSE_EQ')
        .slice(0, 10);
      return [...configured, ...equities];
    }
    return configured.length > 0 ? configured : FALLBACK_POPULAR_INSTRUMENTS;
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
      midcapNifty: dto.midcapNifty !== undefined ? Number(dto.midcapNifty) : this.lotSizes.midcapNifty,
      sensex: dto.sensex !== undefined ? Number(dto.sensex) : this.lotSizes.sensex,
      nifty50Lots: dto.nifty50Lots !== undefined ? Number(dto.nifty50Lots) : this.lotSizes.nifty50Lots,
      bankNiftyLots: dto.bankNiftyLots !== undefined ? Number(dto.bankNiftyLots) : this.lotSizes.bankNiftyLots,
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
    return this.syncMaster({ csvContent });
  }

  /**
   * Retrieve current sync status and metadata of dedicated collection 'index_options' from Firestore.
   */
  public async getOptionsSyncStatus() {
    const meta = this.firestoreService ? await this.firestoreService.getIndexOptionsMetadata() : null;
    return {
      storedInFirestore: !!meta,
      metadata: meta,
      inMemoryCount: this.indexOptions.length,
      tradedIndices: Array.from(InstrumentsService.TRADED_INDEX_SYMBOLS),
    };
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

  /**
   * Search across cash equities, benchmark indices, and traded index option contracts.
   * Dynamically queries Firestore master data and configured indices.
   */
  async search(query?: string, limit = 10): Promise<InstrumentItem[]> {
    let matched: Omit<InstrumentItem, 'ltp'>[];
    const popular = this.getPopularInstruments();

    if (!query || typeof query !== 'string') {
      matched = popular.slice(0, limit);
    } else {
      const clean = query.trim().toUpperCase();
      const popMatches = popular.filter(
        (item) => item.symbol.includes(clean) || item.name.toUpperCase().includes(clean),
      );

      if (popMatches.length >= limit) {
        matched = popMatches.slice(0, limit);
      } else {
        const seenSecIds = new Set(popMatches.map((p) => p.securityId));
        const masterMatches: Omit<InstrumentItem, 'ltp'>[] = [];

        // 1. Search cash equities & indices from Firestore master data
        for (const item of this.scripMaster) {
          if (seenSecIds.has(item.securityId)) continue;
          if (item.symbol.includes(clean) || item.name.toUpperCase().includes(clean)) {
            masterMatches.push(item);
            seenSecIds.add(item.securityId);
            if (popMatches.length + masterMatches.length >= limit) break;
          }
        }

        // 2. If limit not reached, also search traded index options from Firestore
        if (popMatches.length + masterMatches.length < limit) {
          for (const opt of this.indexOptions) {
            if (seenSecIds.has(opt.securityId)) continue;
            const customUpper = (opt.customSymbol || '').toUpperCase();
            const strikeStr = String(opt.strikePrice);
            if (
              customUpper.includes(clean) ||
              opt.symbolName.includes(clean) ||
              (clean.includes(strikeStr) &&
                (clean.includes(opt.optionType) ||
                  clean.includes(opt.optionType === 'CE' ? 'CALL' : 'PUT')))
            ) {
              masterMatches.push({
                symbol: opt.customSymbol || `${opt.symbolName} ${opt.strikePrice} ${opt.optionType}`,
                name: `${opt.symbolName} ${opt.strikePrice} ${opt.optionType === 'CE' ? 'CALL' : 'PUT'} (${opt.expiryDate})`,
                securityId: opt.securityId,
                exchangeSegment: 'NSE_FNO',
                instrumentType: 'OPTIDX',
                lotSize: opt.lotSize,
              });
              seenSecIds.add(opt.securityId);
              if (popMatches.length + masterMatches.length >= limit) break;
            }
          }
        }

        matched = [...popMatches, ...masterMatches].slice(0, limit);
      }
    }

    return this.enrichWithLiveLtp(matched);
  }

  /**
   * Browse / filter cash equities & indices stored in sec_id_to_name_mapping.
   */
  public getEquities(dto?: QueryEquitiesDto): {
    total: number;
    items: Omit<InstrumentItem, 'ltp'>[];
    limit: number;
    offset: number;
  } {
    const q = dto?.q ? dto.q.trim().toUpperCase() : '';
    const segment = dto?.segment ? dto.segment.trim().toUpperCase() : '';
    const limit = dto?.limit ? Math.min(Math.max(1, dto.limit), 200) : 50;
    const offset = dto?.offset ? Math.max(0, dto.offset) : 0;

    let filtered = this.scripMaster;

    if (segment) {
      filtered = filtered.filter((item) => item.exchangeSegment === segment);
    }

    if (q) {
      filtered = filtered.filter(
        (item) => item.symbol.includes(q) || item.name.toUpperCase().includes(q) || item.securityId === q,
      );
    }

    const paginated = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      items: paginated,
      limit,
      offset,
    };
  }

  /**
   * Browse / filter traded index options stored in index_options collection.
   */
  public getOptions(dto?: QueryOptionsDto): {
    total: number;
    items: CachedIndexOption[];
    limit: number;
    offset: number;
    expiries: string[];
    tradedIndices: string[];
  } {
    const indexFilter = dto?.index ? dto.index.trim().toUpperCase() : '';
    const expiryFilter = dto?.expiry ? dto.expiry.trim() : '';
    const strikeFilter = dto?.strike !== undefined && dto?.strike !== null ? Number(dto.strike) : null;
    const optionTypeFilter = dto?.optionType ? dto.optionType.trim().toUpperCase() : '';
    const q = dto?.q ? dto.q.trim().toUpperCase() : '';
    const limit = dto?.limit ? Math.min(Math.max(1, dto.limit), 200) : 50;
    const offset = dto?.offset ? Math.max(0, dto.offset) : 0;

    let filtered = this.indexOptions;

    if (indexFilter) {
      let symKey = indexFilter;
      if (symKey.includes('BANK')) symKey = 'BANKNIFTY';
      else if (symKey.includes('MIDCP') || symKey.includes('MIDCAP')) symKey = 'MIDCPNIFTY';
      else if (symKey.includes('SENSEX')) symKey = 'SENSEX';
      else if (symKey.includes('NIFTY')) symKey = 'NIFTY';

      filtered = filtered.filter((o) => o.symbolName === symKey);
    }

    if (expiryFilter) {
      filtered = filtered.filter((o) => o.expiryDate === expiryFilter);
    }

    if (strikeFilter !== null && !isNaN(strikeFilter)) {
      filtered = filtered.filter((o) => Math.abs(o.strikePrice - strikeFilter) < 0.1);
    }

    if (optionTypeFilter) {
      const optType = optionTypeFilter.startsWith('C') ? 'CE' : optionTypeFilter.startsWith('P') ? 'PE' : optionTypeFilter;
      filtered = filtered.filter((o) => o.optionType === optType);
    }

    if (q) {
      filtered = filtered.filter(
        (o) =>
          (o.customSymbol && o.customSymbol.toUpperCase().includes(q)) ||
          o.symbolName.includes(q) ||
          String(o.strikePrice).includes(q) ||
          o.securityId === q,
      );
    }

    // Collect distinct expiries
    const expiriesSet = new Set<string>();
    const expirySource = indexFilter ? this.indexOptions.filter((o) => {
      let symKey = indexFilter;
      if (symKey.includes('BANK')) symKey = 'BANKNIFTY';
      else if (symKey.includes('MIDCP') || symKey.includes('MIDCAP')) symKey = 'MIDCPNIFTY';
      else if (symKey.includes('SENSEX')) symKey = 'SENSEX';
      else if (symKey.includes('NIFTY')) symKey = 'NIFTY';
      return o.symbolName === symKey;
    }) : this.indexOptions;

    for (const o of expirySource) {
      if (o.expiryDate) expiriesSet.add(o.expiryDate);
    }
    const expiries = Array.from(expiriesSet).sort();

    const paginated = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      items: paginated,
      limit,
      offset,
      expiries,
      tradedIndices: Array.from(InstrumentsService.TRADED_INDEX_SYMBOLS),
    };
  }

  async getAll(): Promise<InstrumentItem[]> {
    return this.enrichWithLiveLtp(this.getPopularInstruments());
  }

  getAllSync(): Omit<InstrumentItem, 'ltp'>[] {
    return this.getPopularInstruments();
  }

  findBySymbol(symbol: string): Omit<InstrumentItem, 'ltp'> | undefined {
    if (!symbol) return undefined;
    const clean = symbol.trim().toUpperCase();

    // 1. Check configured tradeable indices dynamically from Firestore
    const configured = this.getConfiguredIndicesSync(false);
    for (const idx of configured) {
      const symUpper = idx.symbol.toUpperCase();
      const nameUpper = (idx.name || '').toUpperCase();
      if (clean === symUpper || clean === nameUpper) {
        return idx;
      }
      if (symUpper.includes('BANK') && (clean === 'BANK NIFTY' || clean === 'NIFTY BANK' || clean === 'BANKNIFTY')) {
        return idx;
      }
      if (
        (symUpper.includes('MIDCAP') || symUpper.includes('MIDCP')) &&
        (clean === 'MIDCAP NIFTY' || clean === 'MIDCP NIFTY' || clean === 'MIDCPNIFTY' || clean === 'NIFTY MIDCAP')
      ) {
        return idx;
      }
      if (
        symUpper.includes('SENSEX') &&
        (clean === 'SENSEX' || clean === 'BSE SENSEX' || clean === 'BSE SENSEX INDEX')
      ) {
        return idx;
      }
      if ((symUpper === 'NIFTY' || symUpper === 'NIFTY 50') && (clean === 'NIFTY' || clean === 'NIFTY 50')) {
        return idx;
      }
    }

    // 2. Search scripMaster by exact symbol (Firestore master cache)
    const scripMatch = this.scripMasterBySymbol.get(clean);
    if (scripMatch) return scripMatch;

    // 3. Search scripMaster by company name / custom symbol
    const foundInMaster = this.scripMaster.find(
      (item) => item.symbol.toUpperCase() === clean || item.name.toUpperCase() === clean,
    );
    if (foundInMaster) return foundInMaster;

    // 4. Search in real options loaded from Firestore
    const optMatch = this.indexOptions.find(
      (o) =>
        (o.customSymbol && o.customSymbol.toUpperCase() === clean) ||
        (o.tradingSymbol && o.tradingSymbol.toUpperCase() === clean),
    );
    if (optMatch) {
      return {
        symbol: optMatch.customSymbol || optMatch.tradingSymbol,
        name: optMatch.customSymbol || optMatch.tradingSymbol,
        securityId: String(optMatch.securityId),
        exchangeSegment: optMatch.exchange || 'NSE_FNO',
        instrumentType: 'OPTIDX',
        lotSize: optMatch.lotSize,
      };
    }

    // 5. Fallback cold-start
    return FALLBACK_POPULAR_INSTRUMENTS.find((item) => item.symbol.toUpperCase() === clean);
  }

  findBySecurityId(securityId: string): {
    symbol: string;
    securityId?: string;
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

    // 1. Search indexOptions (loaded from Firestore database)
    const matchedOpt =
      this.indexOptionsBySecId.get(cleanId) ||
      this.indexOptions.find((opt) => String(opt.securityId).trim() === cleanId);
    if (matchedOpt) {
      return {
        symbol: matchedOpt.customSymbol || matchedOpt.tradingSymbol,
        securityId: cleanId,
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

    // 2. Search scripMaster (10,193+ equities and indices from Firestore database)
    const matchedMaster = this.scripMasterBySecId.get(cleanId);
    if (matchedMaster) {
      return {
        symbol: matchedMaster.symbol,
        securityId: cleanId,
        name: matchedMaster.name,
        customSymbol: matchedMaster.symbol,
        tradingSymbol: matchedMaster.symbol,
        exchangeSegment: matchedMaster.exchangeSegment,
        lotSize: matchedMaster.lotSize || 1,
      };
    }

    // 3. Search configured tradeable indices from Firestore
    const matchedConfig = this.getConfiguredIndicesSync(false).find(
      (item) => String(item.securityId).trim() === cleanId,
    );
    if (matchedConfig) {
      return {
        symbol: matchedConfig.symbol,
        securityId: cleanId,
        name: matchedConfig.name,
        exchangeSegment: matchedConfig.exchangeSegment,
        lotSize: matchedConfig.lotSize || 1,
      };
    }

    // 4. Fallback cold-start
    const matchedPop = FALLBACK_POPULAR_INSTRUMENTS.find((item) => String(item.securityId).trim() === cleanId);
    if (matchedPop) {
      return {
        symbol: matchedPop.symbol,
        securityId: cleanId,
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
      // live api check error
    }

    // Strictly real data only: if not found in Firestore or Dhan, return empty array. NEVER generate mock calendar dates.
    return [];
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

    if (raw.includes('BANK')) {
      normalizedName = 'NIFTY BANK';
      baseSymbol = 'BANKNIFTY';
      securityId = '25';
      lotSize = this.lotSizes.bankNifty;
      defaultStep = 100;
    } else if (raw.includes('MIDCP') || raw.includes('MIDCAP')) {
      normalizedName = 'MIDCAP NIFTY';
      baseSymbol = 'MIDCPNIFTY';
      securityId = '442';
      lotSize = this.lotSizes.midcapNifty;
      defaultStep = 25;
    } else if (raw.includes('SENSEX')) {
      normalizedName = 'SENSEX';
      baseSymbol = 'SENSEX';
      securityId = '51';
      exchangeSegment = 'BSE_FNO';
      lotSize = this.lotSizes.sensex;
      defaultStep = 100;
    } else if (raw.includes('NIFTY')) {
      normalizedName = 'NIFTY 50';
      baseSymbol = 'NIFTY';
      securityId = '13';
      lotSize = this.lotSizes.nifty50;
      defaultStep = 50;
    } else {
      const match = this.findBySymbol(raw) || this.findBySecurityId(raw);
      if (match) {
        normalizedName = match.name || match.symbol;
        baseSymbol = match.symbol;
        securityId = match.securityId;
        lotSize = match.lotSize || 1;
        exchangeSegment = match.exchangeSegment === 'NSE_EQ' ? 'NSE_FNO' : (match.exchangeSegment || 'NSE_FNO');
      }
    }

    // 1. Strictly verify options exist in Firestore
    const symbolOptions = this.indexOptions.filter((o) => o.symbolName === baseSymbol);
    if (symbolOptions.length === 0) {
      throw new NotFoundException(
        `Option contracts for ${normalizedName} not found in database. Please sync master data from Settings.`,
      );
    }

    // 2. Determine real available expiries from Firestore options
    const availableExpiries = await this.getExpiries(baseSymbol);
    if (availableExpiries.length === 0) {
      throw new NotFoundException(
        `No option expiry dates found in database for ${normalizedName}. Please sync master data from Settings.`,
      );
    }

    let targetExpiry: string;
    let nextExpiryStr: string | null = null;

    if (dto.expiry) {
      const match = availableExpiries.find((e) => e.expiryDate === dto.expiry);
      if (!match) {
        throw new NotFoundException(
          `Expiry ${dto.expiry} not found in database for ${normalizedName}. Available: ${availableExpiries.map((e) => e.expiryDate).join(', ')}`,
        );
      }
      targetExpiry = match.expiryDate;
      const matchIdx = availableExpiries.findIndex((e) => e.expiryDate === targetExpiry);
      if (matchIdx + 1 < availableExpiries.length) {
        nextExpiryStr = availableExpiries[matchIdx + 1].expiryDate;
      }
    } else {
      targetExpiry = availableExpiries[0].expiryDate;
      if (availableExpiries.length > 1) {
        nextExpiryStr = availableExpiries[1].expiryDate;
      }
    }

    // 3. Find all real strikes available in Firestore for targetExpiry
    const expiryOpts = symbolOptions.filter((o) => o.expiryDate === targetExpiry);
    if (expiryOpts.length === 0) {
      throw new NotFoundException(
        `No option contracts found in database for ${normalizedName} on expiry ${targetExpiry}.`,
      );
    }

    const availableStrikes = Array.from(new Set(expiryOpts.map((o) => o.strikePrice))).sort((a, b) => a - b);
    if (availableStrikes.length === 0) {
      throw new NotFoundException(
        `No strike prices found in database for ${normalizedName} on expiry ${targetExpiry}.`,
      );
    }

    // 4. Determine reference spot price to pick the 3 strikes around spot
    let spotPrice = typeof dto.price === 'string' ? parseFloat(dto.price) : dto.price;
    if (!spotPrice || isNaN(spotPrice) || spotPrice <= 0) {
      const ltpObj = await this.getLtp(normalizedName);
      spotPrice = (ltpObj.ltp && ltpObj.ltp > 0) ? ltpObj.ltp : (defaultStep === 100 ? 52000 : 25500);
    } else {
      spotPrice = parseFloat(String(spotPrice));
    }

    let step = defaultStep;
    if (availableStrikes.length >= 2) {
      step = availableStrikes[1] - availableStrikes[0];
    }

    // Find closest strike in real database strikes
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < availableStrikes.length; i++) {
      const diff = Math.abs(availableStrikes[i] - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    let selectedStrikes: number[] = [];
    if (availableStrikes.length <= 3) {
      selectedStrikes = availableStrikes;
    } else {
      const startIdx = Math.max(0, Math.min(closestIdx - 1, availableStrikes.length - 3));
      selectedStrikes = availableStrikes.slice(startIdx, startIdx + 3);
    }

    const atmStrike = availableStrikes[closestIdx];
    const contracts: OptionContractDetails[] = [];

    const buildChainForExpiryDate = (
      expiryDateStr: string,
      expiryType: 'CURRENT' | 'NEXT',
    ): ExpiryOptionChain => {
      const chainOpts = symbolOptions.filter((o) => o.expiryDate === expiryDateStr);
      const strikePairs: StrikeOptionPair[] = [];
      const d = this.parseDateString(expiryDateStr);
      const fmt = this.formatExpiryDate(d);

      for (const strike of selectedStrikes) {
        const realCall = chainOpts.find((o) => Math.abs(o.strikePrice - strike) < 0.1 && o.optionType === 'CE');
        const realPut = chainOpts.find((o) => Math.abs(o.strikePrice - strike) < 0.1 && o.optionType === 'PE');

        if (!realCall && !realPut) {
          continue;
        }

        const callContract: OptionContractDetails | null = realCall
          ? {
              symbol: realCall.customSymbol || realCall.tradingSymbol,
              tradingSymbol: realCall.tradingSymbol,
              instrumentName: normalizedName,
              strikePrice: realCall.strikePrice,
              optionType: 'CE',
              expiryDate: realCall.expiryDate,
              expiryType,
              securityId: String(realCall.securityId), // REAL DHAN SECURITY ID FROM DATABASE
              exchangeSegment: realCall.exchange || 'NSE_FNO',
              lotSize: realCall.lotSize || lotSize,
              ltp: 0,
              moneyness: strike < atmStrike ? 'ITM' : strike === atmStrike ? 'ATM' : 'OTM',
            }
          : null;

        const putContract: OptionContractDetails | null = realPut
          ? {
              symbol: realPut.customSymbol || realPut.tradingSymbol,
              tradingSymbol: realPut.tradingSymbol,
              instrumentName: normalizedName,
              strikePrice: realPut.strikePrice,
              optionType: 'PE',
              expiryDate: realPut.expiryDate,
              expiryType,
              securityId: String(realPut.securityId), // REAL DHAN SECURITY ID FROM DATABASE
              exchangeSegment: realPut.exchange || 'NSE_FNO',
              lotSize: realPut.lotSize || lotSize,
              ltp: 0,
              moneyness: strike < atmStrike ? 'OTM' : strike === atmStrike ? 'ATM' : 'ITM',
            }
          : null;

        if (callContract) contracts.push(callContract);
        if (putContract) contracts.push(putContract);

        strikePairs.push({
          strikePrice: strike,
          relativeStrike: strike < atmStrike ? 'ATM-1' : strike === atmStrike ? 'ATM' : 'ATM+1',
          call: callContract as any,
          put: putContract as any,
        });
      }

      return {
        expiryDate: expiryDateStr,
        displayExpiry: fmt.displayExpiry,
        shortExpiry: fmt.shortExpiry,
        strikes: strikePairs,
      };
    };

    const currentExpiry = buildChainForExpiryDate(targetExpiry, 'CURRENT');
    const nextExpiry = nextExpiryStr ? buildChainForExpiryDate(nextExpiryStr, 'NEXT') : null;

    // Enrich real contracts with live LTP from Dhan
    if (contracts.length > 0) {
      await this.enrichWithLiveLtp(contracts);
    }

    return {
      instrument: normalizedName,
      spotPrice,
      strikeStep: step,
      strikes: selectedStrikes,
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

  private async enrichWithLiveLtp<T extends { securityId: string; exchangeSegment: string; symbol: string; ltp?: number }>(
    items: T[],
  ): Promise<Array<T & { ltp?: number }>> {
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
        (it as any).ltp = livePrice;
        return { ...it, ltp: livePrice };
      }
      return { ...it };
    });
  }
}
