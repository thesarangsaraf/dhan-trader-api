import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiPropertyOptional({ description: 'Current password for verification (optional)' })
  @IsString()
  @IsOptional()
  currentPassword?: string;

  @ApiProperty({ description: 'New password to set', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
