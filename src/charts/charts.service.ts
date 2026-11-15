import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { YahooFinanceService, ChartCandlesResponse } from '../yahoo/yahoo.service';
import { GetCandlesDto } from './dto/get-candles.dto';

@Injectable()
export class ChartsService {
  private readonly logger = new Logger(ChartsService.name);

  constructor(private readonly yahooService: YahooFinanceService) {}

  async getCandles(query: GetCandlesDto): Promise<ChartCandlesResponse> {
    try {
      const limit = query.limit ? parseInt(String(query.limit), 10) : undefined;
      const period1 = query.period1 ? parseInt(String(query.period1), 10) : undefined;
      const period2 = query.period2 ? parseInt(String(query.period2), 10) : undefined;
      return await this.yahooService.getCandles({
        symbol: query.symbol,
        interval: query.interval,
        range: query.range,
        period1: isNaN(period1!) ? undefined : period1,
        period2: isNaN(period2!) ? undefined : period2,
        limit: isNaN(limit!) ? undefined : limit,
      });
    } catch (err: any) {
      this.logger.error(`Failed to fetch candles for ${query.symbol || 'NIFTY 50'}: ${err.message}`);
      throw new HttpException(
        err.message || 'Failed to fetch candlestick data',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
