import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

@Injectable()
export class ConfigService implements OnModuleInit, OnModuleDestroy {
  public clientId: string;
  public accessToken: string;
  public telegramBotToken: string;
  public telegramChatId: string;
  public port: number;
  public host: string;
  public pollIntervalMs: number;
  public dhanApiBase: string;
  public dhanScripMasterUrl: string;
  public webhookBaseUrl: string;
  public telegramApiBase: string;
  public yahooFinanceBaseUrl: string;
  public jwtSecret: string;
  public cronSecret: string;
  public cloudRunService: string;
  public cloudRunRegion: string;
  public containerRegistryRepo: string;

  // Google Cloud Firestore configuration
  public firestoreProjectId: string;
  public firestoreDatabaseId: string;
  public firestoreKeyFile: string;
  public firestoreAuthScopes: string[];

  private env: Record<string, string>;
  private listeners: Set<(config: ConfigService) => void> = new Set();

  constructor() {
    this.env = parseEnvFile(ENV_PATH);

    // Synchronize parsed .env values into process.env if not explicitly set
    for (const [key, val] of Object.entries(this.env)) {
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }

    // Google Cloud Firestore credentials
    this.firestoreProjectId = (process.env.FIRESTORE_PROJECT_ID || this.env.FIRESTORE_PROJECT_ID || 'dhan-trader-514002').trim();
    this.firestoreDatabaseId = (process.env.FIRESTORE_DATABASE_ID || this.env.FIRESTORE_DATABASE_ID || 'dhan-trader-firebase-db').trim();
    this.firestoreKeyFile = (process.env.FIRESTORE_KEY_FILE || this.env.FIRESTORE_KEY_FILE || 'google-service-account-key.json').trim();
    const rawScopes = (process.env.FIRESTORE_AUTH_SCOPES || this.env.FIRESTORE_AUTH_SCOPES || '').trim();
    this.firestoreAuthScopes = rawScopes ? rawScopes.split(',').map((s) => s.trim()).filter(Boolean) : [];

    // Server Network Configuration
    this.port = parseInt(process.env.PORT || this.env.PORT || '8000', 10);
    this.host = process.env.HOST || this.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || this.env.POLL_INTERVAL_MS || '4000', 10);

    // Dhan HQ API v2 Endpoints
    this.dhanApiBase = (process.env.DHAN_API_BASE || this.env.DHAN_API_BASE || 'https://api.dhan.co/v2').trim();
    this.dhanScripMasterUrl = (process.env.DHAN_SCRIP_MASTER_URL || this.env.DHAN_SCRIP_MASTER_URL || 'https://images.dhan.co/api-data/api-scrip-master.csv').trim();

    // Webhook Postback Callback URL
    this.webhookBaseUrl = (process.env.WEBHOOK_BASE_URL || this.env.WEBHOOK_BASE_URL || 'https://dhan-trader-api-218680608145.asia-south1.run.app').trim();

    // External Integration Endpoints
    this.telegramApiBase = (process.env.TELEGRAM_API_BASE || this.env.TELEGRAM_API_BASE || 'https://api.telegram.org').trim();
    this.yahooFinanceBaseUrl = (process.env.YAHOO_FINANCE_BASE_URL || this.env.YAHOO_FINANCE_BASE_URL || 'https://query1.finance.yahoo.com/v8/finance/chart').trim();

    // Application Security
    this.jwtSecret = (process.env.JWT_SECRET || this.env.JWT_SECRET || 'dhan-trader-user-jwt-secret-key-2026').trim();
    this.cronSecret = (process.env.CRON_SECRET || this.env.CRON_SECRET || '').trim();

    // Google Cloud Run & Deployment
    this.cloudRunService = (process.env.CLOUD_RUN_SERVICE || this.env.CLOUD_RUN_SERVICE || 'dhan-trader-api').trim();
    this.cloudRunRegion = (process.env.CLOUD_RUN_REGION || this.env.CLOUD_RUN_REGION || 'asia-south1').trim();
    this.containerRegistryRepo = (process.env.CONTAINER_REGISTRY_REPO || this.env.CONTAINER_REGISTRY_REPO || 'asia-south1-docker.pkg.dev/dhan-trader-514002/dhan-api-docker/dhan-trader-api').trim();

    // Default configuration (all dynamically loaded from Firestore on startup)
    this.clientId = (process.env.DHAN_CLIENT_ID || this.env.DHAN_CLIENT_ID || '').trim();
    this.accessToken = (process.env.DHAN_ACCESS_TOKEN || this.env.DHAN_ACCESS_TOKEN || '').trim();
    this.telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN || this.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.telegramChatId = (process.env.TELEGRAM_CHAT_ID || this.env.TELEGRAM_CHAT_ID || '').trim();

    // In unit testing environment, provide default mock tokens if not provided
    if (process.env.NODE_ENV === 'test') {
      this.clientId = this.clientId || '1106885516';
      this.accessToken = this.accessToken || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTA2ODg1NTE2IiwiY2xpZW50SWQiOiIxMTA2ODg1NTE2IiwiaWF0IjoxNzMwODAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.test_token';
      this.telegramBotToken = this.telegramBotToken || '9055598050:AAGw88WggZZ0usCWWOo2-eksoVbvIx3iiuo';
      this.telegramChatId = this.telegramChatId || '8953936469';
    }
  }

  onModuleInit() {
    // Monitor .env for external URLs, credentials, and settings hot-reloading
    if (fs.existsSync(ENV_PATH)) {
      try {
        fs.watchFile(ENV_PATH, { interval: 2000 }, () => {
          this.reloadFromEnv();
        });
      } catch (err) {
        // Watcher error ignored
      }
    }
  }

  onModuleDestroy() {
    if (fs.existsSync(ENV_PATH)) {
      try {
        fs.unwatchFile(ENV_PATH);
      } catch (err) {}
    }
  }

  reloadFromEnv() {
    this.env = parseEnvFile(ENV_PATH);
    let changed = false;

    const syncVar = (key: string, currentVal: string, setter: (val: string) => void) => {
      const envVal = (this.env[key] || '').trim();
      if (envVal && envVal !== currentVal) {
        setter(envVal);
        process.env[key] = envVal;
        changed = true;
      }
    };

    syncVar('FIRESTORE_PROJECT_ID', this.firestoreProjectId, (v) => (this.firestoreProjectId = v));
    syncVar('FIRESTORE_DATABASE_ID', this.firestoreDatabaseId, (v) => (this.firestoreDatabaseId = v));
    syncVar('FIRESTORE_KEY_FILE', this.firestoreKeyFile, (v) => (this.firestoreKeyFile = v));
    syncVar('DHAN_API_BASE', this.dhanApiBase, (v) => (this.dhanApiBase = v));
    syncVar('DHAN_SCRIP_MASTER_URL', this.dhanScripMasterUrl, (v) => (this.dhanScripMasterUrl = v));
    syncVar('WEBHOOK_BASE_URL', this.webhookBaseUrl, (v) => (this.webhookBaseUrl = v));
    syncVar('TELEGRAM_API_BASE', this.telegramApiBase, (v) => (this.telegramApiBase = v));
    syncVar('YAHOO_FINANCE_BASE_URL', this.yahooFinanceBaseUrl, (v) => (this.yahooFinanceBaseUrl = v));
    syncVar('JWT_SECRET', this.jwtSecret, (v) => (this.jwtSecret = v));
    syncVar('CRON_SECRET', this.cronSecret, (v) => (this.cronSecret = v));
    syncVar('CLOUD_RUN_SERVICE', this.cloudRunService, (v) => (this.cloudRunService = v));
    syncVar('CLOUD_RUN_REGION', this.cloudRunRegion, (v) => (this.cloudRunRegion = v));
    syncVar('CONTAINER_REGISTRY_REPO', this.containerRegistryRepo, (v) => (this.containerRegistryRepo = v));

    if (changed) {
      this.notifyChange();
    }
  }

  getWebhookCallbackUrl(): string {
    const base = (this.webhookBaseUrl || process.env.WEBHOOK_BASE_URL || this.env.WEBHOOK_BASE_URL || '').trim();
    if (!base) return '';
    return `${base.replace(/\/+$/, '')}/api/webhooks/dhan`;
  }

  onChange(listener: (config: ConfigService) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange() {
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (err) {
        console.error('Error in config change listener:', err);
      }
    }
  }

  updateCredentials(
    creds: {
      clientId?: string;
      accessToken?: string;
      telegramBotToken?: string;
      telegramChatId?: string;
    },
    _persistEnv = false,
  ) {
    let changed = false;
    if (creds.clientId && creds.clientId !== this.clientId) {
      this.clientId = creds.clientId.trim();
      changed = true;
    }
    if (creds.accessToken && creds.accessToken !== this.accessToken) {
      this.accessToken = creds.accessToken.trim();
      changed = true;
    }
    if (creds.telegramBotToken !== undefined && creds.telegramBotToken !== this.telegramBotToken) {
      this.telegramBotToken = creds.telegramBotToken.trim();
      changed = true;
    }
    if (creds.telegramChatId !== undefined && creds.telegramChatId !== this.telegramChatId) {
      this.telegramChatId = creds.telegramChatId.trim();
      changed = true;
    }

    if (changed) {
      this.notifyChange();
    }

    return {
      clientId: this.clientId,
      accessToken: this.accessToken,
      telegramBotToken: this.telegramBotToken,
      telegramChatId: this.telegramChatId,
    };
  }

  persistToEnv() {
    // No-op: All application credentials & settings are managed exclusively in Google Cloud Firestore.
  }
}
