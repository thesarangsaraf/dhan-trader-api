process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { AlertsService } from '../src/alerts/alerts.service';
import { ConfigService } from '../src/config/config.service';
import { DhanService } from '../src/dhan/dhan.service';
import { TelegramService } from '../src/telegram/telegram.service';

test('AlertsService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: AlertsService;

  const mockDhanService = {
    getLtp: async () => ({
      ok: true,
      data: {
        status: 'success',
        data: {
          'IDX_I': {
            '13': { last_price: 24520.5 },
            '25': { last_price: 51850.0 },
          },
        },
      },
    }),
  };

  const mockTelegramService = {
    sendAlertNotification: async () => ({ success: true }),
  };

  moduleRef = await Test.createTestingModule({
    providers: [
      AlertsService,
      ConfigService,
      { provide: DhanService, useValue: mockDhanService },
      { provide: TelegramService, useValue: mockTelegramService },
    ],
  }).compile();

  service = moduleRef.get<AlertsService>(AlertsService);

  await t.test('returns predefined popular NSE indices without static IP requirement', () => {
    const indices = service.getIndices();
    assert.ok(Array.isArray(indices));
    assert.ok(indices.length >= 10);

    const nifty50 = indices.find((i) => i.name === 'NIFTY 50');
    assert.ok(nifty50);
    assert.strictEqual(nifty50.securityId, '13');
    assert.strictEqual(nifty50.exchangeSegment, 'IDX_I');

    const bankNifty = indices.find((i) => i.name === 'NIFTY BANK');
    assert.ok(bankNifty);
    assert.strictEqual(bankNifty.securityId, '25');
  });

  await t.test('creates, reads, categorizes and manages price alerts', () => {
    const result = service.createAlert({
      instrument: 'NIFTY 50',
      targetPrice: 24950.0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Test breakout alert',
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.alert.id.startsWith('ALT-'));
    assert.strictEqual(result.alert.instrument, 'NIFTY 50');
    assert.strictEqual(result.alert.targetPrice, 24950.0);
    assert.strictEqual(result.alert.status, 'ACTIVE');
    assert.strictEqual(result.alert.dhanMetadata.noStaticIpRequired, true);

    const grouped = service.getGroupedAlerts();
    assert.ok(Array.isArray(grouped));
    const niftyGroup = grouped.find((g: any) => g.instrument === 'NIFTY 50');
    assert.ok(niftyGroup);
    assert.ok(niftyGroup.alerts.some((a: any) => a.id === result.alert.id));

    const cancelRes = service.cancelAlert(result.alert.id);
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(cancelRes.alert.status, 'CANCELLED');

    const delRes = service.deleteAlert(result.alert.id);
    assert.strictEqual(delRes.success, true);
  });

  await t.test('triggers test notification event', () => {
    const testEvent = service.triggerTestAlert('NIFTY 50');
    assert.strictEqual(testEvent.instrument, 'NIFTY 50');
    assert.strictEqual(testEvent.isTest, true);

    const events = service.getTriggeredEventsSince();
    assert.ok(events.length > 0);
  });
});
