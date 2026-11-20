import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ScreenerScanMode, ScreenerStrategyType } from '../models/screener.models';

export class ScreenerScanDto {
  @ApiPropertyOptional({
    description: 'Scan mode: live or historical',
    enum: ['live', 'historical'],
    default: 'live',
  })
  @IsOptional()
  @IsIn(['live', 'historical'], {
    message: 'Mode must be either "live" or "historical"',
  })
  mode?: ScreenerScanMode;

  @ApiPropertyOptional({
    description: 'Strategy: "liquidity-sweep" / "LIQUIDITY_SWEEP" (default) or "order-block" / "ORDER_BLOCK"',
    enum: ['liquidity-sweep', 'LIQUIDITY_SWEEP', 'order-block', 'ORDER_BLOCK'],
    default: 'liquidity-sweep',
  })
  @IsOptional()
  @IsIn(['liquidity-sweep', 'LIQUIDITY_SWEEP', 'order-block', 'ORDER_BLOCK'], {
    message: 'Strategy must be either "liquidity-sweep" or "order-block"',
  })
  strategy?: ScreenerStrategyType;

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

  @ApiPropertyOptional({
    description: 'Higher Timeframe for Order Block scanning ("1h" or "4h")',
    enum: ['1h', '4h'],
    default: '1h',
  })
  @IsOptional()
  @IsIn(['1h', '4h'])
  htfTimeframe?: '1h' | '4h';

  @ApiPropertyOptional({
    description: 'Lower Timeframe for Confirmation Sniper setup ("5m" or "15m")',
    enum: ['5m', '15m'],
    default: '5m',
  })
  @IsOptional()
  @IsIn(['5m', '15m'])
  ltfTimeframe?: '5m' | '15m';

  @ApiPropertyOptional({
    description: 'Swing lookback bars left/right (default 5)',
    example: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(20)
  swingLookback?: number;

  @ApiPropertyOptional({
    description: 'Require Fair Value Gap (FVG) for valid OB (default true)',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  requireFVG?: boolean;

  @ApiPropertyOptional({
    description: 'Minimum Risk-to-Reward ratio (default 2.5)',
    example: 2.5,
  })
  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @Max(20.0)
  minRR?: number;

  @ApiPropertyOptional({
    description: 'Entry mode: "LIMIT_TAP", "LTF_CHOCH", "RECLAIM_CLOSE", or "LTF_STRUCTURE_SHIFT"',
    enum: ['LIMIT_TAP', 'LTF_CHOCH', 'RECLAIM_CLOSE', 'LTF_STRUCTURE_SHIFT'],
    default: 'RECLAIM_CLOSE',
  })
  @IsOptional()
  @IsIn(['LIMIT_TAP', 'LTF_CHOCH', 'RECLAIM_CLOSE', 'LTF_STRUCTURE_SHIFT'])
  entryMode?: any;

  @ApiPropertyOptional({
    description: 'Timeframe for Liquidity Sweep scanning ("5m", "15m", "1h", "4h")',
    enum: ['5m', '15m', '1h', '4h'],
    default: '15m',
  })
  @IsOptional()
  @IsIn(['5m', '15m', '1h', '4h'])
  timeframe?: '5m' | '15m' | '1h' | '4h';

  @ApiPropertyOptional({
    description: 'Equal Highs / Equal Lows ATR tolerance factor (default 0.15)',
    example: 0.15,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1.0)
  eqToleranceATR?: number;

  @ApiPropertyOptional({
    description: 'Minimum wick sweep depth beyond pool price as ATR factor (default 0.05)',
    example: 0.05,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.0)
  @Max(2.0)
  minSweepDepthATR?: number;

  @ApiPropertyOptional({
    description: 'Maximum candles allowed to reclaim after piercing pool (default 2)',
    example: 2,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxReclaimBars?: number;

  @ApiPropertyOptional({
    description: 'Include Previous Day High/Low (PDH/PDL) as liquidity pools (default true)',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  includeSessionExtremes?: boolean;

  @ApiPropertyOptional({
    description: 'Proximity threshold percent for HTF POI approaching alert (default 0.005 / 0.5%)',
    example: 0.005,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.0005)
  @Max(0.05)
  proximityPercent?: number;
}
