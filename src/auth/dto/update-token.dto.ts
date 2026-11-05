import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateTokenDto {
  @ApiProperty({ description: 'Dhan JWT Access Token', example: 'eyJhbGciOiJIUzUxMiJ9...' })
  @IsNotEmpty()
  @IsString()
  token: string;

  @ApiProperty({ description: 'Dhan Client ID', example: '1106885516', required: false })
  @IsOptional()
  @IsString()
  clientId?: string;
}
