import { Controller, Get, Post, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ScreenerService } from './screener.service';
import { ScreenerScanDto } from './dto/screener-scan.dto';
import { UpdateWatchlistDto } from './dto/update-watchlist.dto';
import { UserAuthGuard } from '../user-auth/user-auth.guard';
import { Public } from '../user-auth/public.decorator';

@ApiTags('Screener')
@ApiBearerAuth()
@UseGuards(UserAuthGuard)
@Controller('api/screener')
export class ScreenerController {
  constructor(private readonly screenerService: ScreenerService) {}

  @Get('watchlist')
  @ApiOperation({ summary: 'Retrieve configurable large-cap NSE stock watchlist from Firestore' })
  @ApiResponse({ status: 200, description: 'Watchlist stocks array' })
  async getWatchlist() {
    return this.screenerService.getWatchlist();
  }

  @Put('watchlist')
  @ApiOperation({ summary: 'Update stock universe watchlist in Firestore' })
  @ApiResponse({ status: 200, description: 'Updated watchlist' })
  async updateWatchlist(@Body() dto: UpdateWatchlistDto) {
    return this.screenerService.updateWatchlist(dto);
  }

  @Post('watchlist/reset')
  @ApiOperation({ summary: 'Reset watchlist back to the default 28 large-cap NSE stocks' })
  @ApiResponse({ status: 200, description: 'Reset watchlist' })
  async resetWatchlist() {
    return this.screenerService.resetWatchlist();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Retrieve configurable strategy parameters from Firestore' })
  @ApiResponse({ status: 200, description: 'Strategy parameters' })
  async getSettings() {
    return this.screenerService.getSettings();
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update configurable strategy parameters in Firestore' })
  @ApiResponse({ status: 200, description: 'Updated strategy parameters' })
  async updateSettings(@Body() dto: any) {
    return this.screenerService.updateSettings(dto);
  }

  @Post('scan')
  @ApiOperation({ summary: 'Execute technical price action scan (Supply/Demand OB & Liquidity Sweeps)' })
  @ApiResponse({ status: 200, description: 'Scan matches with entry and stop loss' })
  async runScan(@Body() dto: ScreenerScanDto) {
    return this.screenerService.scan(dto);
  }
}
