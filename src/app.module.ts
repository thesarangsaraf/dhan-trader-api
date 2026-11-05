import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule } from './config/config.module';
import { DhanModule } from './dhan/dhan.module';
import { TelegramModule } from './telegram/telegram.module';
import { AuthModule } from './auth/auth.module';
import { AlertsModule } from './alerts/alerts.module';
import { OrdersModule } from './orders/orders.module';
import { InstrumentsModule } from './instruments/instruments.module';

@Module({
  imports: [
    ConfigModule,
    DhanModule,
    TelegramModule,
    AuthModule,
    AlertsModule,
    OrdersModule,
    InstrumentsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
