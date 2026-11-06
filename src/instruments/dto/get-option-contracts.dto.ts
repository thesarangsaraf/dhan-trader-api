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
    description: 'Reference price to calculate ATM, ITM, and OTM strikes (e.g. 25500). If omitted, live LTP is used.',
    example: 25500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price?: number;

  @ApiPropertyOptional({
    description: 'Target expiry date in YYYY-MM-DD or DD-MM-YYYY format (e.g. 2026-11-05). If omitted, nearest expiry is used.',
    example: '2026-11-05',
  })
  @IsOptional()
  @IsString()
  expiry?: string;
}
