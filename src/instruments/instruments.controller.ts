import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';
import { SyncInstrumentsDto } from './dto/sync-instruments.dto';
import { UpdateLotSizesDto } from './dto/update-lot-sizes.dto';
import { Roles } from '../user-auth/roles.decorator';
import { UserRole } from '../user-auth/dto/create-user.dto';

@ApiTags('Instruments')
@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  @Get('traded-instruments')
  @ApiOperation({
    summary: 'Get traded instruments master data from Firestore (master_data/traded_instruments)',
    description: 'Retrieves configured tradeable instruments with official Dhan Scrip Master fields (displayName, lotSize, smFreezeQty, strikeStep, expiryFlag, etc.) and user preferences.',
  })
  @ApiResponse({ status: 200, description: 'Traded instruments master configuration' })
  async getTradedInstruments() {
    return {
      success: true,
      data: await this.instrumentsService.getTradedInstruments(),
    };
  }

  @Put('traded-instruments')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update traded instruments configuration in Firestore (master_data/traded_instruments) (Admin only)',
    description: 'Persists updated user preferences (preferredLots, stopLossPoints, order) while preserving NSE-fixed lotSize and official Dhan fields in master_data/traded_instruments.',
  })
  @ApiResponse({ status: 200, description: 'Traded instruments successfully updated' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can update traded instruments' })
  async updateTradedInstruments(@Body() dto: UpdateLotSizesDto) {
    return this.instrumentsService.updateTradedInstruments(dto);
  }

  @Post('traded-instruments/sync-json')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Fast sync master_data/traded_instruments from static backend JSON file (Admin only)',
    description: 'Syncs official Dhan fields for the 4 traded indices from the static backend JSON file without downloading the full Dhan CSV. Preserves user preferences unless resetPreferences=true.',
  })
  @ApiResponse({ status: 200, description: 'Traded instruments synced from static master JSON' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can sync traded instruments' })
  async syncTradedInstrumentsFromJson(@Body() body?: { resetPreferences?: boolean }) {
    return this.instrumentsService.syncTradedInstrumentsFromJson(Boolean(body?.resetPreferences));
  }

  @Get('indices')
  @ApiOperation({
    summary: 'Get list of all tradeable indices configured in Firestore for Conditional Alert Composer',
    description: 'Retrieves all master data indices backed by Firestore with live LTP and database-driven NSE lot sizes.',
  })
  @ApiResponse({ status: 200, description: 'List of tradeable indices with live LTP and lot size configurations' })
  async getConfiguredIndices() {
    return this.instrumentsService.getConfiguredIndices();
  }

  @Post('sync')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync NSE security master & index options into Firestore collections (Admin only)',
    description: 'Syncs cash equities to sec_id_to_name_mapping and traded index options to index_options.',
  })
  @ApiResponse({ status: 200, description: 'Master data successfully synced to Firestore' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can sync instruments' })
  async syncMaster(@Body() dto?: SyncInstrumentsDto) {
    return this.instrumentsService.syncMaster(dto);
  }

  @Post('flush-and-reload/equities')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Flush and reload cash equities & benchmark indices from Dhan (Admin only)',
    description: 'Completely wipes sec_id_to_name_mapping from Firestore and re-downloads fresh cash equities from Dhan API.',
  })
  @ApiResponse({ status: 200, description: 'Cash equities successfully flushed and reloaded' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can flush and reload equities' })
  async flushAndReloadEquities(@Body() dto?: SyncInstrumentsDto) {
    return this.instrumentsService.flushAndReloadEquities(dto);
  }

  @Post('flush-and-reload/options')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Flush and reload traded index options from Dhan (Admin only)',
    description: 'Completely wipes index_options from Firestore and re-downloads fresh option contracts from Dhan API.',
  })
  @ApiResponse({ status: 200, description: 'Traded index options successfully flushed and reloaded' })
  @ApiResponse({ status: 403, description: 'Forbidden - only admin users can flush and reload options' })
  async flushAndReloadOptions(@Body() dto?: SyncInstrumentsDto) {
    return this.instrumentsService.flushAndReloadOptions(dto);
  }

  @Get('sync/status')
  @ApiOperation({ summary: 'Get current sync status and metadata of sec_id_to_name_mapping from Firestore' })
  @ApiResponse({ status: 200, description: 'Firestore sec_id_to_name_mapping metadata and in-memory counts' })
  async getSyncStatus() {
    return this.instrumentsService.getSyncStatus();
  }

  @Get('sync/options/status')
  @ApiOperation({ summary: 'Get current sync status and metadata of index_options collection from Firestore' })
  @ApiResponse({ status: 200, description: 'Firestore index_options metadata and in-memory counts' })
  async getOptionsSyncStatus() {
    return this.instrumentsService.getOptionsSyncStatus();
  }

  @Get('option-contracts')
  @ApiOperation({
    summary: 'Get 3 option contracts (ATM, ITM, OTM) for current and next expiry',
    description: 'Accepts instrument name (e.g. NIFTY 50), optional reference price (e.g. 25500), and optional expiry date. Returns 3 strikes (At The Money, In The Money, Out of The Money) with live/model LTP for current and next expiry.',
  })
  @ApiResponse({ status: 200, description: 'Option contracts for current and next expiry with live/model LTP' })
  @ApiResponse({ status: 400, description: 'Instrument name missing or invalid' })
  async getOptionContractsGet(@Query() dto: GetOptionContractsDto) {
    return this.instrumentsService.getOptionContracts(dto);
  }

  @Get('expiries')
  @ApiOperation({ summary: 'Get list of option expiries for an instrument' })
  @ApiQuery({ name: 'instrument', required: false, description: 'Instrument name (e.g. NIFTY 50, BANK NIFTY, SENSEX)' })
  @ApiResponse({ status: 200, description: 'List of option expiries' })
  async getExpiries(@Query('instrument') instrument?: string) {
    return this.instrumentsService.getExpiries(instrument);
  }

  @Get('ltp')
  @ApiOperation({ summary: 'Fetch live last trade price (LTP) of an instrument using Yahoo Finance / Dhan' })
  @ApiQuery({ name: 'symbol', required: true, description: 'Instrument symbol or ticker (e.g. NIFTY 50, RELIANCE, NIFTY 24500 CE)' })
  @ApiResponse({ status: 200, description: 'Live LTP for the requested instrument' })
  async getLtp(@Query('symbol') symbol: string) {
    return this.instrumentsService.getLtp(symbol);
  }

  @Get()
  @ApiOperation({ summary: 'Search scrip master with live LTP (Indices, F&O options, Equities)' })
  @ApiQuery({ name: 'q', required: false, description: 'Search keyword (e.g. NIFTY, BANK)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Result count limit', example: 10 })
  @ApiResponse({ status: 200, description: 'List of matching instruments with live LTP' })
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : 10;
    return this.instrumentsService.search(q, isNaN(lim) ? 10 : lim);
  }
}
