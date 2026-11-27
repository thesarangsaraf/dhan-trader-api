import { Injectable, Logger, Optional } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';
import { AlertsService } from '../alerts/alerts.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { DhanService } from '../dhan/dhan.service';
import { DhanWebhookDto } from './dto/dhan-webhook.dto';
import { parseWebhookStringBody } from './webhook-body-parser.middleware';

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

function pickFirstDefined<T = any>(...values: T[]): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') {
      return v;
    }
  }
  return undefined;
}

function pickFirstPositiveNumber(...values: any[]): number | undefined {
  for (const v of values) {
    const num = Number(v);
    if (!isNaN(num) && num > 0) {
      return num;
    }
  }
  return undefined;
}

function cleanAlertNote(note?: string): string {
  if (!note) return '';
  return String(note)
    .replace(/\s*\[Webhook:\s*[^\]]+\]/gi, '')
    .trim();
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly telegramService: TelegramService,
    @Optional() private readonly alertsService?: AlertsService,
    @Optional() private readonly instrumentsService?: InstrumentsService,
    @Optional() private readonly dhanService?: DhanService,
  ) {}

  /**
   * Process Dhan Postback / Webhook POST payload.
   * Normalizes raw/wrapped/snake_case payloads, ensures cold-start alert sync,
   * enriches missing execution details from Dhan's order book when needed,
   * updates alert state, formats a comprehensive message, and dispatches it to Telegram.
   */
  async handleDhanWebhook(
    rawPayload: DhanWebhookDto | Record<string, any> | string,
    meta?: { contentType?: string },
  ): Promise<{
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
    const unwrapped = this.unwrapRawPayload(rawPayload);
    const dto = this.normalizePayload(unwrapped);

    this.logger.log(
      `📥 Received Dhan Webhook: orderId=${dto.orderId || 'N/A'}, status=${dto.orderStatus || 'N/A'}, symbol=${dto.tradingSymbol || 'N/A'}, securityId=${dto.securityId || 'N/A'}`,
    );

    if (!dto.orderId || !dto.orderStatus) {
      const topKeys = unwrapped && typeof unwrapped === 'object' ? Object.keys(unwrapped) : [];
      this.logger.warn(
        `⚠️ Incomplete Dhan Webhook payload (content-type=${meta?.contentType || 'none'}, keys=[${topKeys.join(', ')}])`,
      );
    }

    // 1. Enrich missing execution fields (average price, filled qty, symbol, status, securityId) from live Dhan order book
    await this.enrichFromDhanOrderBook(dto);

    // 2. Ensure cold-start alert sync has completed before matching
    if (this.alertsService && typeof (this.alertsService as any).ensureSynced === 'function') {
      await (this.alertsService as any).ensureSynced().catch(() => {});
    }

    // 3. Locate matching alert in AlertsService; if unmatched, refresh once from Dhan
    let matchedAlert = this.findMatchingAlert(dto);
    if (!matchedAlert && this.alertsService && typeof (this.alertsService as any).syncWithDhan === 'function') {
      await (this.alertsService as any).syncWithDhan().catch(() => {});
      matchedAlert = this.findMatchingAlert(dto);
    }

    const orderStatus = (dto.orderStatus || 'UNKNOWN').toUpperCase();
    const action = (dto.transactionType || matchedAlert?.attachedOrder?.transactionType || 'BUY').toUpperCase();

    if (matchedAlert) {
      this.updateAlertFromWebhook(matchedAlert, dto);
    }

    // 4. Resolve trigger instrument name and target price level
    const { instrumentName, targetPrice, operator, remarks } = this.resolveTriggerInfo(dto, matchedAlert);

    // 5. Resolve attached order instrument and contract details
    const orderDetails = this.resolveOrderDetails(dto, matchedAlert, instrumentName);

    // 6. Construct high-visibility Telegram message
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

    // 7. Send message immediately to Telegram
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
   * Unwrap string bodies or nested Data/data/payload envelopes if present.
   */
  private unwrapRawPayload(raw: any): Record<string, any> {
    let obj: any = raw;
    if (typeof obj === 'string') {
      obj = parseWebhookStringBody(obj);
    }
    if (!obj || typeof obj !== 'object') {
      return {};
    }

    const hasRootOrderFields = Boolean(
      obj.orderId || obj.order_id || obj.orderStatus || obj.order_status || obj.alertId || obj.condition,
    );
    if (!hasRootOrderFields) {
      const inner = obj.Data || obj.data || obj.payload;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return inner;
      }
    }
    return obj;
  }

  /**
   * Normalize Dhan postbacks (camelCase, snake_case, REST aliases, or conditional trigger structures)
   * into a consistent DhanWebhookDto shape.
   */
  private normalizePayload(p: Record<string, any>): DhanWebhookDto {
    const firstOrder = Array.isArray(p.orders) && p.orders.length > 0 ? p.orders[0] : undefined;
    const cond = p.condition && typeof p.condition === 'object' ? p.condition : undefined;

    const orderId = pickFirstDefined(p.orderId, p.order_id, p.dhanOrderId, firstOrder?.orderId, firstOrder?.order_id);
    const securityId = pickFirstDefined(p.securityId, p.security_id, firstOrder?.securityId, firstOrder?.security_id);

    let alertInstrument = pickFirstDefined(p.alertInstrument, p.alert_instrument);
    if (!alertInstrument && cond?.securityId && this.instrumentsService) {
      const condMeta = this.instrumentsService.findBySecurityId(String(cond.securityId));
      if (condMeta?.name) alertInstrument = condMeta.name;
    }

    const normalized: DhanWebhookDto = {
      ...p,
      dhanClientId: pickFirstDefined(p.dhanClientId, p.dhan_client_id, p.clientId),
      orderId: orderId !== undefined ? String(orderId) : undefined,
      correlationId: pickFirstDefined(
        p.correlationId,
        p.correlation_id,
        firstOrder?.correlationId,
        p.alertId !== undefined ? String(p.alertId) : undefined,
        p.alert_id !== undefined ? String(p.alert_id) : undefined,
      ),
      orderStatus: pickFirstDefined(
        p.orderStatus,
        p.order_status,
        firstOrder?.orderStatus,
        firstOrder?.status,
        p.status,
        p.alertStatus,
      ),
      transactionType: pickFirstDefined(
        p.transactionType,
        p.transaction_type,
        p.action,
        p.side,
        firstOrder?.transactionType,
        firstOrder?.action,
      ),
      exchangeSegment: pickFirstDefined(
        p.exchangeSegment,
        p.exchange_segment,
        firstOrder?.exchangeSegment,
        cond?.exchangeSegment,
      ),
      productType: pickFirstDefined(p.productType, p.product_type, firstOrder?.productType),
      orderType: pickFirstDefined(p.orderType, p.order_type, firstOrder?.orderType),
      validity: pickFirstDefined(p.validity, firstOrder?.validity),
      tradingSymbol: pickFirstDefined(
        p.tradingSymbol,
        p.trading_symbol,
        p.customSymbol,
        p.symbol,
        firstOrder?.tradingSymbol,
        firstOrder?.customSymbol,
        firstOrder?.symbol,
      ),
      securityId: securityId !== undefined ? String(securityId) : undefined,
      quantity: pickFirstPositiveNumber(p.quantity, p.orderQty, p.order_qty, firstOrder?.quantity) ?? p.quantity,
      filled_qty:
        pickFirstPositiveNumber(p.filled_qty, p.filledQty, p.tradedQuantity, p.traded_qty, firstOrder?.filled_qty) ??
        p.filled_qty,
      tradedQuantity:
        pickFirstPositiveNumber(p.tradedQuantity, p.traded_qty, p.filledQty, p.filled_qty) ?? p.tradedQuantity,
      price: pickFirstPositiveNumber(p.price, firstOrder?.price) ?? p.price,
      averagePrice:
        pickFirstPositiveNumber(
          p.averagePrice,
          p.average_price,
          p.averageTradedPrice,
          p.tradedPrice,
          p.traded_price,
        ) ?? p.averagePrice,
      triggerPrice:
        pickFirstPositiveNumber(p.triggerPrice, p.trigger_price, cond?.comparingValue) ?? p.triggerPrice,
      drvExpiryDate: pickFirstDefined(p.drvExpiryDate, p.drv_expiry_date, p.expiryDate, firstOrder?.expiryDate),
      drvOptionType: pickFirstDefined(p.drvOptionType, p.drv_option_type, p.optionType, firstOrder?.optionType),
      drvStrikePrice: pickFirstPositiveNumber(p.drvStrikePrice, p.drv_strike_price, p.strikePrice) ?? p.drvStrikePrice,
      omsErrorCode: pickFirstDefined(p.omsErrorCode, p.oms_error_code),
      omsErrorDescription: pickFirstDefined(p.omsErrorDescription, p.oms_error_description),
      alertInstrument,
      alertTargetPrice: pickFirstPositiveNumber(p.alertTargetPrice, p.alert_target_price, cond?.comparingValue),
      alertRemarks: pickFirstDefined(p.alertRemarks, p.alert_remarks, cond?.userNote),
    };

    return normalized;
  }

  /**
   * When Dhan sends an orderId but leaves price, quantity, symbol, or status incomplete
   * (common on MARKET order postbacks), enrich missing fields from Dhan's live order book.
   */
  private async enrichFromDhanOrderBook(dto: DhanWebhookDto): Promise<void> {
    if (!dto.orderId || !this.dhanService || typeof this.dhanService.getOrders !== 'function') {
      return;
    }

    const statusUpper = (dto.orderStatus || '').toUpperCase();
    const needsPrice =
      !['REJECTED', 'CANCELLED', 'EXPIRED', 'PENDING', 'TRANSIT'].includes(statusUpper) &&
      !(Number(dto.averagePrice) > 0 || Number(dto.price) > 0);
    const needsQty = !(Number(dto.filled_qty) > 0 || Number(dto.tradedQuantity) > 0 || Number(dto.quantity) > 0);
    const needsStatus = !dto.orderStatus || statusUpper === 'UNKNOWN';
    const needsSymbol = !dto.tradingSymbol && !dto.securityId;

    if (!needsPrice && !needsQty && !needsStatus && !needsSymbol) {
      return;
    }

    try {
      const ordersRes = await this.dhanService.getOrders();
      if (!ordersRes?.ok || !Array.isArray(ordersRes.data)) return;

      const targetOrderId = String(dto.orderId).trim();
      const matchedOrder = ordersRes.data.find(
        (ord: any) => String(ord.orderId || ord.order_id || ord.dhanOrderId || '').trim() === targetOrderId,
      );
      if (!matchedOrder) return;

      if (needsStatus) {
        dto.orderStatus = pickFirstDefined(matchedOrder.orderStatus, matchedOrder.status, dto.orderStatus);
      }
      if (!dto.transactionType) {
        dto.transactionType = matchedOrder.transactionType;
      }
      if (!dto.exchangeSegment) {
        dto.exchangeSegment = matchedOrder.exchangeSegment;
      }
      if (!dto.productType) {
        dto.productType = matchedOrder.productType;
      }
      if (!dto.orderType) {
        dto.orderType = matchedOrder.orderType;
      }
      if (!dto.securityId && matchedOrder.securityId) {
        dto.securityId = String(matchedOrder.securityId);
      }
      if (!dto.tradingSymbol) {
        dto.tradingSymbol = pickFirstDefined(matchedOrder.tradingSymbol, matchedOrder.customSymbol, matchedOrder.symbol);
      }
      if (!dto.correlationId && matchedOrder.correlationId) {
        dto.correlationId = String(matchedOrder.correlationId);
      }
      if (needsQty) {
        const filled = pickFirstPositiveNumber(
          matchedOrder.filledQty,
          matchedOrder.filled_qty,
          matchedOrder.tradedQuantity,
        );
        const total = pickFirstPositiveNumber(matchedOrder.quantity, matchedOrder.orderQty);
        if (filled) dto.filled_qty = filled;
        if (total) dto.quantity = total;
      }
      if (needsPrice) {
        const avg = pickFirstPositiveNumber(
          matchedOrder.averageTradedPrice,
          matchedOrder.averagePrice,
          matchedOrder.tradedPrice,
          matchedOrder.price,
        );
        if (avg) dto.averagePrice = avg;
      }
      if (!dto.drvExpiryDate && matchedOrder.drvExpiryDate) dto.drvExpiryDate = matchedOrder.drvExpiryDate;
      if (!dto.drvOptionType && matchedOrder.drvOptionType) dto.drvOptionType = matchedOrder.drvOptionType;
      if (!dto.drvStrikePrice && matchedOrder.drvStrikePrice) dto.drvStrikePrice = Number(matchedOrder.drvStrikePrice);
      if (!dto.omsErrorCode && matchedOrder.omsErrorCode) dto.omsErrorCode = matchedOrder.omsErrorCode;
      if (!dto.omsErrorDescription && matchedOrder.omsErrorDescription) {
        dto.omsErrorDescription = matchedOrder.omsErrorDescription;
      }
    } catch {
      // Non-fatal: continue formatting with whatever payload fields are available
    }
  }

  /**
   * Search memory alerts for the corresponding alert rule.
   */
  private findMatchingAlert(dto: DhanWebhookDto): any {
    if (!this.alertsService) return null;
    const allAlerts = this.alertsService.alerts || [];

    // Strategy A: Match by correlationId
    if (dto.correlationId) {
      const corr = String(dto.correlationId);
      const match = allAlerts.find(
        (a) =>
          a.id === corr ||
          a.dhanAlertId === corr ||
          `DHAN-${a.dhanAlertId}` === corr ||
          a.correlationId === corr ||
          (a.remarks && a.remarks.includes(corr)) ||
          (Array.isArray(a.conditionalOrders) && a.conditionalOrders.some((o: any) => o.correlationId === corr)) ||
          (Array.isArray(a.orders) && a.orders.some((o: any) => o.correlationId === corr)),
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

    // Strategy C: Match by securityId on attached contract (prefer ACTIVE, then TRIGGERED)
    if (dto.securityId) {
      const secId = String(dto.securityId);
      const side = (dto.transactionType || '').toUpperCase();
      const matchesSecurity = (a: any) =>
        a.attachedOrder?.securityId === secId ||
        (Array.isArray(a.conditionalOrders) && a.conditionalOrders.some((o: any) => String(o.securityId) === secId)) ||
        (Array.isArray(a.orders) && a.orders.some((o: any) => String(o.securityId) === secId));
      const matchesSide = (a: any) => {
        if (!side) return true;
        const ordSide = (a.attachedOrder?.transactionType || a.conditionalOrders?.[0]?.transactionType || '').toUpperCase();
        return !ordSide || ordSide === side;
      };

      const activeExact = allAlerts.find((a) => a.status === 'ACTIVE' && matchesSecurity(a) && matchesSide(a));
      if (activeExact) return activeExact;

      const activeSec = allAlerts.find((a) => a.status === 'ACTIVE' && matchesSecurity(a));
      if (activeSec) return activeSec;

      const triggeredMatch = allAlerts.find((a) => a.status === 'TRIGGERED' && matchesSecurity(a) && matchesSide(a));
      if (triggeredMatch) return triggeredMatch;
    }

    // Strategy D: Match active alert by triggerPrice
    if (dto.triggerPrice && dto.triggerPrice > 0) {
      const match = allAlerts.find(
        (a) => a.status === 'ACTIVE' && Math.abs(a.targetPrice - (dto.triggerPrice || 0)) <= a.targetPrice * 0.005,
      );
      if (match) return match;
    }

    return null;
  }

  /**
   * Update the internal alert state to reflect the webhook event.
   */
  private updateAlertFromWebhook(alert: any, dto: DhanWebhookDto): void {
    const status = (dto.orderStatus || 'TRADED').toUpperCase();
    const execPrice = pickFirstPositiveNumber(dto.averagePrice, dto.price);

    if (status === 'TRADED' || status === 'FILLED' || status === 'EXECUTED') {
      alert.status = 'TRIGGERED';
      alert.triggeredAt = new Date().toISOString();
      if (execPrice) alert.triggeredPrice = execPrice;
    }

    if (alert.attachedOrder) {
      alert.attachedOrder.status = status;
      if (dto.orderId) alert.attachedOrder.orderId = dto.orderId;
      if (execPrice) alert.attachedOrder.price = execPrice;
      alert.attachedOrder.executedAt = new Date().toISOString();
    }

    if (Array.isArray(alert.conditionalOrders)) {
      for (const ord of alert.conditionalOrders) {
        if (!dto.securityId || String(ord.securityId) === String(dto.securityId) || ord.orderId === dto.orderId) {
          ord.status = status;
          if (dto.orderId) ord.orderId = dto.orderId;
          if (execPrice) ord.price = execPrice;
          ord.executedAt = new Date().toISOString();
        }
      }
    }
  }

  /**
   * Resolve the primary trigger instrument and trigger price.
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
    if (dto.alertInstrument) {
      return {
        instrumentName: dto.alertInstrument,
        targetPrice: dto.alertTargetPrice || dto.triggerPrice || dto.price || 0,
        operator: 'GREATER_THAN_EQUAL',
        remarks: cleanAlertNote(dto.alertRemarks) || 'Price Alert Trigger',
      };
    }

    if (matchedAlert) {
      return {
        instrumentName: matchedAlert.instrument || 'NIFTY 50',
        targetPrice: matchedAlert.targetPrice || dto.triggerPrice || 0,
        operator: matchedAlert.operator || 'GREATER_THAN_EQUAL',
        remarks: cleanAlertNote(matchedAlert.remarks) || '',
      };
    }

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
      if (meta?.name) {
        const metaUpper = meta.name.toUpperCase();
        if (metaUpper.includes('BANKNIFTY') || metaUpper.includes('BANK NIFTY')) inferred = 'BANK NIFTY';
        else if (metaUpper.includes('MIDCP') || metaUpper.includes('MIDCAP')) inferred = 'MIDCAP NIFTY';
        else if (metaUpper.includes('SENSEX')) inferred = 'SENSEX';
        else if (metaUpper.includes('NIFTY')) inferred = 'NIFTY 50';
        else inferred = meta.name;
      }
    }

    return {
      instrumentName: inferred,
      targetPrice: dto.triggerPrice || dto.price || 0,
      operator: 'TARGET_MET',
      remarks: 'Automated Dhan Conditional Trigger',
    };
  }

  /**
   * Resolve attached order details (symbol, strike, option type, lots, price, value).
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
      matchedAlert?.attachedOrder?.customSymbol ||
      matchedAlert?.attachedOrder?.symbol ||
      matchedAlert?.attachedOrder?.tradingSymbol ||
      '';

    let secMeta: any;
    const effectiveSecId = dto.securityId || matchedAlert?.attachedOrder?.securityId;
    if (effectiveSecId && this.instrumentsService) {
      secMeta = this.instrumentsService.findBySecurityId(String(effectiveSecId));
      if (secMeta && (!attachedSymbol || attachedSymbol.startsWith('SEC-'))) {
        attachedSymbol = secMeta.customSymbol || secMeta.symbol || secMeta.tradingSymbol || '';
      }
    }

    if (!attachedSymbol) {
      attachedSymbol = effectiveSecId ? `Security #${effectiveSecId}` : triggerInstrument;
    }

    const qty = parseInt(
      String(dto.filled_qty || dto.tradedQuantity || dto.quantity || matchedAlert?.attachedOrder?.quantity || 0),
      10,
    );
    const execPrice = parseFloat(
      String(dto.averagePrice || dto.price || matchedAlert?.attachedOrder?.price || 0),
    );

    // Resolve lot size and computed lots (do not fabricate 1 lot when quantity is 0)
    let lotSize = 1;
    if (secMeta?.lotSize) {
      lotSize = secMeta.lotSize;
    } else if (matchedAlert?.attachedOrder?.lotSize) {
      lotSize = matchedAlert.attachedOrder.lotSize;
    } else if (this.instrumentsService) {
      lotSize = this.instrumentsService.getLotSizeForInstrument(attachedSymbol || triggerInstrument) || 1;
    }
    const computedLots =
      qty > 0
        ? lotSize > 1
          ? Math.round((qty / lotSize) * 100) / 100
          : matchedAlert?.attachedOrder?.lots || 1
        : 0;

    const orderType = (dto.orderType || matchedAlert?.attachedOrder?.orderType || 'MARKET').toUpperCase();
    let productType = (dto.productType || matchedAlert?.attachedOrder?.productType || 'INTRADAY').toUpperCase();
    if (productType === 'INTRADAY') productType = 'INTRADAY (MIS)';
    else if (productType === 'CNC') productType = 'CNC (Delivery)';
    else if (productType === 'MARGIN') productType = 'MARGIN (NRML)';

    const exchangeSegment =
      dto.exchangeSegment || matchedAlert?.attachedOrder?.exchangeSegment || secMeta?.exchangeSegment || 'NSE_FNO';
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
   * Format message in Telegram HTML parse mode.
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

    let headerBanner = `⚡ <b>DHAN ALERT TRIGGERED &amp; ORDER EXECUTED</b> ✅`;
    if (orderStatus === 'REJECTED') {
      headerBanner = `⚠️ <b>DHAN ALERT TRIGGERED — ORDER REJECTED</b> ❌`;
    } else if (orderStatus === 'PENDING' || orderStatus === 'TRANSIT') {
      headerBanner = `⚡ <b>DHAN ALERT TRIGGERED — ORDER PLACED (PENDING)</b> ⏳`;
    } else if (orderStatus === 'PART_TRADED') {
      headerBanner = `⚡ <b>DHAN ALERT TRIGGERED — PARTIALLY EXECUTED</b> ⏳`;
    } else if (orderStatus === 'CANCELLED' || orderStatus === 'EXPIRED') {
      headerBanner = `🚫 <b>DHAN ALERT TRIGGERED — ORDER ${escapeHtml(orderStatus)}</b>`;
    } else if (orderStatus === 'UNKNOWN') {
      headerBanner = `⚠️ <b>DHAN WEBHOOK RECEIVED — STATUS UNKNOWN</b>`;
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
      lines.push(`• <b>Price:</b> ${orderType === 'MARKET' ? 'MARKET' : 'N/A'}`);
    }

    lines.push(`• <b>Type &amp; Product:</b> ${escapeHtml(orderType)} | ${escapeHtml(productType)}`);

    if (strikePrice || optionType || expiryDate) {
      lines.push('');
      lines.push(`📋 <b>Option Contract Details:</b>`);
      if (strikePrice) lines.push(`• <b>Strike Price:</b> ₹${formatInr(strikePrice)}`);
      if (optionType) lines.push(`• <b>Option Type:</b> ${escapeHtml(optionType)}`);
      if (expiryDate) lines.push(`• <b>Expiry Date:</b> ${escapeHtml(expiryDate)}`);
    }

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
