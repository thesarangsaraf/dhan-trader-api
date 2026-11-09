import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FirestoreService } from './firestore.service';
import { ConfigService } from '../config/config.service';
import { UpdateTradeSecurityDto } from './dto/update-trade-security.dto';

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

  @Get('index-options/status')
  @ApiOperation({ summary: 'Get metadata and status of NSE index options stored in Firestore' })
  @ApiResponse({ status: 200, description: 'Index options metadata and chunking stats' })
  async getIndexOptionsStatus() {
    const meta = await this.firestoreService.getIndexOptionsMetadata();
    return {
      storedInFirestore: !!meta,
      metadata: meta,
    };
  }

  @Get('sec-id-mapping/status')
  @ApiOperation({ summary: 'Get metadata and status of security ID to name mapping stored in Firestore' })
  @ApiResponse({ status: 200, description: 'sec_id_to_name_mapping metadata, document count, and instrument totals' })
  async getSecIdMappingStatus() {
    const meta = await this.firestoreService.getSecIdMappingMetadata();
    return {
      storedInFirestore: !!meta,
      metadata: meta,
    };
  }

  @Get('trade-security')
  @ApiOperation({ summary: 'Get trade security configuration status from Firestore (config/security)' })
  @ApiResponse({ status: 200, description: 'Security config status' })
  async getTradeSecurityStatus() {
    const sec = await this.firestoreService.getTradeSecurityConfig();
    return {
      configured: !!(sec?.orderPassword || sec?.password),
      updatedAt: sec?.updatedAt,
    };
  }

  @Post('trade-security')
  @ApiOperation({ summary: 'Update trade security / order authorization password in Firestore (config/security)' })
  @ApiResponse({ status: 200, description: 'Trade security password saved' })
  async updateTradeSecurity(@Body() dto: UpdateTradeSecurityDto) {
    const res = await this.firestoreService.saveTradePassword(dto.password);
    return {
      success: true,
      message: 'Trade password updated in Firestore (config/security)',
      writeTime: res.writeTime,
    };
  }
}
