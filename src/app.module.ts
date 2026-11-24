import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { ConfigModule } from './config/config.module';
import { DhanModule } from './dhan/dhan.module';
import { YahooModule } from './yahoo/yahoo.module';
import { TelegramModule } from './telegram/telegram.module';
import { AuthModule } from './auth/auth.module';
import { AlertsModule } from './alerts/alerts.module';
import { OrdersModule } from './orders/orders.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { FirestoreModule } from './firestore/firestore.module';
import { UserAuthModule } from './user-auth/user-auth.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ScreenerModule } from './screener/screener.module';
import { UserAuthGuard } from './user-auth/user-auth.guard';
import { RolesGuard } from './user-auth/roles.guard';

@Module({
  imports: [
    ConfigModule,
    FirestoreModule,
    DhanModule,
    YahooModule,
    TelegramModule,
    AuthModule,
    AlertsModule,
    OrdersModule,
    InstrumentsModule,
    UserAuthModule,
    WebhooksModule,
    ScreenerModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
