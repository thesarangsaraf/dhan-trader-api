import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional } from 'class-validator';

export class SyncInstrumentsDto {
  @ApiPropertyOptional({
    description: 'Optional array of index options to sync. If omitted, uses existing options cache or Firestore index_options.',
  })
  @IsOptional()
  @IsArray()
  options?: any[];

  @ApiPropertyOptional({
    description: 'Optional array of scrip master equities/indices to sync. If omitted, uses existing scrip master file or cache.',
  })
  @IsOptional()
  @IsArray()
  scripMaster?: any[];

  @ApiPropertyOptional({
    description: 'Whether to force overwrite existing documents in Firestore',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({
    description: 'Raw CSV text of Dhan api-scrip-master.csv to parse and sync',
  })
  @IsOptional()
  csvContent?: string;

  @ApiPropertyOptional({
    description: 'URL of Dhan api-scrip-master.csv to download and sync',
  })
  @IsOptional()
  csvUrl?: string;
}
