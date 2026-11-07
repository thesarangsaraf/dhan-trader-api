import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FirestoreService } from './firestore.service';
import { ConfigService } from '../config/config.service';

@ApiTags('Firestore')
@Controller('api/firestore')
export class FirestoreController {
  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get Google Cloud Firestore connection status and configuration' })
  @ApiResponse({ status: 200, description: 'Current Firestore connection state' })
  getStatus() {
    return this.firestoreService.getStatus();
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test live connectivity to Google Cloud Firestore database and sync Dhan token',
  })
  @ApiResponse({ status: 200, description: 'Connection test results and token sync status' })
  async testConnection() {
    const testResult = await this.firestoreService.testConnection();

    let tokenSaved = false;
    let tokenMessage = 'No active in-memory token to sync';

    if (testResult.success && this.config.accessToken) {
      try {
        await this.firestoreService.saveDhanToken({
          accessToken: this.config.accessToken,
          clientId: this.config.clientId,
          source: 'firestore_test_sync',
        });
        tokenSaved = true;
        tokenMessage = 'Dhan access token successfully saved to Firestore database (dhan/token)';
      } catch (err: any) {
        tokenMessage = `Error saving token to Firestore: ${err.message}`;
      }
    }

    return {
      ...testResult,
      tokenSaved,
      tokenMessage,
      tokenCollection: 'dhan/token',
    };
  }
}
