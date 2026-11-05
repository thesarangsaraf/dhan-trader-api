import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { AutoSlDto } from './dto/auto-sl.dto';

@ApiTags('Orders')
@Controller('api')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

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

  @Get('holdings')
  @ApiOperation({ summary: 'Get Demat equity holdings from Dhan API' })
  @ApiResponse({ status: 200, description: 'Demat holdings array' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getHoldings() {
    return this.ordersService.getHoldings();
  }

  @Post('strategy/auto-sl')
  @HttpCode(200)
  @ApiOperation({ summary: 'Execute real Nifty Auto-SL (-7 pts) and Target (+30 pts) Bracket Runner on Dhan' })
  @ApiResponse({ status: 200, description: 'Bracket orders deployed with execution logs' })
  @ApiResponse({ status: 400, description: 'Strategy execution failure on Dhan' })
  async executeAutoSl(@Body() dto: AutoSlDto) {
    return this.ordersService.executeAutoSLTarget(dto);
  }

  @Get('strategy/auto-sl/logs')
  @ApiOperation({ summary: 'Get Auto-SL bracket execution logs' })
  @ApiResponse({ status: 200, description: 'Array of past strategy execution runs' })
  getAutoSlLogs() {
    return this.ordersService.getAutoSlLogs();
  }
}
