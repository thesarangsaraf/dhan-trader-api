import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { InstrumentsModule } from '../instruments/instruments.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [AlertsModule, InstrumentsModule, TelegramModule, NotificationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
