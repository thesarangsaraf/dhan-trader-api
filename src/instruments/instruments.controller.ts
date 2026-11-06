import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';

@ApiTags('Instruments')
@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

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
