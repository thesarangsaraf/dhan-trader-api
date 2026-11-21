import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({
    description: 'Toggle to enable or disable Telegram order postback notifications',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  telegramEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Toggle to enable or disable ntfy.sh Android push notifications',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  ntfyEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'ntfy.sh topic name to publish notifications to (e.g. dhan-alerts-sarang-8821)',
    example: 'dhan-alerts-sarang-8821',
  })
  @IsOptional()
  @IsString()
  ntfyTopic?: string;

  @ApiPropertyOptional({
    description: 'ntfy server base URL (default: https://ntfy.sh)',
    example: 'https://ntfy.sh',
  })
  @IsOptional()
  @IsString()
  ntfyServerUrl?: string;
}
