process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { AlertsService } from '../src/alerts/alerts.service';
import { ConfigService } from '../src/config/config.service';
import { DhanService } from '../src/dhan/dhan.service';
import { TelegramService } from '../src/telegram/telegram.service';
import { InstrumentsService } from '../src/instruments/instruments.service';

test('AlertsService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: AlertsService;

  const mockDhanAlertsList: any[] = [];
  const mockDhanService: any = {
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
    getAlerts: async () => ({
      ok: true,
      data: mockDhanAlertsList,
    }),
    cancelDhanAlert: async (alertId: string) => {
      const idx = mockDhanAlertsList.findIndex((a) => a.alertId === alertId || a.id === alertId);
      if (idx >= 0) mockDhanAlertsList.splice(idx, 1);
      return { ok: true };
    },
    createDhanAlert: async (payload: any) => {
      const alertId = payload.alertId || `DHAN-ALT-${Math.floor(Math.random() * 90000 + 10000)}`;
      const obj = { alertId, id: alertId, ...payload };
      mockDhanAlertsList.push(obj);
      return { ok: true, data: obj };
    },
    placeOrder: async (ordPayload: any) => ({
      ok: true,
      data: { orderId: 'DHAN-ORD-COND-1', orderStatus: 'EXECUTED', ...ordPayload },
    }),
  };

  const mockTelegramService = {
    sendAlertNotification: async () => ({ success: true }),
    sendOrderNotification: async () => ({ success: true }),
    sendMessage: async () => ({ success: true }),
  };

  const mockInstrumentsService = {
    findBySymbol: (sym: string) => {
      if (sym.includes('24500')) return { symbol: sym, securityId: '45021', exchangeSegment: 'NSE_FNO' };
      if (sym.includes('25000')) return { symbol: sym, securityId: '40037', exchangeSegment: 'NSE_FNO', lotSize: 65 };
      return undefined;
    },
    findBySecurityId: (id: string) => {
      if (id === '45021') {
        return {
          symbol: 'NIFTY 24500 CE',
          tradingSymbol: 'NIFTY-26Nov-24500-CE',
          customSymbol: 'NIFTY 24500 CE',
          securityId: '45021',
          exchangeSegment: 'NSE_FNO',
          expiryDate: '2026-11-26',
          strikePrice: 24500,
          optionType: 'CE',
        };
      }
      if (id === '2885') {
        return {
          symbol: 'RELIANCE',
          tradingSymbol: 'RELIANCE-EQ',
          customSymbol: 'Reliance Industries Ltd',
          name: 'Reliance Industries Ltd',
          securityId: '2885',
          exchangeSegment: 'NSE_EQ',
          lotSize: 1,
        };
      }
      return undefined;
    },
  };

  moduleRef = await Test.createTestingModule({
    providers: [
      AlertsService,
      ConfigService,
      { provide: DhanService, useValue: mockDhanService },
      { provide: TelegramService, useValue: mockTelegramService },
      { provide: InstrumentsService, useValue: mockInstrumentsService },
    ],
  }).compile();

  service = moduleRef.get<AlertsService>(AlertsService);

  await t.test('returns predefined popular NSE indices', () => {
    const indices = service.getIndices();
    assert.ok(Array.isArray(indices));
    assert.strictEqual(indices.length, 4);

    const nifty50 = indices.find((i) => i.name === 'NIFTY 50');
    assert.ok(nifty50);
    assert.strictEqual(nifty50.securityId, '13');
    assert.strictEqual(nifty50.exchangeSegment, 'IDX_I');

    const bankNifty = indices.find((i) => i.name === 'BANK NIFTY');
    assert.ok(bankNifty);
    assert.strictEqual(bankNifty.securityId, '25');

    const sensex = indices.find((i) => i.name === 'SENSEX');
    assert.ok(sensex);
    assert.strictEqual(sensex.securityId, '51');

    const midcapNifty = indices.find((i) => i.name === 'MIDCAP NIFTY');
    assert.ok(midcapNifty);
    assert.strictEqual(midcapNifty.securityId, '442');

    // Confirm that removed indices are NOT present
    const removedNames = ['NIFTY NEXT 50', 'INDIA VIX', 'NIFTY IT', 'NIFTY AUTO', 'NIFTY FMCG', 'NIFTY PHARMA', 'NIFTY METAL', 'NIFTY FIN SERVICE'];
    for (const rName of removedNames) {
      assert.ok(!indices.some((i) => i.name === rName), `Expected ${rName} to be deleted`);
    }
  });

  await t.test('creates, reads, categorizes and manages price alerts', () => {
    const result = service.createAlert({
      instrument: 'NIFTY 50',
      targetPrice: 24950.0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Test breakout alert',
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.alert.id.startsWith('ALT-') || result.alert.id.startsWith('DHAN-'));
    assert.strictEqual(result.alert.instrument, 'NIFTY 50');
    assert.strictEqual(result.alert.targetPrice, 24950.0);
    assert.strictEqual(result.alert.status, 'ACTIVE');

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

  await t.test('creates and executes alert with conditional order', async () => {
    const res = await service.createConditionalAlert({
      instrument: 'NIFTY 50',
      targetPrice: 24520.0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Conditional buy on breakout',
      conditionalOrder: {
        symbol: 'NIFTY 24500 CE',
        quantity: 50,
        transactionType: 'BUY',
        orderType: 'MARKET',
      },
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.alert.hasConditionalOrder, true);
    assert.strictEqual(res.alert.conditionalOrders.length, 1);
    assert.strictEqual(res.alert.conditionalOrders[0].symbol, 'NIFTY 24500 CE');
    assert.strictEqual(res.alert.conditionalOrders[0].status, 'PENDING');
    assert.strictEqual(res.alert.conditionalOrders[0].securityId, '45021');

    // Simulate price tick trigger (price is 24525.0 >= 24520.0)
    service.priceCache.set('IDX_I:13', 24525.0);
    service.priceCache.set('NIFTY 50', 24525.0);
    await service.checkAndTick();

    const triggered = service.alerts.find((a) => a.id === res.alert.id);
    assert.strictEqual(triggered.status, 'TRIGGERED');
    assert.strictEqual(triggered.conditionalOrders[0].status, 'PLACED');
    assert.strictEqual(triggered.conditionalOrders[0].orderId, 'DHAN-ORD-COND-1');
    assert.strictEqual(triggered.attachedOrder.status, 'PLACED');
    assert.strictEqual(triggered.attachedOrder.orderId, 'DHAN-ORD-COND-1');

    const all = service.getAllAlerts();
    const alertWithOrd = all.find((a) => a.id === res.alert.id);
    assert.ok(alertWithOrd.attachedOrder);
    assert.strictEqual(alertWithOrd.attachedOrder.symbol, 'NIFTY 24500 CE');
  });

  await t.test('converts 5 lots to 325 shares and sets LESS_THAN operator when target is below current LTP', async () => {
    service.priceCache.set('IDX_I:13', 25030.0);
    service.priceCache.set('NIFTY 50', 25030.0);

    let submittedDhanPayload: any = null;
    mockDhanService.createDhanAlert = async (payload: any) => {
      submittedDhanPayload = payload;
      return { ok: true, data: { alertId: 'DHAN-ALT-LOTS-1' } };
    };

    const res = await service.createConditionalAlert({
      instrument: 'NIFTY 50',
      targetPrice: 25000.0, // below 25030.0 -> LESS_THAN
      remarks: 'NIFTY 25000 breakdown with 5 lots',
      conditionalOrder: {
        symbol: 'NIFTY 25000 CE',
        quantity: 5, // user provided 5 lots
        transactionType: 'BUY',
        orderType: 'MARKET',
      },
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(submittedDhanPayload.condition.operator, 'LESS_THAN');
    assert.strictEqual(submittedDhanPayload.orders[0].quantity, 325); // 5 lots * 65 = 325 shares
    assert.strictEqual(res.alert.conditionalOrders[0].quantity, 325);
  });

  await t.test('creates alert with Stop Loss configured on NIFTY 50 and places SL alert directly on Dhan HQ API v2', async () => {
    mockDhanService.getLtp = async () => ({
      ok: true,
      data: {
        status: 'success',
        data: {
          'IDX_I': {
            '13': { last_price: 25700.0 },
            '25': { last_price: 51850.0 },
          },
        },
      },
    });
    service.priceCache.set('IDX_I:13', 25700.0);
    service.priceCache.set('NIFTY 50', 25700.0);

    const prevCreate = mockDhanService.createDhanAlert;
    const prevGet = mockDhanService.getAlerts;

    const slDhanAlerts: any[] = [];
    mockDhanService.createDhanAlert = async (payload: any) => {
      const alertId = `DHAN-SL-ALT-${Math.floor(Math.random() * 9000 + 1000)}`;
      const alertObj = { alertId, id: alertId, ...payload };
      slDhanAlerts.push(alertObj);
      return { ok: true, data: alertObj };
    };
    mockDhanService.getAlerts = async () => ({
      ok: true,
      data: slDhanAlerts,
    });

    try {
      // User places alert on NIFTY 50 at 25017 buying 25000 Call with Stop Loss
      const res = await service.createConditionalAlert({
        instrument: 'NIFTY 50',
        targetPrice: 25017.0,
        operator: 'LESS_THAN',
        remarks: 'NIFTY 25017 entry buying 25000 CE',
        conditionalOrder: {
          symbol: 'NIFTY 25000 CE',
          quantity: 5,
          transactionType: 'BUY',
          orderType: 'MARKET',
        },
        stopLoss: {
          enabled: true,
        },
      });

      assert.strictEqual(res.success, true);
      assert.ok(res.alert.stopLoss);
      assert.strictEqual(res.alert.stopLoss.enabled, true);
      assert.strictEqual(res.alert.stopLoss.points, 12); // Default for Nifty 50 is 12 pts
      assert.strictEqual(res.alert.stopLoss.targetPrice, 25005.0); // 25017 - 12 = 25005
      assert.strictEqual(res.alert.stopLoss.operator, 'LESS_THAN');
      assert.strictEqual(res.alert.stopLoss.action, 'SELL');
      assert.strictEqual(res.alert.status, 'ACTIVE');

      // Both Entry alert AND Stop Loss alert must be deployed directly to Dhan HQ API v2 at creation!
      assert.strictEqual(slDhanAlerts.length, 2, 'Two alerts (Entry and Stop Loss) must be created on Dhan HQ API v2');
      const entryPayload = slDhanAlerts[0];
      const slPayload = slDhanAlerts[1];

      assert.strictEqual(entryPayload.condition.comparingValue, 25017.0);
      assert.strictEqual(entryPayload.orders[0].transactionType, 'BUY');

      assert.strictEqual(slPayload.condition.comparingValue, 25005.0);
      assert.strictEqual(slPayload.condition.operator, 'LESS_THAN');
      assert.strictEqual(slPayload.orders[0].transactionType, 'SELL');
      assert.strictEqual(slPayload.orders[0].quantity, 325); // 5 lots * 65

      // Verify both alerts exist in the registry from Dhan
      const parentAlert = service.alerts.find((a) => a.id === res.alert.id);
      assert.ok(parentAlert);
      assert.strictEqual(parentAlert.stopLossAlertPlaced, true);
      assert.strictEqual(parentAlert.stopLossAlertId, res.alert.stopLossAlertId);

      const slAlert = service.alerts.find((a) => a.id === res.alert.stopLossAlertId);
      assert.ok(slAlert, 'Stop loss alert should be present in alert registry immediately on Dhan');
      assert.strictEqual(slAlert.isStopLossAlert, true);
      assert.strictEqual(slAlert.parentAlertId, parentAlert.id);
      assert.strictEqual(slAlert.targetPrice, 25005.0);
      assert.strictEqual(slAlert.operator, 'LESS_THAN');
      assert.strictEqual(slAlert.conditionalOrders[0].symbol, 'NIFTY 25000 CE');
      assert.strictEqual(slAlert.conditionalOrders[0].transactionType, 'SELL');
      assert.strictEqual(slAlert.conditionalOrders[0].quantity, 325); // same quantity
    } finally {
      mockDhanService.createDhanAlert = prevCreate;
      mockDhanService.getAlerts = prevGet;
    }
  });

  await t.test('throws BadRequestException and cancels primary alert if Stop Loss placement fails on Dhan', async () => {
    const prevCreate = mockDhanService.createDhanAlert;
    const prevCancel = mockDhanService.cancelDhanAlert;

    let callCount = 0;
    let cancelledId: string | null = null;
    mockDhanService.createDhanAlert = async (payload: any) => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, data: { alertId: 'DHAN-PRIMARY-1', id: 'DHAN-PRIMARY-1', ...payload } };
      }
      return { ok: false, error: 'Margin insufficient for stop loss order' };
    };
    mockDhanService.cancelDhanAlert = async (id: string) => {
      cancelledId = id;
      return { ok: true };
    };

    let thrownError: any = null;
    try {
      await service.createConditionalAlert({
        instrument: 'NIFTY 50',
        targetPrice: 25017.0,
        remarks: 'Entry test',
        conditionalOrder: {
          symbol: 'NIFTY 25000 CE',
          quantity: 50,
          transactionType: 'BUY',
        },
        stopLoss: {
          enabled: true,
        },
      });
    } catch (err: any) {
      thrownError = err;
    } finally {
      mockDhanService.createDhanAlert = prevCreate;
      mockDhanService.cancelDhanAlert = prevCancel;
    }

    assert.ok(thrownError, 'Must throw error when Dhan rejects SL alert');
    assert.strictEqual(cancelledId, 'DHAN-PRIMARY-1', 'Must cancel primary alert on Dhan when SL fails');
    // Ensure no fake/mock alert was added to registry
    const fakeAlert = service.alerts.find((a) => a.id === 'DHAN-PRIMARY-1');
    assert.strictEqual(fakeAlert, undefined, 'No fake or unhedged alert should remain in alerts registry');
  });

  await t.test('calculates Stop Loss correctly for BANK NIFTY (20 points) for BUY and SELL (Put) orders', async () => {
    // 1. BANK NIFTY Buy order: 51850 -> SL: 51850 - 20 = 51830
    const buyRes = await service.createConditionalAlert({
      instrument: 'NIFTY BANK',
      targetPrice: 51850.0,
      operator: 'GREATER_THAN',
      conditionalOrder: {
        symbol: 'BANKNIFTY 52000 CE',
        quantity: 30,
        transactionType: 'BUY',
        orderType: 'MARKET',
      },
      stopLoss: {
        enabled: true,
      },
    });
    assert.strictEqual(buyRes.alert.stopLoss.points, 20); // 20 pts for BANK NIFTY
    assert.strictEqual(buyRes.alert.stopLoss.targetPrice, 51830.0); // 51850 - 20
    assert.strictEqual(buyRes.alert.stopLoss.action, 'SELL');

    // 2. BANK NIFTY Bearish (Put / Breakdown): 51850 -> SL: 51850 + 20 = 51870
    const putRes = await service.createConditionalAlert({
      instrument: 'NIFTY BANK',
      targetPrice: 51850.0,
      operator: 'LESS_THAN',
      conditionalOrder: {
        symbol: 'BANKNIFTY 51500 PE',
        quantity: 30,
        transactionType: 'BUY', // Buying Put option
        orderType: 'MARKET',
      },
      stopLoss: {
        enabled: true,
      },
    });
    assert.strictEqual(putRes.alert.stopLoss.points, 20);
    assert.strictEqual(putRes.alert.stopLoss.targetPrice, 51870.0); // 51850 + 20 for bearish
    assert.strictEqual(putRes.alert.stopLoss.action, 'SELL'); // Sells the put option
  });

  await t.test('resolves instrument name from security ID for indices, equities, and options', () => {
    // 1. Index security ID (13 -> NIFTY 50)
    const idxName = service.resolveInstrumentName('13');
    assert.strictEqual(idxName, 'NIFTY 50');

    // 2. Equity security ID (2885 -> Reliance Industries Ltd)
    const eqName = service.resolveInstrumentName('2885');
    assert.strictEqual(eqName, 'Reliance Industries Ltd');

    // 3. Option contract security ID (45021 -> NIFTY 24500 CE)
    const optName = service.resolveInstrumentName('45021');
    assert.strictEqual(optName, 'NIFTY 24500 CE');

    // 4. Unknown security ID with userNote fallback
    const noteFallback = service.resolveInstrumentName('999999', 'My Stock Alert');
    assert.strictEqual(noteFallback, 'My Stock Alert');

    // 5. Unknown security ID with no fallback
    const rawFallback = service.resolveInstrumentName('999999');
    assert.strictEqual(rawFallback, 'SEC-999999');
  });

  await t.test('getInstrumentDetailsBySecurityId returns structured metadata', () => {
    const idxDetails = service.getInstrumentDetailsBySecurityId('13');
    assert.ok(idxDetails);
    assert.strictEqual(idxDetails.instrumentName, 'NIFTY 50');
    assert.strictEqual(idxDetails.exchangeSegment, 'IDX_I');

    const eqDetails = service.getInstrumentDetailsBySecurityId('2885');
    assert.ok(eqDetails);
    assert.strictEqual(eqDetails.instrumentName, 'Reliance Industries Ltd');
    assert.strictEqual(eqDetails.symbol, 'RELIANCE');
    assert.strictEqual(eqDetails.exchangeSegment, 'NSE_EQ');

    const notFound = service.getInstrumentDetailsBySecurityId('999999');
    assert.strictEqual(notFound, null);
  });

  await t.test('triggers test notification event', () => {
    const testEvent = service.triggerTestAlert('NIFTY 50');
    assert.strictEqual(testEvent.instrument, 'NIFTY 50');
    assert.strictEqual(testEvent.isTest, true);

    const events = service.getTriggeredEventsSince();
    assert.ok(events.length > 0);
  });
});
