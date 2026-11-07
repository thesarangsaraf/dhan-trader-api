import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { FirestoreService } from '../firestore/firestore.service';

function decodeJwtPayload(token: string): any {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length < 2) return null;

  try {
    let payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadBase64.length % 4) {
      payloadBase64 += '=';
    }
    const jsonStr = Buffer.from(payloadBase64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

function formatIST(date: Date): string {
  if (!date || isNaN(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date) + ' IST';
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    const absSec = Math.abs(totalSeconds);
    const h = Math.floor(absSec / 3600);
    const m = Math.floor((absSec % 3600) / 60);
    return `Expired ${h > 0 ? `${h}h ` : ''}${m}m ago`;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private autoRenewTimer: NodeJS.Timeout | null = null;
  private lastSavedToken: string | null = null;
  public static readonly AUTO_RENEW_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  public static readonly RENEW_THRESHOLD_SEC = 4 * 3600; // 4 hours before expiry

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

    this.startAutoRenewTimer();
  }

  onModuleDestroy() {
    this.stopAutoRenewTimer();
  }

  startAutoRenewTimer() {
    if (this.autoRenewTimer) {
      clearInterval(this.autoRenewTimer);
      this.autoRenewTimer = null;
    }

    if (process.env.NODE_ENV === 'test') {
      return;
    }

    this.logger.log('Starting hourly Dhan token auto-renew timer (checks every 1 hour, renews when < 4h remaining)');
    this.autoRenewTimer = setInterval(() => {
      this.checkAndAutoRenew().catch((err) => {
        this.logger.error(`Error in token auto-renew interval: ${err.message}`);
      });
    }, AuthService.AUTO_RENEW_INTERVAL_MS);

    if (this.autoRenewTimer && typeof this.autoRenewTimer.unref === 'function') {
      this.autoRenewTimer.unref();
    }

    // Schedule initial check shortly after startup
    setTimeout(() => {
      this.checkAndAutoRenew().catch(() => {});
    }, 5000).unref();
  }

  stopAutoRenewTimer() {
    if (this.autoRenewTimer) {
      clearInterval(this.autoRenewTimer);
      this.autoRenewTimer = null;
    }
  }

  async checkAndAutoRenew() {
    const inspection = this.getTokenInspection();
    if (!inspection.configured) {
      this.logger.debug('Token auto-renew check skipped: No token configured');
      return { skipped: true, reason: 'NO_TOKEN' };
    }

    if (inspection.isExpired) {
      this.logger.warn(
        'Token auto-renew check: Current token is already EXPIRED. Dhan RenewToken API only accepts active tokens. Manual login required.'
      );
      return { skipped: true, reason: 'EXPIRED' };
    }

    const secondsRemaining = inspection.secondsRemaining;
    if (secondsRemaining !== null && secondsRemaining > AuthService.RENEW_THRESHOLD_SEC) {
      this.logger.log(
        `Token auto-renew check: Token active with ${inspection.timeRemainingFormatted} remaining. Renewal not needed yet (threshold: 4h).`
      );
      return { skipped: true, reason: 'NOT_DUE', secondsRemaining };
    }

    this.logger.log(
      `Token auto-renew triggered: ${inspection.timeRemainingFormatted} remaining. Requesting fresh token from Dhan API...`
    );

    const res = await this.renewToken();
    if (res.success) {
      this.logger.log(`Dhan token renewed and synced to Firestore database! New expiry: ${res.inspection?.expiresAtIST}`);
      if (this.telegramService?.isConfigured()) {
        const msg = `<b>🔐 Dhan Access Token Auto-Renewed</b>\n` +
          `Your Dhan API access token was automatically renewed for 24 hours and saved to Firestore database.\n` +
          `<b>New Expiry:</b> <code>${res.inspection?.expiresAtIST}</code>`;
        this.telegramService.sendMessage(msg).catch(() => {});
      }
      return { renewed: true, res };
    } else {
      this.logger.error(`Dhan token auto-renewal failed: ${res.error}`);
      if (this.telegramService?.isConfigured()) {
        const msg = `<b>⚠️ Dhan Token Auto-Renewal Failed</b>\n` +
          `Could not renew Dhan token: <i>${res.error}</i>\n` +
          `Time remaining: <code>${inspection.timeRemainingFormatted}</code>`;
        this.telegramService.sendMessage(msg).catch(() => {});
      }
      return { renewed: false, error: res.error };
    }
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
   * Loads token from Firestore database into memory cache.
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
          false,
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
        this.logger.log('Seeding initial Dhan access token to Firestore database (dhan/token)...');
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

      await this.firestoreService.saveDhanToken({
        accessToken: token,
        clientId: derivedClientId,
        updatedAt: new Date().toISOString(),
        expiresAt: expSec ? new Date(expSec * 1000).toISOString() : undefined,
        expiresAtIST: expSec ? formatIST(new Date(expSec * 1000)) : undefined,
        issuedAtIST: expSec ? formatIST(new Date(iatSec * 1000)) : undefined,
        userName: payload?.userName || payload?.name,
        status: expSec && expSec < nowSec ? 'EXPIRED' : 'ACTIVE',
        source,
      });
      this.lastSavedToken = token;
      this.logger.log(`✅ Dhan JWT token successfully persisted to Firestore (dhan/token) [Source: ${source}]`);
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to save Dhan token to Firestore: ${err.message}`);
      return false;
    }
  }

  async renewToken() {
    const apiResult = await this.dhanService.renewToken();

    if (apiResult.ok && apiResult.data) {
      const d = apiResult.data;
      const newToken = typeof d === 'string'
        ? d
        : (d?.token || d?.accessToken || d?.data?.token || d?.data?.accessToken || (typeof d?.data === 'string' ? d.data : null));

      if (typeof newToken === 'string' && newToken.trim()) {
        const cleanToken = newToken.trim();

        // Cache token in memory and notify listeners (persistEnv = false)
        this.config.updateCredentials({ accessToken: cleanToken }, false);
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

    const errorMsg = apiResult.data?.errorMessage
      || apiResult.data?.message
      || apiResult.error
      || `Dhan token renewal rejected by Dhan API (HTTP ${apiResult.status})`;

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

    // Cache token in memory immediately for fast access
    this.config.updateCredentials(
      {
        accessToken: newToken.trim(),
        clientId: derivedClientId,
      },
      false,
    );
    if (typeof (this.dhanService as any)?.setCachedToken === 'function') {
      this.dhanService.setCachedToken(newToken.trim(), derivedClientId);
    }

    // Persist to Firestore database and wait for write completion
    await this.persistTokenToDatabase(newToken.trim(), derivedClientId, 'manual_update');

    return {
      success: true,
      message: 'Access Token updated and saved to Firestore database successfully',
      inspection: this.getTokenInspection(),
    };
  }
}
