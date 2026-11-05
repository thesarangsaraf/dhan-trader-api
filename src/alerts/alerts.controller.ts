import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';

@ApiTags('Alerts')
@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'List all price alerts with live current LTP' })
  @ApiResponse({ status: 200, description: 'Array of registered alerts' })
  getAllAlerts() {
    return this.alertsService.getAllAlerts();
  }

  @Get('grouped')
  @ApiOperation({ summary: 'Get alerts categorized by instrument with count badges' })
  @ApiResponse({ status: 200, description: 'Categorized alerts group' })
  getGrouped() {
    return this.alertsService.getGroupedAlerts();
  }

  @Get('indices')
  @ApiOperation({ summary: 'Get popular NSE benchmark indices' })
  @ApiResponse({ status: 200, description: 'Popular indices with live prices' })
  getIndices() {
    return this.alertsService.getIndices();
  }

  @Get('poll')
  @ApiOperation({ summary: 'Poll for newly triggered alert events since last event ID' })
  @ApiQuery({ name: 'since', required: false, description: 'Last processed event ID' })
  @ApiResponse({ status: 200, description: 'Newly triggered events' })
  poll(@Query('since') since?: string) {
    const events = this.alertsService.getTriggeredEventsSince(since);
    return { events };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create new price alert (No static IP needed)' })
  @ApiResponse({ status: 201, description: 'Alert created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  createAlert(@Body() dto: CreateAlertDto) {
    return this.alertsService.createAlert(dto);
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
  @ApiParam({ name: 'id', description: 'Alert ID (e.g. ALT-123456)' })
  @ApiResponse({ status: 200, description: 'Alert cancelled' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  cancelAlert(@Param('id') id: string) {
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
  deleteAlert(@Param('id') id: string) {
    return this.alertsService.deleteAlert(id);
  }
}
