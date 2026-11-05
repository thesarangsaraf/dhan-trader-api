import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class UpdateAlertDto {
  @ApiProperty({ description: 'Target price level', example: 25000.0, required: false })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  targetPrice?: number;

  @ApiProperty({ description: 'Trigger condition operator', example: 'GREATER_THAN_OR_EQUAL', required: false })
  @IsOptional()
  @IsString()
  operator?: string;

  @ApiProperty({ description: 'Remarks', example: 'Updated level', required: false })
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiProperty({ description: 'Alert status', enum: ['ACTIVE', 'TRIGGERED', 'CANCELLED'], required: false })
  @IsOptional()
  @IsString()
  status?: string;
}
