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

  private env: Record<string, string>;
  private listeners: Set<(config: ConfigService) => void> = new Set();

  constructor() {
    this.env = parseEnvFile(ENV_PATH);
    this.clientId = (process.env.DHAN_CLIENT_ID || this.env.DHAN_CLIENT_ID || '').trim();
    this.accessToken = (process.env.DHAN_ACCESS_TOKEN || this.env.DHAN_ACCESS_TOKEN || '').trim();
    this.telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN || this.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.telegramChatId = (process.env.TELEGRAM_CHAT_ID || this.env.TELEGRAM_CHAT_ID || '').trim();
    this.port = parseInt(process.env.PORT || this.env.PORT || '8000', 10);
    this.host = process.env.HOST || this.env.HOST || '127.0.0.1';
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || this.env.POLL_INTERVAL_MS || '4000', 10);
    this.dhanApiBase = (process.env.DHAN_API_BASE || 'https://api.dhan.co/v2').trim();
  }

  onModuleInit() {
    if (fs.existsSync(ENV_PATH)) {
      try {
        fs.watchFile(ENV_PATH, { interval: 1000 }, () => {
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
    const envClientId = (this.env.DHAN_CLIENT_ID || '').trim();
    const envAccessToken = (this.env.DHAN_ACCESS_TOKEN || '').trim();
    const envTgToken = (this.env.TELEGRAM_BOT_TOKEN || '').trim();
    const envTgChat = (this.env.TELEGRAM_CHAT_ID || '').trim();

    if (envClientId && envClientId !== this.clientId) {
      this.clientId = envClientId;
      changed = true;
    }
    if (envAccessToken && envAccessToken !== this.accessToken) {
      this.accessToken = envAccessToken;
      changed = true;
    }
    if (envTgToken && envTgToken !== this.telegramBotToken) {
      this.telegramBotToken = envTgToken;
      changed = true;
    }
    if (envTgChat && envTgChat !== this.telegramChatId) {
      this.telegramChatId = envTgChat;
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

  updateCredentials(creds: {
    clientId?: string;
    accessToken?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
  }) {
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
      this.persistToEnv();
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
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    let lines: string[] = [];
    if (fs.existsSync(ENV_PATH)) {
      lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    }

    const keysToUpdate: Record<string, string> = {
      DHAN_CLIENT_ID: `'${this.clientId}'`,
      DHAN_ACCESS_TOKEN: `'${this.accessToken}'`,
      TELEGRAM_BOT_TOKEN: `'${this.telegramBotToken}'`,
      TELEGRAM_CHAT_ID: `'${this.telegramChatId}'`,
      PORT: String(this.port),
      HOST: this.host,
      POLL_INTERVAL_MS: String(this.pollIntervalMs),
    };

    const updatedKeys = new Set<string>();
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        if (key in keysToUpdate) {
          updatedKeys.add(key);
          return `${key}=${keysToUpdate[key]}`;
        }
      }
      return line;
    });

    for (const [key, val] of Object.entries(keysToUpdate)) {
      if (!updatedKeys.has(key)) {
        newLines.push(`${key}=${val}`);
      }
    }

    fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf8');
  }
}
