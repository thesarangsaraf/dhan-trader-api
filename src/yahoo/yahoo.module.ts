import { Global, Module } from '@nestjs/common';
import { YahooFinanceService } from './yahoo.service';

@Global()
@Module({
  providers: [YahooFinanceService],
  exports: [YahooFinanceService],
})
export class YahooModule {}
