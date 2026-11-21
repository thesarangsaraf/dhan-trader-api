import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { NtfyService } from './ntfy.service';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [TelegramModule],
  controllers: [NotificationsController],
  providers: [NtfyService, NotificationsService],
  exports: [NtfyService, NotificationsService],
})
export class NotificationsModule {}
