import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class UpdateTradeSecurityDto {
  @ApiProperty({
    description: 'New trade / order authorization password to store in Firestore config/security',
    example: '••••',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(4)
  password: string;
}
