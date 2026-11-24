import { Module } from '@nestjs/common';
import { ScreenerController, ChartsController } from './screener.controller';
import { ScreenerService } from './screener.service';
import { InstrumentsModule } from '../instruments/instruments.module';

@Module({
  imports: [InstrumentsModule],
  controllers: [ScreenerController, ChartsController],
  providers: [ScreenerService],
  exports: [ScreenerService],
})
export class ScreenerModule {}
