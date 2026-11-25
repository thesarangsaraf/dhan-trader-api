import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';
import { GetHistoricalCandlesQueryDto } from './dto/sync-historical-data.dto';

export interface HistoricalCandle {
  epoch: number;
  timestampIST: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoricalCandlesMonthDoc {
  month: string;
  count: number;
  startEpoch: number;
  endEpoch: number;
  csv: string;
  updatedAt: string;
}

export interface HistoricalCandlesMetadata {
  symbol: string;
  securityId: string;
  timeframe: string;
  sourceRepo: string;
  collection: string;
  totalCandles: number;
  totalMonths: number;
  firstEpoch: number;
  lastEpoch: number;
  firstMonth: string;
  lastMonth: string;
  months: string[];
  monthCounts: Record<string, number>;
  updatedAt: string;
}

export interface HistoricalDataStatusResponse {
  storedInFirestore: boolean;
  syncInProgress: boolean;
  sourceRepo: string;
  collection: string;
  metadata: HistoricalCandlesMetadata | null;
}

export interface HistoricalDataSyncResponse {
  success: boolean;
  collection: string;
  symbol: string;
  timeframe: string;
  sourceRepo: string;
  mode: 'full' | 'incremental';
  filesProcessed: number;
  filesSkipped: number;
  total1MinRows: number;
  totalCandlesSynced: number;
  totalCandlesInDb: number;
  monthsWritten: string[];
  totalMonthsInDb: number;
  firstMonth: string;
  lastMonth: string;
  firstEpoch: number;
  lastEpoch: number;
  durationMs: number;
  syncedAt: string;
  message: string;
}

interface ActiveBucket {
  epoch: number;
  monthKey: string;
  bucketKey: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MonthBuffer {
  month: string;
  startEpoch: number;
  endEpoch: number;
  count: number;
  lines: string[];
}

export interface ResampleAccumulator {
  lastSeenEpoch: number;
  total1MinRows: number;
  total5MinRows: number;
  currentBucket: ActiveBucket | null;
  months: Map<string, MonthBuffer>;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

export type HistoricalIndexKey = 'NIFTY50' | 'BANKNIFTY';

export interface HistoricalIndexConfig {
  key: HistoricalIndexKey;
  routeSlug: string;
  symbol: string;
  securityId: string;
  docId: string;
  sourceRepo: string;
  githubTreeUrl: string;
  githubRawBase: string;
  filePrefix: string;
}

export const HISTORICAL_INDEX_CONFIGS: Record<HistoricalIndexKey, HistoricalIndexConfig> = {
  NIFTY50: {
    key: 'NIFTY50',
    routeSlug: 'nifty50-5m',
    symbol: 'NIFTY 50',
    securityId: '13',
    docId: 'NIFTY50_5M',
    sourceRepo: 'https://github.com/technovusin/nifty50-historical-data',
    githubTreeUrl: 'https://api.github.com/repos/technovusin/nifty50-historical-data/git/trees/main?recursive=1',
    githubRawBase: 'https://raw.githubusercontent.com/technovusin/nifty50-historical-data/main',
    filePrefix: 'NIFTY50',
  },
  BANKNIFTY: {
    key: 'BANKNIFTY',
    routeSlug: 'banknifty-5m',
    symbol: 'BANK NIFTY',
    securityId: '25',
    docId: 'BANKNIFTY_5M',
    sourceRepo: 'https://github.com/technovusin/banknifty-historical-data',
    githubTreeUrl: 'https://api.github.com/repos/technovusin/banknifty-historical-data/git/trees/main?recursive=1',
    githubRawBase: 'https://raw.githubusercontent.com/technovusin/banknifty-historical-data/main',
    filePrefix: 'BANKNIFTY',
  },
};

const IST_OFFSET_SECONDS = 19800; // UTC+05:30
const WRITE_BATCH_SIZE = 25;
const FETCH_CONCURRENCY = 4;

@Injectable()
export class HistoricalDataService {
  private readonly logger = new Logger(HistoricalDataService.name);
  private syncInProgress = false;
  private readonly syncInProgressByIndex = new Set<HistoricalIndexKey>();

  static readonly SOURCE_REPO = HISTORICAL_INDEX_CONFIGS.NIFTY50.sourceRepo;
  static readonly GITHUB_TREE_URL = HISTORICAL_INDEX_CONFIGS.NIFTY50.githubTreeUrl;
  static readonly GITHUB_RAW_BASE = HISTORICAL_INDEX_CONFIGS.NIFTY50.githubRawBase;
  static readonly BANKNIFTY_SOURCE_REPO = HISTORICAL_INDEX_CONFIGS.BANKNIFTY.sourceRepo;
  static readonly BANKNIFTY_GITHUB_TREE_URL = HISTORICAL_INDEX_CONFIGS.BANKNIFTY.githubTreeUrl;
  static readonly BANKNIFTY_GITHUB_RAW_BASE = HISTORICAL_INDEX_CONFIGS.BANKNIFTY.githubRawBase;
  static readonly COLLECTION_NAME = 'historical_candles';
  static readonly DOC_ID = HISTORICAL_INDEX_CONFIGS.NIFTY50.docId;
  static readonly BANKNIFTY_DOC_ID = HISTORICAL_INDEX_CONFIGS.BANKNIFTY.docId;
  static readonly SUBCOLLECTION_NAME = 'months';

  constructor(private readonly firestoreService: FirestoreService) {}

  public static getIndexConfig(indexKey: HistoricalIndexKey = 'NIFTY50'): HistoricalIndexConfig {
    return HISTORICAL_INDEX_CONFIGS[indexKey];
  }

  private isIndexSyncInProgress(indexKey: HistoricalIndexKey): boolean {
    return this.syncInProgress || this.syncInProgressByIndex.has(indexKey);
  }

  /**
   * Formats a Unix epoch (seconds) into IST wall-clock string YYYY-MM-DDTHH:MM:SS.
   */
  public static epochToIstString(epochSeconds: number): string {
    return new Date((epochSeconds + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 19);
  }

  /**
   * Extracts YYYY-MM month key in IST from a Unix epoch (seconds).
   */
  public static epochToIstMonth(epochSeconds: number): string {
    return HistoricalDataService.epochToIstString(epochSeconds).slice(0, 7);
  }

  /**
   * Creates a streaming accumulator for resampling 1-minute CSV files into 5-minute monthly buckets.
   */
  public createAccumulator(): ResampleAccumulator {
    return {
      lastSeenEpoch: -1,
      total1MinRows: 0,
      total5MinRows: 0,
      currentBucket: null,
      months: new Map<string, MonthBuffer>(),
    };
  }

  /**
   * Feeds a single 1-minute CSV text chunk (must be fed in chronological file order)
   * into the 5-minute resampler accumulator.
   */
  public feedCsvToAccumulator(acc: ResampleAccumulator, csvText: string): void {
    const lines = csvText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      // Skip CSV header
      if (line.charCodeAt(0) === 69 /* 'E' */ && line.startsWith('Epoch')) continue;

      const parts = line.split(',');
      if (parts.length < 6) continue;

      const epoch = Number.parseInt(parts[0], 10);
      if (!Number.isFinite(epoch) || epoch <= acc.lastSeenEpoch) continue;

      const open = Number.parseFloat(parts[2]);
      const high = Number.parseFloat(parts[3]);
      const low = Number.parseFloat(parts[4]);
      const close = Number.parseFloat(parts[5]);
      if (
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        continue;
      }

      const vol = parts.length > 6 && parts[6] ? Number.parseInt(parts[6], 10) || 0 : 0;
      acc.lastSeenEpoch = epoch;
      acc.total1MinRows++;

      const ts = parts[1]?.trim() || '';
      let monthKey: string;
      let bucketKey: string;
      const bucketEpoch = Math.floor(epoch / 300) * 300;

      if (ts.length >= 16 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts)) {
        const datePart = ts.slice(0, 10);
        const hourStr = ts.slice(11, 13);
        const minute = Number.parseInt(ts.slice(14, 16), 10);
        const bucketMinStr = String(Math.floor(minute / 5) * 5).padStart(2, '0');
        monthKey = datePart.slice(0, 7);
        bucketKey = `${datePart}T${hourStr}:${bucketMinStr}:00`;
      } else {
        const istStr = HistoricalDataService.epochToIstString(bucketEpoch);
        monthKey = istStr.slice(0, 7);
        bucketKey = istStr;
      }

      if (!acc.currentBucket || acc.currentBucket.bucketKey !== bucketKey) {
        if (acc.currentBucket) {
          this.flushBucketToMonth(acc, acc.currentBucket);
        }
        acc.currentBucket = {
          epoch: bucketEpoch,
          monthKey,
          bucketKey,
          open,
          high,
          low,
          close,
          volume: vol,
        };
      } else {
        if (high > acc.currentBucket.high) acc.currentBucket.high = high;
        if (low < acc.currentBucket.low) acc.currentBucket.low = low;
        acc.currentBucket.close = close;
        acc.currentBucket.volume += vol;
      }
    }
  }

  /**
   * Flushes the final pending 5-minute candle bucket and returns sorted monthly buffers.
   */
  public finalizeAccumulator(acc: ResampleAccumulator): MonthBuffer[] {
    if (acc.currentBucket) {
      this.flushBucketToMonth(acc, acc.currentBucket);
      acc.currentBucket = null;
    }

    return Array.from(acc.months.values()).sort((a, b) => a.month.localeCompare(b.month));
  }

  private flushBucketToMonth(acc: ResampleAccumulator, bucket: ActiveBucket): void {
    let monthBuf = acc.months.get(bucket.monthKey);
    if (!monthBuf) {
      monthBuf = {
        month: bucket.monthKey,
        startEpoch: bucket.epoch,
        endEpoch: bucket.epoch,
        count: 0,
        lines: [],
      };
      acc.months.set(bucket.monthKey, monthBuf);
    }

    if (bucket.epoch < monthBuf.startEpoch) monthBuf.startEpoch = bucket.epoch;
    if (bucket.epoch > monthBuf.endEpoch) monthBuf.endEpoch = bucket.epoch;

    monthBuf.lines.push(
      `${bucket.epoch},${bucket.open.toFixed(2)},${bucket.high.toFixed(2)},${bucket.low.toFixed(2)},${bucket.close.toFixed(2)},${bucket.volume}`,
    );
    monthBuf.count++;
    acc.total5MinRows++;
  }

  /**
   * Lists and chronologically sorts all 1-minute CSV paths from the GitHub repository tree.
   */
  public async listGitHub1MinCsvPaths(indexKey: HistoricalIndexKey = 'NIFTY50'): Promise<string[]> {
    const config = HistoricalDataService.getIndexConfig(indexKey);
    const response = await fetch(config.githubTreeUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dhan-trader-api',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(
        `GitHub API returned HTTP ${response.status} while listing ${config.sourceRepo}`,
      );
    }

    const payload = (await response.json()) as { tree?: GitHubTreeEntry[]; truncated?: boolean };
    const entries = Array.isArray(payload?.tree) ? payload.tree : [];
    const filePattern = new RegExp(`${config.filePrefix}_1min_\\d{4}(?:-\\d{2})?\\.csv$`, 'i');

    const paths = entries
      .filter(
        (entry) =>
          entry.type === 'blob' &&
          entry.path.startsWith('1min/') &&
          entry.path.endsWith('.csv') &&
          filePattern.test(entry.path),
      )
      .map((entry) => entry.path)
      .sort((a, b) => a.localeCompare(b));

    if (paths.length === 0) {
      throw new ServiceUnavailableException(
        `No 1-minute ${config.symbol} CSV files were found in the GitHub repository.`,
      );
    }

    return paths;
  }

  /**
   * Determines which 1-minute CSV files must be downloaded based on existing Firestore metadata.
   */
  public selectFilesToSync(
    allPaths: string[],
    existingMeta: HistoricalCandlesMetadata | null,
    force: boolean,
    indexKey: HistoricalIndexKey = 'NIFTY50',
  ): { filesToFetch: string[]; filesSkipped: string[]; isFullRebuild: boolean } {
    if (force || !existingMeta || !Array.isArray(existingMeta.months) || existingMeta.months.length === 0) {
      return {
        filesToFetch: allPaths,
        filesSkipped: [],
        isFullRebuild: true,
      };
    }

    const config = HistoricalDataService.getIndexConfig(indexKey);
    const monthlyPattern = new RegExp(`${config.filePrefix}_1min_(\\d{4}-\\d{2})\\.csv$`, 'i');
    const yearlyPattern = new RegExp(`${config.filePrefix}_1min_(\\d{4})\\.csv$`, 'i');

    const existingMonths = new Set(existingMeta.months);
    const lastMonth = existingMeta.lastMonth || existingMeta.months[existingMeta.months.length - 1];
    const lastYear = lastMonth.slice(0, 4);

    const filesToFetch: string[] = [];
    const filesSkipped: string[] = [];

    for (const filePath of allPaths) {
      const monthlyMatch = filePath.match(monthlyPattern);
      if (monthlyMatch) {
        const ym = monthlyMatch[1];
        if (ym >= lastMonth || !existingMonths.has(ym)) {
          filesToFetch.push(filePath);
        } else {
          filesSkipped.push(filePath);
        }
        continue;
      }

      const yearlyMatch = filePath.match(yearlyPattern);
      if (yearlyMatch) {
        const yr = yearlyMatch[1];
        const hasAnyMonthForYear = existingMeta.months.some((m) => m.startsWith(`${yr}-`));
        if (yr >= lastYear || !hasAnyMonthForYear) {
          filesToFetch.push(filePath);
        } else {
          filesSkipped.push(filePath);
        }
        continue;
      }

      filesToFetch.push(filePath);
    }

    return {
      filesToFetch,
      filesSkipped,
      isFullRebuild: false,
    };
  }

  /**
   * Fetches raw CSV text for a single repository path.
   */
  protected async fetchRawCsv(
    repoPath: string,
    githubRawBase: string = HistoricalDataService.GITHUB_RAW_BASE,
  ): Promise<string> {
    const url = `${githubRawBase}/${repoPath}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'dhan-trader-api',
      },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new ServiceUnavailableException(`Failed to download ${repoPath} (HTTP ${response.status})`);
    }

    return response.text();
  }

  /**
   * Downloads files with bounded concurrency while returning results in original chronological order.
   */
  private async fetchFilesInBatches(
    paths: string[],
    githubRawBase: string,
    onBatchReady: (csvTexts: string[]) => void,
  ): Promise<void> {
    for (let i = 0; i < paths.length; i += FETCH_CONCURRENCY) {
      const slice = paths.slice(i, i + FETCH_CONCURRENCY);
      const texts = await Promise.all(slice.map((p) => this.fetchRawCsv(p, githubRawBase)));
      onBatchReady(texts);
    }
  }

  /**
   * Returns current Firestore sync metadata for an index's 5-minute historical candles (1 Firestore read).
   */
  public async getStatus(indexKey: HistoricalIndexKey = 'NIFTY50'): Promise<HistoricalDataStatusResponse> {
    const config = HistoricalDataService.getIndexConfig(indexKey);
    const collection = `${HistoricalDataService.COLLECTION_NAME}/${config.docId}`;
    const syncInProgress = this.isIndexSyncInProgress(indexKey);

    if (!this.firestoreService.isReady()) {
      return {
        storedInFirestore: false,
        syncInProgress,
        sourceRepo: config.sourceRepo,
        collection,
        metadata: null,
      };
    }

    const meta = await this.firestoreService.getDoc<HistoricalCandlesMetadata>(
      HistoricalDataService.COLLECTION_NAME,
      config.docId,
    );

    return {
      storedInFirestore: Boolean(meta && meta.totalCandles > 0 && meta.totalMonths > 0),
      syncInProgress,
      sourceRepo: config.sourceRepo,
      collection,
      metadata: meta || null,
    };
  }

  /**
   * On-demand sync for NIFTY 50 5-minute candles into Firestore (historical_candles/NIFTY50_5M).
   */
  public async syncNifty50FiveMin(force = false): Promise<HistoricalDataSyncResponse> {
    return this.syncFiveMin('NIFTY50', force);
  }

  /**
   * On-demand sync for BANK NIFTY 5-minute candles into Firestore (historical_candles/BANKNIFTY_5M).
   */
  public async syncBankNiftyFiveMin(force = false): Promise<HistoricalDataSyncResponse> {
    return this.syncFiveMin('BANKNIFTY', force);
  }

  /**
   * Shared on-demand sync: Fetches 1-minute CSVs from GitHub, resamples to 5-minute OHLCV candles,
   * and writes compact monthly documents into Firestore (historical_candles/{DOC_ID}/months/{YYYY-MM}).
   */
  public async syncFiveMin(indexKey: HistoricalIndexKey, force = false): Promise<HistoricalDataSyncResponse> {
    const config = HistoricalDataService.getIndexConfig(indexKey);

    if (!this.firestoreService.isReady()) {
      throw new ServiceUnavailableException('Firestore is not initialized. Check credentials.');
    }
    if (this.isIndexSyncInProgress(indexKey)) {
      throw new ConflictException(`${config.symbol} 5-minute historical data sync is already in progress.`);
    }

    this.syncInProgressByIndex.add(indexKey);
    const startedAt = Date.now();

    try {
      const existingMeta = await this.firestoreService.getDoc<HistoricalCandlesMetadata>(
        HistoricalDataService.COLLECTION_NAME,
        config.docId,
      );

      const allPaths = await this.listGitHub1MinCsvPaths(indexKey);
      const { filesToFetch, filesSkipped, isFullRebuild } = this.selectFilesToSync(
        allPaths,
        existingMeta,
        force,
        indexKey,
      );

      this.logger.log(
        `📈 Starting ${config.symbol} 5m sync (${isFullRebuild ? 'full' : 'incremental'}): ${filesToFetch.length} CSV file(s) to fetch, ${filesSkipped.length} skipped`,
      );

      const acc = this.createAccumulator();
      if (filesToFetch.length > 0) {
        await this.fetchFilesInBatches(filesToFetch, config.githubRawBase, (csvTexts) => {
          for (const csvText of csvTexts) {
            this.feedCsvToAccumulator(acc, csvText);
          }
        });
      }

      const syncedMonths = this.finalizeAccumulator(acc);
      const now = new Date().toISOString();
      const parentDocRef = this.firestoreService.doc(
        HistoricalDataService.COLLECTION_NAME,
        config.docId,
      );
      const monthsColRef = parentDocRef.collection(HistoricalDataService.SUBCOLLECTION_NAME);

      // On full rebuild, remove any obsolete month documents
      if (isFullRebuild && typeof monthsColRef.listDocuments === 'function') {
        try {
          const existingDocs = await monthsColRef.listDocuments();
          const keepSet = new Set(syncedMonths.map((m) => m.month));
          const staleDocs = existingDocs.filter((d) => !keepSet.has(d.id));
          if (staleDocs.length > 0) {
            await this.deleteRefsInBatches(staleDocs);
          }
        } catch (err: any) {
          this.logger.warn(`Could not prune stale month docs: ${err.message}`);
        }
      }

      // Write synced monthly documents in bounded batches (<=25 docs/batch to stay well under 10 MiB payload)
      if (syncedMonths.length > 0) {
        await this.writeMonthlyDocsInBatches(monthsColRef, syncedMonths, now);
      }

      // Merge metadata counts without reading unchanged months from Firestore
      const monthCounts: Record<string, number> = isFullRebuild
        ? {}
        : { ...(existingMeta?.monthCounts || {}) };

      for (const m of syncedMonths) {
        monthCounts[m.month] = m.count;
      }

      const allMonthsSorted = Object.keys(monthCounts).sort((a, b) => a.localeCompare(b));
      const totalCandlesInDb = allMonthsSorted.reduce((sum, key) => sum + (monthCounts[key] || 0), 0);
      const firstMonth = allMonthsSorted[0] || '';
      const lastMonth = allMonthsSorted[allMonthsSorted.length - 1] || '';

      let firstEpoch = isFullRebuild ? 0 : existingMeta?.firstEpoch || 0;
      let lastEpoch = isFullRebuild ? 0 : existingMeta?.lastEpoch || 0;
      for (const m of syncedMonths) {
        if (firstEpoch === 0 || m.startEpoch < firstEpoch) firstEpoch = m.startEpoch;
        if (m.endEpoch > lastEpoch) lastEpoch = m.endEpoch;
      }

      const collectionPath = `${HistoricalDataService.COLLECTION_NAME}/${config.docId}`;
      const metadata: HistoricalCandlesMetadata = {
        symbol: config.symbol,
        securityId: config.securityId,
        timeframe: '5m',
        sourceRepo: config.sourceRepo,
        collection: collectionPath,
        totalCandles: totalCandlesInDb,
        totalMonths: allMonthsSorted.length,
        firstEpoch,
        lastEpoch,
        firstMonth,
        lastMonth,
        months: allMonthsSorted,
        monthCounts,
        updatedAt: now,
      };

      await parentDocRef.set(metadata, { merge: false });

      const durationMs = Date.now() - startedAt;
      const monthsWritten = syncedMonths.map((m) => m.month);

      this.logger.log(
        `✅ Synced ${acc.total5MinRows} ${config.symbol} 5m candles across ${monthsWritten.length} month doc(s) in ${(durationMs / 1000).toFixed(2)}s (DB total: ${totalCandlesInDb} across ${allMonthsSorted.length} months)`,
      );

      return {
        success: true,
        collection: collectionPath,
        symbol: config.symbol,
        timeframe: '5m',
        sourceRepo: config.sourceRepo,
        mode: isFullRebuild ? 'full' : 'incremental',
        filesProcessed: filesToFetch.length,
        filesSkipped: filesSkipped.length,
        total1MinRows: acc.total1MinRows,
        totalCandlesSynced: acc.total5MinRows,
        totalCandlesInDb,
        monthsWritten,
        totalMonthsInDb: allMonthsSorted.length,
        firstMonth,
        lastMonth,
        firstEpoch,
        lastEpoch,
        durationMs,
        syncedAt: now,
        message: isFullRebuild
          ? `Full sync completed: ${acc.total5MinRows.toLocaleString()} ${config.symbol} 5m candles saved across ${monthsWritten.length} monthly documents.`
          : `Incremental sync completed: ${acc.total5MinRows.toLocaleString()} ${config.symbol} 5m candles updated across ${monthsWritten.length} month(s) (${filesSkipped.length} unchanged source files skipped).`,
      };
    } finally {
      this.syncInProgressByIndex.delete(indexKey);
    }
  }

  /**
   * Queries stored 5-minute NIFTY 50 candles from Firestore.
   */
  public async getNifty50FiveMinCandles(query: GetHistoricalCandlesQueryDto) {
    return this.getFiveMinCandles('NIFTY50', query);
  }

  /**
   * Queries stored 5-minute BANK NIFTY candles from Firestore.
   */
  public async getBankNiftyFiveMinCandles(query: GetHistoricalCandlesQueryDto) {
    return this.getFiveMinCandles('BANKNIFTY', query);
  }

  /**
   * Queries stored 5-minute candles for an index from Firestore by reading ONLY overlapping monthly documents.
   */
  public async getFiveMinCandles(
    indexKey: HistoricalIndexKey,
    query: GetHistoricalCandlesQueryDto,
  ): Promise<{
    success: boolean;
    symbol: string;
    timeframe: string;
    monthsRead: string[];
    count: number;
    candles: HistoricalCandle[];
  }> {
    const config = HistoricalDataService.getIndexConfig(indexKey);

    if (!this.firestoreService.isReady()) {
      throw new ServiceUnavailableException('Firestore is not initialized. Check credentials.');
    }

    const meta = await this.firestoreService.getDoc<HistoricalCandlesMetadata>(
      HistoricalDataService.COLLECTION_NAME,
      config.docId,
    );

    if (!meta || !Array.isArray(meta.months) || meta.months.length === 0) {
      return {
        success: true,
        symbol: config.symbol,
        timeframe: '5m',
        monthsRead: [],
        count: 0,
        candles: [],
      };
    }

    const fromMonth =
      query.fromMonth ||
      (query.fromEpoch !== undefined ? HistoricalDataService.epochToIstMonth(query.fromEpoch) : undefined);
    const toMonth =
      query.toMonth ||
      (query.toEpoch !== undefined ? HistoricalDataService.epochToIstMonth(query.toEpoch) : undefined);

    let targetMonths = meta.months.filter((m) => {
      if (fromMonth && m < fromMonth) return false;
      if (toMonth && m > toMonth) return false;
      return true;
    });

    // If no range filter is passed, default to the most recent month (1 Firestore read) to prevent huge responses
    if (!fromMonth && !toMonth && !query.limit && targetMonths.length > 1) {
      targetMonths = [targetMonths[targetMonths.length - 1]];
    } else if (!fromMonth && !toMonth && query.limit && targetMonths.length > 0) {
      // Read backwards just enough months if only limit is requested
      const needed: string[] = [];
      let accumulated = 0;
      for (let i = targetMonths.length - 1; i >= 0; i--) {
        const m = targetMonths[i];
        needed.unshift(m);
        accumulated += meta.monthCounts?.[m] ?? 1600;
        if (accumulated >= query.limit) break;
      }
      targetMonths = needed;
    }

    const monthsColRef = this.firestoreService
      .doc(HistoricalDataService.COLLECTION_NAME, config.docId)
      .collection(HistoricalDataService.SUBCOLLECTION_NAME);

    const snapshots = await Promise.all(targetMonths.map((monthId) => monthsColRef.doc(monthId).get()));
    const candles: HistoricalCandle[] = [];

    for (const snap of snapshots) {
      if (!snap.exists) continue;
      const data = snap.data() as HistoricalCandlesMonthDoc | undefined;
      if (!data?.csv) continue;

      const rows = data.csv.split('\n');
      for (const row of rows) {
        if (!row) continue;
        const parts = row.split(',');
        if (parts.length < 5) continue;
        const epoch = Number.parseInt(parts[0], 10);
        if (!Number.isFinite(epoch)) continue;
        if (query.fromEpoch !== undefined && epoch < query.fromEpoch) continue;
        if (query.toEpoch !== undefined && epoch > query.toEpoch) continue;

        candles.push({
          epoch,
          timestampIST: HistoricalDataService.epochToIstString(epoch),
          open: Number.parseFloat(parts[1]),
          high: Number.parseFloat(parts[2]),
          low: Number.parseFloat(parts[3]),
          close: Number.parseFloat(parts[4]),
          volume: parts.length > 5 ? Number.parseInt(parts[5], 10) || 0 : 0,
        });
      }
    }

    const limitedCandles =
      query.limit && candles.length > query.limit ? candles.slice(candles.length - query.limit) : candles;

    return {
      success: true,
      symbol: config.symbol,
      timeframe: '5m',
      monthsRead: targetMonths,
      count: limitedCandles.length,
      candles: limitedCandles,
    };
  }

  private async writeMonthlyDocsInBatches(
    monthsColRef: FirebaseFirestore.CollectionReference,
    months: MonthBuffer[],
    updatedAt: string,
  ): Promise<void> {
    const db = this.firestoreService.getDb();

    for (let i = 0; i < months.length; i += WRITE_BATCH_SIZE) {
      const slice = months.slice(i, i + WRITE_BATCH_SIZE);
      if (typeof db.batch === 'function') {
        const batch = db.batch();
        for (const m of slice) {
          const docData: HistoricalCandlesMonthDoc = {
            month: m.month,
            count: m.count,
            startEpoch: m.startEpoch,
            endEpoch: m.endEpoch,
            csv: m.lines.join('\n'),
            updatedAt,
          };
          batch.set(monthsColRef.doc(m.month), docData, { merge: false });
        }
        await batch.commit();
      } else {
        await Promise.all(
          slice.map((m) =>
            monthsColRef.doc(m.month).set(
              {
                month: m.month,
                count: m.count,
                startEpoch: m.startEpoch,
                endEpoch: m.endEpoch,
                csv: m.lines.join('\n'),
                updatedAt,
              } satisfies HistoricalCandlesMonthDoc,
              { merge: false },
            ),
          ),
        );
      }
    }
  }

  private async deleteRefsInBatches(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
    const db = this.firestoreService.getDb();
    for (let i = 0; i < refs.length; i += 400) {
      const slice = refs.slice(i, i + 400);
      if (typeof db.batch === 'function') {
        const batch = db.batch();
        for (const ref of slice) {
          batch.delete(ref);
        }
        await batch.commit();
      } else {
        await Promise.all(slice.map((ref) => ref.delete()));
      }
    }
  }
}
