import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ConditionalOrderDto } from './conditional-order.dto';
import { StopLossConfigDto } from './stop-loss.dto';

export class CreateConditionalAlertDto {
  @ApiProperty({
    description: 'Underlying instrument symbol or index name to monitor',
    example: 'NIFTY 50',
  })
  @IsNotEmpty()
  @IsString()
  instrument: string;

  @ApiProperty({
    description: 'Target price level that triggers the alert and conditional order',
    example: 25500.0,
  })
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  targetPrice: number;

  @ApiPropertyOptional({
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
  })
  @IsOptional()
  @IsString()
  operator?: string;

  @ApiPropertyOptional({
    description: 'Dhan security ID of the underlying instrument',
    example: '13',
  })
  @IsOptional()
  @IsString()
  securityId?: string;

  @ApiPropertyOptional({
    description: 'Exchange segment of the underlying instrument',
    example: 'IDX_I',
    default: 'IDX_I',
  })
  @IsOptional()
  @IsString()
  exchangeSegment?: string;

  @ApiPropertyOptional({
    description: 'User remarks or strategy note',
    example: 'Buy Call option when Nifty breaks 25500 resistance',
  })
  @IsOptional()
  @IsString()
  remarks?: string;

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

  @ApiPropertyOptional({
    description: 'Attempt registration with Dhan HQ API v2 (/alerts/orders)',
    default: true,
  })
  @IsOptional()
  executeViaDhanApi?: boolean;

  @ApiPropertyOptional({
    description: 'Auto-execute the order via in-memory marketfeed engine upon trigger (No static IP required)',
    default: true,
  })
  @IsOptional()
  autoExecuteOnTrigger?: boolean;

  @ApiPropertyOptional({
    description: 'Alert frequency mode',
    enum: ['ONCE', 'IMMEDIATELY'],
    default: 'ONCE',
  })
  @IsOptional()
  @IsString()
  frequency?: string;

  @ApiPropertyOptional({
    description: 'Comparison type',
    enum: ['PRICE_WITH_VALUE', 'TECHNICAL_WITH_VALUE'],
    default: 'PRICE_WITH_VALUE',
  })
  @IsOptional()
  @IsString()
  comparisonType?: string;

  @ApiPropertyOptional({ description: 'Expiration date in YYYY-MM-DD format for Dhan conditional trigger', example: '2026-12-31' })
  @IsOptional()
  @IsString()
  expDate?: string;

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
}
