import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { FirestoreService } from '../firestore/firestore.service';

export interface DhanApiResponse<T = any> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
  isNetworkOrTimeout?: boolean;
}

@Injectable()
export class DhanService {
  private isTokenLoadedFromDb = false;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  /**
   * Ensures the Dhan access token is cached in memory.
   * If already cached, returns immediately without any Firestore database calls.
   */
  async ensureTokenCached(): Promise<void> {
    if (this.isTokenLoadedFromDb && this.config.accessToken) {
      return;
    }

    if (!this.firestoreService || !this.firestoreService.isReady()) {
      return;
    }

    try {
      const stored = await this.firestoreService.getDhanToken();
      if (stored?.accessToken) {
        this.config.accessToken = stored.accessToken;
        if (stored.clientId) {
          this.config.clientId = stored.clientId;
        }
        this.isTokenLoadedFromDb = true;
      }
    } catch {
      // Graceful fallback to existing in-memory configuration
    }
  }

  /**
   * Update the cached in-memory token (e.g. after renewal or manual update).
   */
  public setCachedToken(token: string, clientId?: string) {
    this.config.accessToken = token;
    if (clientId) {
      this.config.clientId = clientId;
    }
    this.isTokenLoadedFromDb = true;
  }

  getHeaders(): Record<string, string> {
    return {
      'client-id': this.config.clientId,
      'access-token': this.config.accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async request<T = any>(endpoint: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
  } = {}): Promise<DhanApiResponse<T>> {
    await this.ensureTokenCached();

    const url = `${this.config.dhanApiBase}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers: {
        ...this.getHeaders(),
        ...(options.headers || {}),
      },
    };

    if (options.body) {
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
      fetchOptions.signal = controller.signal;

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeout);

      const contentType = response.headers.get('content-type') || '';
      let data: any;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        status: response.status,
        ok: response.ok,
        data,
      };
    } catch (err: any) {
      return {
        status: 0,
        ok: false,
        error: err.message,
        isNetworkOrTimeout: true,
      };
    }
  }

  // Live profile check
  async getProfile(): Promise<DhanApiResponse> {
    return this.request('/profile');
  }

  // Real account funds and margin limits
  async getFundLimits(): Promise<DhanApiResponse> {
    return this.request('/fundlimit');
  }

  // Real demat holdings
  async getHoldings(): Promise<DhanApiResponse> {
    return this.request('/holdings');
  }

  // Token renewal via Dhan API (Requires GET and dhanClientId header)
  async renewToken(): Promise<DhanApiResponse> {
    return this.request('/RenewToken', {
      method: 'GET',
      headers: {
        'dhanClientId': this.config.clientId,
        'client-id': this.config.clientId,
      },
    });
  }

  // Orders
  async getOrders(): Promise<DhanApiResponse> {
    return this.request('/orders');
  }

  async placeOrder(orderPayload: any): Promise<DhanApiResponse> {
    return this.request('/orders', {
      method: 'POST',
      body: orderPayload,
    });
  }

  async cancelOrder(orderId: string): Promise<DhanApiResponse> {
    return this.request(`/orders/${orderId}`, {
      method: 'DELETE',
    });
  }

  // Positions
  async getPositions(): Promise<DhanApiResponse> {
    return this.request('/positions');
  }

  // Trades
  async getTrades(): Promise<DhanApiResponse> {
    return this.request('/trades');
  }

  // Marketfeed LTP lookup
  async getLtp(instruments: Record<string, number[]>): Promise<DhanApiResponse> {
    return this.request('/marketfeed/ltp', {
      method: 'POST',
      body: instruments,
    });
  }

  // Option Chain Expiry List
  async getOptionChainExpiryList(underlyingScrip: number, underlyingSeg = 'IDX_I'): Promise<DhanApiResponse> {
    return this.request('/optionchain/expirylist', {
      method: 'POST',
      body: {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
      },
    });
  }

  // Option Chain Quotes & Greek Data
  async getOptionChain(underlyingScrip: number, underlyingSeg: string, expiry: string): Promise<DhanApiResponse> {
    return this.request('/optionchain', {
      method: 'POST',
      body: {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
        Expiry: expiry,
      },
    });
  }

  // Live Conditional Triggers & Price Alerts (Dhan HQ v2)
  async getAlerts(): Promise<DhanApiResponse> {
    return this.request('/alerts/orders');
  }

  async getAlertById(alertId: string): Promise<DhanApiResponse> {
    return this.request(`/alerts/orders/${alertId}`);
  }

  async createDhanAlert(payload: any): Promise<DhanApiResponse> {
    return this.request('/alerts/orders', {
      method: 'POST',
      body: payload,
    });
  }

  async modifyDhanAlert(alertId: string, payload: any): Promise<DhanApiResponse> {
    return this.request(`/alerts/orders/${alertId}`, {
      method: 'PUT',
      body: payload,
    });
  }

  async cancelDhanAlert(alertId: string): Promise<DhanApiResponse> {
    return this.request(`/alerts/orders/${alertId}`, {
      method: 'DELETE',
    });
  }
}
