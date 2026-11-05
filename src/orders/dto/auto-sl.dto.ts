import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class AutoSlDto {
  @ApiProperty({ description: 'Option contract symbol', example: 'NIFTY 24600 CE' })
  @IsNotEmpty()
  @IsString()
  symbol: string;

  @ApiProperty({ description: 'Long entry price', example: 140.0 })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  entryPrice: number;

  @ApiProperty({ description: 'Contract quantity', example: 50 })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  quantity: number;

  @ApiProperty({ description: 'Strike price if symbol not provided', example: 24600, required: false })
  @IsOptional()
  @IsNumber()
  strike?: number;

  @ApiProperty({ description: 'Dhan security ID', example: '45021', required: false })
  @IsOptional()
  @IsString()
  securityId?: string;
}
