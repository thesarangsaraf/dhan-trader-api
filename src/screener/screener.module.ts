import { Module } from '@nestjs/common';
import { ScreenerController } from './screener.controller';
import { ScreenerService } from './screener.service';
import { FirestoreModule } from '../firestore/firestore.module';
import { YahooModule } from '../yahoo/yahoo.module';

@Module({
  imports: [FirestoreModule, YahooModule],
  controllers: [ScreenerController],
  providers: [ScreenerService],
  exports: [ScreenerService],
})
export class ScreenerModule {}
