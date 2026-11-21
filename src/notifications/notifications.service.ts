import { Injectable, Logger, Optional } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';
import { NtfyService } from './ntfy.service';
import { FirestoreService, NotificationConfig } from '../firestore/firestore.service';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';

export interface NotificationSettingsSummary {
  telegram: {
    enabled: boolean;
    configured: boolean;
    chatId: string;
    botConfigured: boolean;
  };
  ntfy: {
    enabled: boolean;
    configured: boolean;
    topic: string;
    serverUrl: string;
    subscriptionUrl: string;
  };
  updatedAt?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly ntfyService: NtfyService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  /**
   * Retrieve active notification settings from Firestore config/notifications
   */
  async getSettings(): Promise<NotificationSettingsSummary> {
    let cfg: NotificationConfig = {
      telegramEnabled: true,
      ntfyEnabled: true,
      ntfyTopic: 'dhan-alerts-sarang-8821',
      ntfyServerUrl: 'https://ntfy.sh',
    };

    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      try {
        cfg = await this.firestoreService.getNotificationConfig();
      } catch (err: any) {
        this.logger.warn(`Could not read notification config from Firestore: ${err.message}`);
      }
    }

    const tgStatus = this.telegramService.getStatus();
    const ntfyStatus = await this.ntfyService.getStatus();

    return {
      telegram: {
        enabled: Boolean(cfg.telegramEnabled),
        configured: tgStatus.configured,
        chatId: tgStatus.chatId,
        botConfigured: tgStatus.botConfigured,
      },
      ntfy: {
        enabled: Boolean(cfg.ntfyEnabled),
        configured: ntfyStatus.configured,
        topic: cfg.ntfyTopic || ntfyStatus.topic,
        serverUrl: cfg.ntfyServerUrl || ntfyStatus.serverUrl,
        subscriptionUrl: ntfyStatus.subscriptionUrl,
      },
      updatedAt: cfg.updatedAt,
    };
  }

  /**
   * Update notification settings and persist to Google Cloud Firestore (config/notifications)
   */
  async updateSettings(dto: UpdateNotificationSettingsDto): Promise<NotificationSettingsSummary> {
    if (!this.firestoreService || !this.firestoreService.isReady()) {
      throw new Error('Firestore is not ready. Cannot persist notification settings.');
    }

    await this.firestoreService.saveNotificationConfig({
      telegramEnabled: dto.telegramEnabled,
      ntfyEnabled: dto.ntfyEnabled,
      ntfyTopic: dto.ntfyTopic,
      ntfyServerUrl: dto.ntfyServerUrl,
    });

    this.logger.log(`⚙️ Notification settings updated in Firestore: telegram=${dto.telegramEnabled}, ntfy=${dto.ntfyEnabled}`);
    return this.getSettings();
  }

  /**
   * Dispatch test notifications to all active/enabled channels
   */
  async sendTestNotification(): Promise<{
    telegram: { sent: boolean; reason?: string; error?: string };
    ntfy: { sent: boolean; reason?: string; error?: string };
  }> {
    const settings = await this.getSettings();
    const result: {
      telegram: { sent: boolean; reason?: string; error?: string };
      ntfy: { sent: boolean; reason?: string; error?: string };
    } = {
      telegram: { sent: false, reason: 'Telegram disabled in settings' },
      ntfy: { sent: false, reason: 'ntfy.sh disabled in settings' },
    };

    // 1. Test Telegram if enabled
    if (settings.telegram.enabled) {
      if (settings.telegram.configured) {
        const tgRes = await this.telegramService.sendTestNotification();
        result.telegram = {
          sent: Boolean(tgRes && tgRes.success),
          reason: tgRes?.reason,
          error: tgRes?.error,
        };
      } else {
        result.telegram = { sent: false, reason: 'Telegram bot token or chat ID not configured' };
      }
    }

    // 2. Test ntfy if enabled
    if (settings.ntfy.enabled) {
      const ntfyRes = await this.ntfyService.sendTestNotification();
      result.ntfy = {
        sent: Boolean(ntfyRes && ntfyRes.success),
        reason: ntfyRes?.reason,
        error: ntfyRes?.error,
      };
    }

    return result;
  }
}
