import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateTelegramDto {
  @ApiProperty({ description: 'Telegram Bot Token', example: '123456789:ABCDefgh...', required: false })
  @IsOptional()
  @IsString()
  botToken?: string;

  @ApiProperty({ description: 'Telegram Chat ID', example: '8953936469', required: false })
  @IsOptional()
  @IsString()
  chatId?: string;
}
