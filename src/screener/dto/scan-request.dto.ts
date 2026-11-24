import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class ScanRequestDto {
  @ApiPropertyOptional({
    description: 'Specific symbols to scan. If omitted or empty and scope is entire, runs on full Master Instrument List.',
    example: ['NIFTY 50', 'BANK NIFTY', 'RELIANCE', 'TCS'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  symbols?: string[];

  @ApiPropertyOptional({
    description: 'Instrument scope: "indices" (4 Traded Benchmark Indices: NIFTY 50, BANK NIFTY, MIDCAP NIFTY, SENSEX) or "custom"',
    enum: ['indices', 'custom', 'all'],
    default: 'indices',
  })
  @IsOptional()
  @IsIn(['indices', 'custom', 'all'])
  scope?: 'indices' | 'custom' | 'all' = 'indices';

  @ApiPropertyOptional({
    description: 'Lookback period for Yahoo Finance 5m candles (strictly native <= 60d: 5d, 15d, 30d, 60d)',
    enum: ['5d', '15d', '30d', '60d'],
    default: '60d',
  })
  @IsOptional()
  @IsIn(['5d', '15d', '30d', '60d'])
  lookbackPeriod?: '5d' | '15d' | '30d' | '60d' = '60d';

  @ApiPropertyOptional({
    description: 'Swing low lookback bars (default: 20 candles)',
    default: 20,
    minimum: 5,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(5)
  @Max(100)
  swingLookback?: number = 20;

  @ApiPropertyOptional({
    description: 'Stop Loss buffer points (default: 3 points)',
    default: 3,
    minimum: 0.1,
    maximum: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(50)
  slBuffer?: number = 3;

  @ApiPropertyOptional({
    description: 'Target Risk-to-Reward ratio (default: 2.0 RR)',
    default: 2.0,
    minimum: 0.5,
    maximum: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(10)
  targetRr?: number = 2.0;

  @ApiPropertyOptional({
    description: 'Maximum candles to wait for retest before discarding setup (default: 15 candles)',
    default: 15,
    minimum: 3,
    maximum: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(3)
  @Max(60)
  maxRetestBars?: number = 15;
}
