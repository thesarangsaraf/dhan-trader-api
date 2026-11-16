import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsArray, IsString } from 'class-validator';

export class ScreenerScanDto {
  @ApiPropertyOptional({
    description: 'Timeframe interval for candle analysis',
    enum: ['15m', '1h', '1d', '1wk'],
    default: '15m',
  })
  @IsOptional()
  @IsIn(['15m', '1h', '1d', '1wk', '30m', '5m'], {
    message: 'Timeframe must be one of: 15m, 1h, 1d, 1wk (or 5m, 30m)',
  })
  timeframe?: string;

  @ApiPropertyOptional({
    description: 'Optional subset of ticker symbols to scan. If omitted, all enabled watchlist tickers from Firestore are scanned.',
    example: ['RELIANCE', 'TCS'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  symbols?: string[];
}
