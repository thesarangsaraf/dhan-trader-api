import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryOptionsDto {
  @ApiPropertyOptional({
    description: 'Filter by traded index (NIFTY, BANKNIFTY, MIDCPNIFTY, SENSEX)',
    example: 'NIFTY',
  })
  @IsOptional()
  @IsString()
  index?: string;

  @ApiPropertyOptional({
    description: 'Filter by contract expiry date in YYYY-MM-DD format (e.g. 2026-11-09)',
    example: '2026-11-09',
  })
  @IsOptional()
  @IsString()
  expiry?: string;

  @ApiPropertyOptional({
    description: 'Filter by exact strike price (e.g. 24000)',
    example: 24000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  strike?: number;

  @ApiPropertyOptional({
    description: 'Filter by option type: CE (Call) or PE (Put)',
    example: 'CE',
  })
  @IsOptional()
  @IsString()
  optionType?: string;

  @ApiPropertyOptional({
    description: 'Free-text search keyword on customSymbol or symbol (e.g. 24000 CALL)',
    example: '24000 CALL',
  })
  @IsOptional()
  @IsString()
  q?: string;

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
