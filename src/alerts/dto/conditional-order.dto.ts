import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class ConditionalOrderDto {
  @ApiProperty({
    description: 'Trading symbol to order upon alert trigger',
    example: 'NIFTY 25500 CE',
  })
  @IsNotEmpty()
  @IsString()
  symbol: string;

  @ApiPropertyOptional({
    description: 'Dhan security ID (e.g. 45021). If omitted, system attempts resolution from symbol.',
    example: '45021',
  })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiPropertyOptional({
    description: 'Exchange segment',
    example: 'NSE_FNO',
    default: 'NSE_FNO',
  })
  @IsOptional()
  @IsString()
  exchangeSegment?: string;

  @ApiProperty({
    description: 'Order transaction side',
    enum: ['BUY', 'SELL'],
    example: 'BUY',
  })
  @IsNotEmpty()
  @IsString()
  transactionType: string;

  @ApiPropertyOptional({
    description: 'Order type',
    enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
    default: 'MARKET',
  })
  @IsOptional()
  @IsString()
  orderType?: string;

  @ApiPropertyOptional({
    description: 'Product type',
    enum: ['INTRADAY', 'CNC', 'MARGIN'],
    default: 'INTRADAY',
  })
  @IsOptional()
  @IsString()
  productType?: string;

  @ApiProperty({
    description: 'Order quantity',
    example: 50,
  })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  quantity: number;

  @ApiPropertyOptional({
    description: 'Number of lots (optional; if provided, quantity is automatically computed)',
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lots?: number;

  @ApiPropertyOptional({
    description: 'Limit price for LIMIT orders',
    example: 130.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;

  @ApiPropertyOptional({
    description: 'Trigger price for SL orders',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  triggerPrice?: number;

  @ApiPropertyOptional({
    description: 'Order validity',
    enum: ['DAY', 'IOC'],
    default: 'DAY',
  })
  @IsOptional()
  @IsString()
  validity?: string;
}
