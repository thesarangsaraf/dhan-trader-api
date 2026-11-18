import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateLotSizesDto {
  @ApiPropertyOptional({ description: 'NIFTY 50 preferred order lots', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  nifty50Lots?: number;

  @ApiPropertyOptional({ description: 'BANK NIFTY preferred order lots', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  bankNiftyLots?: number;

  @ApiPropertyOptional({ description: 'MIDCAP NIFTY preferred order lots', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  midcapNiftyLots?: number;

  @ApiPropertyOptional({ description: 'SENSEX preferred order lots', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  sensexLots?: number;

  @ApiPropertyOptional({ description: 'Array of configurable tradeable instruments (NSE-fixed lotSize is preserved from master data)' })
  @IsOptional()
  @IsArray()
  instruments?: any[];

  @ApiPropertyOptional({ description: 'Legacy alias for instruments array' })
  @IsOptional()
  @IsArray()
  indices?: any[];
}

export class UpdateTradedInstrumentsDto extends UpdateLotSizesDto {}

