import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { FirestoreService } from '../firestore/firestore.service';

function formatInr(val: number): string {
  if (isNaN(val)) return '0.00';
  return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface NtfySendOptions {
  topic?: string;
  serverUrl?: string;
  title?: string;
  message: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  tags?: string[];
  click?: string;
}

@Injectable()
export class NtfyService {
  private readonly logger = new Logger(NtfyService.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly firestoreService?: FirestoreService,
  ) {}

  /**
   * Resolve active ntfy topic from Firestore (primary) or ConfigService
   */
  async getTopic(): Promise<string> {
    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      try {
        const notifCfg = await this.firestoreService.getNotificationConfig();
        if (notifCfg?.ntfyTopic) {
          return notifCfg.ntfyTopic.trim();
        }
      } catch (err: any) {
        this.logger.warn(`Failed reading ntfy topic from Firestore: ${err.message}`);
      }
    }
    return (this.config.ntfyTopic || 'dhan-alerts-sarang-8821').trim();
  }

  /**
   * Resolve active ntfy server URL from Firestore or ConfigService
   */
  async getServerUrl(): Promise<string> {
    if (this.firestoreService && typeof this.firestoreService.isReady === 'function' && this.firestoreService.isReady()) {
      try {
        const notifCfg = await this.firestoreService.getNotificationConfig();
        if (notifCfg?.ntfyServerUrl) {
          return notifCfg.ntfyServerUrl.trim();
        }
      } catch {}
    }
    return (this.config.ntfyServerUrl || 'https://ntfy.sh').trim();
  }

  /**
   * Check if ntfy channel is configured
   */
  async isConfigured(): Promise<boolean> {
    const topic = await this.getTopic();
    return Boolean(topic && topic.length > 0);
  }

  /**
   * Get public subscription URL for this topic
   */
  async getSubscriptionUrl(): Promise<string> {
    const serverUrl = await this.getServerUrl();
    const topic = await this.getTopic();
    return `${serverUrl.replace(/\/+$/, '')}/${topic}`;
  }

  /**
   * Get live status of ntfy service
   */
  async getStatus(): Promise<{
    configured: boolean;
    topic: string;
    serverUrl: string;
    subscriptionUrl: string;
  }> {
    const topic = await this.getTopic();
    const serverUrl = await this.getServerUrl();
    return {
      configured: Boolean(topic && topic.length > 0),
      topic,
      serverUrl,
      subscriptionUrl: `${serverUrl.replace(/\/+$/, '')}/${topic}`,
    };
  }

  /**
   * Send notification to ntfy.sh topic
   */
  async sendNotification(options: NtfySendOptions): Promise<{
    success: boolean;
    topic?: string;
    data?: any;
    error?: string;
    reason?: string;
  }> {
    if (process.env.NODE_ENV === 'test') {
      return { success: true, topic: options.topic || 'test-topic', reason: 'Test mode: external network suppressed' };
    }

    const topic = (options.topic || (await this.getTopic())).trim();
    if (!topic) {
      return { success: false, reason: 'ntfy topic is not configured' };
    }

    const serverUrl = (options.serverUrl || (await this.getServerUrl())).trim().replace(/\/+$/, '');
    const url = `${serverUrl}/${topic}`;

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Markdown': 'yes',
    };

    if (options.title) {
      headers['Title'] = options.title;
    }

    if (options.priority) {
      headers['Priority'] = options.priority;
    }

    if (options.tags && options.tags.length > 0) {
      headers['Tags'] = options.tags.join(',');
    }

    if (options.click) {
      headers['Click'] = options.click;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: options.message,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(`ntfy.sh returned HTTP ${response.status}: ${errorText}`);
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const responseData = await response.json().catch(() => ({ status: 'ok' }));
      this.logger.log(`📱 ntfy.sh notification sent successfully to topic [${topic}]`);
      return {
        success: true,
        topic,
        data: responseData,
      };
    } catch (err: any) {
      this.logger.warn(`ntfy send failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Send test notification to verify connection
   */
  async sendTestNotification(topicOverride?: string): Promise<any> {
    const topic = topicOverride ? topicOverride.trim() : await this.getTopic();
    const timeStr = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const markdownMessage = [
      `### 🔔 Dhan Trader & ntfy.sh Connected!`,
      ``,
      `Real-time postback updates and execution alerts will be pushed to your Android phone on this topic.`,
      ``,
      `• **Topic:** \`${topic}\``,
      `• **Status:** Active & Verified`,
      `• **Verified At:** ${timeStr} IST`,
    ].join('\n');

    return this.sendNotification({
      topic,
      title: '✅ Dhan Trader Connected!',
      message: markdownMessage,
      priority: 'default',
      tags: ['white_check_mark', 'bell'],
    });
  }

  /**
   * Format postback order/alert execution data into Markdown suitable for ntfy.sh
   */
  formatPostbackMessage(params: {
    orderStatus: string;
    action: string;
    instrumentName: string;
    targetPrice: number;
    operator: string;
    remarks: string;
    attachedSymbol: string;
    quantity: number;
    lots: number;
    executionPrice: number;
    totalValue: number;
    orderType: string;
    productType: string;
    exchangeSegment: string;
    strikePrice?: number;
    optionType?: string;
    expiryDate?: string;
    orderId: string;
    correlationId: string | null;
    omsErrorCode: string | null;
    omsErrorDescription: string | null;
  }): { title: string; message: string; priority: 'min' | 'low' | 'default' | 'high' | 'urgent'; tags: string[] } {
    const {
      orderStatus,
      action,
      instrumentName,
      targetPrice,
      operator,
      remarks,
      attachedSymbol,
      quantity,
      lots,
      executionPrice,
      totalValue,
      orderType,
      productType,
      exchangeSegment,
      strikePrice,
      optionType,
      expiryDate,
      orderId,
      correlationId,
      omsErrorCode,
      omsErrorDescription,
    } = params;

    const sideIcon = action === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    let title = `⚡ Dhan Alert: ${instrumentName} (${orderStatus})`;
    let priority: 'min' | 'low' | 'default' | 'high' | 'urgent' = 'default';
    let tags: string[] = ['bell'];

    let headerBanner = `### ⚡ DHAN ALERT TRIGGERED & ORDER EXECUTED ✅`;

    if (orderStatus === 'TRADED' || orderStatus === 'FILLED' || orderStatus === 'EXECUTED') {
      title = `✅ Dhan Trade: ${attachedSymbol} (${action})`;
      priority = 'high';
      tags = action === 'BUY' ? ['chart_with_upwards_trend', 'white_check_mark'] : ['chart_with_downwards_trend', 'white_check_mark'];
      headerBanner = `### ⚡ DHAN ALERT TRIGGERED & ORDER EXECUTED ✅`;
    } else if (orderStatus === 'REJECTED') {
      title = `⚠️ Dhan Order REJECTED: ${attachedSymbol}`;
      priority = 'urgent';
      tags = ['warning', 'rotating_light'];
      headerBanner = `### ⚠️ DHAN ALERT TRIGGERED — ORDER REJECTED ❌`;
    } else if (orderStatus === 'PENDING' || orderStatus === 'TRANSIT') {
      title = `⏳ Dhan Order Placed: ${attachedSymbol}`;
      priority = 'default';
      tags = ['hourglass_flowing_sand'];
      headerBanner = `### ⚡ DHAN ALERT TRIGGERED — ORDER PLACED (PENDING) ⏳`;
    } else if (orderStatus === 'CANCELLED') {
      title = `🚫 Dhan Order Cancelled: ${attachedSymbol}`;
      priority = 'default';
      tags = ['no_entry_sign'];
      headerBanner = `### 🚫 DHAN ALERT TRIGGERED — ORDER CANCELLED`;
    }

    const timeStr = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const lines: string[] = [
      headerBanner,
      ``,
      `**🎯 Trigger Alert Details:**`,
      `• **Instrument:** \`${instrumentName}\``,
      `• **Trigger Price Level:** ₹${formatInr(targetPrice)}`,
    ];

    if (operator && operator !== 'TARGET_MET') {
      lines.push(`• **Condition:** Price crossed target (\`${operator}\`)`);
    }

    if (remarks) {
      lines.push(`• **Note:** ${remarks}`);
    }

    lines.push(``);
    lines.push(`**📦 Attached Order Execution:**`);
    lines.push(`• **Action:** ${sideIcon}`);
    lines.push(`• **Contract / Symbol:** \`${attachedSymbol}\``);
    lines.push(`• **Order Status:** **${orderStatus}**`);

    const lotsDisplay = lots > 0 ? ` (${lots} ${lots === 1 ? 'lot' : 'lots'})` : '';
    lines.push(`• **Quantity:** ${quantity} units${lotsDisplay}`);

    if (executionPrice > 0) {
      lines.push(`• **Execution Price:** ₹${formatInr(executionPrice)}`);
      if (totalValue > 0) {
        lines.push(`• **Traded Value:** ₹${formatInr(totalValue)}`);
      }
    } else {
      lines.push(`• **Price:** MARKET`);
    }

    lines.push(`• **Type & Product:** ${orderType} | ${productType}`);

    if (strikePrice || optionType || expiryDate) {
      lines.push(``);
      lines.push(`**📋 Option Contract Details:**`);
      if (strikePrice) lines.push(`• **Strike Price:** ₹${formatInr(strikePrice)}`);
      if (optionType) lines.push(`• **Option Type:** ${optionType}`);
      if (expiryDate) lines.push(`• **Expiry Date:** ${expiryDate}`);
    }

    if (orderStatus === 'REJECTED' && (omsErrorDescription || omsErrorCode)) {
      lines.push(``);
      lines.push(`**⚠️ Rejection Details:**`);
      lines.push(`• **Reason:** ${omsErrorDescription || 'RMS / Exchange rejection'}`);
      if (omsErrorCode) lines.push(`• **Error Code:** \`${omsErrorCode}\``);
    }

    lines.push(``);
    lines.push(`**🆔 Identifiers & Tracking:**`);
    lines.push(`• **Order ID:** \`${orderId}\``);
    if (correlationId) {
      lines.push(`• **Correlation ID:** \`${correlationId}\``);
    }
    lines.push(`• **Segment:** ${exchangeSegment}`);
    lines.push(`• **Execution Time:** ${timeStr} IST`);

    return {
      title,
      message: lines.join('\n'),
      priority,
      tags,
    };
  }
}
