process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { HistoricalDataService } from '../src/historical-data/historical-data.service';

function createInMemoryFirestoreMock(initialReady = true) {
  const store = new Map<string, any>();

  const makeDocRef = (fullPath: string): any => ({
    id: fullPath.split('/').pop(),
    path: fullPath,
    get: async () => ({
      exists: store.has(fullPath),
      id: fullPath.split('/').pop(),
      data: () => store.get(fullPath),
    }),
    set: async (data: any) => {
      store.set(fullPath, data);
      return { writeTime: { toDate: () => new Date() } };
    },
    delete: async () => {
      store.delete(fullPath);
      return { writeTime: { toDate: () => new Date() } };
    },
    collection: (subColName: string) => makeColRef(`${fullPath}/${subColName}`),
  });

  const makeColRef = (colPath: string): any => ({
    id: colPath.split('/').pop(),
    doc: (docId: string) => makeDocRef(`${colPath}/${docId}`),
    listDocuments: async () => {
      const prefix = `${colPath}/`;
      const refs: any[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          refs.push(makeDocRef(key));
        }
      }
      return refs;
    },
  });

  const db: any = {
    collection: (colName: string) => makeColRef(colName),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: any) => {
          ops.push(() => store.set(ref.path, data));
        },
        delete: (ref: any) => {
          ops.push(() => store.delete(ref.path));
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
  };

  const firestoreServiceMock: any = {
    isReady: () => initialReady,
    getDb: () => db,
    doc: (col: string, id: string) => makeDocRef(`${col}/${id}`),
    getDoc: async (col: string, id: string) => {
      const snap = await makeDocRef(`${col}/${id}`).get();
      return snap.exists ? snap.data() : null;
    },
  };

  return { store, firestoreServiceMock };
}

test('HistoricalDataService (NestJS)', async (t) => {
  await t.test('resamples 1-minute CSV rows into 09:15 IST aligned 5-minute monthly buckets', () => {
    const { firestoreServiceMock } = createInMemoryFirestoreMock();
    const service = new HistoricalDataService(firestoreServiceMock);
    const acc = service.createAccumulator();

    // 2017-04-03 09:15..09:20 IST + duplicate epoch + 2026-11-23 15:15..15:19 IST with Volume
    const csv1 = [
      'Epoch,Timestamp,Open,High,Low,Close',
      '1491191100,2017-04-03T09:15:00,9219.63,9221.75,9202.90,9204.85',
      '1491191160,2017-04-03T09:16:00,9205.60,9206.00,9201.45,9203.40',
      '1491191160,2017-04-03T09:16:00,9999.00,9999.00,9999.00,9999.00', // duplicate epoch ignored
      '1491191340,2017-04-03T09:19:00,9203.25,9205.85,9202.25,9204.00',
      '1491191400,2017-04-03T09:20:00,9203.70,9207.15,9202.90,9206.00',
    ].join('\n');

    const csv2 = [
      'Epoch,Timestamp,Open,High,Low,Close,Volume',
      '1795427100,2026-11-23T15:15:00,25360.00,25370.00,25355.00,25365.00,1000',
      '1795427160,2026-11-23T15:16:00,25365.00,25375.50,25362.00,25366.40,916',
    ].join('\n');

    service.feedCsvToAccumulator(acc, csv1);
    service.feedCsvToAccumulator(acc, csv2);
    const months = service.finalizeAccumulator(acc);

    assert.strictEqual(acc.total1MinRows, 6);
    assert.strictEqual(acc.total5MinRows, 3);
    assert.strictEqual(months.length, 2);

    assert.strictEqual(months[0].month, '2017-04');
    assert.strictEqual(months[0].count, 2);
    assert.strictEqual(
      months[0].lines[0],
      '1491191100,9219.63,9221.75,9201.45,9204.00,0',
    );
    assert.strictEqual(
      months[0].lines[1],
      '1491191400,9203.70,9207.15,9202.90,9206.00,0',
    );

    assert.strictEqual(months[1].month, '2026-11');
    assert.strictEqual(months[1].count, 1);
    assert.strictEqual(
      months[1].lines[0],
      '1795427100,25360.00,25375.50,25355.00,25366.40,1916',
    );
  });

  await t.test('selectFilesToSync skips closed historical months during incremental sync', () => {
    const { firestoreServiceMock } = createInMemoryFirestoreMock();
    const service = new HistoricalDataService(firestoreServiceMock);

    const allPaths = [
      '1min/2017/NIFTY50_1min_2017.csv',
      '1min/2025/NIFTY50_1min_2025.csv',
      '1min/2026/NIFTY50_1min_2026-01.csv',
      '1min/2026/NIFTY50_1min_2026-10.csv',
      '1min/2026/NIFTY50_1min_2026-11.csv',
    ];

    const existingMeta: any = {
      months: ['2017-04', '2025-12', '2026-01', '2026-10', '2026-11'],
      lastMonth: '2026-11',
    };

    const inc = service.selectFilesToSync(allPaths, existingMeta, false);
    assert.strictEqual(inc.isFullRebuild, false);
    assert.deepStrictEqual(inc.filesToFetch, ['1min/2026/NIFTY50_1min_2026-11.csv']);
    assert.strictEqual(inc.filesSkipped.length, 4);

    const full = service.selectFilesToSync(allPaths, existingMeta, true);
    assert.strictEqual(full.isFullRebuild, true);
    assert.strictEqual(full.filesToFetch.length, 5);
    assert.strictEqual(full.filesSkipped.length, 0);
  });

  await t.test('syncNifty50FiveMin fetches GitHub CSVs, saves monthly docs, supports incremental updates and candle queries', async () => {
    const { store, firestoreServiceMock } = createInMemoryFirestoreMock(true);
    const service = new HistoricalDataService(firestoreServiceMock);

    const originalFetch = global.fetch;
    const fetchedUrls: string[] = [];

    const mockFiles: Record<string, string> = {
      '1min/2017/NIFTY50_1min_2017.csv': [
        'Epoch,Timestamp,Open,High,Low,Close',
        '1491191100,2017-04-03T09:15:00,9219.63,9221.75,9202.90,9204.85',
        '1491191160,2017-04-03T09:16:00,9205.60,9206.00,9201.45,9203.40',
      ].join('\n'),
      '1min/2026/NIFTY50_1min_2026-11.csv': [
        'Epoch,Timestamp,Open,High,Low,Close,Volume',
        '1795427100,2026-11-23T15:15:00,25360.00,25370.00,25355.00,25365.00,500',
      ].join('\n'),
    };

    (global as any).fetch = async (url: string) => {
      fetchedUrls.push(url);
      if (url === HistoricalDataService.GITHUB_TREE_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tree: [
              { path: '1min/2017/NIFTY50_1min_2017.csv', type: 'blob' },
              { path: '1min/2026/NIFTY50_1min_2026-11.csv', type: 'blob' },
              { path: '15sec/2026/NIFTY50_15sec_2026-11.csv', type: 'blob' },
            ],
          }),
        };
      }
      const repoPath = url.replace(`${HistoricalDataService.GITHUB_RAW_BASE}/`, '');
      if (mockFiles[repoPath]) {
        return {
          ok: true,
          status: 200,
          text: async () => mockFiles[repoPath],
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    try {
      // 1. Initial sync (empty DB -> full rebuild)
      const res1 = await service.syncNifty50FiveMin(false);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.mode, 'full');
      assert.strictEqual(res1.filesProcessed, 2);
      assert.strictEqual(res1.totalCandlesInDb, 2);
      assert.deepStrictEqual(res1.monthsWritten, ['2017-04', '2026-11']);
      assert.ok(store.has('historical_candles/NIFTY50_5M'));
      assert.ok(store.has('historical_candles/NIFTY50_5M/months/2017-04'));
      assert.ok(store.has('historical_candles/NIFTY50_5M/months/2026-11'));

      // 2. Status check
      const status = await service.getStatus();
      assert.strictEqual(status.storedInFirestore, true);
      assert.strictEqual(status.metadata?.totalCandles, 2);
      assert.strictEqual(status.metadata?.totalMonths, 2);

      // 3. Incremental sync after a new 5-min bar arrives in 2026-11
      fetchedUrls.length = 0;
      mockFiles['1min/2026/NIFTY50_1min_2026-11.csv'] +=
        '\n1795427400,2026-11-23T15:20:00,25365.00,25380.00,25364.00,25378.50,800';

      const res2 = await service.syncNifty50FiveMin(false);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.mode, 'incremental');
      assert.strictEqual(res2.filesProcessed, 1);
      assert.strictEqual(res2.filesSkipped, 1);
      assert.strictEqual(res2.totalCandlesInDb, 3);
      assert.deepStrictEqual(res2.monthsWritten, ['2026-11']);
      assert.ok(
        !fetchedUrls.some((u) => u.includes('2017')),
        'Incremental sync must not re-fetch closed 2017 CSV',
      );

      // 4. Query candles for 2026-11 only (1 monthly doc read)
      const candlesRes = await service.getNifty50FiveMinCandles({
        fromMonth: '2026-11',
        toMonth: '2026-11',
      });
      assert.strictEqual(candlesRes.success, true);
      assert.deepStrictEqual(candlesRes.monthsRead, ['2026-11']);
      assert.strictEqual(candlesRes.count, 2);
      assert.strictEqual(candlesRes.candles[1].close, 25378.5);
      assert.strictEqual(candlesRes.candles[1].volume, 800);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  await t.test('throws ServiceUnavailableException when Firestore is not ready and ConflictException on concurrent sync', async () => {
    const { firestoreServiceMock: notReadyMock } = createInMemoryFirestoreMock(false);
    const notReadySvc = new HistoricalDataService(notReadyMock);
    await assert.rejects(() => notReadySvc.syncNifty50FiveMin(false), ServiceUnavailableException);

    const { firestoreServiceMock: readyMock } = createInMemoryFirestoreMock(true);
    const busySvc = new HistoricalDataService(readyMock);
    (busySvc as any).syncInProgress = true;
    await assert.rejects(() => busySvc.syncNifty50FiveMin(false), ConflictException);
    (busySvc as any).syncInProgress = false;
    (busySvc as any).syncInProgressByIndex.add('BANKNIFTY');
    await assert.rejects(() => busySvc.syncBankNiftyFiveMin(false), ConflictException);
  });

  await t.test('syncBankNiftyFiveMin fetches Bank Nifty GitHub CSVs, saves to BANKNIFTY_5M, supports incremental sync and queries', async () => {
    const { store, firestoreServiceMock } = createInMemoryFirestoreMock(true);
    const service = new HistoricalDataService(firestoreServiceMock);

    const originalFetch = global.fetch;
    const fetchedUrls: string[] = [];

    const mockFiles: Record<string, string> = {
      '1min/2021/BANKNIFTY_1min_2021.csv': [
        'Epoch,Timestamp,Open,High,Low,Close',
        '1628051400,2021-08-04T10:00:00,35620.1,35638.15,35616.55,35626.85',
        '1628051460,2021-08-04T10:01:00,35629.2,35629.2,35611.0,35613.95',
      ].join('\n'),
      '1min/2026/BANKNIFTY_1min_2026-11.csv': [
        'Epoch,Timestamp,Open,High,Low,Close,Volume',
        '1793591100,2026-11-02T09:15:00,54837.2,54978.7,54834.85,54963.7,4905674',
      ].join('\n'),
    };

    (global as any).fetch = async (url: string) => {
      fetchedUrls.push(url);
      if (url === HistoricalDataService.BANKNIFTY_GITHUB_TREE_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tree: [
              { path: '1min/2021/BANKNIFTY_1min_2021.csv', type: 'blob' },
              { path: '1min/2026/BANKNIFTY_1min_2026-11.csv', type: 'blob' },
              { path: '15sec/2026/BANKNIFTY_15sec_2026-11.csv', type: 'blob' },
            ],
          }),
        };
      }
      const repoPath = url.replace(`${HistoricalDataService.BANKNIFTY_GITHUB_RAW_BASE}/`, '');
      if (mockFiles[repoPath]) {
        return {
          ok: true,
          status: 200,
          text: async () => mockFiles[repoPath],
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    try {
      // 1. Initial sync (empty DB -> full rebuild)
      const res1 = await service.syncBankNiftyFiveMin(false);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.symbol, 'BANK NIFTY');
      assert.strictEqual(res1.collection, 'historical_candles/BANKNIFTY_5M');
      assert.strictEqual(res1.sourceRepo, HistoricalDataService.BANKNIFTY_SOURCE_REPO);
      assert.strictEqual(res1.mode, 'full');
      assert.strictEqual(res1.filesProcessed, 2);
      assert.strictEqual(res1.totalCandlesInDb, 2);
      assert.deepStrictEqual(res1.monthsWritten, ['2021-08', '2026-11']);
      assert.ok(store.has('historical_candles/BANKNIFTY_5M'));
      assert.ok(store.has('historical_candles/BANKNIFTY_5M/months/2021-08'));
      assert.ok(store.has('historical_candles/BANKNIFTY_5M/months/2026-11'));

      // 2. Status check
      const status = await service.getStatus('BANKNIFTY');
      assert.strictEqual(status.storedInFirestore, true);
      assert.strictEqual(status.collection, 'historical_candles/BANKNIFTY_5M');
      assert.strictEqual(status.metadata?.symbol, 'BANK NIFTY');
      assert.strictEqual(status.metadata?.securityId, '25');
      assert.strictEqual(status.metadata?.totalCandles, 2);
      assert.strictEqual(status.metadata?.totalMonths, 2);

      // 3. Incremental sync after a new 5-min bar arrives in 2026-11
      fetchedUrls.length = 0;
      mockFiles['1min/2026/BANKNIFTY_1min_2026-11.csv'] +=
        '\n1793591400,2026-11-02T09:20:00,54969.25,55006.6,54969.1,54981.45,4103119';

      const res2 = await service.syncBankNiftyFiveMin(false);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.mode, 'incremental');
      assert.strictEqual(res2.filesProcessed, 1);
      assert.strictEqual(res2.filesSkipped, 1);
      assert.strictEqual(res2.totalCandlesInDb, 3);
      assert.deepStrictEqual(res2.monthsWritten, ['2026-11']);
      assert.ok(
        !fetchedUrls.some((u) => u.includes('2021')),
        'Incremental sync must not re-fetch closed 2021 CSV',
      );

      // 4. Query candles for 2026-11 only
      const candlesRes = await service.getBankNiftyFiveMinCandles({
        fromMonth: '2026-11',
        toMonth: '2026-11',
      });
      assert.strictEqual(candlesRes.success, true);
      assert.strictEqual(candlesRes.symbol, 'BANK NIFTY');
      assert.deepStrictEqual(candlesRes.monthsRead, ['2026-11']);
      assert.strictEqual(candlesRes.count, 2);
      assert.strictEqual(candlesRes.candles[1].close, 54981.45);
      assert.strictEqual(candlesRes.candles[1].volume, 4103119);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });
});
