import { Body, Controller, Get, Post } from '@nestjs/common';
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
    summary: 'Test live connectivity to Google Cloud Firestore database',
  })
  @ApiResponse({ status: 200, description: 'Connection test results and token inspection' })
  async testConnection() {
    const testResult = await this.firestoreService.testConnection();

    let storedTokenInfo: any = null;
    let tokenMessage = 'No token stored in Firestore';

    if (testResult.success) {
      try {
        const stored = await this.firestoreService.getDhanToken();
        if (stored?.accessToken) {
          storedTokenInfo = {
            hasToken: true,
            status: stored.status,
            expiresAtIST: stored.expiresAtIST,
            clientId: stored.clientId,
            source: stored.source,
          };
          tokenMessage = `Dhan access token verified in Firestore (Expires: ${stored.expiresAtIST || 'N/A'}, Status: ${stored.status || 'ACTIVE'})`;
        }
      } catch (err: any) {
        tokenMessage = `Error reading token from Firestore: ${err.message}`;
      }
    }

    return {
      ...testResult,
      tokenSaved: false,
      tokenMessage,
      storedToken: storedTokenInfo,
      tokenCollection: 'config/dhan',
    };
  }
}
