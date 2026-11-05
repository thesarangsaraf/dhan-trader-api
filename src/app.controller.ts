import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from './config/config.service';

@ApiTags('System')
@Controller()
export class AppController {
  constructor(private readonly config: ConfigService) {}

  @Get(['', 'health', 'api'])
  @ApiOperation({ summary: 'Backend status & service discovery index' })
  @ApiResponse({ status: 200, description: 'Service health and endpoint index' })
  getRoot() {
    return {
      name: 'Dhan Trader Backend API',
      framework: 'NestJS',
      status: 'ONLINE',
      version: '2.0.0',
      service: 'Pure Backend Trading Engine & Price Alert Bot (TypeScript)',
      timestamp: new Date().toISOString(),
      dhanStatus: {
        clientId: this.config.clientId,
        staticIpRequired: false,
      },
      documentation: {
        swaggerUi: '/docs',
        openApiSpec: '/api/docs/openapi.json',
      },
      endpoints: {
        docs: 'GET /docs',
        openapi: 'GET /api/docs/openapi.json',
        authStatus: 'GET /api/auth/status',
        authVerify: 'GET /api/auth/verify',
        authRenew: 'POST /api/auth/renew',
        authUpdate: 'POST /api/auth/update',
        alerts: 'GET, POST /api/alerts',
        alertsGrouped: 'GET /api/alerts/grouped',
        alertsIndices: 'GET /api/alerts/indices',
        alertsPoll: 'GET /api/alerts/poll?since=<id>',
        alertCancel: 'POST /api/alerts/:id/cancel',
        alertUpdate: 'PUT /api/alerts/:id',
        alertDelete: 'DELETE /api/alerts/:id',
        orders: 'GET, POST /api/orders',
        orderCancel: 'DELETE /api/orders/:id',
        positions: 'GET /api/positions',
        holdings: 'GET /api/holdings',
        strategyAutoSl: 'POST /api/strategy/auto-sl',
        strategyLogs: 'GET /api/strategy/auto-sl/logs',
        instruments: 'GET /api/instruments?q=<query>&limit=<n>',
        telegramStatus: 'GET /api/telegram/status',
        telegramTest: 'POST /api/telegram/test',
        telegramUpdate: 'POST /api/telegram/update',
      },
    };
  }
}
