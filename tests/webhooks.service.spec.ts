import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { DhanWebhookDto } from '../src/webhooks/dto/dhan-webhook.dto';

describe('WebhooksService (NestJS)', () => {
  const sentMessages: string[] = [];

  const mockTelegramService: any = {
    sendMessage: async (text: string, options: any) => {
      sentMessages.push(text);
      return { success: true, data: { ok: true } };
    },
    getStatus: () => ({ configured: true, chatId: '123***789', botConfigured: true }),
  };

  const mockAlertsService: any = {
    alerts: [
      {
        id: 'ALT-1001',
        dhanAlertId: 'DHAN-5501',
        instrument: 'NIFTY 50',
        targetPrice: 24500.0,
        operator: 'GREATER_THAN_EQUAL',
        status: 'ACTIVE',
        remarks: 'Breakout above 24500',
        attachedOrder: {
          symbol: 'NIFTY 28 NOV 24500 CALL',
          tradingSymbol: 'NIFTY-Nov2026-24500-CE',
          securityId: '43210',
          transactionType: 'BUY',
          quantity: 50,
          lots: 1,
          lotSize: 50,
          price: 0,
          status: 'PENDING',
          orderId: null,
        },
        conditionalOrders: [
          {
            securityId: '43210',
            symbol: 'NIFTY 28 NOV 24500 CALL',
            quantity: 50,
            status: 'PENDING',
            orderId: null,
          },
        ],
      },
    ],
  };

  const mockInstrumentsService: any = {
    findBySecurityId: (secId: string) => {
      if (secId === '43210') {
        return {
          symbol: 'NIFTY 28 NOV 24500 CALL',
          customSymbol: 'NIFTY 28 NOV 24500 CALL',
          name: 'NIFTY 50',
          strikePrice: 24500,
          optionType: 'CALL',
          expiryDate: '2026-11-28',
          lotSize: 50,
          exchangeSegment: 'NSE_FNO',
        };
      }
      return undefined;
    },
    getLotSizeForInstrument: (sym: string) => {
      if (sym.includes('NIFTY')) return 50;
      if (sym.includes('BANKNIFTY')) return 15;
      return 1;
    },
  };

  const service = new WebhooksService(
    mockTelegramService,
    mockAlertsService,
    mockInstrumentsService,
  );

  it('processes Dhan webhook for TRADED order, matches alert, and formats message with key details', async () => {
    sentMessages.length = 0;

    const payload: DhanWebhookDto = {
      dhanClientId: '1106885516',
      orderId: '1124112098765',
      correlationId: 'ALT-1001',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      tradingSymbol: 'NIFTY 28 NOV 24500 CALL',
      securityId: '43210',
      quantity: 50,
      filled_qty: 50,
      price: 142.5,
      triggerPrice: 24500.0,
      drvExpiryDate: '2026-11-28',
      drvOptionType: 'CALL',
      drvStrikePrice: 24500.0,
    };

    const res = await service.handleDhanWebhook(payload);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.matchedAlertId, 'ALT-1001');
    assert.strictEqual(res.data.instrument, 'NIFTY 50');
    assert.strictEqual(res.data.targetPrice, 24500.0);
    assert.strictEqual(res.data.action, 'BUY');
    assert.strictEqual(res.data.price, 142.5);
    assert.strictEqual(res.data.quantity, 50);

    // Verify alert state was updated to TRIGGERED
    const alert = mockAlertsService.alerts[0];
    assert.strictEqual(alert.status, 'TRIGGERED');
    assert.strictEqual(alert.attachedOrder.status, 'TRADED');
    assert.strictEqual(alert.attachedOrder.orderId, '1124112098765');

    // Verify Telegram message content
    assert.strictEqual(sentMessages.length, 1);
    const msg = sentMessages[0];
    assert.ok(msg.includes('DHAN ALERT TRIGGERED &amp; ORDER EXECUTED'), 'Header missing');
    assert.ok(msg.includes('NIFTY 50'), 'Instrument name missing');
    assert.ok(msg.includes('24,500.00'), 'Price level missing');
    assert.ok(msg.includes('BUY'), 'Action missing');
    assert.ok(msg.includes('NIFTY 28 NOV 24500 CALL'), 'Contract symbol missing');
    assert.ok(msg.includes('142.50'), 'Execution price missing');
    assert.ok(msg.includes('50 units'), 'Quantity missing');
    assert.ok(msg.includes('1 lot'), 'Lot calculation missing');
    assert.ok(msg.includes('1124112098765'), 'Order ID missing');
  });

  it('formats Telegram message for REJECTED order with OMS error description and code', async () => {
    sentMessages.length = 0;

    const payload: DhanWebhookDto = {
      dhanClientId: '1106885516',
      orderId: '1124112099999',
      correlationId: 'ALT-1001',
      orderStatus: 'REJECTED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      tradingSymbol: 'NIFTY 28 NOV 24500 CALL',
      securityId: '43210',
      quantity: 50,
      price: 0,
      triggerPrice: 24500.0,
      omsErrorCode: 'RMS-101',
      omsErrorDescription: 'Insufficient margin in account for derivative order',
    };

    const res = await service.handleDhanWebhook(payload);

    assert.strictEqual(res.success, true);
    assert.strictEqual(sentMessages.length, 1);
    const msg = sentMessages[0];
    assert.ok(msg.includes('ORDER REJECTED'), 'Rejected header missing');
    assert.ok(msg.includes('Insufficient margin in account'), 'Error description missing');
    assert.ok(msg.includes('RMS-101'), 'Error code missing');
  });

  it('handles unmatched webhook gracefully and infers instrument from tradingSymbol', async () => {
    sentMessages.length = 0;

    const payload: DhanWebhookDto = {
      dhanClientId: '1106885516',
      orderId: '1124112077777',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      tradingSymbol: 'BANKNIFTY 28 NOV 52000 CALL',
      quantity: 15,
      price: 320.0,
      triggerPrice: 52000.0,
    };

    const res = await service.handleDhanWebhook(payload);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.matchedAlertId, undefined);
    assert.strictEqual(res.data.instrument, 'BANK NIFTY');
    assert.strictEqual(res.data.targetPrice, 52000.0);
    assert.strictEqual(sentMessages.length, 1);
    const msg = sentMessages[0];
    assert.ok(msg.includes('BANK NIFTY'), 'Inferred instrument missing');
    assert.ok(msg.includes('52,000.00'), 'Trigger price missing');
  });

  it('supports ntfy.sh notification channel and honors telegram/ntfy toggles', async () => {
    sentMessages.length = 0;
    const ntfySentMessages: any[] = [];
    const mockNtfyService: any = {
      formatPostbackMessage: (p: any) => ({
        title: `⚡ Dhan Trade: ${p.attachedSymbol}`,
        message: `Execution of ${p.attachedSymbol} at ${p.executionPrice}`,
        priority: 'high',
        tags: ['chart_with_upwards_trend'],
      }),
      sendNotification: async (opts: any) => {
        ntfySentMessages.push(opts);
        return { success: true, topic: 'dhan-alerts-sarang-8821' };
      },
    };

    let activeConfig = {
      telegramEnabled: false,
      ntfyEnabled: true,
      ntfyTopic: 'dhan-alerts-sarang-8821',
      ntfyServerUrl: 'https://ntfy.sh',
    };

    const mockNotificationsService: any = {
      getSettings: async () => ({
        telegram: { enabled: activeConfig.telegramEnabled },
        ntfy: { enabled: activeConfig.ntfyEnabled, topic: activeConfig.ntfyTopic },
      }),
    };

    const serviceWithNtfy = new WebhooksService(
      mockTelegramService,
      mockAlertsService,
      mockInstrumentsService,
      mockNtfyService,
      mockNotificationsService,
    );

    const payload: DhanWebhookDto = {
      dhanClientId: '1106885516',
      orderId: '1124112098765',
      correlationId: 'ALT-1001',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      tradingSymbol: 'NIFTY 28 NOV 24500 CALL',
      quantity: 50,
      price: 142.5,
    };

    // Case 1: Telegram disabled, ntfy enabled
    const res1 = await serviceWithNtfy.handleDhanWebhook(payload);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.telegramSent, false);
    assert.strictEqual(res1.ntfySent, true);
    assert.strictEqual(sentMessages.length, 0); // Telegram was skipped
    assert.strictEqual(ntfySentMessages.length, 1); // ntfy was called

    // Case 2: Both Telegram and ntfy enabled
    activeConfig.telegramEnabled = true;
    const res2 = await serviceWithNtfy.handleDhanWebhook(payload);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.telegramSent, true);
    assert.strictEqual(res2.ntfySent, true);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(ntfySentMessages.length, 2);
  });
});
