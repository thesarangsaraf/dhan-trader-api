process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { FirestoreService } from '../src/firestore/firestore.service';
import { ConfigService } from '../src/config/config.service';

test('FirestoreService (NestJS)', async (t) => {
  let service: FirestoreService;
  let configService: ConfigService;

  const mockDb: any = {
    listCollections: async () => [
      { id: 'orders' },
      { id: 'alerts' },
      { id: 'settings' },
    ],
    collection: (colName: string) => ({
      id: colName,
      doc: (docId: string) => ({
        id: docId,
        get: async () => ({
          exists: docId !== 'non_existent',
          id: docId,
          data: () => (docId !== 'non_existent' ? { key: 'sample_value' } : undefined),
        }),
        set: async (data: any, options: any) => ({
          writeTime: {
            toDate: () => new Date('2026-11-07T03:00:00.000Z'),
          },
        }),
        delete: async () => ({
          writeTime: {
            toDate: () => new Date('2026-11-07T03:00:00.000Z'),
          },
        }),
      }),
      limit: (n: number) => ({
        get: async () => ({
          docs: [
            { id: 'doc1', data: () => ({ name: 'Doc 1' }) },
            { id: 'doc2', data: () => ({ name: 'Doc 2' }) },
          ],
        }),
      }),
    }),
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      FirestoreService,
      {
        provide: ConfigService,
        useValue: {
          firestoreProjectId: 'dhan-trader-514002',
          firestoreDatabaseId: 'dhan-trader-firebase-db',
          firestoreKeyFile: 'google-service-account-key.json',
          updateCredentials: () => ({}),
        },
      },
    ],
  }).compile();

  service = moduleRef.get<FirestoreService>(FirestoreService);
  configService = moduleRef.get<ConfigService>(ConfigService);
  service.setFirestoreInstance(mockDb);

  await t.test('reports configured status and credentials metadata', async () => {
    const status = service.getStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.projectId, 'dhan-trader-514002');
    assert.strictEqual(status.databaseId, 'dhan-trader-firebase-db');
    assert.strictEqual(service.isReady(), true);
  });

  await t.test('executes connectivity test successfully', async () => {
    const res = await service.testConnection();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.projectId, 'dhan-trader-514002');
    assert.strictEqual(res.databaseId, 'dhan-trader-firebase-db');
    assert.deepStrictEqual(res.collections, ['orders', 'alerts', 'settings']);
    assert.ok(typeof res.latencyMs === 'number');
  });

  await t.test('reads document via getDoc', async () => {
    const data = await service.getDoc('settings', 'sample_doc');
    assert.deepStrictEqual(data, { key: 'sample_value' });

    const nonExistent = await service.getDoc('settings', 'non_existent');
    assert.strictEqual(nonExistent, null);
  });

  await t.test('writes document via setDoc', async () => {
    const res = await service.setDoc('alerts', 'alert-1', { symbol: 'NIFTY', price: 24500 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.writeTime, '2026-11-07T03:00:00.000Z');
  });

  await t.test('deletes document via deleteDoc', async () => {
    const res = await service.deleteDoc('alerts', 'alert-1');
    assert.strictEqual(res.success, true);
  });

  await t.test('lists documents in a collection', async () => {
    const docs = await service.listDocuments('orders', 10);
    assert.strictEqual(docs.length, 2);
    assert.strictEqual(docs[0].id, 'doc1');
    assert.deepStrictEqual(docs[0].data, { name: 'Doc 1' });
  });

  await t.test('saves and retrieves Dhan token in collection config and document dhan', async () => {
    let savedCol = '';
    let savedDoc = '';
    let savedData: any = null;
    const tokenDbMock: any = {
      collection: (col: string) => {
        savedCol = col;
        return {
          doc: (id: string) => {
            savedDoc = id;
            return {
              set: async (data: any) => {
                savedData = data;
                return { writeTime: { toDate: () => new Date('2026-11-07T03:30:00.000Z') } };
              },
              get: async () => ({
                exists: !!savedData,
                data: () => savedData,
              }),
            };
          },
        };
      },
    };

    service.setFirestoreInstance(tokenDbMock);

    const saveRes = await service.saveDhanToken({
      accessToken: 'eyJ_mock_token',
      clientId: '1106885516',
      userName: 'Trader',
    });
    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(savedCol, 'config');
    assert.strictEqual(savedDoc, 'dhan');
    assert.strictEqual(savedData.accessToken, 'eyJ_mock_token');
    assert.strictEqual(savedData.clientId, '1106885516');

    const retrieved = await service.getDhanToken();
    assert.strictEqual(retrieved?.accessToken, 'eyJ_mock_token');
    assert.strictEqual(retrieved?.clientId, '1106885516');

    // Test stale token protection:
    // Create an active token (exp in future) and an older/expired token
    const nowSec = Math.floor(Date.now() / 1000);
    const activePayload = { sub: '1106885516', clientId: '1106885516', exp: nowSec + 86400, iat: nowSec };
    const olderPayload = { sub: '1106885516', clientId: '1106885516', exp: nowSec - 3600, iat: nowSec - 90000 };

    const activeJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(activePayload)).toString('base64url')}.sig1`;
    const olderJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(olderPayload)).toString('base64url')}.sig2`;

    // Save active token
    const saveActiveRes = await service.saveDhanToken({
      accessToken: activeJwt,
      clientId: '1106885516',
    });
    assert.strictEqual(saveActiveRes.success, true);
    assert.strictEqual(savedData.accessToken, activeJwt);

    // Attempt to save older/expired token without force -> should be rejected
    const saveOlderRes = await service.saveDhanToken({
      accessToken: olderJwt,
      clientId: '1106885516',
    });
    assert.strictEqual(saveOlderRes.success, false);
    assert.strictEqual(saveOlderRes.skipped, true);
    // Firestore still contains the newer active token
    assert.strictEqual(savedData.accessToken, activeJwt);

    // Saving with force: true -> overrides
    const forceRes = await service.saveDhanToken(
      {
        accessToken: olderJwt,
        clientId: '1106885516',
      },
      { force: true },
    );
    assert.strictEqual(forceRes.success, true);
    assert.strictEqual(savedData.accessToken, olderJwt);

    // Restore mockDb
    service.setFirestoreInstance(mockDb);
  });

  await t.test('saves and retrieves index options in chunked documents', async () => {
    const memoryDocs = new Map<string, any>();
    const optionsDbMock: any = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          set: async (data: any) => {
            memoryDocs.set(`${col}/${id}`, data);
            return { writeTime: { toDate: () => new Date('2026-11-07T04:00:00.000Z') } };
          },
          get: async () => {
            const data = memoryDocs.get(`${col}/${id}`);
            return {
              exists: !!data,
              data: () => data,
            };
          },
          delete: async () => {
            memoryDocs.delete(`${col}/${id}`);
            return { writeTime: { toDate: () => new Date('2026-11-07T04:00:00.000Z') } };
          },
        }),
        get: async () => {
          const docs: any[] = [];
          for (const [k, v] of memoryDocs.entries()) {
            if (k.startsWith(`${col}/`)) {
              const docId = k.replace(`${col}/`, '');
              docs.push({
                id: docId,
                ref: { delete: async () => memoryDocs.delete(k) },
                data: () => v,
              });
            }
          }
          return {
            empty: docs.length === 0,
            docs,
          };
        },
      }),
    };

    service.setFirestoreInstance(optionsDbMock);

    const sampleOptions = [
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45001',
        tradingSymbol: 'NIFTY-Nov2026-25500-CE',
        customSymbol: 'NIFTY 26 NOV 25500 CALL',
        expiryDate: '2026-11-26',
        strikePrice: 25500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45002',
        tradingSymbol: 'NIFTY-Nov2026-25500-PE',
        customSymbol: 'NIFTY 26 NOV 25500 PUT',
        expiryDate: '2026-11-26',
        strikePrice: 25500,
        optionType: 'PE',
        lotSize: 50,
      },
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45003',
        tradingSymbol: 'NIFTY-Dec2026-25500-CE-W1',
        customSymbol: 'NIFTY 03 DEC 25500 CALL',
        expiryDate: '2026-12-03',
        strikePrice: 25500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45004',
        tradingSymbol: 'NIFTY-Dec2026-25500-CE-W2',
        customSymbol: 'NIFTY 10 DEC 25500 CALL',
        expiryDate: '2026-12-10',
        strikePrice: 25500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45005',
        tradingSymbol: 'NIFTY-Dec2026-25500-CE-W3',
        customSymbol: 'NIFTY 17 DEC 25500 CALL',
        expiryDate: '2026-12-17',
        strikePrice: 25500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'BANKNIFTY',
        exchange: 'NSE_FNO',
        securityId: '52001',
        tradingSymbol: 'BANKNIFTY-Nov2026-52000-CE',
        customSymbol: 'BANKNIFTY 26 NOV 52000 CALL',
        expiryDate: '2026-11-26',
        strikePrice: 52000,
        optionType: 'CE',
        lotSize: 30,
      },
      {
        symbolName: 'BANKNIFTY',
        exchange: 'NSE_FNO',
        securityId: '52002',
        tradingSymbol: 'BANKNIFTY-Dec2026-52000-CE',
        customSymbol: 'BANKNIFTY 03 DEC 52000 CALL',
        expiryDate: '2026-12-03',
        strikePrice: 52000,
        optionType: 'CE',
        lotSize: 30,
      },
    ];

    const saveRes = await service.saveIndexOptions(sampleOptions);
    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(saveRes.totalItems, 5);
    assert.strictEqual(saveRes.totalChunks, 2);

    const meta = await service.getIndexOptionsMetadata();
    assert.strictEqual(meta?.totalItems, 5);
    assert.strictEqual(meta?.totalChunks, 2);
    assert.strictEqual(meta?.maxExpiriesPerIndex, 3);

    const niftyDoc = await service.getIndexOptionDocument('NIFTY');
    assert.strictEqual(niftyDoc?.symbol, 'NIFTY');
    assert.strictEqual(niftyDoc?.name, 'NIFTY 50');
    assert.strictEqual(niftyDoc?.currentExpiry, '2026-11-26');
    assert.strictEqual(niftyDoc?.nextExpiry, '2026-12-03');
    assert.strictEqual(niftyDoc?.farExpiry, '2026-12-10');
    assert.deepStrictEqual(niftyDoc?.expiries, ['2026-11-26', '2026-12-03', '2026-12-10']);
    assert.strictEqual(niftyDoc?.totalContracts, 4);

    const bankDoc = await service.getIndexOptionDocument('BANKNIFTY');
    assert.strictEqual(bankDoc?.symbol, 'BANKNIFTY');
    assert.strictEqual(bankDoc?.name, 'NIFTY BANK');
    assert.strictEqual(bankDoc?.currentExpiry, '2026-11-26');
    assert.strictEqual(bankDoc?.nextExpiry, null);
    assert.strictEqual(bankDoc?.farExpiry, null);
    assert.deepStrictEqual(bankDoc?.expiries, ['2026-11-26']);
    assert.strictEqual(bankDoc?.totalContracts, 1);

    const fetched = await service.getIndexOptions();
    assert.strictEqual(fetched.length, 5);
    assert.strictEqual(fetched[0].securityId, '45001');
    assert.strictEqual(fetched[1].securityId, '45002');
    assert.strictEqual(fetched[2].securityId, '45003');
    assert.strictEqual(fetched[3].securityId, '45004');
    assert.strictEqual(fetched[4].securityId, '52001');

    const delRes = await service.deleteIndexOptions();
    assert.strictEqual(delRes.success, true);
    const afterDel = await service.getIndexOptions();
    assert.strictEqual(afterDel.length, 0);

    // Restore mockDb
    service.setFirestoreInstance(mockDb);
  });

  await t.test('saves, retrieves, and organizes master_data/sec_id_to_name_mapping with chunks subcollection', async () => {
    const memoryDocs = new Map<string, any>();
    const makeCollection = (prefix: string): any => ({
      doc: (id: string) => {
        const docPath = `${prefix}/${id}`;
        return {
          id,
          set: async (data: any) => {
            memoryDocs.set(docPath, data);
            return { writeTime: { toDate: () => new Date('2026-11-07T05:00:00.000Z') } };
          },
          get: async () => {
            const data = memoryDocs.get(docPath);
            return {
              exists: !!data,
              data: () => data,
            };
          },
          delete: async () => {
            memoryDocs.delete(docPath);
            return { writeTime: { toDate: () => new Date('2026-11-07T05:00:00.000Z') } };
          },
          collection: (subCol: string) => makeCollection(`${docPath}/${subCol}`),
        };
      },
      get: async () => {
        const docs: any[] = [];
        const matchPrefix = `${prefix}/`;
        for (const [k, v] of memoryDocs.entries()) {
          if (k.startsWith(matchPrefix) && !k.slice(matchPrefix.length).includes('/')) {
            const docId = k.slice(matchPrefix.length);
            docs.push({
              id: docId,
              ref: { delete: async () => memoryDocs.delete(k) },
              data: () => v,
            });
          }
        }
        return {
          empty: docs.length === 0,
          docs,
        };
      },
    });

    const mappingDbMock: any = {
      collection: (col: string) => makeCollection(col),
    };

    service.setFirestoreInstance(mappingDbMock);

    const mockOptions = [
      {
        symbolName: 'NIFTY',
        exchange: 'NSE_FNO',
        securityId: '45021',
        tradingSymbol: 'NIFTY 24500 CE',
        customSymbol: 'NIFTY 24500 CE',
        expiryDate: '2026-11-12',
        strikePrice: 24500,
        optionType: 'CE',
        lotSize: 50,
      },
      {
        symbolName: 'BANKNIFTY',
        exchange: 'NSE_FNO',
        securityId: '52010',
        tradingSymbol: 'BANKNIFTY 52000 CE',
        customSymbol: 'BANKNIFTY 52000 CE',
        expiryDate: '2026-11-12',
        strikePrice: 52000,
        optionType: 'CE',
        lotSize: 30,
      },
    ];

    const mockScrip = [
      {
        symbol: 'NIFTY 50',
        name: 'Nifty 50 Index',
        securityId: '13',
        exchangeSegment: 'IDX_I',
        instrumentType: 'INDEX',
        lotSize: 65,
      },
      {
        symbol: 'RELIANCE',
        name: 'Reliance Industries Ltd',
        securityId: '2885',
        exchangeSegment: 'NSE_EQ',
        instrumentType: 'EQUITY',
        lotSize: 1,
      },
    ];

    const saveRes = await service.saveSecIdMapping(mockOptions, mockScrip);
    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(saveRes.collection, 'master_data/sec_id_to_name_mapping');
    assert.strictEqual(saveRes.totalInstruments, 4);
    assert.strictEqual(saveRes.totalOptions, 2);
    assert.strictEqual(saveRes.totalIndices, 1);
    assert.strictEqual(saveRes.totalEquities, 1);
    assert.ok(saveRes.documents.includes('nifty_50_options'));
    assert.ok(saveRes.documents.includes('bank_nifty_options'));
    assert.ok(saveRes.documents.includes('indices'));
    assert.ok(saveRes.documents.includes('equities_chunk_01'));

    const meta = await service.getSecIdMappingMetadata();
    assert.strictEqual(meta?.totalInstruments, 4);
    assert.strictEqual(meta?.collection, 'master_data/sec_id_to_name_mapping');

    const readRes = await service.getSecIdMapping();
    assert.strictEqual(readRes.options.length, 2);
    assert.strictEqual(readRes.scripMaster.length, 2);

    const delRes = await service.deleteSecIdMapping();
    assert.strictEqual(delRes.success, true);

    // Restore mockDb
    service.setFirestoreInstance(mockDb);
  });

  await t.test('reads, saves, and syncs traded instruments from static master JSON in master_data/traded_instruments', async () => {
    const store = new Map<string, any>();
    const masterDbMock: any = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          set: async (data: any) => {
            store.set(`${col}/${id}`, data);
            return { writeTime: { toDate: () => new Date('2026-11-18T14:20:00.000Z') } };
          },
          get: async () => {
            const data = store.get(`${col}/${id}`);
            return { exists: !!data, data: () => data };
          },
        }),
      }),
    };
    service.setFirestoreInstance(masterDbMock);

    // 1. Empty Firestore returns NO hardcoded defaults (strict zero-defaults contract)
    const emptyRes = await service.getTradedInstruments(true);
    assert.strictEqual(emptyRes.instruments.length, 0);
    assert.strictEqual(emptyRes.nifty50, 0);

    // 2. Explicit sync from static master JSON populates master_data/traded_instruments with Dhan displayName
    const initialSync = await service.syncTradedInstrumentsFromMasterJson(false);
    assert.strictEqual(initialSync.success, true);
    assert.strictEqual(initialSync.source, 'static-master-json');
    assert.strictEqual(initialSync.data.instruments.length, 4);
    assert.strictEqual(initialSync.data.instruments[0].displayName, 'Nifty 50');
    assert.strictEqual(initialSync.data.instruments[0].symbolName, 'NIFTY');
    assert.strictEqual(initialSync.data.instruments[0].lotSize, 65);
    assert.strictEqual(initialSync.data.instruments[0].smFreezeQty, 1756);

    // 3. Save preferred lots to master_data/traded_instruments; NSE-fixed lotSize must remain locked & enabled must not be persisted
    const saveRes = await service.saveTradedInstruments({
      nifty50: 75,
      bankNifty: 35,
      nifty50Lots: 15,
      bankNiftyLots: 10,
    });
    assert.strictEqual(saveRes.success, true);
    assert.ok(store.has('master_data/traded_instruments'));
    const persisted = store.get('master_data/traded_instruments');
    assert.strictEqual(persisted.instruments[0].displayName, 'Nifty 50');
    assert.strictEqual(persisted.instruments[0].lotSize, 65, 'NSE-fixed lotSize must remain locked');
    assert.strictEqual(persisted.instruments[1].lotSize, 30, 'NSE-fixed lotSize must remain locked');
    assert.strictEqual(persisted.instruments[0].preferredLots, 15);
    assert.strictEqual(persisted.instruments[1].preferredLots, 10);
    assert.strictEqual(persisted.instruments[0].enabled, undefined, 'Legacy enabled field must not be persisted');
    assert.strictEqual(persisted.instruments[0].symbol, undefined, 'Legacy symbol field must not be persisted');
    assert.strictEqual(persisted.instruments[0].name, undefined, 'Legacy name field must not be persisted');

    // 4. Sync from static master JSON preserves user preferredLots (15) and official Dhan lotSize (65)
    const syncRes = await service.syncTradedInstrumentsFromMasterJson(true);
    assert.strictEqual(syncRes.success, true);
    assert.strictEqual(syncRes.source, 'static-master-json');
    assert.strictEqual(syncRes.data.instruments[0].lotSize, 65);
    assert.strictEqual(syncRes.data.instruments[0].preferredLots, 15);

    service.setFirestoreInstance(mockDb);
  });

  await t.test('reads and saves telegram and app configurations in config collection', async () => {
    const store = new Map<string, any>();
    const configDbMock: any = {
      collection: (col: string) => ({
        doc: (id: string) => ({
          set: async (data: any) => {
            store.set(`${col}/${id}`, data);
            return { writeTime: { toDate: () => new Date() } };
          },
          get: async () => ({
            exists: store.has(`${col}/${id}`),
            data: () => store.get(`${col}/${id}`),
          }),
        }),
      }),
    };
    service.setFirestoreInstance(configDbMock);

    // 1. Save and retrieve Telegram config
    const tgRes = await service.saveTelegramConfig({
      botToken: '123456:ABC-DEF',
      chatId: '987654321',
    });
    assert.strictEqual(tgRes.success, true);

    const tgDoc = await service.getTelegramConfig();
    assert.strictEqual(tgDoc?.botToken, '123456:ABC-DEF');
    assert.strictEqual(tgDoc?.chatId, '987654321');

    // 2. Save and retrieve App config
    const appRes = await service.saveAppConfig({
      port: 8080,
      host: '0.0.0.0',
      pollIntervalMs: 5000,
    });
    assert.strictEqual(appRes.success, true);

    const appDoc = await service.getAppConfig();
    assert.strictEqual(appDoc?.port, 8080);
    assert.strictEqual(appDoc?.host, '0.0.0.0');
    assert.strictEqual(appDoc?.pollIntervalMs, 5000);

    // Restore mockDb
    service.setFirestoreInstance(mockDb);
  });

  await t.test('handles uninitialized Firestore client gracefully', async () => {
    const uninitService = new FirestoreService(configService);
    assert.strictEqual(uninitService.isReady(), false);
    const uninitStatus = uninitService.getStatus();
    assert.strictEqual(uninitStatus.configured, false);

    const testRes = await uninitService.testConnection();
    assert.strictEqual(testRes.success, false);
    assert.strictEqual(testRes.message, 'Firestore client is not initialized');

    assert.throws(() => uninitService.getDb(), /Firestore is not initialized/);
  });
});
