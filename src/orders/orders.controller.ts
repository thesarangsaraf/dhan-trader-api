import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { DhanOrderWebSocketService } from './dhan-order-websocket.service';
import { PlaceOrderDto } from './dto/place-order.dto';

@ApiTags('Orders')
@Controller('api')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderWsService: DhanOrderWebSocketService,
  ) {}

  @Get('orders')
  @ApiOperation({ summary: 'Get live orders book from Dhan API' })
  @ApiResponse({ status: 200, description: 'List of executed, pending and cancelled orders' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getOrders() {
    return this.ordersService.getOrders();
  }

  @Post('orders')
  @HttpCode(201)
  @ApiOperation({ summary: 'Place a real live order on Dhan HQ API' })
  @ApiResponse({ status: 201, description: 'Order placed successfully on Dhan' })
  @ApiResponse({ status: 400, description: 'Dhan rejection or validation failure' })
  async placeOrder(@Body() dto: PlaceOrderDto) {
    return this.ordersService.placeOrder(dto);
  }

  @Delete('orders/:id')
  @ApiOperation({ summary: 'Cancel an order on Dhan HQ API' })
  @ApiParam({ name: 'id', description: 'Dhan Order ID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 400, description: 'Cancellation failed' })
  async cancelOrder(@Param('id') id: string) {
    return this.ordersService.cancelOrder(id);
  }

  @Get('positions')
  @ApiOperation({ summary: 'Get live open/closed positions and account funds from Dhan API' })
  @ApiResponse({ status: 200, description: 'Positions array, margin funds, and P&L summary' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getPositions() {
    return this.ordersService.getPositions();
  }

  @Get('orders/websocket/status')
  @ApiOperation({ summary: 'Get Dhan Order WebSocket live stream status' })
  @ApiResponse({ status: 200, description: 'Live connection state, client ID and last event timestamp' })
  getWebSocketStatus() {
    return this.orderWsService.getStatus();
  }

  @Post('orders/websocket/simulate')
  @ApiOperation({ summary: 'Simulate an incoming order push from Dhan WebSocket and notify Telegram' })
  @ApiResponse({ status: 200, description: 'Simulated order dispatched' })
  async simulateOrderWebSocket(@Body() sampleOrder?: any) {
    return this.orderWsService.simulateOrderEvent(sampleOrder);
  }
}
