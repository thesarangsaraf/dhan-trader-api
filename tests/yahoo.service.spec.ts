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

    const nonOpt = service.parseOptionSymbol('RELIANCE');
    assert.strictEqual(nonOpt.isOption, false);
  });

  await t.test('calculates realistic option LTP based on spot and strike', () => {
    // ITM Call: spot = 24600, strike = 24500 -> intrinsic = 100, plus time premium
    const itmCall = service.calculateOptionLtp(24500, 'CE', 24600);
    assert.ok(itmCall >= 100);

    // OTM Call: spot = 24400, strike = 24500 -> intrinsic = 0, time premium > 0
    const otmCall = service.calculateOptionLtp(24500, 'CE', 24400);
    assert.ok(otmCall > 0);
    assert.ok(otmCall < 150);

    // ITM Put: spot = 24400, strike = 24500 -> intrinsic = 100
    const itmPut = service.calculateOptionLtp(24500, 'PE', 24400);
    assert.ok(itmPut >= 100);
  });

  await t.test('fetches live LTP for NIFTY 50 or fallback safely', async () => {
    const ltp = await service.getLtp('NIFTY 50');
    // If network connection is active, LTP will be a positive number
    if (ltp !== null) {
      assert.ok(typeof ltp === 'number');
      assert.ok(ltp > 10000);
    }
  });
});
