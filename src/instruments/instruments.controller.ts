import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';
import { GetOptionContractsDto } from './dto/get-option-contracts.dto';

@ApiTags('Instruments')
@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  @Get('option-contracts')
  @ApiOperation({
    summary: 'Get 3 option contracts (ATM-1, ATM, ATM+1) for current and next expiry',
    description: 'Accepts instrument name (e.g. NIFTY 50) and reference price (e.g. 25500), returning contracts for 25450, 25500, 25550 for current and next expiry dates.',
  })
  @ApiResponse({ status: 200, description: 'Option contracts for current and next expiry with live/model LTP' })
  @ApiResponse({ status: 400, description: 'Instrument name missing or invalid' })
  async getOptionContractsGet(@Query() dto: GetOptionContractsDto) {
    return this.instrumentsService.getOptionContracts(dto);
  }

  @Post('option-contracts')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get 3 option contracts (ATM-1, ATM, ATM+1) for current and next expiry via POST payload',
    description: 'JSON body alternative for frontend convenience containing instrument name and optional reference price.',
  })
  @ApiResponse({ status: 200, description: 'Option contracts for current and next expiry with live/model LTP' })
  @ApiResponse({ status: 400, description: 'Instrument name missing or invalid' })
  async getOptionContractsPost(@Body() dto: GetOptionContractsDto) {
    return this.instrumentsService.getOptionContracts(dto);
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
