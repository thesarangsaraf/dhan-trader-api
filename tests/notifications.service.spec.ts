process.env.NODE_ENV = 'test';
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NtfyService } from '../src/notifications/ntfy.service';
import { NotificationsService } from '../src/notifications/notifications.service';

describe('Notifications & NtfyService (NestJS)', () => {
  const mockConfig: any = {
    ntfyTopic: 'dhan-alerts-sarang-8821',
    ntfyServerUrl: 'https://ntfy.sh',
  };

  let firestoreDoc: any = null;
  const mockFirestoreService: any = {
    isReady: () => true,
    getNotificationConfig: async () => {
      return (
        firestoreDoc || {
          telegramEnabled: true,
          ntfyEnabled: true,
          ntfyTopic: 'dhan-alerts-sarang-8821',
          ntfyServerUrl: 'https://ntfy.sh',
        }
      );
    },
    saveNotificationConfig: async (cfg: any) => {
      firestoreDoc = {
        telegramEnabled: cfg.telegramEnabled ?? true,
        ntfyEnabled: cfg.ntfyEnabled ?? true,
        ntfyTopic: cfg.ntfyTopic || 'dhan-alerts-sarang-8821',
        ntfyServerUrl: cfg.ntfyServerUrl || 'https://ntfy.sh',
        updatedAt: new Date().toISOString(),
      };
      return { success: true, config: firestoreDoc, writeTime: new Date().toISOString() };
    },
  };

  const telegramSentMessages: string[] = [];
  const mockTelegramService: any = {
    sendMessage: async (text: string) => {
      telegramSentMessages.push(text);
      return { success: true };
    },
    sendTestNotification: async () => {
      telegramSentMessages.push('TEST');
      return { success: true };
    },
    getStatus: () => ({ configured: true, chatId: '123***789', botConfigured: true }),
  };

  const ntfyService = new NtfyService(mockConfig, mockFirestoreService);
  const notificationsService = new NotificationsService(
    mockTelegramService,
    ntfyService,
    mockFirestoreService,
  );

  it('resolves default topic and server URL for ntfy.sh', async () => {
    const topic = await ntfyService.getTopic();
    assert.strictEqual(topic, 'dhan-alerts-sarang-8821');

    const serverUrl = await ntfyService.getServerUrl();
    assert.strictEqual(serverUrl, 'https://ntfy.sh');

    const status = await ntfyService.getStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.subscriptionUrl, 'https://ntfy.sh/dhan-alerts-sarang-8821');
  });

  it('formats TRADED postback order into Markdown with high priority and trading details', () => {
    const formatted = ntfyService.formatPostbackMessage({
      orderStatus: 'TRADED',
      action: 'BUY',
      instrumentName: 'NIFTY 50',
      targetPrice: 24500.0,
      operator: 'GREATER_THAN_EQUAL',
      remarks: 'Breakout above 24500',
      attachedSymbol: 'NIFTY 28 NOV 24500 CALL',
      quantity: 50,
      lots: 1,
      executionPrice: 142.5,
      totalValue: 7125.0,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      exchangeSegment: 'NSE_FNO',
      strikePrice: 24500,
      optionType: 'CALL',
      expiryDate: '2026-11-28',
      orderId: '1124112098765',
      correlationId: 'ALT-1001',
      omsErrorCode: null,
      omsErrorDescription: null,
    });

    assert.strictEqual(formatted.priority, 'high');
    assert.ok(formatted.title.includes('NIFTY 28 NOV 24500 CALL'));
    assert.ok(formatted.message.includes('DHAN ALERT TRIGGERED & ORDER EXECUTED'));
    assert.ok(formatted.message.includes('NIFTY 50'));
    assert.ok(formatted.message.includes('142.50'));
    assert.ok(formatted.message.includes('7,125.00'));
    assert.ok(formatted.message.includes('1124112098765'));
  });

  it('formats REJECTED postback order with urgent priority and rejection details', () => {
    const formatted = ntfyService.formatPostbackMessage({
      orderStatus: 'REJECTED',
      action: 'BUY',
      instrumentName: 'NIFTY 50',
      targetPrice: 24500.0,
      operator: 'GREATER_THAN_EQUAL',
      remarks: 'Breakout above 24500',
      attachedSymbol: 'NIFTY 28 NOV 24500 CALL',
      quantity: 50,
      lots: 1,
      executionPrice: 0,
      totalValue: 0,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      exchangeSegment: 'NSE_FNO',
      orderId: '1124112099999',
      correlationId: 'ALT-1001',
      omsErrorCode: 'RMS-101',
      omsErrorDescription: 'Insufficient margin in account for derivative order',
    });

    assert.strictEqual(formatted.priority, 'urgent');
    assert.ok(formatted.title.includes('REJECTED'));
    assert.ok(formatted.message.includes('ORDER REJECTED'));
    assert.ok(formatted.message.includes('Insufficient margin in account'));
    assert.ok(formatted.message.includes('RMS-101'));
  });

  it('retrieves active notification settings and toggles from Firestore', async () => {
    const settings = await notificationsService.getSettings();
    assert.strictEqual(settings.telegram.enabled, true);
    assert.strictEqual(settings.ntfy.enabled, true);
    assert.strictEqual(settings.ntfy.topic, 'dhan-alerts-sarang-8821');
    assert.strictEqual(settings.telegram.configured, true);
  });

  it('updates notification toggles and persists to Firestore (e.g. telegram disabled, ntfy enabled)', async () => {
    const updated = await notificationsService.updateSettings({
      telegramEnabled: false,
      ntfyEnabled: true,
      ntfyTopic: 'dhan-alerts-sarang-9999',
    });

    assert.strictEqual(updated.telegram.enabled, false);
    assert.strictEqual(updated.ntfy.enabled, true);
    assert.strictEqual(updated.ntfy.topic, 'dhan-alerts-sarang-9999');

    // Verify Firestore was updated
    assert.strictEqual(firestoreDoc.telegramEnabled, false);
    assert.strictEqual(firestoreDoc.ntfyEnabled, true);
    assert.strictEqual(firestoreDoc.ntfyTopic, 'dhan-alerts-sarang-9999');
  });

  it('sends test notifications respecting channel enabled/disabled toggles', async () => {
    telegramSentMessages.length = 0;
    // Currently telegram is disabled, ntfy is enabled
    const res = await notificationsService.sendTestNotification();

    assert.strictEqual(res.telegram.sent, false);
    assert.strictEqual(res.telegram.reason, 'Telegram disabled in settings');
    assert.strictEqual(res.ntfy.sent, true);
    assert.strictEqual(telegramSentMessages.length, 0);

    // Re-enable telegram
    await notificationsService.updateSettings({ telegramEnabled: true });
    const res2 = await notificationsService.sendTestNotification();
    assert.strictEqual(res2.telegram.sent, true);
    assert.strictEqual(res2.ntfy.sent, true);
    assert.strictEqual(telegramSentMessages.length, 1);
  });
});
