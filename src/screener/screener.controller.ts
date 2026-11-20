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
    summary: 'Execute on-demand market scan (Liquidity Sweep or Order Block SMC)',
  })
  @ApiResponse({
    status: 200,
    description: 'Detected BUY/SELL recommendations and chart overlays',
  })
  async runScan(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scan(dto || {});
  }

  @Post('liquidity-sweep/scan')
  @ApiOperation({
    summary: 'Execute on-demand Standalone Liquidity Sweep Strategy scan',
  })
  @ApiResponse({
    status: 200,
    description: 'Standalone Liquidity Pools (BSL/SSL/EQH/EQL), detected sweeps, and trade setups',
  })
  async runLiquiditySweepScan(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scanLiquiditySweeps(dto || {});
  }

  @Post('liquidity-sweeps')
  @ApiOperation({
    summary: 'Alias for on-demand Standalone Liquidity Sweep scan',
  })
  @ApiResponse({
    status: 200,
    description: 'Standalone Liquidity Pools and sweeps',
  })
  async runLiquiditySweepsAlias(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scanLiquiditySweeps(dto || {});
  }

  @Post('order-block/scan')
  @ApiOperation({
    summary: 'Execute on-demand Multi-Timeframe Order Block (SMC / Supply & Demand) Strategy scan',
  })
  @ApiResponse({
    status: 200,
    description: 'Active HTF Order Blocks, approaching/mitigating POIs, and confirmed LTF sniper setups',
  })
  async runOrderBlockScan(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scanOrderBlocks(dto || {});
  }

  @Post('order-blocks')
  @ApiOperation({
    summary: 'Alias for on-demand Multi-Timeframe Order Block scan',
  })
  @ApiResponse({
    status: 200,
    description: 'Active HTF Order Blocks and confirmed LTF sniper setups',
  })
  async runOrderBlocksAlias(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scanOrderBlocks(dto || {});
  }
}
