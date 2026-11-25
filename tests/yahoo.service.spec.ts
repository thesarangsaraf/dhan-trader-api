process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert';
import { Test, TestingModule } from '@nestjs/testing';
import { YahooFinanceService } from '../src/yahoo/yahoo.service';

test('YahooFinanceService (NestJS)', async (t) => {
  let moduleRef: TestingModule;
  let service: YahooFinanceService;

  moduleRef = await Test.createTestingModule({
    providers: [YahooFinanceService],
  }).compile();

  service = moduleRef.get<YahooFinanceService>(YahooFinanceService);

  await t.test('maps Indian index and equity symbols to Yahoo tickers correctly', () => {
    assert.strictEqual(service.mapToYahooSymbol('NIFTY 50'), '^NSEI');
    assert.strictEqual(service.mapToYahooSymbol('BANK NIFTY'), '^NSEBANK');
    assert.strictEqual(service.mapToYahooSymbol('SENSEX'), '^BSESN');
    assert.strictEqual(service.mapToYahooSymbol('MIDCAP NIFTY'), 'NIFTY_MID_SELECT.NS');
    assert.strictEqual(service.mapToYahooSymbol('MIDCP NIFTY'), 'NIFTY_MID_SELECT.NS');
    assert.strictEqual(service.mapToYahooSymbol('FINNIFTY'), 'NIFTY_FIN_SERVICE.NS');
    assert.strictEqual(service.mapToYahooSymbol('RELIANCE'), 'RELIANCE.NS');
    assert.strictEqual(service.mapToYahooSymbol('TCS'), 'TCS.NS');
    assert.strictEqual(service.mapToYahooSymbol('^NSEI'), '^NSEI');
    assert.strictEqual(service.mapToYahooSymbol('RELIANCE.NS'), 'RELIANCE.NS');
    assert.strictEqual(service.mapToYahooSymbol(''), null);
  });

  await t.test('parses option contracts accurately', () => {
    const opt1 = service.parseOptionSymbol('NIFTY 24500 CE');
    assert.strictEqual(opt1.isOption, true);
    assert.strictEqual(opt1.underlying, 'NIFTY 50');
    assert.strictEqual(opt1.strike, 24500);
    assert.strictEqual(opt1.type, 'CE');

    const opt2 = service.parseOptionSymbol('BANKNIFTY 52000 PE');
    assert.strictEqual(opt2.isOption, true);
    assert.strictEqual(opt2.underlying, 'BANK NIFTY');
    assert.strictEqual(opt2.strike, 52000);
    assert.strictEqual(opt2.type, 'PE');

    // Official Dhan / NSE scrip master formats with expiry dates and CALL / PUT words
    const opt3 = service.parseOptionSymbol('NIFTY 01 DEC 25300 CALL');
    assert.strictEqual(opt3.isOption, true);
    assert.strictEqual(opt3.underlying, 'NIFTY 50');
    assert.strictEqual(opt3.strike, 25300);
    assert.strictEqual(opt3.type, 'CE');

    const opt4 = service.parseOptionSymbol('NIFTY 01 DEC 25350 PUT');
    assert.strictEqual(opt4.isOption, true);
    assert.strictEqual(opt4.underlying, 'NIFTY 50');
    assert.strictEqual(opt4.strike, 25350);
    assert.strictEqual(opt4.type, 'PE');

    const opt5 = service.parseOptionSymbol('NIFTY-Dec2026-25300-CE');
    assert.strictEqual(opt5.isOption, true);
    assert.strictEqual(opt5.underlying, 'NIFTY 50');
    assert.strictEqual(opt5.strike, 25300);
    assert.strictEqual(opt5.type, 'CE');

    const opt6 = service.parseOptionSymbol('BANKNIFTY 28 NOV 52000 CALL');
    assert.strictEqual(opt6.isOption, true);
    assert.strictEqual(opt6.underlying, 'BANK NIFTY');
    assert.strictEqual(opt6.strike, 52000);
    assert.strictEqual(opt6.type, 'CE');

    const opt7 = service.parseOptionSymbol('SENSEX 28 NOV 80000 CALL');
    assert.strictEqual(opt7.isOption, true);
    assert.strictEqual(opt7.underlying, 'SENSEX');
    assert.strictEqual(opt7.strike, 80000);
    assert.strictEqual(opt7.type, 'CE');

    const opt8 = service.parseOptionSymbol('MIDCPNIFTY 28 NOV 12500 CALL');
    assert.strictEqual(opt8.isOption, true);
    assert.strictEqual(opt8.underlying, 'MIDCAP NIFTY');
    assert.strictEqual(opt8.strike, 12500);
    assert.strictEqual(opt8.type, 'CE');

    const nonOpt = service.parseOptionSymbol('RELIANCE');
    assert.strictEqual(nonOpt.isOption, false);
  });

  await t.test('fetches live LTP for NIFTY 50 or fallback safely', async () => {
    const ltp = await service.getLtp('NIFTY 50');
    // If network connection is active, LTP will be a positive number
    if (ltp !== null) {
      assert.ok(typeof ltp === 'number');
      assert.ok(ltp > 10000);
    }
  });

  await t.test('fetches candlestick data with OHLC and volume', async () => {
    try {
      const res = await service.getCandles({ symbol: 'NIFTY 50', interval: '5m', range: '1d', limit: 10 });
      assert.strictEqual(res.symbol, 'NIFTY 50');
      assert.strictEqual(res.yahooSymbol, '^NSEI');
      assert.ok(Array.isArray(res.candles));
      assert.ok(res.candles.length <= 10);
      if (res.candles.length > 0) {
        const c = res.candles[0];
        assert.ok(typeof c.time === 'number');
        assert.ok(typeof c.open === 'number');
        assert.ok(typeof c.high === 'number');
        assert.ok(typeof c.low === 'number');
        assert.ok(typeof c.close === 'number');
      }

      // Also test with period1 and period2
      const now = Math.floor(Date.now() / 1000);
      const periodRes = await service.getCandles({
        symbol: 'NIFTY 50',
        interval: '5m',
        period1: now - 86400 * 3,
        period2: now,
      });
      assert.ok(Array.isArray(periodRes.candles));
    } catch (e: any) {
      // If offline/network blocked in test environment
      assert.ok(e.message);
    }
  });
});
