import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class GetTradeHistoryDto {
  @ApiPropertyOptional({
    description: 'Financial year (e.g. "2026-2027", "2025-2026", "2024-2025")',
    example: '2026-2027',
  })
  @IsOptional()
  @IsString()
  financialYear?: string;

  @ApiPropertyOptional({
    description: 'Custom Start Date in YYYY-MM-DD format (overrides financialYear start)',
    example: '2026-04-01',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be in YYYY-MM-DD format' })
  fromDate?: string;

  @ApiPropertyOptional({
    description: 'Custom End Date in YYYY-MM-DD format (overrides financialYear end)',
    example: '2026-11-07',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be in YYYY-MM-DD format' })
  toDate?: string;

  @ApiPropertyOptional({
    description: 'Page number for Dhan pagination (starts at 0)',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number;

  @ApiPropertyOptional({
    description: 'Whether to auto-fetch multiple pages for the period (defaults to true if page is not specified)',
    default: true,
    example: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  fetchAll?: boolean;
}
