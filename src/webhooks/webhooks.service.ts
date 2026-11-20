import { Injectable, Logger, Optional } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';
import { AlertsService } from '../alerts/alerts.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { DhanWebhookDto } from './dto/dhan-webhook.dto';

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
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly telegramService: TelegramService,
    @Optional() private readonly alertsService?: AlertsService,
    @Optional() private readonly instrumentsService?: InstrumentsService,
  ) {}

  /**
   * Process Dhan Postback / Webhook POST payload.
   * Matches alert and attached order details, updates alert state,
   * formats a comprehensive message, and dispatches it immediately to Telegram.
   */
  async handleDhanWebhook(dto: DhanWebhookDto): Promise<{
    success: boolean;
    message: string;
    matchedAlertId?: string;
    telegramSent: boolean;
    telegramReason?: string;
    data: {
      orderId?: string;
      orderStatus?: string;
      instrument?: string;
      targetPrice?: number;
      action?: string;
      attachedSymbol?: string;
      price?: number;
      quantity?: number;
    };
  }> {
    this.logger.log(
      `📥 Received Dhan Webhook: orderId=${dto.orderId || 'N/A'}, status=${dto.orderStatus || 'N/A'}, symbol=${dto.tradingSymbol || 'N/A'}`,
    );

    const orderStatus = (dto.orderStatus || 'UNKNOWN').toUpperCase();
    const action = (dto.transactionType || 'BUY').toUpperCase();

    // 1. Locate matching alert in AlertsService if available
    const matchedAlert = this.findMatchingAlert(dto);
    if (matchedAlert) {
      this.updateAlertFromWebhook(matchedAlert, dto);
    }

    // 2. Resolve trigger instrument name and target price level
    const { instrumentName, targetPrice, operator, remarks } = this.resolveTriggerInfo(dto, matchedAlert);

    // 3. Resolve attached order instrument and contract details
    const orderDetails = this.resolveOrderDetails(dto, matchedAlert, instrumentName);

    // 4. Construct high-visibility Telegram message
    const messageHtml = this.formatTelegramMessage({
      orderStatus,
      action,
      instrumentName,
      targetPrice,
      operator,
      remarks,
      ...orderDetails,
      orderId: dto.orderId || 'N/A',
      correlationId: dto.correlationId || matchedAlert?.id || null,
      exchangeSegment: dto.exchangeSegment || orderDetails.exchangeSegment || 'NSE_FNO',
      omsErrorCode: dto.omsErrorCode || null,
      omsErrorDescription: dto.omsErrorDescription || null,
    });

    // 5. Send message immediately to Telegram
    let teleRes: any = { success: false, reason: 'TelegramService not available' };
    if (this.telegramService && typeof this.telegramService.sendMessage === 'function') {
      teleRes = await this.telegramService.sendMessage(messageHtml, { parseMode: 'HTML' });
    }
    const telegramSent = Boolean(teleRes && teleRes.success);

    this.logger.log(
      `✈️ Telegram notification ${telegramSent ? 'dispatched successfully' : 'suppressed/failed'}: ${teleRes?.reason || 'OK'}`,
    );

    return {
      success: true,
      message: 'Dhan webhook processed and Telegram alert notification evaluated',
      matchedAlertId: matchedAlert?.id,
      telegramSent,
      telegramReason: teleRes?.reason,
      data: {
        orderId: dto.orderId,
        orderStatus,
        instrument: instrumentName,
        targetPrice,
        action,
        attachedSymbol: orderDetails.attachedSymbol,
        price: orderDetails.executionPrice,
        quantity: orderDetails.quantity,
      },
    };
  }

  /**
   * Search memory alerts for the corresponding alert rule
   */
  private findMatchingAlert(dto: DhanWebhookDto): any {
    if (!this.alertsService) return null;
    const allAlerts = this.alertsService.alerts || [];

    // Strategy A: Match by correlationId
    if (dto.correlationId) {
      const match = allAlerts.find(
        (a) =>
          a.id === dto.correlationId ||
          a.dhanAlertId === dto.correlationId ||
          `DHAN-${a.dhanAlertId}` === dto.correlationId ||
          (a.remarks && a.remarks.includes(dto.correlationId)),
      );
      if (match) return match;
    }

    // Strategy B: Match by orderId on attachedOrder or conditionalOrders
    if (dto.orderId) {
      const match = allAlerts.find(
        (a) =>
          a.attachedOrder?.orderId === dto.orderId ||
          (Array.isArray(a.conditionalOrders) && a.conditionalOrders.some((o: any) => o.orderId === dto.orderId)) ||
          (Array.isArray(a.orders) && a.orders.some((o: any) => o.orderId === dto.orderId)),
      );
      if (match) return match;
    }

    // Strategy C: Match by securityId on attached contract
    if (dto.securityId) {
      const match = allAlerts.find(
        (a) =>
          a.status === 'ACTIVE' &&
          (a.attachedOrder?.securityId === String(dto.securityId) ||
            (Array.isArray(a.conditionalOrders) && a.conditionalOrders.some((o: any) => String(o.securityId) === String(dto.securityId)))),
      );
      if (match) return match;
    }

    // Strategy D: Match active alert by triggerPrice or instrument
    if (dto.triggerPrice && dto.triggerPrice > 0) {
      const match = allAlerts.find(
        (a) => a.status === 'ACTIVE' && Math.abs(a.targetPrice - (dto.triggerPrice || 0)) <= a.targetPrice * 0.005,
      );
      if (match) return match;
    }

    return null;
  }

  /**
   * Update the internal alert state to reflect the webhook event
   */
  private updateAlertFromWebhook(alert: any, dto: DhanWebhookDto): void {
    const status = (dto.orderStatus || 'TRADED').toUpperCase();

    if (status === 'TRADED' || status === 'FILLED' || status === 'EXECUTED') {
      alert.status = 'TRIGGERED';
      alert.triggeredAt = new Date().toISOString();
      if (dto.price) alert.triggeredPrice = dto.price;
    }

    if (alert.attachedOrder) {
      alert.attachedOrder.status = status;
      if (dto.orderId) alert.attachedOrder.orderId = dto.orderId;
      if (dto.price) alert.attachedOrder.price = dto.price;
      alert.attachedOrder.executedAt = new Date().toISOString();
    }

    if (Array.isArray(alert.conditionalOrders)) {
      for (const ord of alert.conditionalOrders) {
        if (!dto.securityId || String(ord.securityId) === String(dto.securityId) || ord.orderId === dto.orderId) {
          ord.status = status;
          if (dto.orderId) ord.orderId = dto.orderId;
          if (dto.price) ord.price = dto.price;
          ord.executedAt = new Date().toISOString();
        }
      }
    }
  }

  /**
   * Resolve the primary trigger instrument and trigger price
   */
  private resolveTriggerInfo(
    dto: DhanWebhookDto,
    matchedAlert: any,
  ): {
    instrumentName: string;
    targetPrice: number;
    operator: string;
    remarks: string;
  } {
    // 1. Explicit in DTO enrichment
    if (dto.alertInstrument) {
      return {
        instrumentName: dto.alertInstrument,
        targetPrice: dto.alertTargetPrice || dto.triggerPrice || dto.price || 0,
        operator: 'GREATER_THAN_EQUAL',
        remarks: dto.alertRemarks || 'Price Alert Trigger',
      };
    }

    // 2. From matched alert in database/memory
    if (matchedAlert) {
      return {
        instrumentName: matchedAlert.instrument || 'NIFTY 50',
        targetPrice: matchedAlert.targetPrice || dto.triggerPrice || 0,
        operator: matchedAlert.operator || 'GREATER_THAN_EQUAL',
        remarks: matchedAlert.remarks || '',
      };
    }

    // 3. Fallback: deduce underlying index from tradingSymbol or securityId
    let inferred = 'NIFTY 50';
    const sym = (dto.tradingSymbol || '').toUpperCase();
    if (sym.includes('BANKNIFTY') || sym.includes('BANK NIFTY')) {
      inferred = 'BANK NIFTY';
    } else if (sym.includes('MIDCP') || sym.includes('MIDCAP')) {
      inferred = 'MIDCAP NIFTY';
    } else if (sym.includes('SENSEX')) {
      inferred = 'SENSEX';
    } else if (sym.includes('NIFTY')) {
      inferred = 'NIFTY 50';
    } else if (dto.securityId && this.instrumentsService) {
      const meta = this.instrumentsService.findBySecurityId(dto.securityId);
      if (meta?.name) inferred = meta.name;
    }

    return {
      instrumentName: inferred,
      targetPrice: dto.triggerPrice || dto.price || 0,
      operator: 'TARGET_MET',
      remarks: 'Automated Dhan Conditional Trigger',
    };
  }

  /**
   * Resolve attached order details (symbol, strike, option type, lots, price, value)
   */
  private resolveOrderDetails(
    dto: DhanWebhookDto,
    matchedAlert: any,
    triggerInstrument: string,
  ): {
    attachedSymbol: string;
    quantity: number;
    lots: number;
    executionPrice: number;
    orderType: string;
    productType: string;
    exchangeSegment: string;
    strikePrice?: number;
    optionType?: string;
    expiryDate?: string;
    totalValue: number;
  } {
    let attachedSymbol =
      dto.tradingSymbol ||
      matchedAlert?.attachedOrder?.symbol ||
      matchedAlert?.attachedOrder?.tradingSymbol ||
      matchedAlert?.attachedOrder?.customSymbol ||
      '';

    let secMeta: any;
    if (dto.securityId && this.instrumentsService) {
      secMeta = this.instrumentsService.findBySecurityId(dto.securityId);
      if (secMeta && !attachedSymbol) {
        attachedSymbol = secMeta.customSymbol || secMeta.symbol || secMeta.tradingSymbol || '';
      }
    }

    if (!attachedSymbol) {
      attachedSymbol = dto.securityId ? `Security #${dto.securityId}` : triggerInstrument;
    }

    const qty = parseInt(String(dto.filled_qty || dto.tradedQuantity || dto.quantity || matchedAlert?.attachedOrder?.quantity || 0), 10);
    const execPrice = parseFloat(String(dto.averagePrice || dto.price || matchedAlert?.attachedOrder?.price || 0));

    // Resolve lot size and computed lots
    let lotSize = 1;
    if (secMeta?.lotSize) {
      lotSize = secMeta.lotSize;
    } else if (this.instrumentsService) {
      lotSize = this.instrumentsService.getLotSizeForInstrument(attachedSymbol || triggerInstrument) || 1;
    }
    const computedLots = lotSize > 1 && qty > 0 ? Math.round((qty / lotSize) * 100) / 100 : 1;

    let orderType = (dto.orderType || matchedAlert?.attachedOrder?.orderType || 'MARKET').toUpperCase();
    let productType = (dto.productType || matchedAlert?.attachedOrder?.productType || 'INTRADAY').toUpperCase();
    if (productType === 'INTRADAY') productType = 'INTRADAY (MIS)';
    else if (productType === 'CNC') productType = 'CNC (Delivery)';
    else if (productType === 'MARGIN') productType = 'MARGIN (NRML)';

    const exchangeSegment = dto.exchangeSegment || matchedAlert?.attachedOrder?.exchangeSegment || secMeta?.exchangeSegment || 'NSE_FNO';
    const strikePrice = dto.drvStrikePrice || secMeta?.strikePrice || matchedAlert?.attachedOrder?.strikePrice;
    const optionType = (dto.drvOptionType || secMeta?.optionType || matchedAlert?.attachedOrder?.optionType || '').toUpperCase();
    const expiryDate = dto.drvExpiryDate || secMeta?.expiryDate || matchedAlert?.attachedOrder?.expiryDate;

    const totalValue = qty > 0 && execPrice > 0 ? qty * execPrice : 0;

    return {
      attachedSymbol,
      quantity: qty,
      lots: computedLots,
      executionPrice: execPrice,
      orderType,
      productType,
      exchangeSegment,
      strikePrice,
      optionType,
      expiryDate,
      totalValue,
    };
  }

  /**
   * Format message in Telegram HTML parse mode
   */
  formatTelegramMessage(params: {
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
  }): string {
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

    // Header banner based on execution status
    let headerBanner = `⚡ <b>DHAN ALERT TRIGGERED &amp; ORDER EXECUTED</b> ✅`;
    if (orderStatus === 'REJECTED') {
      headerBanner = `⚠️ <b>DHAN ALERT TRIGGERED — ORDER REJECTED</b> ❌`;
    } else if (orderStatus === 'PENDING' || orderStatus === 'TRANSIT') {
      headerBanner = `⚡ <b>DHAN ALERT TRIGGERED — ORDER PLACED (PENDING)</b> ⏳`;
    } else if (orderStatus === 'CANCELLED') {
      headerBanner = `🚫 <b>DHAN ALERT TRIGGERED — ORDER CANCELLED</b>`;
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
      '',
      `🎯 <b>Trigger Alert Details:</b>`,
      `• <b>Instrument:</b> <code>${escapeHtml(instrumentName)}</code>`,
      `• <b>Trigger Price Level:</b> ₹${formatInr(targetPrice)}`,
    ];

    if (operator && operator !== 'TARGET_MET') {
      lines.push(`• <b>Condition:</b> Price crossed target (<code>${escapeHtml(operator)}</code>)`);
    }

    if (remarks) {
      lines.push(`• <b>Note:</b> ${escapeHtml(remarks)}`);
    }

    lines.push('');
    lines.push(`📦 <b>Attached Order Execution:</b>`);
    lines.push(`• <b>Action:</b> ${sideIcon}`);
    lines.push(`• <b>Contract / Symbol:</b> <code>${escapeHtml(attachedSymbol)}</code>`);
    lines.push(`• <b>Order Status:</b> <b>${escapeHtml(orderStatus)}</b>`);

    const lotsDisplay = lots > 0 ? ` (${lots} ${lots === 1 ? 'lot' : 'lots'})` : '';
    lines.push(`• <b>Quantity:</b> ${quantity} units${lotsDisplay}`);

    if (executionPrice > 0) {
      lines.push(`• <b>Execution Price:</b> ₹${formatInr(executionPrice)}`);
      if (totalValue > 0) {
        lines.push(`• <b>Traded Value:</b> ₹${formatInr(totalValue)}`);
      }
    } else {
      lines.push(`• <b>Price:</b> MARKET`);
    }

    lines.push(`• <b>Type &amp; Product:</b> ${escapeHtml(orderType)} | ${escapeHtml(productType)}`);

    // Option / Derivative Contract Details if applicable
    if (strikePrice || optionType || expiryDate) {
      lines.push('');
      lines.push(`📋 <b>Option Contract Details:</b>`);
      if (strikePrice) lines.push(`• <b>Strike Price:</b> ₹${formatInr(strikePrice)}`);
      if (optionType) lines.push(`• <b>Option Type:</b> ${escapeHtml(optionType)}`);
      if (expiryDate) lines.push(`• <b>Expiry Date:</b> ${escapeHtml(expiryDate)}`);
    }

    // OMS Rejection Details if failed
    if (orderStatus === 'REJECTED' && (omsErrorDescription || omsErrorCode)) {
      lines.push('');
      lines.push(`⚠️ <b>Rejection Details:</b>`);
      lines.push(`• <b>Reason:</b> ${escapeHtml(omsErrorDescription || 'RMS / Exchange rejection')}`);
      if (omsErrorCode) lines.push(`• <b>Error Code:</b> <code>${escapeHtml(omsErrorCode)}</code>`);
    }

    lines.push('');
    lines.push(`🆔 <b>Identifiers &amp; Tracking:</b>`);
    lines.push(`• <b>Order ID:</b> <code>${escapeHtml(orderId)}</code>`);
    if (correlationId) {
      lines.push(`• <b>Correlation ID:</b> <code>${escapeHtml(correlationId)}</code>`);
    }
    lines.push(`• <b>Segment:</b> ${escapeHtml(exchangeSegment)}`);
    lines.push(`• <b>Execution Time:</b> ${timeStr} IST`);

    return lines.join('\n');
  }
}
