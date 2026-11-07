import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';
import { CreateConditionalAlertDto } from './dto/create-conditional-alert.dto';

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

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create new price alert (No static IP needed)' })
  @ApiResponse({ status: 201, description: 'Alert created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  createAlert(@Body() dto: CreateAlertDto) {
    return this.alertsService.createAlert(dto);
  }

  @Post('conditional-order')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Place Dhan alert with conditional order (Dhan HQ v2 /alerts/orders + Local Engine)',
    description: 'Creates a price alert that automatically triggers and places one or more conditional orders on Dhan HQ when the target price condition is met.',
  })
  @ApiResponse({ status: 201, description: 'Alert with conditional order placed successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
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
  @ApiOperation({ summary: 'Cancel an active alert' })
  @ApiParam({ name: 'id', description: 'Alert ID (e.g. ALT-123456 or Dhan Trigger ID)' })
  @ApiResponse({ status: 200, description: 'Alert cancelled' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async cancelAlert(@Param('id') id: string) {
    return this.alertsService.cancelAlert(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing alert' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert updated' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  updateAlert(@Param('id') id: string, @Body() dto: UpdateAlertDto) {
    return this.alertsService.updateAlert(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Permanently delete an alert' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert deleted' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async deleteAlert(@Param('id') id: string) {
    return this.alertsService.deleteAlert(id);
  }
}
