import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Authentication username', example: 'sarang' })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ description: 'User authentication password', example: '••••••••' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
