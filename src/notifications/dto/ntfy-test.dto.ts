import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class NtfyTestDto {
  @ApiPropertyOptional({
    description: 'Optional ntfy topic override for verification test',
    example: 'dhan-alerts-sarang-8821',
  })
  @IsOptional()
  @IsString()
  topic?: string;

  @ApiPropertyOptional({
    description: 'Optional custom test message text',
    example: 'Test alert notification from Dhan Trader',
  })
  @IsOptional()
  @IsString()
  message?: string;
}
