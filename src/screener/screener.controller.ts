import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ScreenerService } from './screener.service';
import { ScreenerScanDto } from './dto/screener-scan.dto';
import { UserAuthGuard } from '../user-auth/user-auth.guard';

@ApiTags('Screener')
@ApiBearerAuth()
@UseGuards(UserAuthGuard)
@Controller('api/screener')
export class ScreenerController {
  constructor(private readonly screenerService: ScreenerService) {}

  @Get('instruments')
  @ApiOperation({
    summary: 'Retrieve configured traded instruments from Firestore master_data/traded_instruments',
  })
  @ApiResponse({ status: 200, description: 'Configured enabled traded instruments universe' })
  async getInstruments() {
    const instruments = await this.screenerService.getConfiguredInstruments();
    return { instruments };
  }

  @Post('scan')
  @ApiOperation({
    summary: 'Execute on-demand 5-minute Liquidity Sweep & Reversal scan (Live or Historical)',
  })
  @ApiResponse({
    status: 200,
    description: 'Detected BUY/SELL liquidity sweep recommendations with surrounding 5m candles',
  })
  async runScan(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scan(dto || {});
  }
}
