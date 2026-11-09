import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyOrderPasswordDto {
  @ApiProperty({
    description: 'Order authorization password to verify against Firestore config/security',
    example: '••••',
  })
  @IsNotEmpty()
  @IsString()
  password: string;
}
