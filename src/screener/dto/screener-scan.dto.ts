import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ScreenerScanMode } from '../models/screener.models';

export class ScreenerScanDto {
  @ApiPropertyOptional({
    description: 'Scan mode: live (latest 2-3 closed 5m candles) or historical (full session backtest for selected date/range)',
    enum: ['live', 'historical'],
    default: 'live',
  })
  @IsOptional()
  @IsIn(['live', 'historical'], {
    message: 'Mode must be either "live" or "historical"',
  })
  mode?: ScreenerScanMode;

  @ApiPropertyOptional({
    description: 'Single trading date (YYYY-MM-DD) for historical mode. Shorthand for startDate=endDate=date.',
    example: '2026-11-17',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date?: string;

  @ApiPropertyOptional({
    description: 'Start date (YYYY-MM-DD) for historical date range scan.',
    example: '2026-11-14',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be in YYYY-MM-DD format',
  })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date (YYYY-MM-DD) for historical date range scan.',
    example: '2026-11-17',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be in YYYY-MM-DD format',
  })
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Optional subset of configured indices from config/lot_sizes to scan.',
    example: ['NIFTY 50', 'BANK NIFTY'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  symbols?: string[];
}
