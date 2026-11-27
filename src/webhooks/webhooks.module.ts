import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { InstrumentsModule } from '../instruments/instruments.module';
import { TelegramModule } from '../telegram/telegram.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookBodyParserMiddleware } from './webhook-body-parser.middleware';

@Module({
  imports: [AlertsModule, InstrumentsModule, TelegramModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WebhookBodyParserMiddleware).forRoutes(WebhooksController);
  }
}
