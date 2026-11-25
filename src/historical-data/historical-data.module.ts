import { Module } from '@nestjs/common';
import { HistoricalDataController } from './historical-data.controller';
import { HistoricalDataService } from './historical-data.service';

@Module({
  controllers: [HistoricalDataController],
  providers: [HistoricalDataService],
  exports: [HistoricalDataService],
})
export class HistoricalDataModule {}
