import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FirestoreService } from './firestore.service';

@ApiTags('Firestore')
@Controller('api/firestore')
export class FirestoreController {
  constructor(private readonly firestoreService: FirestoreService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get Google Cloud Firestore connection status and configuration' })
  @ApiResponse({ status: 200, description: 'Current Firestore connection state' })
  getStatus() {
    return this.firestoreService.getStatus();
  }
}
