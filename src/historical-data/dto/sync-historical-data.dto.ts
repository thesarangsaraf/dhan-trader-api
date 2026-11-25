import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class SyncHistoricalDataDto {
  @ApiPropertyOptional({
    description:
      'When false (default), runs a cost-optimized incremental sync fetching only missing or latest month CSVs. When true, rebuilds all months from the full GitHub repository.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean = false;
}

export class GetHistoricalCandlesQueryDto {
  @ApiPropertyOptional({
    description: 'Start month inclusive in YYYY-MM format (e.g. 2026-09)',
    example: '2026-09',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'fromMonth must be in YYYY-MM format' })
  fromMonth?: string;

  @ApiPropertyOptional({
    description: 'End month inclusive in YYYY-MM format (e.g. 2026-11)',
    example: '2026-11',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'toMonth must be in YYYY-MM format' })
  toMonth?: string;

  @ApiPropertyOptional({
    description: 'Start Unix epoch in seconds (inclusive)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromEpoch?: number;

  @ApiPropertyOptional({
    description: 'End Unix epoch in seconds (inclusive)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  toEpoch?: number;

  @ApiPropertyOptional({
    description: 'Maximum number of candles to return (returns most recent candles up to limit)',
    default: 500,
    minimum: 1,
    maximum: 20000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20000)
  limit?: number;
}
