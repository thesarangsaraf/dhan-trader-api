import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HistoricalDataService } from './historical-data.service';
import { GetHistoricalCandlesQueryDto, SyncHistoricalDataDto } from './dto/sync-historical-data.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Historical Data')
@Controller('api/historical-data')
export class HistoricalDataController {
  constructor(private readonly historicalDataService: HistoricalDataService) {}

  @Get('nifty50-5m/status')
  @ApiOperation({
    summary: 'Get NIFTY 50 5-minute historical data sync status & metadata from Firestore',
    description:
      'Reads historical_candles/NIFTY50_5M metadata document (1 Firestore read) to report stored candle count, month coverage, and last sync timestamp.',
  })
  @ApiResponse({ status: 200, description: 'Firestore historical_candles/NIFTY50_5M metadata & status' })
  async getNifty50FiveMinStatus() {
    return this.historicalDataService.getStatus();
  }

  @Post('nifty50-5m/sync')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'On-demand sync of NIFTY 50 5-minute candles from GitHub into Firestore (Admin only)',
    description:
      'Fetches 1-minute NIFTY 50 CSVs from technovusin/nifty50-historical-data, resamples them into 09:15 IST aligned 5-minute OHLCV candles, and persists compact monthly documents into Firestore (historical_candles/NIFTY50_5M/months/{YYYY-MM}). Supports incremental sync (force=false) or full rebuild (force=true).',
  })
  @ApiResponse({ status: 200, description: 'NIFTY 50 5-minute candles successfully synced to Firestore' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can trigger historical data sync' })
  @ApiResponse({ status: 409, description: 'Conflict - a sync operation is already in progress' })
  async syncNifty50FiveMin(@Body() dto?: SyncHistoricalDataDto) {
    return this.historicalDataService.syncNifty50FiveMin(Boolean(dto?.force));
  }

  @Get('nifty50-5m/candles')
  @ApiOperation({
    summary: 'Query NIFTY 50 5-minute historical candles from Firestore',
    description:
      'Reads only the overlapping YYYY-MM monthly documents from historical_candles/NIFTY50_5M/months and returns parsed 5-minute OHLCV candles.',
  })
  @ApiResponse({ status: 200, description: 'Parsed 5-minute NIFTY 50 OHLCV candles' })
  async getNifty50FiveMinCandles(@Query() query: GetHistoricalCandlesQueryDto) {
    return this.historicalDataService.getNifty50FiveMinCandles(query);
  }

  @Get('banknifty-5m/status')
  @ApiOperation({
    summary: 'Get BANK NIFTY 5-minute historical data sync status & metadata from Firestore',
    description:
      'Reads historical_candles/BANKNIFTY_5M metadata document (1 Firestore read) to report stored candle count, month coverage, and last sync timestamp.',
  })
  @ApiResponse({ status: 200, description: 'Firestore historical_candles/BANKNIFTY_5M metadata & status' })
  async getBankNiftyFiveMinStatus() {
    return this.historicalDataService.getStatus('BANKNIFTY');
  }

  @Post('banknifty-5m/sync')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'On-demand sync of BANK NIFTY 5-minute candles from GitHub into Firestore (Admin only)',
    description:
      'Fetches 1-minute BANK NIFTY CSVs from technovusin/banknifty-historical-data, resamples them into 09:15 IST aligned 5-minute OHLCV candles, and persists compact monthly documents into Firestore (historical_candles/BANKNIFTY_5M/months/{YYYY-MM}). Supports incremental sync (force=false) or full rebuild (force=true).',
  })
  @ApiResponse({ status: 200, description: 'BANK NIFTY 5-minute candles successfully synced to Firestore' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can trigger historical data sync' })
  @ApiResponse({ status: 409, description: 'Conflict - a sync operation is already in progress' })
  async syncBankNiftyFiveMin(@Body() dto?: SyncHistoricalDataDto) {
    return this.historicalDataService.syncBankNiftyFiveMin(Boolean(dto?.force));
  }

  @Get('banknifty-5m/candles')
  @ApiOperation({
    summary: 'Query BANK NIFTY 5-minute historical candles from Firestore',
    description:
      'Reads only the overlapping YYYY-MM monthly documents from historical_candles/BANKNIFTY_5M/months and returns parsed 5-minute OHLCV candles.',
  })
  @ApiResponse({ status: 200, description: 'Parsed 5-minute BANK NIFTY OHLCV candles' })
  async getBankNiftyFiveMinCandles(@Query() query: GetHistoricalCandlesQueryDto) {
    return this.historicalDataService.getBankNiftyFiveMinCandles(query);
  }
}
