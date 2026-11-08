import { Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { FirestoreService } from '../firestore/firestore.service';
import { decodeJwtPayload, formatIST, formatDuration } from './jwt.util';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private lastSavedToken: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly dhanService: DhanService,
    @Optional() private readonly telegramService?: TelegramService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  async onModuleInit() {
    await this.syncTokenFromDatabase().catch((err) => {
      this.logger.warn(`Could not sync token from database at startup: ${err.message}`);
    });

    // Listen for any in-memory or env config changes to keep Firestore continuously updated
    this.config.onChange(async (cfg) => {
      if (cfg.accessToken && cfg.accessToken !== this.lastSavedToken) {
        await this.persistTokenToDatabase(cfg.accessToken, cfg.clientId, 'config_change');
      }
    });
  }

  getTokenInspection() {
    const token = this.config.accessToken;
    const clientId = this.config.clientId;

    if (!token) {
      return {
        configured: false,
        status: 'MISSING',
        statusText: 'No Token Configured',
        clientId,
        tokenMasked: 'None',
        issuedAtIST: 'N/A',
        expiresAtIST: 'N/A',
        secondsRemaining: 0,
        timeRemainingFormatted: 'No Token Configured',
        isExpired: true,
        isExpiringSoon: false,
        payload: null,
      };
    }

    const payload = decodeJwtPayload(token);
    const nowSec = Math.floor(Date.now() / 1000);

    const masked = token.length > 16
      ? `${token.slice(0, 8)}...${token.slice(-6)}`
      : '********';

    if (!payload || !payload.exp) {
      return {
        configured: true,
        status: 'ACTIVE',
        statusText: 'Token Active (Opaque format)',
        clientId,
        tokenMasked: masked,
        issuedAtIST: 'Unknown (Opaque Token)',
        expiresAtIST: 'Unknown (Opaque Token)',
        secondsRemaining: null,
        timeRemainingFormatted: 'Validity managed by Dhan API',
        isExpired: false,
        isExpiringSoon: false,
        payload: { raw: 'Opaque or Custom Token Format' },
      };
    }

    const expSec = payload.exp;
    const iatSec = payload.iat || (expSec - 86400);
    const secondsRemaining = expSec - nowSec;

    let status = 'ACTIVE';
    let statusText = 'Token Active';

    if (secondsRemaining <= 0) {
      status = 'EXPIRED';
      statusText = 'Token Expired';
    } else if (secondsRemaining < 7200) {
      status = 'EXPIRING_SOON';
      statusText = 'Expiring Soon';
    }

    return {
      configured: true,
      status,
      statusText,
      clientId,
      tokenMasked: masked,
      issuedAtSec: iatSec,
      expiresAtSec: expSec,
      issuedAtIST: formatIST(new Date(iatSec * 1000)),
      expiresAtIST: formatIST(new Date(expSec * 1000)),
      secondsRemaining,
      timeRemainingFormatted: formatDuration(secondsRemaining),
      isExpired: secondsRemaining <= 0,
      isExpiringSoon: secondsRemaining > 0 && secondsRemaining < 7200,
      payload: {
        sub: payload.sub || payload.clientId || clientId,
        clientId: payload.clientId || clientId,
        userName: payload.userName || payload.name || payload.clientId || clientId || 'Account',
        iat: iatSec,
        exp: expSec,
      },
    };
  }

  async verifyLiveValidity() {
    const inspection = this.getTokenInspection();
    if (!inspection.configured) {
      return {
        verified: false,
        source: 'local',
        message: 'No token configured',
        inspection,
      };
    }

    const apiResult = await this.dhanService.getProfile();
    if (!apiResult.ok) {
      let errorMsg = apiResult.data?.errorMessage
        || apiResult.data?.message
        || apiResult.data?.data?.['808']
        || apiResult.error
        || `Dhan API rejection (HTTP ${apiResult.status})`;

      if (errorMsg === 'Invalid Token' || apiResult.data?.errorCode === 'DH-906') {
        errorMsg = 'Dhan rejected token (DH-906: Invalid Token). The token was revoked or superseded by Dhan (e.g. newer token generated, logged out, or expired on server). Please generate a fresh token from Dhan HQ web console.';

        if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
          this.firestoreService.saveDhanToken({
            accessToken: this.config.accessToken,
            clientId: this.config.clientId,
            status: 'INVALID',
            source: 'dhan_verify_invalid',
          }).catch(() => {});
        }
      }

      return {
        valid: false,
        verified: false,
        source: 'dhan_api',
        status: apiResult.status,
        errorCode: apiResult.data?.errorCode,
        message: errorMsg,
        inspection: { ...inspection, status: 'INVALID', statusText: errorMsg },
      };
    }

    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      this.firestoreService.saveDhanToken({
        accessToken: this.config.accessToken,
        clientId: this.config.clientId,
        status: 'ACTIVE',
        source: 'dhan_verify_success',
      }).catch(() => {});
    }

    return {
      valid: true,
      verified: true,
      source: 'dhan_api',
      message: 'Successfully verified live with Dhan API v2',
      profile: apiResult.data,
      inspection,
    };
  }

  /**
   * Loads token from Firestore database into memory cache and updates local .env.
   * If Firestore is not populated yet but memory has initial token, seeds it to Firestore.
   */
  async syncTokenFromDatabase(force = false): Promise<boolean> {
    if (!this.firestoreService || typeof this.firestoreService.isReady !== 'function' || !this.firestoreService.isReady()) {
      return false;
    }

    try {
      const stored = await this.firestoreService.getDhanToken();
      if (stored?.accessToken) {
        this.config.updateCredentials(
          {
            accessToken: stored.accessToken,
            clientId: stored.clientId || this.config.clientId,
          },
          true,
        );
        if (typeof (this.dhanService as any)?.setCachedToken === 'function') {
          this.dhanService.setCachedToken(stored.accessToken, stored.clientId);
        }
        this.lastSavedToken = stored.accessToken;
        this.logger.log(
          `🔑 Dhan access token synced from Firestore database (Database: ${this.config.firestoreDatabaseId}, ClientId: ${stored.clientId})`,
        );
        return true;
      } else if (this.config.accessToken) {
        this.logger.log('Seeding initial Dhan access token to Firestore database (config/dhan)...');
        await this.persistTokenToDatabase(this.config.accessToken, this.config.clientId, 'seed_initial');
        return true;
      }
    } catch (err: any) {
      this.logger.warn(`Failed to sync Dhan token from Firestore: ${err.message}`);
    }
    return false;
  }

  /**
   * Persists the token and calculated metadata to Firestore database.
   */
  async persistTokenToDatabase(token: string, clientId?: string, source = 'dhan'): Promise<boolean> {
    if (!this.firestoreService || typeof this.firestoreService.isReady !== 'function' || !this.firestoreService.isReady()) {
      return false;
    }

    try {
      const payload = decodeJwtPayload(token);
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = payload?.exp;
      const iatSec = payload?.iat || (expSec ? expSec - 86400 : nowSec);
      const derivedClientId = clientId || payload?.clientId || payload?.sub || this.config.clientId;

      const saveRes = await this.firestoreService.saveDhanToken(
        {
          accessToken: token,
          clientId: derivedClientId,
          updatedAt: new Date().toISOString(),
          expiresAt: expSec ? new Date(expSec * 1000).toISOString() : undefined,
          expiresAtIST: expSec ? formatIST(new Date(expSec * 1000)) : undefined,
          issuedAtIST: expSec ? formatIST(new Date(iatSec * 1000)) : undefined,
          userName: payload?.userName || payload?.name,
          status: expSec && expSec < nowSec ? 'EXPIRED' : 'ACTIVE',
          source,
        },
        { force: source === 'manual_update' },
      );

      if (saveRes.skipped) {
        this.logger.warn(`Dhan token persistence skipped: ${saveRes.reason}`);
        return false;
      }

      this.lastSavedToken = token;
      this.logger.log(`✅ Dhan JWT token successfully persisted to Firestore (config/dhan) [Source: ${source}]`);
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to save Dhan token to Firestore: ${err.message}`);
      return false;
    }
  }

  async renewToken() {
    // If in-memory token is expired, check if Firestore already has a newer active token
    const inspection = this.getTokenInspection();
    if (inspection.isExpired) {
      await this.syncTokenFromDatabase(true);
      const freshInspection = this.getTokenInspection();
      if (!freshInspection.isExpired) {
        return {
          success: true,
          source: 'firestore_sync',
          message: 'Active Dhan Access Token retrieved from Firestore database',
          inspection: freshInspection,
        };
      }
    }

    const apiResult = await this.dhanService.renewToken();

    if (apiResult.ok && apiResult.data) {
      const d = apiResult.data;
      const newToken = typeof d === 'string'
        ? d
        : (d?.token || d?.accessToken || d?.data?.token || d?.data?.accessToken || (typeof d?.data === 'string' ? d.data : null));

      if (typeof newToken === 'string' && newToken.trim()) {
        const cleanToken = newToken.trim();

        // Cache token in memory and persist to .env
        this.config.updateCredentials({ accessToken: cleanToken }, true);
        if (typeof (this.dhanService as any)?.setCachedToken === 'function') {
          this.dhanService.setCachedToken(cleanToken);
        }

        // Update token in Firestore database
        await this.persistTokenToDatabase(cleanToken, this.config.clientId, 'dhan_renew');

        return {
          success: true,
          source: 'dhan_api',
          message: 'Dhan Access Token renewed successfully and saved to Firestore database',
          inspection: this.getTokenInspection(),
        };
      }
    }

    let errorMsg = apiResult.data?.errorMessage
      || apiResult.data?.message
      || apiResult.error
      || `Dhan token renewal rejected by Dhan API (HTTP ${apiResult.status})`;

    if (apiResult.data?.errorCode === 'DH-901' || errorMsg.includes('invalid or expired')) {
      errorMsg = 'Current access token has expired. Dhan API v2 does not allow renewing expired tokens via /RenewToken. Please generate a new access token on Dhan HQ Web console and update it in the Manual Token Update section.';
    }

    return {
      success: false,
      source: 'dhan_api',
      status: apiResult.status,
      error: errorMsg,
    };
  }

  async updateToken(newToken: string, newClientId?: string) {
    if (!newToken || typeof newToken !== 'string' || !newToken.trim()) {
      throw new Error('Access token cannot be empty');
    }

    const payload = decodeJwtPayload(newToken.trim());
    const derivedClientId = newClientId || payload?.clientId || payload?.sub || this.config.clientId;

    // Cache token in memory and persist to .env
    this.config.updateCredentials(
      {
        accessToken: newToken.trim(),
        clientId: derivedClientId,
      },
      true,
    );
    if (typeof (this.dhanService as any)?.setCachedToken === 'function') {
      this.dhanService.setCachedToken(newToken.trim(), derivedClientId);
    }

    // Persist to Firestore database and wait for write completion (force: true)
    await this.persistTokenToDatabase(newToken.trim(), derivedClientId, 'manual_update');

    return {
      success: true,
      message: 'Access Token updated and saved to Firestore database successfully',
      inspection: this.getTokenInspection(),
    };
  }
}
