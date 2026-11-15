import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetCandlesDto {
  @ApiPropertyOptional({
    description: 'Instrument name or symbol (e.g. NIFTY 50, BANK NIFTY, SENSEX, RELIANCE)',
    default: 'NIFTY 50',
  })
  symbol?: string;

  @ApiPropertyOptional({
    description: 'Candle timeframe interval (1m, 2m, 5m, 15m, 30m, 60m, 1h, 1d, 1wk, 1mo)',
    default: '5m',
  })
  interval?: string;

  @ApiPropertyOptional({
    description: 'Time duration range (1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max)',
    default: '1d',
  })
  range?: string;

  @ApiPropertyOptional({
    description: 'Starting UNIX epoch timestamp in seconds for historical window query',
    example: 1792999800,
  })
  period1?: number;

  @ApiPropertyOptional({
    description: 'Ending UNIX epoch timestamp in seconds for historical window query',
    example: 1794564000,
  })
  period2?: number;

  @ApiPropertyOptional({
    description: 'Optional maximum number of most recent candles to return',
    example: 10,
  })
  limit?: number;
}
