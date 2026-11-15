import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Persistent long-lived refresh token stored on client', example: 'a1b2c3d4...' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
