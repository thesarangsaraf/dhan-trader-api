import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';

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
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly dhanService: DhanService,
  ) {}

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
        secondsRemaining: 86400,
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
        userName: payload.userName || 'TRADER',
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
      const errorMsg = apiResult.data?.errorMessage
        || apiResult.data?.message
        || apiResult.data?.data?.['808']
        || apiResult.error
        || `Dhan API rejection (HTTP ${apiResult.status})`;

      return {
        verified: false,
        source: 'dhan_api',
        status: apiResult.status,
        message: errorMsg,
        inspection: { ...inspection, status: 'INVALID', statusText: errorMsg },
      };
    }

    return {
      verified: true,
      source: 'dhan_api',
      message: 'Successfully verified live with Dhan API v2',
      profile: apiResult.data,
      inspection,
    };
  }

  async renewToken() {
    const apiResult = await this.dhanService.renewToken();

    if (apiResult.ok && apiResult.data) {
      const newToken = apiResult.data.accessToken || apiResult.data.token || apiResult.data;
      if (typeof newToken === 'string') {
        this.config.updateCredentials({ accessToken: newToken });
        return {
          success: true,
          source: 'dhan_api',
          message: 'Dhan Access Token renewed successfully via Dhan API',
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

  updateToken(newToken: string, newClientId?: string) {
    if (!newToken || typeof newToken !== 'string' || !newToken.trim()) {
      throw new Error('Access token cannot be empty');
    }

    const payload = decodeJwtPayload(newToken.trim());
    const derivedClientId = newClientId || payload?.clientId || payload?.sub || this.config.clientId;

    this.config.updateCredentials({
      accessToken: newToken.trim(),
      clientId: derivedClientId,
    });

    return {
      success: true,
      message: 'Access Token updated and synced to .env successfully',
      inspection: this.getTokenInspection(),
    };
  }
}
