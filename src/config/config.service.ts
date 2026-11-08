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

  // Google Cloud Firestore is the ONLY configuration sourced from .env
  public firestoreProjectId: string;
  public firestoreDatabaseId: string;
  public firestoreKeyFile: string;

  private env: Record<string, string>;
  private listeners: Set<(config: ConfigService) => void> = new Set();

  constructor() {
    this.env = parseEnvFile(ENV_PATH);

    // Google Cloud Firestore credentials (the only config retained in .env)
    this.firestoreProjectId = (process.env.FIRESTORE_PROJECT_ID || this.env.FIRESTORE_PROJECT_ID || 'dhan-trader-514002').trim();
    this.firestoreDatabaseId = (process.env.FIRESTORE_DATABASE_ID || this.env.FIRESTORE_DATABASE_ID || 'dhan-trader-firebase-db').trim();
    this.firestoreKeyFile = (process.env.FIRESTORE_KEY_FILE || this.env.FIRESTORE_KEY_FILE || 'google-service-account-key.json').trim();

    // Default configuration (all dynamically loaded from Firestore on startup)
    this.clientId = (process.env.DHAN_CLIENT_ID || '').trim();
    this.accessToken = (process.env.DHAN_ACCESS_TOKEN || '').trim();
    this.telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.telegramChatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    this.port = parseInt(process.env.PORT || '8000', 10);
    this.host = process.env.HOST || '127.0.0.1';
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);
    this.dhanApiBase = (process.env.DHAN_API_BASE || 'https://api.dhan.co/v2').trim();

    // In unit testing environment, provide default mock tokens if not provided
    if (process.env.NODE_ENV === 'test') {
      this.clientId = this.clientId || '1106885516';
      this.accessToken = this.accessToken || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTA2ODg1NTE2IiwiY2xpZW50SWQiOiIxMTA2ODg1NTE2IiwiaWF0IjoxNzMwODAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.test_token';
      this.telegramBotToken = this.telegramBotToken || '9055598050:AAGw88WggZZ0usCWWOo2-eksoVbvIx3iiuo';
      this.telegramChatId = this.telegramChatId || '8953936469';
    }
  }

  onModuleInit() {
    // Only monitor .env for Firestore connection credential changes
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
    const envFsProject = (this.env.FIRESTORE_PROJECT_ID || '').trim();
    const envFsDb = (this.env.FIRESTORE_DATABASE_ID || '').trim();
    const envFsKey = (this.env.FIRESTORE_KEY_FILE || '').trim();

    if (envFsProject && envFsProject !== this.firestoreProjectId) {
      this.firestoreProjectId = envFsProject;
      changed = true;
    }
    if (envFsDb && envFsDb !== this.firestoreDatabaseId) {
      this.firestoreDatabaseId = envFsDb;
      changed = true;
    }
    if (envFsKey && envFsKey !== this.firestoreKeyFile) {
      this.firestoreKeyFile = envFsKey;
      changed = true;
    }

    if (changed) {
      this.notifyChange();
    }
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
