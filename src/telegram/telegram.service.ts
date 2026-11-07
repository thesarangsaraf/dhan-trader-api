import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

function escapeHtml(text: any): string {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInr(val: number): string {
  if (isNaN(val)) return '0.00';
  return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
    // Event notifications stopped per user instruction (will decide later when to send)
    return { success: true, disabled: true, reason: 'Telegram event notifications disabled' };
  }

  formatOrderEventHtml(o: any): string {
    const status = (o.orderStatus || o.status || 'UNKNOWN').toUpperCase();
    const side = (o.transactionType || o.action || 'BUY').toUpperCase();
    const sideIcon = side === 'BUY' ? '🟢 BUY' : '🔴 SELL';

    let headerEmoji = '📋';
    let headerTitle = `DHAN ORDER UPDATE: ${status}`;
    if (status === 'TRADED' || status === 'FILLED' || status === 'EXECUTED') {
      headerEmoji = '✅';
      headerTitle = 'DHAN ORDER EXECUTED (TRADED)';
    } else if (status === 'PENDING' || status === 'TRANSIT') {
      headerEmoji = '⚡';
      headerTitle = 'DHAN ORDER PLACED (PENDING)';
    } else if (status === 'REJECTED') {
      headerEmoji = '❌';
      headerTitle = 'DHAN ORDER REJECTED';
    } else if (status === 'CANCELLED') {
      headerEmoji = '🚫';
      headerTitle = 'DHAN ORDER CANCELLED';
    } else if (status === 'EXPIRED') {
      headerEmoji = '⏳';
      headerTitle = 'DHAN ORDER EXPIRED';
    }

    const symbol = o.tradingSymbol || o.symbol || (o.securityId ? `Security #${o.securityId}` : 'N/A');
    const orderType = (o.orderType || 'MARKET').toUpperCase();
    let productType = (o.productType || 'INTRADAY').toUpperCase();
    if (productType === 'INTRADAY') productType = 'INTRADAY (MIS)';
    else if (productType === 'CNC') productType = 'CNC (Delivery)';

    const segment = o.exchangeSegment || 'NSE_EQ';
    const totalQty = parseInt(o.quantity || o.orderQty || 0, 10);
    const tradedQty = parseInt(o.tradedQuantity || o.filled_qty || (status === 'TRADED' ? totalQty : 0), 10);
    const avgPrice = parseFloat(o.averagePrice || o.tradedPrice || 0);
    const limitPrice = parseFloat(o.price || 0);
    const triggerPrice = parseFloat(o.triggerPrice || 0);

    const timeStr = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    const lines: string[] = [
      `${headerEmoji} <b>${headerTitle}</b> ${headerEmoji}`,
      '',
      `<b>Instrument:</b> <code>${escapeHtml(symbol)}</code>`,
      `<b>Side:</b> ${sideIcon} | <b>Type:</b> ${escapeHtml(orderType)}`,
      `<b>Product:</b> ${escapeHtml(productType)} | <b>Segment:</b> ${escapeHtml(segment)}`,
      `<b>Status:</b> <b>${escapeHtml(status)}</b>`,
      '',
      `📊 <b>Quantity & Price Details:</b>`,
      `• <b>Total Quantity:</b> ${totalQty} shares / units`,
    ];

    if (tradedQty > 0 || status === 'TRADED' || status === 'FILLED' || status === 'EXECUTED') {
      const fillPct = totalQty > 0 ? Math.round((tradedQty / totalQty) * 100) : 100;
      lines.push(`• <b>Traded Quantity:</b> ${tradedQty} shares (${fillPct}% filled)`);
      if (avgPrice > 0) {
        lines.push(`• <b>Avg Executed Price:</b> ₹${formatInr(avgPrice)}`);
        const totalVal = tradedQty * avgPrice;
        lines.push(`• <b>Executed Value:</b> ₹${formatInr(totalVal)}`);
      }
    } else {
      if (limitPrice > 0) {
        lines.push(`• <b>Limit Price:</b> ₹${formatInr(limitPrice)}`);
        if (totalQty > 0) {
          const estVal = totalQty * limitPrice;
          lines.push(`• <b>Estimated Value:</b> ₹${formatInr(estVal)}`);
        }
      } else {
        lines.push(`• <b>Order Price:</b> MARKET`);
      }
      if (triggerPrice > 0) {
        lines.push(`• <b>Trigger Price:</b> ₹${formatInr(triggerPrice)}`);
      }
    }

    // Derivative / Options Details if present
    if (o.drvStrikePrice || o.drvOptionsType || o.drvExpiryDate) {
      const optParts: string[] = [];
      if (o.drvStrikePrice) optParts.push(`Strike: ₹${o.drvStrikePrice}`);
      if (o.drvOptionsType) optParts.push(o.drvOptionsType.toUpperCase());
      if (o.drvExpiryDate) optParts.push(`Exp: ${o.drvExpiryDate}`);
      lines.push(`• <b>Contract:</b> ${escapeHtml(optParts.join(' | '))}`);
    }

    // Rejection details if rejected
    if (status === 'REJECTED' && (o.omsErrorDescription || o.omsErrorCode)) {
      lines.push('');
      lines.push(`⚠️ <b>Rejection Reason:</b> ${escapeHtml(o.omsErrorDescription || 'RMS / Exchange rejection')} ${o.omsErrorCode ? `(Code: ${escapeHtml(o.omsErrorCode)})` : ''}`);
    }

    lines.push('');
    lines.push(`🆔 <b>Identifiers & Tracking:</b>`);
    lines.push(`• <b>Order ID:</b> <code>${escapeHtml(o.orderId || 'N/A')}</code>`);
    if (o.exchangeOrderId) {
      lines.push(`• <b>Exchange Order ID:</b> <code>${escapeHtml(o.exchangeOrderId)}</code>`);
    }
    if (o.correlationId) {
      lines.push(`• <b>Correlation ID:</b> <code>${escapeHtml(o.correlationId)}</code>`);
    }

    lines.push('');
    lines.push(`⏱ <b>Time:</b> ${timeStr} IST`);

    return lines.join('\n');
  }

  async sendOrderEvent(order: any) {
    // Event notifications stopped per user instruction (will decide later when to send)
    return { success: true, disabled: true, reason: 'Telegram event notifications disabled' };
  }

  async sendOrderNotification(order: any, action = 'PLACED') {
    // Event notifications stopped per user instruction (will decide later when to send)
    return { success: true, disabled: true, reason: 'Telegram event notifications disabled' };
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
