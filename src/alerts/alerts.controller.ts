import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { CreateConditionalAlertDto } from './dto/create-conditional-alert.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Alerts')
@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'List all live price alerts and Dhan conditional triggers with live LTP' })
  @ApiResponse({ status: 200, description: 'Array of live alerts' })
  async getAllAlerts() {
    await this.alertsService.syncWithDhan();
    return this.alertsService.getAllAlerts();
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create new price alert' })
  @ApiResponse({ status: 201, description: 'Alert created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can create alerts with attached orders' })
  createAlert(@Body() dto: CreateAlertDto, @Req() req?: any) {
    const hasOrder = Boolean(
      dto.conditionalOrder ||
      (dto.conditionalOrders && dto.conditionalOrders.length > 0) ||
      (dto.attachedOrder && dto.attachedOrder.enabled !== false && (dto.attachedOrder.symbol || dto.attachedOrder.transactionType || dto.attachedOrder.securityId))
    );
    if (hasOrder && req?.user) {
      const user = req.user;
      const isAdmin = (user.role || '').toLowerCase() === UserRole.ADMIN;
      if (!isAdmin) {
        throw new ForbiddenException('Only users with the admin role can place orders or create alerts with conditional orders.');
      }
    }
    return this.alertsService.createAlert(dto);
  }

  @Post('conditional-order')
  @Roles(UserRole.ADMIN)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Place Dhan alert with conditional order (Dhan HQ v2 /alerts/orders + Local Engine) (Admin only)',
    description: 'Creates a price alert that automatically triggers and places one or more conditional orders on Dhan HQ when the target price condition is met.',
  })
  @ApiResponse({ status: 201, description: 'Alert with conditional order placed successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can place conditional orders' })
  createConditionalAlert(@Body() dto: CreateConditionalAlertDto) {
    return this.alertsService.createConditionalAlert(dto);
  }

  @Post(':id/cancel')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Cancel an active alert (Admin only)' })
  @ApiParam({ name: 'id', description: 'Alert ID (e.g. ALT-123456 or Dhan Trigger ID)' })
  @ApiResponse({ status: 200, description: 'Alert cancelled' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can cancel alerts' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async cancelAlert(@Param('id') id: string) {
    return this.alertsService.cancelAlert(id);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Permanently delete an alert (Admin only)' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert deleted' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can delete alerts' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async deleteAlert(@Param('id') id: string) {
    return this.alertsService.deleteAlert(id);
  }
}
