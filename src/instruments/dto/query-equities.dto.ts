import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryEquitiesDto {
  @ApiPropertyOptional({
    description: 'Search keyword for symbol or company name (e.g. RELIANCE, TCS, INFY, NIFTY)',
    example: 'RELIANCE',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by exchange segment (NSE_EQ or IDX_I)',
    example: 'NSE_EQ',
  })
  @IsOptional()
  @IsString()
  segment?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of items to return (default: 50, max: 200)',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Offset for pagination (default: 0)',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;
}
