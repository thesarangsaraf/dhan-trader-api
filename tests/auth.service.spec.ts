process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { ConfigService } from '../src/config/config.service';
import { DhanService } from '../src/dhan/dhan.service';

test('AuthService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: AuthService;
  let config: ConfigService;

  const mockDhanService = {
    getProfile: async () => ({
      ok: true,
      data: {
        dhanClientId: '1106885516',
        name: 'SARANG',
        email: 'trader@dhan.co',
      },
    }),
    renewToken: async () => ({
      ok: true,
      data: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTA2ODg1NTE2IiwiY2xpZW50SWQiOiIxMTA2ODg1NTE2IiwiaWF0IjoxNzMwODAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.renewed_token',
      },
    }),
  };

  moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      ConfigService,
      { provide: DhanService, useValue: mockDhanService },
    ],
  }).compile();

  service = moduleRef.get<AuthService>(AuthService);
  config = moduleRef.get<ConfigService>(ConfigService);

  await t.test('inspects valid JWT token payload and calculates IST timestamps', () => {
    const inspection = service.getTokenInspection();
    assert.ok(inspection.configured, 'Token should be marked configured');
    assert.strictEqual(typeof inspection.issuedAtIST, 'string');
    assert.ok(inspection.issuedAtIST.includes('IST'));
    assert.strictEqual(typeof inspection.expiresAtIST, 'string');
    assert.ok(inspection.expiresAtIST.includes('IST'));
    assert.strictEqual(typeof inspection.secondsRemaining, 'number');
    assert.ok(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'].includes(inspection.status));
  });

  await t.test('updates token and updates in-memory config', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 86400;
    const payload = { sub: '1106885516', clientId: '1106885516', iat: now, exp };
    const hB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sampleJwt = `${hB64}.${pB64}.test_signature`;

    const res = await service.updateToken(sampleJwt, '1106885516');
    assert.strictEqual(res.success, true);
    assert.strictEqual(config.clientId, '1106885516');
    assert.strictEqual(config.accessToken, sampleJwt);

    const inspection = service.getTokenInspection();
    assert.strictEqual(inspection.clientId, '1106885516');
    assert.strictEqual(inspection.status, 'ACTIVE');
  });

  await t.test('verifyLiveValidity calls Dhan API', async () => {
    const res = await service.verifyLiveValidity();
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.source, 'dhan_api');
    assert.strictEqual(res.profile.name, 'SARANG');
  });

  await t.test('renewToken returns renewed status from Dhan API', async () => {
    const res = await service.renewToken();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.source, 'dhan_api');
    assert.strictEqual(typeof res.inspection.expiresAtIST, 'string');
  });

  await t.test('syncs token from Firestore database into in-memory cache', async () => {
    let savedInDb: any = null;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 86400;
    const payload = { sub: '9999999999', clientId: '9999999999', iat: now, exp };
    const hB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const pB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const validSyncedJwt = `${hB64}.${pB64}.sig`;

    const mockFsService: any = {
      isReady: () => true,
      getDhanToken: async () => ({
        accessToken: validSyncedJwt,
        clientId: '9999999999',
      }),
      saveDhanToken: async (data: any) => {
        savedInDb = data;
        return { success: true, writeTime: new Date().toISOString() };
      },
    };

    const authWithDb = new AuthService(config, mockDhanService as any, undefined, mockFsService);
    const synced = await authWithDb.syncTokenFromDatabase();
    assert.strictEqual(synced, true);
    assert.strictEqual(config.accessToken, validSyncedJwt);
    assert.strictEqual(config.clientId, '9999999999');

    await authWithDb.persistTokenToDatabase(validSyncedJwt, '9999999999');
    assert.strictEqual(savedInDb.accessToken, validSyncedJwt);
    assert.strictEqual(savedInDb.clientId, '9999999999');
  });
});
