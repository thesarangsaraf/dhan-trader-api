import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateLotSizesDto {
  @ApiPropertyOptional({ description: 'NIFTY 50 units per lot (contract multiplier)', example: 65 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  nifty50?: number;

  @ApiPropertyOptional({ description: 'BANK NIFTY units per lot', example: 30 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  bankNifty?: number;

  @ApiPropertyOptional({ description: 'FINNIFTY units per lot', example: 65 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  finNifty?: number;

  @ApiPropertyOptional({ description: 'MIDCAP NIFTY units per lot', example: 120 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  midcapNifty?: number;

  @ApiPropertyOptional({ description: 'SENSEX units per lot', example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  sensex?: number;

  @ApiPropertyOptional({ description: 'NIFTY 50 order lots input', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  nifty50Lots?: number;

  @ApiPropertyOptional({ description: 'BANK NIFTY order lots input', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  bankNiftyLots?: number;

  @ApiPropertyOptional({ description: 'FINNIFTY order lots input', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  finNiftyLots?: number;

  @ApiPropertyOptional({ description: 'MIDCAP NIFTY order lots input', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  midcapNiftyLots?: number;

  @ApiPropertyOptional({ description: 'SENSEX order lots input', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  sensexLots?: number;

  @ApiPropertyOptional({ description: 'Array of configurable tradeable indices' })
  @IsOptional()
  @IsArray()
  indices?: any[];
}

