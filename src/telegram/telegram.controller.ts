import { Body, Controller, Get, Post, Optional } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TelegramService } from './telegram.service';
import { ConfigService } from '../config/config.service';
import { FirestoreService } from '../firestore/firestore.service';
import { UpdateTelegramDto } from './dto/update-telegram.dto';

@ApiTags('Telegram')
@Controller('api/telegram')
export class TelegramController {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
    @Optional() private readonly firestoreService?: FirestoreService,
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
  @ApiOperation({ summary: 'Update Telegram credentials dynamically and save to Firestore' })
  @ApiResponse({ status: 200, description: 'Credentials updated' })
  async updateCredentials(@Body() dto: UpdateTelegramDto) {
    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      await this.firestoreService.saveTelegramConfig({
        botToken: dto.botToken,
        chatId: dto.chatId,
      });
    } else {
      this.config.updateCredentials({
        telegramBotToken: dto.botToken,
        telegramChatId: dto.chatId,
      });
    }

    return {
      success: true,
      message: 'Telegram credentials updated and saved to Firestore database',
      status: this.telegramService.getStatus(),
    };
  }
}
