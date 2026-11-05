import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class TelegramService {
  constructor(private readonly config: ConfigService) {}

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

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
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

  async sendAlertNotification(alert: any) {
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const op = alert.operator.includes('GREATER') || alert.operator.includes('UP')
      ? '≥ Crossing Up'
      : '≤ Crossing Down';

    const msg = `
🚨 <b>DHAN TRADER PRICE ALERT TRIGGERED</b> 🚨

<b>Instrument:</b> ${alert.instrument}
<b>Trigger Price:</b> ₹${alert.triggeredPrice || alert.currentPrice}
<b>Target Level:</b> ₹${alert.targetPrice} (${op})
<b>Time:</b> ${timeStr} IST
<b>Remarks:</b> ${alert.remarks || 'None'}
    `.trim();

    return this.sendMessage(msg);
  }

  async sendOrderNotification(order: any, action = 'PLACED') {
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const sideIcon = order.transactionType === 'BUY' ? '🟢 BUY' : '🔴 SELL';

    const msg = `
⚡ <b>DHAN ORDER ${action}</b> ⚡

<b>Symbol:</b> ${order.symbol}
<b>Side:</b> ${sideIcon}
<b>Quantity:</b> ${order.quantity}
<b>Price:</b> ₹${order.price || 'MARKET'}
<b>Type:</b> ${order.orderType} | ${order.productType}
<b>Status:</b> ${order.status}
<b>Order ID:</b> <code>${order.orderId}</code>
<b>Time:</b> ${timeStr} IST
    `.trim();

    return this.sendMessage(msg);
  }

  async sendStrategyNotification(summary: any) {
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    const msg = `
🎯 <b>AUTO-SL STRATEGY DEPLOYED</b> 🎯

<b>Symbol:</b> ${summary.symbol}
<b>Quantity:</b> ${summary.quantity}
<b>Entry:</b> ₹${summary.entryPrice}
<b>Stop Loss:</b> ₹${summary.slPrice} (-${summary.slPoints} pts)
<b>Profit Target:</b> ₹${summary.targetPrice} (+${summary.targetPoints} pts)
<b>Risk:Reward:</b> ${summary.riskRewardRatio}
<b>Time:</b> ${timeStr} IST
    `.trim();

    return this.sendMessage(msg);
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
