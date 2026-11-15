import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ChartsService } from './charts.service';
import { GetCandlesDto } from './dto/get-candles.dto';
import { Public } from '../user-auth/public.decorator';

@ApiTags('Charts')
@ApiBearerAuth()
@Controller('api/charts')
export class ChartsController {
  constructor(private readonly chartsService: ChartsService) {}

  @Public()
  @Get('candles')
  @ApiOperation({ summary: 'Get historical & intraday OHLC candlestick data for given timeframe and duration' })
  @ApiResponse({ status: 200, description: 'Candlestick data with epoch timestamps and OHLCV' })
  async getCandles(@Query() query: GetCandlesDto) {
    return this.chartsService.getCandles(query);
  }
}
