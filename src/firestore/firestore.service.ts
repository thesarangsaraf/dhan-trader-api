import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Firestore, CollectionReference, DocumentReference } from '@google-cloud/firestore';
import { JWT } from 'google-auth-library';
import { ConfigService } from '../config/config.service';
import { decodeJwtPayload, formatIST } from '../auth/jwt.util';

export interface FirestoreStatus {
  configured: boolean;
  projectId: string;
  databaseId: string;
  keyFile: string;
  keyFileFound: boolean;
  clientEmail?: string;
  error?: string | null;
}

export interface StoredDhanToken {
  accessToken: string;
  clientId: string;
  updatedAt: string;
  expiresAt?: string;
  expiresAtIST?: string;
  issuedAtIST?: string;
  userName?: string;
  status?: string;
  source?: string;
}

export interface CachedIndexOption {
  symbolName: string;
  exchange: string;
  securityId: string;
  tradingSymbol: string;
  customSymbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: string;
  lotSize: number;
}

export interface IndexOptionsMetadata {
  totalItems: number;
  totalChunks: number;
  chunkSize: number;
  updatedAt: string;
}

export interface SecIdMappingMetadata {
  collection: string;
  totalInstruments: number;
  totalOptions: number;
  totalIndices: number;
  totalEquities: number;
  documentsCount: number;
  documentIds: string[];
  updatedAt: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  updatedAt?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  pollIntervalMs: number;
  dhanApiBase: string;
  updatedAt?: string;
}

export interface IndexConfigItem {
  symbol: string;
  name: string;
  securityId: string;
  exchangeSegment: string;
  defaultLotSize: number;           // 1. Default lot size preferred for this index (e.g. 5 lots)
  defaultQuantityInOneLot: number;  // 2. Default quantity in 1 lot size (e.g. 65 shares/lot)
  stopLossPoints?: number;
  enabled: boolean;
  order?: number;

  // Backward compatibility aliases
  lotSize?: number;                 // Alias for defaultQuantityInOneLot
  defaultLots?: number;             // Alias for defaultLotSize
  defaultQuantity?: number;         // defaultLotSize * defaultQuantityInOneLot
}

export const DEFAULT_INDICES: IndexConfigItem[] = [
  {
    symbol: 'NIFTY 50',
    name: 'Nifty 50 Index',
    securityId: '13',
    exchangeSegment: 'IDX_I',
    defaultLotSize: 5,
    defaultQuantityInOneLot: 65,
    lotSize: 65,
    defaultLots: 5,
    defaultQuantity: 325,
    stopLossPoints: 12,
    enabled: true,
    order: 1,
  },
  {
    symbol: 'BANK NIFTY',
    name: 'Bank Nifty Index',
    securityId: '25',
    exchangeSegment: 'IDX_I',
    defaultLotSize: 5,
    defaultQuantityInOneLot: 30,
    lotSize: 30,
    defaultLots: 5,
    defaultQuantity: 150,
    stopLossPoints: 20,
    enabled: true,
    order: 2,
  },
  {
    symbol: 'MIDCAP NIFTY',
    name: 'Nifty Midcap Select',
    securityId: '442',
    exchangeSegment: 'IDX_I',
    defaultLotSize: 5,
    defaultQuantityInOneLot: 120,
    lotSize: 120,
    defaultLots: 5,
    defaultQuantity: 600,
    stopLossPoints: 15,
    enabled: true,
    order: 3,
  },
  {
    symbol: 'SENSEX',
    name: 'BSE Sensex Index',
    securityId: '51',
    exchangeSegment: 'IDX_I',
    defaultLotSize: 5,
    defaultQuantityInOneLot: 20,
    lotSize: 20,
    defaultLots: 5,
    defaultQuantity: 100,
    stopLossPoints: 30,
    enabled: true,
    order: 4,
  },
];

export interface IndexLotSizesConfig {
  nifty50: number;
  bankNifty: number;
  midcapNifty: number;
  sensex: number;
  nifty50Lots?: number;
  bankNiftyLots?: number;
  midcapNiftyLots?: number;
  sensexLots?: number;
  indices?: IndexConfigItem[];
  updatedAt?: string;
}

export const DEFAULT_LOT_SIZES: IndexLotSizesConfig = {
  nifty50: 65,
  bankNifty: 30,
  midcapNifty: 120,
  sensex: 20,
  nifty50Lots: 5,
  bankNiftyLots: 5,
  midcapNiftyLots: 5,
  sensexLots: 5,
  indices: [...DEFAULT_INDICES],
};

export interface FirestoreTestResult {
  success: boolean;
  message: string;
  projectId: string;
  databaseId: string;
  latencyMs?: number;
  collections?: string[];
  error?: string;
}

@Injectable()
export class FirestoreService implements OnModuleInit {
  private readonly logger = new Logger(FirestoreService.name);
  private db: Firestore | null = null;
  private clientEmail: string | null = null;
  private keyFilePath: string | null = null;
  private keyFileFound = false;
  private initError: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.initialize();
    if (this.isReady()) {
      await this.syncAllConfigFromFirestore();
    }
  }

  /**
   * Initializes connection to Google Cloud Firestore with the configured service account.
   */
  public initialize(): boolean {
    try {
      const projectId = this.config.firestoreProjectId || 'dhan-trader-514002';
      const databaseId = this.config.firestoreDatabaseId || 'dhan-trader-firebase-db';
      const keyFileConfig = this.config.firestoreKeyFile || 'google-service-account-key.json';

      // 1. Resolve key file path across common locations
      const candidatePaths = [
        path.isAbsolute(keyFileConfig) ? keyFileConfig : path.resolve(process.cwd(), keyFileConfig),
        path.resolve(__dirname, '..', '..', keyFileConfig),
        path.resolve(__dirname, '..', '..', 'google-service-account-key.json'),
      ];

      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        candidatePaths.unshift(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      }

      let foundPath: string | null = null;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }

      this.keyFilePath = foundPath || candidatePaths[0];
      this.keyFileFound = !!foundPath;

      if (!foundPath) {
        this.initError = `Service account key file not found at: ${this.keyFilePath}`;
        this.logger.warn(`Firestore not initialized: ${this.initError}`);
        return false;
      }

      // 2. Read and parse service account credentials
      const keyJson = JSON.parse(fs.readFileSync(foundPath, 'utf8'));
      if (!keyJson.client_email || !keyJson.private_key) {
        this.initError = 'Service account JSON is missing client_email or private_key';
        this.logger.error(`Firestore initialization failed: ${this.initError}`);
        return false;
      }

      this.clientEmail = keyJson.client_email;
      const actualProjectId = keyJson.project_id || projectId;

      // 3. Create Google Auth JWT client (clean, modern authentication without deprecation warnings)
      const authClient = new JWT({
        email: keyJson.client_email,
        key: keyJson.private_key,
        scopes: [
          'https://www.googleapis.com/auth/cloud-platform',
          'https://www.googleapis.com/auth/datastore',
        ],
      });

      // 4. Initialize Firestore instance pointing to project and named database
      this.db = new Firestore({
        projectId: actualProjectId,
        databaseId: databaseId,
        authClient: authClient,
        ignoreUndefinedProperties: true,
      });

      this.initError = null;
      this.logger.log(
        `✅ Google Cloud Firestore connected (Project: ${actualProjectId}, Database: ${databaseId}, ServiceAccount: ${this.clientEmail})`,
      );
      return true;
    } catch (err: any) {
      this.initError = err.message || String(err);
      this.logger.error(`Failed to initialize Google Firestore: ${this.initError}`, err.stack);
      return false;
    }
  }

  /**
   * Directly set or override Firestore instance (useful for unit testing/mocking).
   */
  public setFirestoreInstance(instance: Firestore | null) {
    this.db = instance;
    this.initError = null;
  }

  /**
   * Check whether Firestore client is initialized and ready.
   */
  public isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Retrieve the active Firestore client instance.
   */
  public getDb(): Firestore {
    if (!this.db) {
      throw new Error(
        `Firestore is not initialized. Error: ${this.initError || 'No active connection'}. Check service account credentials.`,
      );
    }
    return this.db;
  }

  /**
   * Returns current Firestore connection metadata and health state.
   */
  public getStatus(): FirestoreStatus {
    return {
      configured: this.isReady(),
      projectId: this.config.firestoreProjectId || 'dhan-trader-514002',
      databaseId: this.config.firestoreDatabaseId || 'dhan-trader-firebase-db',
      keyFile: this.keyFilePath || this.config.firestoreKeyFile,
      keyFileFound: this.keyFileFound,
      clientEmail: this.clientEmail || undefined,
      error: this.initError,
    };
  }

  /**
   * Execute a live connectivity test against Firestore.
   */
  public async testConnection(): Promise<FirestoreTestResult> {
    const projectId = this.config.firestoreProjectId || 'dhan-trader-514002';
    const databaseId = this.config.firestoreDatabaseId || 'dhan-trader-firebase-db';

    if (!this.db) {
      return {
        success: false,
        message: 'Firestore client is not initialized',
        projectId,
        databaseId,
        error: this.initError || 'Credentials missing or invalid',
      };
    }

    const start = Date.now();
    try {
      const collections = await this.db.listCollections();
      const latencyMs = Date.now() - start;
      const collectionNames = collections.map((col) => col.id);

      return {
        success: true,
        message: `Successfully connected to Firestore database [${databaseId}] in project [${projectId}]`,
        projectId,
        databaseId,
        latencyMs,
        collections: collectionNames,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        success: false,
        message: `Failed to communicate with Firestore database [${databaseId}]`,
        projectId,
        databaseId,
        latencyMs,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Helper: Retrieve Dhan access token document from Firestore database (config/dhan).
   */
  public async getDhanToken(): Promise<StoredDhanToken | null> {
    if (!this.isReady()) {
      return null;
    }
    const token = await this.getDoc<StoredDhanToken>('config', 'dhan');
    if (token) return token;

    // Fallback migration check for legacy path (dhan/token or tokens/dhan)
    const legacyToken = (await this.getDoc<StoredDhanToken>('dhan', 'token'))
      || (await this.getDoc<StoredDhanToken>('tokens', 'dhan'));
    if (legacyToken) {
      await this.setDoc('config', 'dhan', legacyToken, true);
      await this.deleteDoc('dhan', 'token').catch(() => {});
      await this.deleteDoc('tokens', 'dhan').catch(() => {});
      return legacyToken;
    }
    return null;
  }

  /**
   * Helper: Save or update Dhan access token in Firestore database (config/dhan).
   * Guarded against stale overwrites: If Firestore already holds a token with a later expiry
   * than the incoming token, the write is rejected unless `options.force` is explicitly true.
   */
  public async saveDhanToken(
    tokenData: Partial<StoredDhanToken> & { accessToken: string; clientId: string },
    options: { force?: boolean } = {},
  ): Promise<{ success: boolean; writeTime: string; skipped?: boolean; reason?: string }> {
    if (!this.isReady()) {
      return { success: false, writeTime: new Date().toISOString(), skipped: true, reason: 'NOT_READY' };
    }

    const incomingToken = (tokenData.accessToken || '').trim();
    if (!incomingToken) {
      return { success: false, writeTime: new Date().toISOString(), skipped: true, reason: 'EMPTY_TOKEN' };
    }

    const incomingPayload = decodeJwtPayload(incomingToken);
    const nowSec = Math.floor(Date.now() / 1000);
    const incomingExp = incomingPayload?.exp || 0;
    const incomingIat = incomingPayload?.iat || (incomingExp ? incomingExp - 86400 : nowSec);

    // Guard against overwriting newer/active token with stale/expired token
    if (!options.force) {
      try {
        const existing = await this.getDoc<StoredDhanToken>('config', 'dhan')
          || await this.getDoc<StoredDhanToken>('dhan', 'token');
        if (existing?.accessToken) {
          const existingPayload = decodeJwtPayload(existing.accessToken);
          const existingExp = existingPayload?.exp || 0;

          // If incoming token has an earlier expiry than existing token in Firestore, reject write
          if (existingExp > 0 && incomingExp > 0 && incomingExp < existingExp) {
            this.logger.warn(
              `⚠️ Stale token write rejected: incoming token expires at ${new Date(incomingExp * 1000).toISOString()}, but Firestore already has a newer token expiring at ${new Date(existingExp * 1000).toISOString()} (source: ${tokenData.source || 'unknown'})`,
            );
            return {
              success: false,
              writeTime: new Date().toISOString(),
              skipped: true,
              reason: 'OLDER_THAN_EXISTING',
            };
          }

          // If existing token is still active, reject saving an already-expired token
          if (existingExp > nowSec && incomingExp <= nowSec && incomingExp > 0) {
            this.logger.warn(
              `⚠️ Expired token write rejected: incoming token is expired, but Firestore token is still active (expires ${existing.expiresAtIST || new Date(existingExp * 1000).toISOString()})`,
            );
            return {
              success: false,
              writeTime: new Date().toISOString(),
              skipped: true,
              reason: 'INCOMING_EXPIRED',
            };
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not check existing token prior to save: ${err.message}`);
      }
    }

    const derivedClientId = tokenData.clientId || incomingPayload?.clientId || incomingPayload?.sub || this.config.clientId;
    const derivedStatus = incomingExp && incomingExp < nowSec ? 'EXPIRED' : (tokenData.status || 'ACTIVE');

    const payload: StoredDhanToken = {
      accessToken: incomingToken,
      clientId: derivedClientId,
      updatedAt: tokenData.updatedAt || new Date().toISOString(),
      expiresAt: incomingExp ? new Date(incomingExp * 1000).toISOString() : tokenData.expiresAt,
      expiresAtIST: incomingExp ? formatIST(new Date(incomingExp * 1000)) : tokenData.expiresAtIST,
      issuedAtIST: incomingExp ? formatIST(new Date(incomingIat * 1000)) : tokenData.issuedAtIST,
      userName: incomingPayload?.userName || incomingPayload?.name || tokenData.userName,
      status: derivedStatus,
      source: tokenData.source || 'dhan',
    };

    const res = await this.setDoc('config', 'dhan', payload, true);
    return {
      success: true,
      writeTime: res.writeTime,
    };
  }

  /**
   * Helper: Save index options array into Firestore database in chunked documents.
   * Stored in collection 'index_options' with document IDs 'chunk_000', 'chunk_001', etc.
   * Plus a '_meta' document tracking total count and chunk structure.
   */
  public async saveIndexOptions(
    items: CachedIndexOption[],
    chunkSize = 500,
  ): Promise<{ success: boolean; totalItems: number; totalChunks: number; writeTime: string }> {
    if (!this.isReady()) {
      throw new Error(`Firestore is not initialized. Check credentials.`);
    }

    const chunks: CachedIndexOption[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const totalChunks = chunks.length;
    const now = new Date().toISOString();
    const colRef = this.collection('index_options');

    // 1. Write chunk documents in parallel
    const writePromises = chunks.map((chunkItems, idx) => {
      const docId = `chunk_${String(idx).padStart(3, '0')}`;
      return colRef.doc(docId).set(
        {
          chunkIndex: idx,
          totalChunks,
          count: chunkItems.length,
          items: chunkItems,
          updatedAt: now,
        },
        { merge: false },
      );
    });

    await Promise.all(writePromises);

    // 2. Clean up any obsolete stale chunks if previously there were more chunks
    try {
      const snapshot = await colRef.get();
      const staleDocs = snapshot.docs.filter((d) => {
        const data = d.data();
        return typeof data.chunkIndex === 'number' && data.chunkIndex >= totalChunks;
      });
      if (staleDocs.length > 0) {
        await Promise.all(staleDocs.map((d) => d.ref.delete()));
      }
    } catch (err: any) {
      this.logger.warn(`Could not check for stale chunks in index_options: ${err.message}`);
    }

    // 3. Write metadata document
    const metaRes = await colRef.doc('_meta').set(
      {
        totalItems: items.length,
        totalChunks,
        chunkSize,
        updatedAt: now,
      },
      { merge: true },
    );

    this.logger.log(
      `✅ Saved ${items.length} index options into Firestore database collection 'index_options' across ${totalChunks} chunks`,
    );

    return {
      success: true,
      totalItems: items.length,
      totalChunks,
      writeTime: metaRes.writeTime.toDate().toISOString(),
    };
  }

  /**
   * Helper: Retrieve all index options from Firestore collection 'index_options'.
   * Re-assembles chunk documents in sequential order.
   */
  public async getIndexOptions(): Promise<CachedIndexOption[]> {
    if (!this.isReady()) {
      return [];
    }

    const snapshot = await this.collection('index_options').get();
    if (snapshot.empty) {
      return [];
    }

    const chunkDocs = snapshot.docs
      .map((d) => d.data())
      .filter((d) => Array.isArray(d.items) && typeof d.chunkIndex === 'number')
      .sort((a, b) => (a.chunkIndex as number) - (b.chunkIndex as number));

    const allOptions: CachedIndexOption[] = [];
    for (const chunk of chunkDocs) {
      for (const item of chunk.items) {
        allOptions.push(item);
      }
    }

    return allOptions;
  }

  /**
   * Helper: Retrieve metadata for stored index options from Firestore.
   */
  public async getIndexOptionsMetadata(): Promise<IndexOptionsMetadata | null> {
    if (!this.isReady()) {
      return null;
    }
    return this.getDoc<IndexOptionsMetadata>('index_options', '_meta');
  }

  /**
   * Helper: Delete all index options documents and metadata in Firestore.
   */
  public async deleteIndexOptions(): Promise<{ success: boolean; deletedCount: number }> {
    if (!this.isReady()) {
      return { success: false, deletedCount: 0 };
    }
    const snapshot = await this.collection('index_options').get();
    if (snapshot.empty) {
      return { success: true, deletedCount: 0 };
    }
    await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
    return { success: true, deletedCount: snapshot.docs.length };
  }

  /**
   * Helper: Save all NSE index options, indices, and equities into Firestore collection 'sec_id_to_name_mapping'.
   * Divides data logically by instrument into documents:
   * - nifty_50_options_part1, nifty_50_options_part2 (all NIFTY option contracts)
   * - bank_nifty_options (all BANK NIFTY option contracts)
   * - finnifty_options (all FINNIFTY option contracts)
   * - midcap_nifty_options (all MIDCAP NIFTY option contracts)
   * - indices (all NSE benchmark & sectoral indices)
   * - equities_chunk_01 ... equities_chunk_XX (all NSE equities in balanced chunks)
   * - _meta (comprehensive metadata)
   *
   * Strictly filters out any BSE or non-NSE objects.
   */
  public async saveSecIdMapping(
    options: CachedIndexOption[] = [],
    scripMaster: any[] = [],
  ): Promise<{
    success: boolean;
    collection: string;
    totalInstruments: number;
    totalOptions: number;
    totalIndices: number;
    totalEquities: number;
    documents: string[];
    syncedAt: string;
  }> {
    if (!this.isReady()) {
      throw new Error('Firestore is not initialized. Check credentials.');
    }

    const colRef = this.collection('sec_id_to_name_mapping');
    const now = new Date().toISOString();
    const docsToWrite: Record<string, any> = {};

    // 1. Strictly filter to NSE instruments only
    const nseOptions = options.filter(
      (opt) => !opt.exchange || opt.exchange.startsWith('NSE'),
    );
    const nseScrip = scripMaster.filter(
      (s) =>
        (!s.exchangeSegment || s.exchangeSegment.startsWith('NSE') || s.exchangeSegment === 'IDX_I') &&
        !s.exchangeSegment.startsWith('BSE'),
    );

    // 2. Options divided by instrument
    const niftyOpts = nseOptions.filter((o) => o.symbolName === 'NIFTY');
    if (niftyOpts.length > 2500) {
      docsToWrite['nifty_50_options_part1'] = {
        documentId: 'nifty_50_options_part1',
        symbol: 'NIFTY 50',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        part: 1,
        totalParts: 2,
        count: niftyOpts.slice(0, 2500).length,
        items: niftyOpts.slice(0, 2500),
        updatedAt: now,
      };
      docsToWrite['nifty_50_options_part2'] = {
        documentId: 'nifty_50_options_part2',
        symbol: 'NIFTY 50',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        part: 2,
        totalParts: 2,
        count: niftyOpts.slice(2500).length,
        items: niftyOpts.slice(2500),
        updatedAt: now,
      };
    } else if (niftyOpts.length > 0) {
      docsToWrite['nifty_50_options'] = {
        documentId: 'nifty_50_options',
        symbol: 'NIFTY 50',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        count: niftyOpts.length,
        items: niftyOpts,
        updatedAt: now,
      };
    }

    const bankOpts = nseOptions.filter((o) => o.symbolName === 'BANKNIFTY');
    if (bankOpts.length > 0) {
      docsToWrite['bank_nifty_options'] = {
        documentId: 'bank_nifty_options',
        symbol: 'BANK NIFTY',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        count: bankOpts.length,
        items: bankOpts,
        updatedAt: now,
      };
    }

    const midOpts = nseOptions.filter((o) => o.symbolName === 'MIDCPNIFTY');
    if (midOpts.length > 0) {
      docsToWrite['midcap_nifty_options'] = {
        documentId: 'midcap_nifty_options',
        symbol: 'MIDCAP NIFTY',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        count: midOpts.length,
        items: midOpts,
        updatedAt: now,
      };
    }

    // Any other remaining option contracts
    const handledSymbols = new Set(['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY']);
    const otherOpts = nseOptions.filter((o) => !handledSymbols.has(o.symbolName));
    if (otherOpts.length > 0) {
      docsToWrite['other_options'] = {
        documentId: 'other_options',
        symbol: 'OTHER_OPTIONS',
        category: 'OPTIONS',
        exchange: 'NSE_FNO',
        count: otherOpts.length,
        items: otherOpts,
        updatedAt: now,
      };
    }

    // 3. Scrip master: Indices
    const indices = nseScrip.filter(
      (s) => s.instrumentType === 'INDEX' || s.exchangeSegment === 'IDX_I',
    );
    if (indices.length > 0) {
      docsToWrite['indices'] = {
        documentId: 'indices',
        symbol: 'NSE_INDICES',
        category: 'INDEX',
        exchange: 'IDX_I',
        count: indices.length,
        items: indices,
        updatedAt: now,
      };
    }

    // 4. Scrip master: Equities divided into chunks of 2,000 items
    const equities = nseScrip.filter((s) => s.instrumentType === 'EQUITY');
    const eqChunkSize = 2000;
    const totalEqChunks = Math.ceil(equities.length / eqChunkSize);
    for (let i = 0; i < equities.length; i += eqChunkSize) {
      const chunkIdx = Math.floor(i / eqChunkSize) + 1;
      const docId = `equities_chunk_${String(chunkIdx).padStart(2, '0')}`;
      const slice = equities.slice(i, i + eqChunkSize);
      docsToWrite[docId] = {
        documentId: docId,
        symbol: 'NSE_EQUITIES',
        category: 'EQUITY',
        exchange: 'NSE_EQ',
        chunkIndex: chunkIdx,
        totalChunks: totalEqChunks,
        count: slice.length,
        items: slice,
        updatedAt: now,
      };
    }

    const docIds = Object.keys(docsToWrite);

    // 5. Write all documents in parallel
    await Promise.all(
      docIds.map((docId) => colRef.doc(docId).set(docsToWrite[docId], { merge: false })),
    );

    // 6. Write metadata document
    const totalInstruments = nseOptions.length + nseScrip.length;
    await colRef.doc('_meta').set(
      {
        collection: 'sec_id_to_name_mapping',
        totalInstruments,
        totalOptions: nseOptions.length,
        totalIndices: indices.length,
        totalEquities: equities.length,
        documentsCount: docIds.length,
        documentIds: docIds,
        updatedAt: now,
      },
      { merge: true },
    );

    this.logger.log(
      `✅ Saved ${totalInstruments} NSE instruments into Firestore collection 'sec_id_to_name_mapping' across ${docIds.length} documents`,
    );

    return {
      success: true,
      collection: 'sec_id_to_name_mapping',
      totalInstruments,
      totalOptions: nseOptions.length,
      totalIndices: indices.length,
      totalEquities: equities.length,
      documents: docIds,
      syncedAt: now,
    };
  }

  /**
   * Helper: Retrieve all NSE index options and scrip master items from Firestore collection 'sec_id_to_name_mapping'.
   */
  public async getSecIdMapping(): Promise<{
    options: CachedIndexOption[];
    scripMaster: any[];
  }> {
    if (!this.isReady()) {
      return { options: [], scripMaster: [] };
    }

    const snapshot = await this.collection('sec_id_to_name_mapping').get();
    if (snapshot.empty) {
      return { options: [], scripMaster: [] };
    }

    const options: CachedIndexOption[] = [];
    const scripMaster: any[] = [];

    for (const doc of snapshot.docs) {
      if (doc.id === '_meta') continue;
      const data = doc.data();
      if (!Array.isArray(data.items)) continue;

      if (data.category === 'OPTIONS') {
        for (const item of data.items) {
          options.push(item);
        }
      } else if (data.category === 'INDEX' || data.category === 'EQUITY') {
        for (const item of data.items) {
          scripMaster.push(item);
        }
      }
    }

    return { options, scripMaster };
  }

  /**
   * Helper: Retrieve metadata for collection 'sec_id_to_name_mapping' from Firestore.
   */
  public async getSecIdMappingMetadata(): Promise<SecIdMappingMetadata | null> {
    if (!this.isReady()) {
      return null;
    }
    return this.getDoc<SecIdMappingMetadata>('sec_id_to_name_mapping', '_meta');
  }

  /**
   * Helper: Delete all documents in collection 'sec_id_to_name_mapping'.
   */
  public async deleteSecIdMapping(): Promise<{ success: boolean; deletedCount: number }> {
    if (!this.isReady()) {
      return { success: false, deletedCount: 0 };
    }
    const snapshot = await this.collection('sec_id_to_name_mapping').get();
    if (snapshot.empty) {
      return { success: true, deletedCount: 0 };
    }
    await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
    return { success: true, deletedCount: snapshot.docs.length };
  }

  /**
   * Helper: Retrieve index lot sizes from Firestore database (config/lot_sizes).
   * Falls back to standard defaults if not yet customized.
   */
  public async getLotSizes(): Promise<IndexLotSizesConfig> {
    if (!this.isReady()) {
      return { ...DEFAULT_LOT_SIZES, indices: DEFAULT_INDICES.map((i) => ({ ...i })) };
    }
    const doc = await this.getDoc<any>('config', 'lot_sizes');
    if (!doc) {
      return { ...DEFAULT_LOT_SIZES, indices: DEFAULT_INDICES.map((i) => ({ ...i })) };
    }

    // Extract clean indices list from Firestore
    let indices: IndexConfigItem[] = [];
    if (Array.isArray(doc.indices) && doc.indices.length > 0) {
      indices = doc.indices.map((idx: any, orderIdx: number) => {
        // 1. defaultLotSize = preferred number of lots by user
        // 2. defaultQuantityInOneLot = quantity in 1 lot size
        const rawQty = idx.defaultQuantityInOneLot ?? idx.lotSize;
        const defaultQuantityInOneLot = rawQty !== undefined && rawQty !== null ? Number(rawQty) : 0;
        const rawLots = idx.defaultLotSize ?? idx.defaultLots;
        const defaultLotSize = rawLots !== undefined && rawLots !== null ? Number(rawLots) : 0;

        return {
          symbol: idx.symbol,
          name: idx.name,
          securityId: idx.securityId,
          exchangeSegment: idx.exchangeSegment,
          defaultLotSize,
          defaultQuantityInOneLot,
          // Compatibility aliases:
          lotSize: defaultQuantityInOneLot,
          defaultLots: defaultLotSize,
          defaultQuantity: defaultLotSize * defaultQuantityInOneLot,
          stopLossPoints: idx.stopLossPoints,
          enabled: idx.enabled !== false,
          order: idx.order ?? orderIdx + 1,
        };
      });
    } else {
      indices = DEFAULT_INDICES.map((i) => ({ ...i }));
    }

    const niftyItem = indices.find((i) => i.symbol.toUpperCase().includes('NIFTY 50')) || indices[0];
    const bankItem = indices.find((i) => i.symbol.toUpperCase().includes('BANK'));
    const midcapItem = indices.find((i) => i.symbol.toUpperCase().includes('MIDCAP') || i.symbol.toUpperCase().includes('MIDCP'));
    const sensexItem = indices.find((i) => i.symbol.toUpperCase().includes('SENSEX'));

    const nifty50 = Number(niftyItem?.defaultQuantityInOneLot ?? niftyItem?.lotSize ?? 0);
    const bankNifty = Number(bankItem?.defaultQuantityInOneLot ?? bankItem?.lotSize ?? 0);
    const midcapNifty = Number(midcapItem?.defaultQuantityInOneLot ?? midcapItem?.lotSize ?? 0);
    const sensex = Number(sensexItem?.defaultQuantityInOneLot ?? sensexItem?.lotSize ?? 0);

    const nifty50Lots = Number(niftyItem?.defaultLotSize ?? niftyItem?.defaultLots ?? 0);
    const bankNiftyLots = Number(bankItem?.defaultLotSize ?? bankItem?.defaultLots ?? 0);
    const midcapNiftyLots = Number(midcapItem?.defaultLotSize ?? midcapItem?.defaultLots ?? 0);
    const sensexLots = Number(sensexItem?.defaultLotSize ?? sensexItem?.defaultLots ?? 0);

    return {
      nifty50,
      bankNifty,
      midcapNifty,
      sensex,
      nifty50Lots,
      bankNiftyLots,
      midcapNiftyLots,
      sensexLots,
      indices,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * Helper: Save or update index lot sizes in Firestore database (config/lot_sizes).
   * Stores strictly clean, standardized data:
   * 1. defaultLotSize: default lot size for index (how much lot size preferred by user)
   * 2. defaultQuantityInOneLot: default quantity in 1 lot size (how much quantity is there for 1 lot size)
   */
  public async saveLotSizes(
    config: Partial<IndexLotSizesConfig>,
  ): Promise<{ success: boolean; data: IndexLotSizesConfig; writeTime: string }> {
    if (!this.isReady()) {
      throw new Error('Firestore is not initialized. Check credentials.');
    }
    const current = await this.getLotSizes();

    let targetIndices: IndexConfigItem[] = [];
    if (config.indices && Array.isArray(config.indices) && config.indices.length > 0) {
      targetIndices = config.indices.map((idx: any, orderIdx: number) => {
        const rawQty = idx.defaultQuantityInOneLot ?? idx.lotSize;
        const defaultQuantityInOneLot = rawQty !== undefined && rawQty !== null ? Number(rawQty) : 0;
        const rawLots = idx.defaultLotSize ?? idx.defaultLots;
        const defaultLotSize = rawLots !== undefined && rawLots !== null ? Number(rawLots) : 0;
        return {
          symbol: idx.symbol,
          name: idx.name,
          securityId: idx.securityId,
          exchangeSegment: idx.exchangeSegment,
          defaultLotSize,
          defaultQuantityInOneLot,
          stopLossPoints: idx.stopLossPoints,
          enabled: idx.enabled !== false,
          order: idx.order ?? orderIdx + 1,
        };
      });
    } else {
      // Build from current or partial inputs
      targetIndices = (current.indices || DEFAULT_INDICES).map((idx, orderIdx) => {
        const sym = idx.symbol.toUpperCase();
        let qtyInOneLot = idx.defaultQuantityInOneLot;
        let preferredLots = idx.defaultLotSize;

        if (sym.includes('BANK')) {
          if (config.bankNifty !== undefined) qtyInOneLot = Number(config.bankNifty);
          if (config.bankNiftyLots !== undefined) preferredLots = Number(config.bankNiftyLots);
        } else if (sym.includes('MIDCAP') || sym.includes('MIDCP')) {
          if (config.midcapNifty !== undefined) qtyInOneLot = Number(config.midcapNifty);
          if (config.midcapNiftyLots !== undefined) preferredLots = Number(config.midcapNiftyLots);
        } else if (sym.includes('SENSEX')) {
          if (config.sensex !== undefined) qtyInOneLot = Number(config.sensex);
          if (config.sensexLots !== undefined) preferredLots = Number(config.sensexLots);
        } else if (sym.includes('NIFTY')) {
          if (config.nifty50 !== undefined) qtyInOneLot = Number(config.nifty50);
          if (config.nifty50Lots !== undefined) preferredLots = Number(config.nifty50Lots);
        }

        return {
          symbol: idx.symbol,
          name: idx.name,
          securityId: idx.securityId,
          exchangeSegment: idx.exchangeSegment,
          defaultLotSize: preferredLots,
          defaultQuantityInOneLot: qtyInOneLot,
          stopLossPoints: idx.stopLossPoints,
          enabled: idx.enabled !== false,
          order: idx.order ?? orderIdx + 1,
        };
      });
    }

    // PURE CLEAN FIRESTORE DOCUMENT — Only standardized indices array with:
    // 1. defaultLotSize
    // 2. defaultQuantityInOneLot
    const cleanFirestoreDoc = {
      indices: targetIndices.map((i) => ({
        symbol: i.symbol,
        name: i.name,
        securityId: i.securityId,
        exchangeSegment: i.exchangeSegment,
        defaultLotSize: i.defaultLotSize,
        defaultQuantityInOneLot: i.defaultQuantityInOneLot,
        stopLossPoints: i.stopLossPoints,
        enabled: i.enabled !== false,
        order: i.order,
      })),
      updatedAt: new Date().toISOString(),
    };

    // Note: merge: false completely wipes previous messy/legacy properties in config/lot_sizes
    const res = await this.setDoc('config', 'lot_sizes', cleanFirestoreDoc, false);
    this.logger.log(`⚙️ Saved clean index lot sizes to Firestore (config/lot_sizes): ${targetIndices.map((i) => `${i.symbol}: ${i.defaultLotSize} lots (${i.defaultQuantityInOneLot}/lot)`).join(', ')}`);

    // In-memory enriched return data with compatibility aliases
    const enrichedIndices: IndexConfigItem[] = targetIndices.map((i) => ({
      ...i,
      lotSize: i.defaultQuantityInOneLot,
      defaultLots: i.defaultLotSize,
      defaultQuantity: i.defaultLotSize * i.defaultQuantityInOneLot,
    }));

    const resultData: IndexLotSizesConfig = {
      indices: enrichedIndices,
      nifty50: targetIndices.find((i) => i.symbol.includes('NIFTY 50'))?.defaultQuantityInOneLot ?? 0,
      bankNifty: targetIndices.find((i) => i.symbol.includes('BANK'))?.defaultQuantityInOneLot ?? 0,
      midcapNifty: targetIndices.find((i) => i.symbol.includes('MIDCAP') || i.symbol.includes('MIDCP'))?.defaultQuantityInOneLot ?? 0,
      sensex: targetIndices.find((i) => i.symbol.includes('SENSEX'))?.defaultQuantityInOneLot ?? 0,
      nifty50Lots: targetIndices.find((i) => i.symbol.includes('NIFTY 50'))?.defaultLotSize ?? 0,
      bankNiftyLots: targetIndices.find((i) => i.symbol.includes('BANK'))?.defaultLotSize ?? 0,
      midcapNiftyLots: targetIndices.find((i) => i.symbol.includes('MIDCAP') || i.symbol.includes('MIDCP'))?.defaultLotSize ?? 0,
      sensexLots: targetIndices.find((i) => i.symbol.includes('SENSEX'))?.defaultLotSize ?? 0,
      updatedAt: cleanFirestoreDoc.updatedAt,
    };

    return {
      success: true,
      data: resultData,
      writeTime: res.writeTime,
    };
  }

  /**
   * Helper: Retrieve Telegram credentials from Firestore (config/telegram).
   */
  public async getTelegramConfig(): Promise<TelegramConfig | null> {
    if (!this.isReady()) return null;
    return this.getDoc<TelegramConfig>('config', 'telegram');
  }

  /**
   * Helper: Save Telegram credentials in Firestore (config/telegram).
   */
  public async saveTelegramConfig(
    cfg: { botToken: string; chatId: string },
  ): Promise<{ success: boolean; writeTime: string }> {
    if (!this.isReady()) {
      throw new Error('Firestore is not initialized. Check credentials.');
    }
    const payload: TelegramConfig = {
      botToken: cfg.botToken.trim(),
      chatId: cfg.chatId.trim(),
      updatedAt: new Date().toISOString(),
    };
    const res = await this.setDoc('config', 'telegram', payload, true);
    if (this.config && typeof (this.config as any).updateCredentials === 'function') {
      this.config.updateCredentials({
        telegramBotToken: payload.botToken,
        telegramChatId: payload.chatId,
      });
    }
    this.logger.log(`⚙️ Saved Telegram configuration to Firestore (config/telegram)`);
    return {
      success: true,
      writeTime: res.writeTime,
    };
  }

  /**
   * Helper: Retrieve application settings from Firestore (config/app).
   */
  public async getAppConfig(): Promise<AppConfig | null> {
    if (!this.isReady()) return null;
    return this.getDoc<AppConfig>('config', 'app');
  }

  /**
   * Helper: Save application settings in Firestore (config/app).
   */
  public async saveAppConfig(
    cfg: Partial<AppConfig>,
  ): Promise<{ success: boolean; writeTime: string }> {
    if (!this.isReady()) {
      throw new Error('Firestore is not initialized. Check credentials.');
    }
    const current = await this.getAppConfig();
    const payload: AppConfig = {
      port: cfg.port !== undefined ? Number(cfg.port) : (current?.port || this.config.port || 8000),
      host: cfg.host || current?.host || this.config.host || '127.0.0.1',
      pollIntervalMs: cfg.pollIntervalMs !== undefined ? Number(cfg.pollIntervalMs) : (current?.pollIntervalMs || this.config.pollIntervalMs || 4000),
      dhanApiBase: cfg.dhanApiBase || current?.dhanApiBase || this.config.dhanApiBase || 'https://api.dhan.co/v2',
      updatedAt: new Date().toISOString(),
    };
    const res = await this.setDoc('config', 'app', payload, true);
    if (payload.port) this.config.port = payload.port;
    if (payload.host) this.config.host = payload.host;
    if (payload.pollIntervalMs) this.config.pollIntervalMs = payload.pollIntervalMs;
    if (payload.dhanApiBase) this.config.dhanApiBase = payload.dhanApiBase;
    this.logger.log(`⚙️ Saved Application configuration to Firestore (config/app)`);
    return {
      success: true,
      writeTime: res.writeTime,
    };
  }

  /**
   * Synchronizes all application settings, Telegram credentials, and Dhan tokens
   * from Firestore database directly into in-memory ConfigService state.
   */
  public async syncAllConfigFromFirestore(): Promise<void> {
    if (!this.isReady()) return;

    try {
      // 1. Dhan Access Token & Client ID
      const tokenDoc = await this.getDhanToken();
      if (tokenDoc?.accessToken) {
        if (this.config && typeof (this.config as any).updateCredentials === 'function') {
          this.config.updateCredentials({
            accessToken: tokenDoc.accessToken,
            clientId: tokenDoc.clientId || this.config.clientId,
          });
        }
        this.logger.log(`🔑 Dhan credentials synced from Firestore (config/dhan)`);
      }

      // 2. Telegram Bot Token & Chat ID
      const telegramDoc = await this.getTelegramConfig();
      if (telegramDoc?.botToken && telegramDoc?.chatId) {
        if (this.config && typeof (this.config as any).updateCredentials === 'function') {
          this.config.updateCredentials({
            telegramBotToken: telegramDoc.botToken,
            telegramChatId: telegramDoc.chatId,
          });
        }
        this.logger.log(`📱 Telegram credentials synced from Firestore (config/telegram)`);
      }

      // 3. Application Configuration (Port, Host, Poll Interval, Dhan API Base)
      const appDoc = await this.getAppConfig();
      if (appDoc) {
        if (appDoc.port) this.config.port = Number(appDoc.port);
        if (appDoc.host) this.config.host = String(appDoc.host);
        if (appDoc.pollIntervalMs) this.config.pollIntervalMs = Number(appDoc.pollIntervalMs);
        if (appDoc.dhanApiBase) this.config.dhanApiBase = String(appDoc.dhanApiBase);
        this.logger.log(`⚙️ Application settings synced from Firestore (config/app)`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not sync configurations from Firestore: ${err.message}`);
    }
  }

  /**
   * Helper: Get a reference to a Firestore collection.
   */
  public collection(collectionName: string): CollectionReference {
    return this.getDb().collection(collectionName);
  }

  /**
   * Helper: Get a reference to a specific document.
   */
  public doc(collectionName: string, docId: string): DocumentReference {
    return this.getDb().collection(collectionName).doc(docId);
  }

  /**
   * Helper: Retrieve a document by ID.
   */
  public async getDoc<T = any>(collectionName: string, docId: string): Promise<T | null> {
    const snapshot = await this.doc(collectionName, docId).get();
    if (!snapshot.exists) {
      return null;
    }
    return snapshot.data() as T;
  }

  /**
   * Helper: Write or update a document by ID.
   */
  public async setDoc<T = Record<string, any>>(
    collectionName: string,
    docId: string,
    data: T,
    merge = true,
  ): Promise<{ success: boolean; writeTime: string }> {
    const res = await this.doc(collectionName, docId).set(data as any, { merge });
    return {
      success: true,
      writeTime: res.writeTime.toDate().toISOString(),
    };
  }

  /**
   * Helper: Delete a document by ID.
   */
  public async deleteDoc(collectionName: string, docId: string): Promise<{ success: boolean }> {
    await this.doc(collectionName, docId).delete();
    return { success: true };
  }

  /**
   * Helper: List documents in a collection with an optional limit.
   */
  public async listDocuments(
    collectionName: string,
    limit = 50,
  ): Promise<Array<{ id: string; data: any }>> {
    const snapshot = await this.collection(collectionName).limit(limit).get();
    return snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      data: docSnap.data(),
    }));
  }
}
