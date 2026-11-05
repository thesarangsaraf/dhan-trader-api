import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class GetOptionContractsDto {
  @ApiProperty({
    description: 'Underlying instrument name or symbol (e.g. NIFTY 50, NIFTY, BANKNIFTY, SENSEX)',
    example: 'NIFTY 50',
  })
  @IsNotEmpty()
  @IsString()
  instrument: string;

  @ApiPropertyOptional({
    description: 'Reference price to calculate ATM and surrounding strikes (e.g. 25500). If omitted, live LTP is used.',
    example: 25500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price?: number;

  @ApiPropertyOptional({
    description: 'Number of strikes to return centered around ATM (default is 3, e.g. ATM-1, ATM, ATM+1)',
    example: 3,
    default: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  strikeCount?: number;

  @ApiPropertyOptional({
    description: 'Custom strike step interval (e.g. 50 for Nifty, 100 for BankNifty). If omitted, determined automatically.',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  strikeStep?: number;

  @ApiPropertyOptional({
    description: 'Optional specific target expiry date in YYYY-MM-DD format',
    example: '2026-11-05',
  })
  @IsOptional()
  @IsString()
  expiry?: string;
}
