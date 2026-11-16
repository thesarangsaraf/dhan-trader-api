import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';
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

  @Get('grouped')
  @ApiOperation({ summary: 'Get live alerts categorized by instrument with count badges' })
  @ApiResponse({ status: 200, description: 'Categorized alerts group with live LTP' })
  async getGrouped() {
    await this.alertsService.syncWithDhan();
    return this.alertsService.getGroupedAlerts();
  }

  @Get('indices')
  @ApiOperation({ summary: 'Get popular NSE benchmark indices with live current prices' })
  @ApiResponse({ status: 200, description: 'Popular indices with live prices' })
  async getIndices() {
    await this.alertsService.checkAndTick();
    return this.alertsService.getIndices();
  }

  @Get('instrument-name/:securityId')
  @ApiOperation({
    summary: 'Fetch instrument display name and metadata by security ID for alerts',
    description: 'Looks up any Dhan security ID (Indices, Equities, or F&O Options) and returns the verified instrument name, symbol, and segment.',
  })
  @ApiParam({ name: 'securityId', description: 'Dhan security ID (e.g. 13 for NIFTY 50, 2885 for RELIANCE, 1100742)' })
  @ApiResponse({ status: 200, description: 'Instrument metadata with display name and symbol' })
  @ApiResponse({ status: 404, description: 'Security ID not found' })
  getInstrumentName(@Param('securityId') securityId: string) {
    const details = this.alertsService.getInstrumentDetailsBySecurityId(securityId);
    if (!details) {
      throw new NotFoundException(`Instrument with security ID ${securityId} not found`);
    }
    return details;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single alert with raw Dhan HQ API JSON by alert ID' })
  @ApiParam({ name: 'id', description: 'Alert ID (e.g. 100234 or DHAN-100234)' })
  @ApiResponse({ status: 200, description: 'Alert object with raw Dhan HQ JSON payload' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async getAlertById(@Param('id') id: string) {
    await this.alertsService.syncWithDhan();
    const alert = this.alertsService.getAlertById(id);
    if (!alert) {
      throw new NotFoundException(`Alert with ID ${id} not found`);
    }
    return alert;
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

  @Post('test-chime')
  @ApiOperation({ summary: 'Simulate an immediate alert notification trigger' })
  @ApiResponse({ status: 200, description: 'Test alert fired' })
  testChime(@Body() body: { instrument?: string }) {
    const inst = body?.instrument || 'NIFTY 50';
    const event = this.alertsService.triggerTestAlert(inst);
    return { success: true, message: 'Test chime alert triggered', event };
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

  @Put(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update an existing alert (Admin only)' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert updated' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can update alerts' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  updateAlert(@Param('id') id: string, @Body() dto: UpdateAlertDto) {
    return this.alertsService.updateAlert(id, dto);
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
