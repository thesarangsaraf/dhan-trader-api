import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class StopLossConfigDto {
  @ApiProperty({
    description: 'Enable automatic Stop Loss placement upon entry order trigger',
    default: true,
    example: true,
  })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    description: 'Stop loss distance in underlying index points (e.g. 12 for Nifty 50, 20 for Bank Nifty)',
    example: 12,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  points?: number;

  @ApiPropertyOptional({
    description: 'Exact calculated Stop Loss trigger price level',
    example: 25005.0,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  targetPrice?: number;

  @ApiPropertyOptional({
    description: 'Trigger condition operator for the stop loss alert',
    example: 'LESS_THAN',
  })
  @IsOptional()
  @IsString()
  operator?: string;

  @ApiPropertyOptional({
    description: 'Transaction action for the stop loss order (e.g. SELL to square off bought contracts)',
    example: 'SELL',
  })
  @IsOptional()
  @IsString()
  action?: string;
}
