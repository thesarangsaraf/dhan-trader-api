import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { FirestoreService } from '../firestore/firestore.service';

@Injectable()
export class TelegramService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  async onModuleInit() {
    if (!this.isConfigured() && this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      try {
        const stored = await this.firestoreService.getTelegramConfig();
        if (stored?.botToken && stored?.chatId) {
          this.config.updateCredentials({
            telegramBotToken: stored.botToken,
            telegramChatId: stored.chatId,
          });
        }
      } catch {}
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.telegramChatId);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      chatId: this.config.telegramChatId
        ? `${this.config.telegramChatId.slice(0, 3)}***${this.config.telegramChatId.slice(-3)}`
        : 'Not Set',
      botConfigured: Boolean(this.config.telegramBotToken),
    };
  }

  async sendMessage(text: string, options: { parseMode?: string } = {}) {
    if (process.env.NODE_ENV === 'test') {
      return { success: false, reason: 'Test mode: external network suppressed' };
    }

    if (!this.isConfigured()) {
      return { success: false, reason: 'Telegram bot token or chat ID not configured' };
    }

    const apiBase = (this.config.telegramApiBase || process.env.TELEGRAM_API_BASE || '').trim();
    if (!apiBase) {
      return { success: false, reason: 'Telegram API base URL is not configured in .env or environment' };
    }
    const url = `${apiBase}/bot${this.config.telegramBotToken}/sendMessage`;
    const payload = {
      chat_id: this.config.telegramChatId,
      text,
      parse_mode: options.parseMode || 'HTML',
      disable_web_page_preview: true,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json();
      return {
        success: data.ok,
        data,
      };
    } catch (err: any) {
      console.warn('Telegram send failed:', err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  async sendTestNotification() {
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const msg = `
✅ <b>Dhan Trader Bot Connected!</b>
Telegram notification link verified successfully at ${timeStr} IST.
Real-time alerts and trade executions will appear here.
    `.trim();

    return this.sendMessage(msg);
  }
}
