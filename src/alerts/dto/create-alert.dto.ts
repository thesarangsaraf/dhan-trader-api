import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ConditionalOrderDto } from './conditional-order.dto';
import { StopLossConfigDto } from './stop-loss.dto';

export class CreateAlertDto {
  @ApiProperty({ description: 'Instrument symbol or Index name', example: 'NIFTY 50' })
  @IsNotEmpty()
  @IsString()
  instrument: string;

  @ApiProperty({ description: 'Target price level to alert on', example: 24950.0 })
  @IsNotEmpty()
  @IsNumber()
  @IsPositive()
  targetPrice: number;

  @ApiProperty({
    description: 'Trigger condition operator',
    enum: [
      'GREATER_THAN_EQUAL',
      'LESS_THAN_EQUAL',
      'GREATER_THAN',
      'LESS_THAN',
      'CROSSING_ANY_SIDE',
      'GREATER_THAN_OR_EQUAL',
      'LESS_THAN_OR_EQUAL',
      'CROSSING_UP',
      'CROSSING_DOWN',
    ],
    default: 'GREATER_THAN_EQUAL',
    required: false,
  })
  @IsOptional()
  @IsString()
  operator?: string;

  @ApiProperty({ description: 'Remarks or user note', example: 'Breakout above resistance', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiProperty({ description: 'Dhan security ID', example: '13', required: false })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiProperty({ description: 'Exchange segment', example: 'IDX_I', required: false })
  @IsOptional()
  @IsString()
  exchangeSegment?: string;

  @ApiPropertyOptional({
    description: 'Single conditional order details to place upon trigger',
    type: () => ConditionalOrderDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConditionalOrderDto)
  conditionalOrder?: ConditionalOrderDto;

  @ApiPropertyOptional({
    description: 'Array of conditional orders to place upon trigger',
    type: () => [ConditionalOrderDto],
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConditionalOrderDto)
  conditionalOrders?: ConditionalOrderDto[];

  @ApiPropertyOptional({ description: 'Legacy attached order object' })
  @IsOptional()
  attachedOrder?: any;

  @ApiPropertyOptional({
    description: 'Automated Stop Loss configuration to place SL alert when entry order is filled',
    type: () => StopLossConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StopLossConfigDto)
  stopLoss?: StopLossConfigDto;

  @ApiPropertyOptional({ description: 'Expiration date in YYYY-MM-DD format for Dhan conditional trigger', example: '2026-12-31' })
  @IsOptional()
  @IsString()
  expDate?: string;

  @ApiPropertyOptional({
    description: 'Order authorization password required when placing alerts with attached orders',
    example: '••••',
  })
  @IsOptional()
  @IsString()
  password?: string;
}
