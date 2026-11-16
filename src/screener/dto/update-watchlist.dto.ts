import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ValidateNested, IsString, IsNotEmpty, IsBoolean, IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class WatchlistStockItemDto {
  @ApiProperty({ description: 'NSE Trading Symbol (without .NS)', example: 'RELIANCE' })
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @ApiProperty({ description: 'Human-readable company name', example: 'Reliance Industries Ltd' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Industry or sector', required: false, example: 'Energy' })
  @IsOptional()
  @IsString()
  sector?: string;

  @ApiProperty({ description: 'Whether active during screener scan', example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ description: 'Display order', required: false, example: 1 })
  @IsOptional()
  @IsNumber()
  order?: number;
}

export class UpdateWatchlistDto {
  @ApiProperty({ description: 'List of watchlist stocks', type: [WatchlistStockItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WatchlistStockItemDto)
  symbols: WatchlistStockItemDto[];
}
