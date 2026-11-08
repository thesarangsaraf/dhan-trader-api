import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';
import { SyncInstrumentsDto } from './dto/sync-instruments.dto';
import { UpdateLotSizesDto } from './dto/update-lot-sizes.dto';
import { QueryEquitiesDto } from './dto/query-equities.dto';
import { QueryOptionsDto } from './dto/query-options.dto';

@ApiTags('Instruments')
@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  @Get('lot-sizes')
  @ApiOperation({
    summary: 'Get database-driven index lot sizes configuration',
    description: 'Retrieves current lot sizes for NIFTY 50, BANK NIFTY, MIDCAP NIFTY, and SENSEX backed by Firestore.',
  })
  @ApiResponse({ status: 200, description: 'Index lot sizes configuration' })
  getLotSizes() {
    return {
      success: true,
      data: this.instrumentsService.getLotSizes(),
    };
  }

  @Put('lot-sizes')
  @ApiOperation({
    summary: 'Update index lot sizes configuration in Firestore',
    description: 'Updates and persists lot sizes in Firestore database collection (config/lot_sizes) and updates in-memory calculation engine.',
  })
  @ApiResponse({ status: 200, description: 'Lot sizes successfully updated' })
  async updateLotSizes(@Body() dto: UpdateLotSizesDto) {
    return this.instrumentsService.updateLotSizes(dto);
  }

  @Post('lot-sizes/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset index lot sizes configuration to defaults' })
  @ApiResponse({ status: 200, description: 'Lot sizes reset to standard defaults' })
  async resetLotSizes() {
    return this.instrumentsService.resetLotSizes();
  }

  @Get('indices')
  @ApiOperation({
    summary: 'Get list of tradeable indices configured in Firestore for Conditional Alert Composer',
    description: 'Retrieves enabled benchmark and sectoral indices backed by Firestore with live LTP and database-driven lot sizes.',
  })
  @ApiResponse({ status: 200, description: 'List of tradeable indices with live LTP and lot size configurations' })
  async getConfiguredIndices() {
    return this.instrumentsService.getConfiguredIndices(true);
  }

  @Post('sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync NSE security master & index options into Firestore collections',
    description: 'Syncs cash equities to sec_id_to_name_mapping and traded index options to index_options.',
  })
  @ApiResponse({ status: 200, description: 'Master data successfully synced to Firestore' })
  async syncMaster(@Body() dto?: SyncInstrumentsDto) {
    if (dto?.csvContent) {
      return this.instrumentsService.syncCsv(dto.csvContent);
    }
    return this.instrumentsService.syncMaster(dto);
  }

  @Post('sync/equities')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync NSE cash equities & benchmark indices into Firestore collection (sec_id_to_name_mapping)',
    description: 'Uploads and organizes all NSE equities into balanced chunks and indices into sec_id_to_name_mapping. Guarantees zero option contracts are saved in this collection.',
  })
  @ApiResponse({ status: 200, description: 'Equities and indices successfully synced to sec_id_to_name_mapping' })
  async syncEquities(@Body() dto?: SyncInstrumentsDto) {
    return this.instrumentsService.syncEquities(dto);
  }

  @Post('sync/options')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync traded index options (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) into Firestore collection (index_options)',
    description: 'Uploads option contracts strictly for the 4 traded indices into collection index_options in chunks of 500. Excludes stock options and non-traded indices.',
  })
  @ApiResponse({ status: 200, description: 'Traded index options successfully synced to index_options' })
  async syncOptions(@Body() dto?: SyncInstrumentsDto) {
    return this.instrumentsService.syncOptions(dto);
  }

  @Post('sync/csv')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload and sync NSE security master from raw CSV content into Firestore',
    description: 'Parses raw Dhan api-scrip-master.csv text, filters strictly to NSE contracts, and writes divided documents.',
  })
  @ApiResponse({ status: 200, description: 'CSV data parsed and synced to Firestore' })
  async syncCsvPost(@Body('csvContent') csvContent: string) {
    return this.instrumentsService.syncCsv(csvContent);
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

  @Get('equities')
  @ApiOperation({
    summary: 'Browse and query cash equities & benchmark indices from sec_id_to_name_mapping',
    description: 'Returns paginated list of equities and indices with search filter and segment filter.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of equities and indices' })
  async getEquities(@Query() dto: QueryEquitiesDto) {
    return this.instrumentsService.getEquities(dto);
  }

  @Get('options')
  @ApiOperation({
    summary: 'Browse and query traded index options from index_options collection',
    description: 'Returns paginated list of traded index options with filters for index, expiry, strike, and option type.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of index options' })
  async getOptions(@Query() dto: QueryOptionsDto) {
    return this.instrumentsService.getOptions(dto);
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

  @Post('option-contracts')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get 3 option contracts (ATM, ITM, OTM) for current and next expiry via POST payload',
    description: 'JSON body alternative accepting instrument, optional price, and optional expiry date, returning ATM, ITM, and OTM contracts.',
  })
  @ApiResponse({ status: 200, description: 'Option contracts for current and next expiry with live/model LTP' })
  @ApiResponse({ status: 400, description: 'Instrument name missing or invalid' })
  async getOptionContractsPost(@Body() dto: GetOptionContractsDto) {
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

  @Get('by-security-id/:securityId')
  @ApiOperation({ summary: 'Find scrip or option contract by Dhan security ID' })
  @ApiParam({ name: 'securityId', description: 'Dhan security ID (e.g. 40040, 13)' })
  @ApiResponse({ status: 200, description: 'Instrument scrip details' })
  @ApiResponse({ status: 404, description: 'Security ID not found' })
  async getBySecurityId(@Param('securityId') securityId: string) {
    const item = this.instrumentsService.findBySecurityId(securityId);
    if (!item) {
      throw new NotFoundException(`Instrument with security ID ${securityId} not found`);
    }
    return item;
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
