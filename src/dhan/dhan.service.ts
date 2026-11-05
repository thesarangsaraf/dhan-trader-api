import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

export interface DhanApiResponse<T = any> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
  isNetworkOrTimeout?: boolean;
}

@Injectable()
export class DhanService {
  constructor(private readonly config: ConfigService) {}

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

  // Token renewal via Dhan API
  async renewToken(): Promise<DhanApiResponse> {
    return this.request('/RenewToken', {
      method: 'POST',
      body: {},
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
