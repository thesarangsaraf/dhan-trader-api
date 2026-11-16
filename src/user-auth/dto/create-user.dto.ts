import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export enum UserRole {
  ADMIN = 'admin',
  TRADER = 'trader',
  VIEWER = 'viewer',
}

export class CreateUserDto {
  @ApiProperty({ description: 'Unique username for authentication', example: 'john_trader' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message: 'Username can only contain alphanumeric characters, underscores, hyphens, and dots',
  })
  username: string;

  @ApiProperty({ description: 'Initial password for the user (min 6 chars)', example: '••••••••' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({ description: 'User authorization role', enum: UserRole, default: UserRole.TRADER })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole = UserRole.TRADER;
}
