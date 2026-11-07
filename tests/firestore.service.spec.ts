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

  await t.test('saves and retrieves Dhan token in collection dhan and document token', async () => {
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
    assert.strictEqual(savedCol, 'dhan');
    assert.strictEqual(savedDoc, 'token');
    assert.strictEqual(savedData.accessToken, 'eyJ_mock_token');
    assert.strictEqual(savedData.clientId, '1106885516');

    const retrieved = await service.getDhanToken();
    assert.strictEqual(retrieved?.accessToken, 'eyJ_mock_token');
    assert.strictEqual(retrieved?.clientId, '1106885516');

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
