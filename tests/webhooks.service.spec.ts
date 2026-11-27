import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { DhanWebhookDto } from '../src/webhooks/dto/dhan-webhook.dto';
import { WebhookBodyParserMiddleware } from '../src/webhooks/webhook-body-parser.middleware';

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

  it('parses text/plain raw JSON string, awaits cold-start sync, and enriches price/symbol from Dhan order book', async () => {
    sentMessages.length = 0;

    let synced = false;
    const coldAlertsService: any = {
      alerts: [],
      ensureSynced: async () => {
        if (!synced) {
          synced = true;
          coldAlertsService.alerts = [
            {
              id: '88001',
              dhanAlertId: '88001',
              instrument: 'NIFTY 50',
              targetPrice: 25800,
              operator: 'GREATER_THAN',
              status: 'TRIGGERED',
              remarks: 'Nifty 25800 call entry [Webhook: https://example.com/api/webhooks/dhan]',
              attachedOrder: {
                securityId: '51001',
                transactionType: 'BUY',
                quantity: 65,
                lotSize: 65,
                lots: 1,
                orderType: 'MARKET',
                productType: 'INTRADAY',
                status: 'PENDING',
              },
            },
          ];
        }
      },
    };

    const coldInstrumentsService: any = {
      findBySecurityId: (secId: string) => {
        if (secId === '51001') {
          return {
            symbol: 'NIFTY 1 DEC 25800 CALL',
            customSymbol: 'NIFTY 1 DEC 25800 CALL',
            name: 'NIFTY 50',
            strikePrice: 25800,
            optionType: 'CE',
            expiryDate: '2026-12-01',
            lotSize: 65,
            exchangeSegment: 'NSE_FNO',
          };
        }
        return undefined;
      },
      getLotSizeForInstrument: () => 65,
    };

    const mockDhanService: any = {
      getOrders: async () => ({
        ok: true,
        data: [
          {
            orderId: '9911223344',
            orderStatus: 'TRADED',
            transactionType: 'BUY',
            exchangeSegment: 'NSE_FNO',
            productType: 'INTRADAY',
            orderType: 'MARKET',
            securityId: '51001',
            tradingSymbol: '',
            quantity: 65,
            filledQty: 65,
            averageTradedPrice: 184.75,
          },
        ],
      }),
    };

    const enrichedService = new WebhooksService(
      mockTelegramService,
      coldAlertsService,
      coldInstrumentsService,
      mockDhanService,
    );

    // Simulate Go-http-client sending raw JSON string with price: 0 and empty tradingSymbol
    const rawJsonPayload = JSON.stringify({
      dhanClientId: '1106885516',
      orderId: '9911223344',
      orderStatus: 'TRADED',
      transactionType: 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      tradingSymbol: '',
      securityId: '51001',
      quantity: 65,
      price: 0,
      triggerPrice: 0,
    });

    const res = await enrichedService.handleDhanWebhook(rawJsonPayload, { contentType: 'text/plain' });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.matchedAlertId, '88001');
    assert.strictEqual(res.data.orderId, '9911223344');
    assert.strictEqual(res.data.orderStatus, 'TRADED');
    assert.strictEqual(res.data.targetPrice, 25800);
    assert.strictEqual(res.data.attachedSymbol, 'NIFTY 1 DEC 25800 CALL');
    assert.strictEqual(res.data.price, 184.75);
    assert.strictEqual(res.data.quantity, 65);

    const msg = sentMessages[0];
    assert.ok(msg.includes('25,800.00'), 'Trigger price from synced alert missing');
    assert.ok(msg.includes('NIFTY 1 DEC 25800 CALL'), 'Contract symbol missing');
    assert.ok(msg.includes('184.75'), 'Enriched execution price missing');
    assert.ok(msg.includes('9911223344'), 'Order ID missing');
    assert.ok(!msg.includes('[Webhook:'), 'Internal webhook URL tag should be stripped from note');
  });

  it('normalizes Data-wrapped snake_case payloads and avoids fabricating 1 lot for 0 quantity or EXECUTED for UNKNOWN', async () => {
    sentMessages.length = 0;

    const wrappedPayload: any = {
      Data: {
        order_id: '778899',
        order_status: 'TRADED',
        transaction_type: 'SELL',
        exchange_segment: 'NSE_FNO',
        trading_symbol: 'NIFTY 1 DEC 25800 CALL',
        security_id: '43210',
        filled_qty: 50,
        traded_price: 210.5,
        trigger_price: 25750,
      },
    };

    const res1 = await service.handleDhanWebhook(wrappedPayload);
    assert.strictEqual(res1.data.orderId, '778899');
    assert.strictEqual(res1.data.orderStatus, 'TRADED');
    assert.strictEqual(res1.data.action, 'SELL');
    assert.strictEqual(res1.data.price, 210.5);
    assert.strictEqual(res1.data.quantity, 50);

    sentMessages.length = 0;
    const emptyRes = await service.handleDhanWebhook({});
    assert.strictEqual(emptyRes.data.orderStatus, 'UNKNOWN');
    assert.strictEqual(emptyRes.data.quantity, 0);
    const unknownMsg = sentMessages[0];
    assert.ok(unknownMsg.includes('STATUS UNKNOWN'), 'Should show STATUS UNKNOWN banner');
    assert.ok(!unknownMsg.includes('(1 lot)'), 'Should not show 1 lot when quantity is 0');
  });

  it('WebhookBodyParserMiddleware parses raw JSON streams sent without application/json Content-Type', async () => {
    const middleware = new WebhookBodyParserMiddleware();

    for (const headers of [{}, { 'content-type': 'text/plain; charset=utf-8' }]) {
      const stream: any = new PassThrough();
      stream.headers = headers;

      await new Promise<void>((resolve) => {
        middleware.use(stream, {} as any, () => resolve());
        stream.end(JSON.stringify({ orderId: 'ORD-STREAM-1', orderStatus: 'TRADED', quantity: 65 }));
      });

      assert.strictEqual(stream.body?.orderId, 'ORD-STREAM-1');
      assert.strictEqual(stream.body?.orderStatus, 'TRADED');
      assert.strictEqual(stream.body?.quantity, 65);
    }
  });
});
