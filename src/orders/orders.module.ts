import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { DhanOrderWebSocketService } from './dhan-order-websocket.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, DhanOrderWebSocketService],
  exports: [OrdersService, DhanOrderWebSocketService],
})
export class OrdersModule {}
