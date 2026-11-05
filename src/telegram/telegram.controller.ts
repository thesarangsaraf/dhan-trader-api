import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TelegramService } from './telegram.service';
import { ConfigService } from '../config/config.service';
import { UpdateTelegramDto } from './dto/update-telegram.dto';

@ApiTags('Telegram')
@Controller('api/telegram')
export class TelegramController {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get Telegram bot connection state' })
  @ApiResponse({ status: 200, description: 'Telegram connection status' })
  getStatus() {
    return this.telegramService.getStatus();
  }

  @Post('test')
  @ApiOperation({ summary: 'Send test verification message to configured Telegram chat' })
  @ApiResponse({ status: 200, description: 'Dispatch result' })
  async sendTest() {
    return this.telegramService.sendTestNotification();
  }

  @Post('update')
  @ApiOperation({ summary: 'Update Telegram credentials dynamically and save to .env' })
  @ApiResponse({ status: 200, description: 'Credentials updated' })
  updateCredentials(@Body() dto: UpdateTelegramDto) {
    this.config.updateCredentials({
      telegramBotToken: dto.botToken,
      telegramChatId: dto.chatId,
    });
    return {
      success: true,
      message: 'Telegram credentials updated and saved to .env',
      status: this.telegramService.getStatus(),
    };
  }
}
