import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ScreenerService } from './screener.service';
import { ScanRequestDto } from './dto/scan-request.dto';

@ApiTags('Screener')
@Controller('api/screener')
export class ScreenerController {
  constructor(private readonly screenerService: ScreenerService) {}

  @Get('instruments')
  @ApiOperation({
    summary: 'Get master instruments available for 5m scanning with Yahoo tickers',
    description: 'Retrieves configured tradeable indices and cash equities mapped to Yahoo Finance tickers.',
  })
  @ApiResponse({ status: 200, description: 'Available instruments for screener' })
  async getInstruments() {
    const data = await this.screenerService.getAvailableInstruments();
    return {
      success: true,
      count: data.length,
      data,
    };
  }

  @Post('scan')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run 5-minute trade screener & backtest on selected or entire Master Instrument List',
    description:
      'Fetches 5m historical OHLCV data from Yahoo Finance within native 60d limit, scans for Liquidity Sweep -> Consolidation Base -> Bullish Impulse Break -> Retest long setups, and calculates backtest metrics.',
  })
  @ApiResponse({ status: 200, description: 'Screener scan results with detected signals and backtest summary' })
  async runScan(@Body() dto: ScanRequestDto) {
    return this.screenerService.runScan(dto);
  }
}

@ApiTags('Charts')
@Controller('api/charts')
export class ChartsController {
  constructor(private readonly screenerService: ScreenerService) {}

  @Get('candles')
  @ApiOperation({
    summary: 'Get historical & intraday OHLC candle data for an instrument (5m Yahoo Finance native)',
  })
  @ApiQuery({ name: 'symbol', required: true, description: 'Symbol or Ticker (e.g. NIFTY 50, RELIANCE)' })
  @ApiQuery({ name: 'range', required: false, description: 'Lookback range (5d, 15d, 30d, 60d)' })
  @ApiResponse({ status: 200, description: 'Candlestick OHLCV data' })
  async getCandles(
    @Query('symbol') symbol: string,
    @Query('range') range?: '5d' | '15d' | '30d' | '60d',
  ) {
    return this.screenerService.get5mCandles(symbol, range || '60d');
  }
}
