import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstrumentsService } from './instruments.service';

@ApiTags('Instruments')
@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Search scrip master (Indices, F&O options, Equities)' })
  @ApiQuery({ name: 'q', required: false, description: 'Search keyword (e.g. NIFTY, BANK)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Result count limit', example: 10 })
  @ApiResponse({ status: 200, description: 'List of matching instruments' })
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : 10;
    return this.instrumentsService.search(q, isNaN(lim) ? 10 : lim);
  }
}
