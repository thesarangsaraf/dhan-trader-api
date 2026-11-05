import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class PlaceOrderDto {
  @ApiProperty({ description: 'Trading symbol', example: 'NIFTY 24500 CE' })
  @IsNotEmpty()
  @IsString()
  symbol: string;

  @ApiProperty({ description: 'Dhan security ID', example: '45021' })
  @IsNotEmpty()
  @IsString()
  securityId: string;

  @ApiProperty({ description: 'Exchange segment', example: 'NSE_FNO', default: 'NSE_FNO', required: false })
  @IsOptional()
  @IsString()
  exchangeSegment?: string;

  @ApiProperty({ description: 'BUY or SELL', enum: ['BUY', 'SELL'], example: 'BUY' })
  @IsNotEmpty()
  @IsString()
  transactionType: string;

  @ApiProperty({ description: 'Order type', enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'], default: 'MARKET', required: false })
  @IsOptional()
  @IsString()
  orderType?: string;

  @ApiProperty({ description: 'Product type', enum: ['INTRADAY', 'CNC', 'MARGIN'], default: 'INTRADAY', required: false })
  @IsOptional()
  @IsString()
  productType?: string;

  @ApiProperty({ description: 'Order quantity', example: 50 })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  quantity: number;

  @ApiProperty({ description: 'Price for LIMIT orders', example: 130.0, required: false })
  @IsOptional()
  @IsNumber()
  price?: number;

  @ApiProperty({ description: 'Trigger price for SL orders', example: 0, required: false })
  @IsOptional()
  @IsNumber()
  triggerPrice?: number;
}
