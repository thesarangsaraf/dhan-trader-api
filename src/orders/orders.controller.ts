import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { GetTradeHistoryDto } from './dto/get-trade-history.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Orders', 'Trades')
@Controller('api')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
  ) {}

  @Get('orders')
  @ApiOperation({ summary: 'Get live orders book from Dhan API' })
  @ApiResponse({ status: 200, description: 'List of executed, pending and cancelled orders' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getOrders() {
    return this.ordersService.getOrders();
  }

  @Post('orders')
  @Roles(UserRole.ADMIN)
  @HttpCode(201)
  @ApiOperation({ summary: 'Place a real live order on Dhan HQ API (Admin only)' })
  @ApiResponse({ status: 201, description: 'Order placed successfully on Dhan' })
  @ApiResponse({ status: 400, description: 'Dhan rejection or validation failure' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can place orders' })
  async placeOrder(@Body() dto: PlaceOrderDto) {
    return this.ordersService.placeOrder(dto);
  }

  @Delete('orders/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Cancel an order on Dhan HQ API (Admin only)' })
  @ApiParam({ name: 'id', description: 'Dhan Order ID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 400, description: 'Cancellation failed' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can cancel orders' })
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

  @Get('funds')
  @ApiOperation({ summary: 'Get live Dhan account funds and available balance' })
  @ApiResponse({ status: 200, description: 'Account funds and available margin balance' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getFunds() {
    return this.ordersService.getFunds();
  }

  @Get('trades/history')
  @ApiOperation({ summary: 'Get historical trade book by financial year or custom dates with invested values' })
  @ApiResponse({ status: 200, description: 'Historical trades list and turnover/investment summary' })
  @ApiResponse({ status: 502, description: 'Dhan API failure' })
  async getTradeHistory(@Query() query: GetTradeHistoryDto) {
    return this.ordersService.getTradeHistory(query);
  }
}
