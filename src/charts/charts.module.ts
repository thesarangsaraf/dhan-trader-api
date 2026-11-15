import { Module } from '@nestjs/common';
import { YahooModule } from '../yahoo/yahoo.module';
import { ChartsController } from './charts.controller';
import { ChartsService } from './charts.service';

@Module({
  imports: [YahooModule],
  controllers: [ChartsController],
  providers: [ChartsService],
  exports: [ChartsService],
})
export class ChartsModule {}
