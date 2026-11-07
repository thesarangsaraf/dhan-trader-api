import { Injectable, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';
import { CreateConditionalAlertDto } from './dto/create-conditional-alert.dto';
import { ConditionalOrderDto } from './dto/conditional-order.dto';

export const POPULAR_NSE_INDICES = [
  { name: 'NIFTY 50', securityId: '13', exchangeSegment: 'IDX_I' },
  { name: 'BANK NIFTY', securityId: '25', exchangeSegment: 'IDX_I' },
  { name: 'SENSEX', securityId: '51', exchangeSegment: 'IDX_I' },
  { name: 'MIDCAP NIFTY', securityId: '442', exchangeSegment: 'IDX_I' },
];

@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  public alerts: any[] = [];
  public dhanAlerts: any[] = [];
  public priceCache: Map<string, number> = new Map();
  public triggeredEvents: any[] = [];

  private monitorTimer: NodeJS.Timeout | null = null;
  private isFetchingPrices = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dhanService: DhanService,
    private readonly telegramService: TelegramService,
    @Optional() private readonly yahooService?: YahooFinanceService,
    @Optional() private readonly instrumentsService?: InstrumentsService,
  ) {}

  onModuleInit() {
    this.startMonitor();
    this.syncWithDhan().catch(() => {});
  }

  onModuleDestroy() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Sync active conditional triggers from Dhan HQ API v2 and refresh live LTP.
   */
  async syncWithDhan() {
    try {
      const dhanRes = await this.dhanService.getAlerts();
      if (dhanRes.ok && Array.isArray(dhanRes.data)) {
        const liveDhanIds = new Set(dhanRes.data.map((d: any) => String(d.alertId || d.id)));

        // Remove any active alert from this.alerts that is NOT live on Dhan (deleted on Dhan web/app or fake fallback)
        this.alerts = this.alerts.filter((a) => {
          if (a.status === 'TRIGGERED' || a.status === 'CANCELLED') {
            return true; // Keep history of triggered/cancelled alerts in local memory
          }
          const id1 = a.id;
          const id2 = a.dhanAlertId;
          const id3 = a.id.startsWith('DHAN-') ? a.id.slice(5) : `DHAN-${a.id}`;
          const existsInDhan = (id1 && liveDhanIds.has(id1)) || (id2 && liveDhanIds.has(id2)) || (id3 && liveDhanIds.has(id3));
          return Boolean(existsInDhan);
        });

        this.dhanAlerts = dhanRes.data.map((d: any) => {
          const alertId = String(d.alertId || d.id);
          const localMatch = this.alerts.find(
            (a) => a.id === alertId || a.dhanAlertId === alertId || a.id === `DHAN-${alertId}` || (alertId.startsWith('DHAN-') && a.id === alertId.slice(5)),
          );

          const secId = String(d.condition?.securityId || d.securityId || '');
          let instName = localMatch?.instrument;
          if (!instName || instName.startsWith('SEC-')) {
            instName = this.resolveInstrumentName(secId, d.condition?.userNote, d.tradingSymbol);
          }

          let expDateStr: string | undefined;
          if (d.condition?.expDate) {
            if (Array.isArray(d.condition.expDate) && d.condition.expDate.length === 3) {
              const [y, m, day] = d.condition.expDate;
              expDateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            } else if (typeof d.condition.expDate === 'string') {
              expDateStr = d.condition.expDate;
            }
          }

          const rawOrders = (d.orders && Array.isArray(d.orders) && d.orders.length > 0)
            ? d.orders
            : (localMatch?.conditionalOrders || (localMatch?.orders ? localMatch.orders : []));

          const enrichedOrders = (rawOrders || []).map((ord: any, idx: number) => {
            let foundOpt: any;
            if (ord.securityId && this.instrumentsService && typeof this.instrumentsService.findBySecurityId === 'function') {
              foundOpt = this.instrumentsService.findBySecurityId(ord.securityId);
            }

            const localOrd = localMatch?.conditionalOrders?.[idx] || localMatch?.orders?.[idx];
            const ordStatus = (localOrd?.status && localOrd.status !== 'PENDING')
              ? localOrd.status
              : (ord.status || ord.orderStatus || 'PENDING').toUpperCase();
            const ordId = localOrd?.orderId || ord.orderId || null;
            const execAt = localOrd?.executedAt || ord.executedAt || null;

            const sym = (foundOpt?.customSymbol && !foundOpt.customSymbol.startsWith('SEC-') ? foundOpt.customSymbol : null)
              || (foundOpt?.symbol && !foundOpt.symbol.startsWith('SEC-') ? foundOpt.symbol : null)
              || foundOpt?.tradingSymbol
              || (ord.customSymbol && !ord.customSymbol.startsWith('SEC-') ? ord.customSymbol : null)
              || (ord.instrumentName && ord.instrumentName.includes(' ') && !ord.instrumentName.startsWith('SEC-') ? ord.instrumentName : null)
              || (ord.symbol && !ord.symbol.startsWith('SEC-') ? ord.symbol : null)
              || ord.tradingSymbol;

            const expiryDate = ord.expiryDate || ord.expDate || foundOpt?.expiryDate || expDateStr;
            const strikePrice = ord.strikePrice || foundOpt?.strikePrice;
            const optionType = ord.optionType || foundOpt?.optionType;
            const instrumentName = foundOpt?.customSymbol || foundOpt?.name || (ord.instrumentName && !ord.instrumentName.startsWith('SEC-') ? ord.instrumentName : instName);

            return {
              ...ord,
              symbol: sym || (ord.symbol && !ord.symbol.startsWith('SEC-') ? ord.symbol : null) || `SEC-${ord.securityId || 'UNKNOWN'}`,
              tradingSymbol: ord.tradingSymbol || foundOpt?.tradingSymbol,
              customSymbol: ord.customSymbol || foundOpt?.customSymbol || sym,
              expiryDate,
              strikePrice,
              optionType,
              instrumentName,
              transactionType: (ord.transactionType || ord.action || 'BUY').toUpperCase(),
              action: (ord.action || ord.transactionType || 'BUY').toUpperCase(),
              quantity: Number(ord.quantity || 0),
              orderType: (ord.orderType || 'MARKET').toUpperCase(),
              productType: (ord.productType || 'INTRADAY').toUpperCase(),
              price: ord.price !== undefined ? parseFloat(String(ord.price)) : 0,
              status: ordStatus,
              orderId: ordId,
              executedAt: execAt,
            };
          });

          const firstOrd = enrichedOrders[0];
          const attachedOrder = firstOrd
            ? {
                enabled: true,
                action: firstOrd.transactionType,
                transactionType: firstOrd.transactionType,
                symbol: firstOrd.symbol,
                tradingSymbol: firstOrd.tradingSymbol,
                customSymbol: firstOrd.customSymbol,
                expiryDate: firstOrd.expiryDate,
                strikePrice: firstOrd.strikePrice,
                optionType: firstOrd.optionType,
                instrumentName: firstOrd.instrumentName,
                securityId: firstOrd.securityId,
                exchangeSegment: firstOrd.exchangeSegment,
                productType: firstOrd.productType,
                orderType: firstOrd.orderType,
                quantity: firstOrd.quantity,
                price: firstOrd.price,
                status: firstOrd.status,
                orderId: firstOrd.orderId,
                executedAt: firstOrd.executedAt,
              }
            : undefined;

          const userNote = d.condition?.userNote || d.remarks || '';
          const isStopLossAlert = Boolean(
            localMatch?.isStopLossAlert || userNote.includes('[STOP LOSS]')
          );
          let parentAlertId = localMatch?.parentAlertId || null;
          if (!parentAlertId && userNote.includes('[STOP LOSS]')) {
            const match = userNote.match(/Exit for #(\d+|DHAN-[\w-]+)/i);
            if (match) {
              parentAlertId = match[1];
            }
          }

          // If Stop Loss alert, ensure order symbol is copied from parent alert if available
          if (isStopLossAlert && parentAlertId && enrichedOrders.length > 0) {
            const parent = this.alerts.find(
              (p) => p.id === parentAlertId || p.dhanAlertId === parentAlertId || p.id === `DHAN-${parentAlertId}`,
            ) || dhanRes.data.find(
              (rawD: any) => String(rawD.alertId || rawD.id) === parentAlertId || String(rawD.alertId || rawD.id) === `DHAN-${parentAlertId}`,
            );
            const parentOrder = parent?.conditionalOrders?.[0] || parent?.orders?.[0];
            if (parentOrder && parentOrder.symbol && !parentOrder.symbol.startsWith('SEC-')) {
              for (const ord of enrichedOrders) {
                if (!ord.symbol || ord.symbol.startsWith('SEC-')) {
                  ord.symbol = parentOrder.symbol;
                  ord.tradingSymbol = parentOrder.tradingSymbol || parentOrder.symbol;
                  ord.customSymbol = parentOrder.customSymbol || parentOrder.symbol;
                  ord.instrumentName = parentOrder.instrumentName || parentOrder.symbol;
                }
              }
            }
          }

          return {
            id: alertId,
            instrument: instName,
            securityId: String(d.condition?.securityId || d.securityId || ''),
            exchangeSegment: d.condition?.exchangeSegment || d.exchangeSegment || 'NSE_EQ',
            targetPrice: parseFloat(d.condition?.comparingValue || d.targetPrice || 0),
            currentPrice: this.getCurrentPrice(instName, d.condition?.securityId, d.condition?.exchangeSegment),
            operator: d.condition?.operator || d.operator || 'GREATER_THAN_EQUAL',
            status: (localMatch?.status === 'TRIGGERED' ? 'TRIGGERED' : (d.alertStatus || d.status || localMatch?.status || 'ACTIVE')).toUpperCase(),
            remarks: d.condition?.userNote || d.remarks || 'Dhan Conditional Trigger',
            expDate: expDateStr,
            createdAt: d.createdTime
              ? (typeof d.createdTime === 'number' ? new Date(d.createdTime * 1000).toISOString() : String(d.createdTime))
              : (localMatch?.createdAt || new Date().toISOString()),
            triggeredAt: d.triggeredAt || localMatch?.triggeredAt || null,
            source: 'dhan_api',
            orders: enrichedOrders,
            hasConditionalOrder: enrichedOrders.length > 0,
            conditionalOrders: enrichedOrders,
            attachedOrder,
            stopLoss: localMatch?.stopLoss,
            stopLossAlertPlaced: localMatch?.stopLossAlertPlaced,
            stopLossAlertId: localMatch?.stopLossAlertId,
            isStopLossAlert,
            parentAlertId,
            dhanAlertId: alertId,
          };
        });

        // Link parent alerts and stop loss alerts together across dhanAlerts
        for (const da of this.dhanAlerts) {
          if (da.isStopLossAlert && da.parentAlertId) {
            const parent = this.dhanAlerts.find(
              (p) => p.id === da.parentAlertId || p.dhanAlertId === da.parentAlertId || p.id === `DHAN-${da.parentAlertId}` || (da.parentAlertId.startsWith('DHAN-') && p.id === da.parentAlertId.slice(5)),
            );
            if (parent) {
              parent.stopLossAlertPlaced = true;
              parent.stopLossAlertId = da.id;
              if (!parent.stopLoss) {
                const slPoints = Math.round(Math.abs(parent.targetPrice - da.targetPrice) * 100) / 100;
                parent.stopLoss = {
                  enabled: true,
                  points: slPoints,
                  targetPrice: da.targetPrice,
                  operator: da.operator,
                  action: da.orders?.[0]?.transactionType || 'SELL',
                };
              }
            }
          }
        }

        // Reconcile this.alerts with this.dhanAlerts
        for (const da of this.dhanAlerts) {
          const localIdx = this.alerts.findIndex(
            (a) => a.id === da.id || a.dhanAlertId === da.id || a.id === `DHAN-${da.id}` || (da.id.startsWith('DHAN-') && a.id === da.id.slice(5)),
          );
          if (localIdx >= 0) {
            this.alerts[localIdx] = {
              ...this.alerts[localIdx],
              ...da,
              stopLoss: da.stopLoss || this.alerts[localIdx].stopLoss,
              stopLossAlertPlaced: da.stopLossAlertPlaced !== undefined ? da.stopLossAlertPlaced : this.alerts[localIdx].stopLossAlertPlaced,
              stopLossAlertId: da.stopLossAlertId || this.alerts[localIdx].stopLossAlertId,
              isStopLossAlert: da.isStopLossAlert !== undefined ? da.isStopLossAlert : this.alerts[localIdx].isStopLossAlert,
              parentAlertId: da.parentAlertId || this.alerts[localIdx].parentAlertId,
            };
          } else {
            this.alerts.push(da);
          }
        }

        // Link parent alerts and stop loss alerts together across this.alerts
        for (const a of this.alerts) {
          if (a.isStopLossAlert && a.parentAlertId) {
            const parent = this.alerts.find(
              (p) => p.id === a.parentAlertId || p.dhanAlertId === a.parentAlertId || p.id === `DHAN-${a.parentAlertId}` || (a.parentAlertId.startsWith('DHAN-') && p.id === a.parentAlertId.slice(5)),
            );
            if (parent) {
              parent.stopLossAlertPlaced = true;
              parent.stopLossAlertId = a.id;
              if (!parent.stopLoss) {
                const slPoints = Math.round(Math.abs(parent.targetPrice - a.targetPrice) * 100) / 100;
                parent.stopLoss = {
                  enabled: true,
                  points: slPoints,
                  targetPrice: a.targetPrice,
                  operator: a.operator,
                  action: a.orders?.[0]?.transactionType || 'SELL',
                };
              }
            }
          }
        }
      }
    } catch {
      // If Dhan API is offline or alerts not subscribed, retain local alerts
    }

    await this.checkAndTick();
  }

  /**
   * Resolves the human-readable instrument name from a security ID or condition details.
   */
  resolveInstrumentName(securityId?: string, fallbackUserNote?: string, fallbackSymbol?: string): string {
    const secId = securityId ? String(securityId).trim() : '';

    // 1. Check popular indices
    if (secId) {
      const matchedIndex = POPULAR_NSE_INDICES.find((i) => i.securityId === secId);
      if (matchedIndex) return matchedIndex.name;
    }

    // 2. Check InstrumentsService by security ID
    if (secId && this.instrumentsService && typeof this.instrumentsService.findBySecurityId === 'function') {
      const found = this.instrumentsService.findBySecurityId(secId);
      if (found) {
        return found.customSymbol || found.name || found.symbol || found.tradingSymbol || `SEC-${secId}`;
      }
    }

    // 3. Fallback to clean userNote if present and not a system string
    if (fallbackUserNote && typeof fallbackUserNote === 'string') {
      const note = fallbackUserNote.trim();
      if (
        note &&
        !note.startsWith('[STOP LOSS]') &&
        !note.startsWith('Conditional order for') &&
        !note.startsWith('Alert for') &&
        !note.startsWith('SEC-') &&
        !note.startsWith('Dhan Conditional')
      ) {
        return note;
      }
    }

    // 4. Fallback to tradingSymbol if available
    if (fallbackSymbol && typeof fallbackSymbol === 'string' && !fallbackSymbol.startsWith('SEC-')) {
      return fallbackSymbol;
    }

    // 5. Final fallback
    return secId ? `SEC-${secId}` : 'CUSTOM';
  }

  /**
   * Returns structured instrument details for a given security ID.
   */
  getInstrumentDetailsBySecurityId(securityId: string) {
    const secId = String(securityId || '').trim();
    if (!secId) return null;

    const matchedIndex = POPULAR_NSE_INDICES.find((i) => i.securityId === secId);
    if (matchedIndex) {
      return {
        securityId: secId,
        instrumentName: matchedIndex.name,
        name: matchedIndex.name,
        symbol: matchedIndex.name,
        tradingSymbol: matchedIndex.name,
        exchangeSegment: matchedIndex.exchangeSegment,
        lotSize: 1,
      };
    }

    if (this.instrumentsService && typeof this.instrumentsService.findBySecurityId === 'function') {
      const found = this.instrumentsService.findBySecurityId(secId);
      if (found) {
        const name = found.customSymbol || found.name || found.symbol || found.tradingSymbol;
        return {
          securityId: secId,
          instrumentName: name,
          name,
          symbol: found.symbol,
          tradingSymbol: found.tradingSymbol || found.symbol,
          customSymbol: found.customSymbol || name,
          exchangeSegment: found.exchangeSegment || 'NSE_EQ',
          expiryDate: found.expiryDate,
          strikePrice: found.strikePrice,
          optionType: found.optionType,
          lotSize: found.lotSize || 1,
        };
      }
    }

    return null;
  }

  getIndices() {
    return POPULAR_NSE_INDICES.map((idx) => ({
      ...idx,
      currentPrice: this.getCurrentPrice(idx.name, idx.securityId, idx.exchangeSegment),
    }));
  }

  getCurrentPrice(instrument?: string, securityId?: string, exchangeSegment?: string): number | null {
    if (securityId && exchangeSegment) {
      const key = `${exchangeSegment}:${securityId}`;
      if (this.priceCache.has(key)) {
        return this.priceCache.get(key) || null;
      }
    }
    if (instrument) {
      const instUp = instrument.toUpperCase();
      if (this.priceCache.has(instUp)) {
        return this.priceCache.get(instUp) || null;
      }
      if (instUp.includes('BANK')) {
        if (this.priceCache.has('BANK NIFTY')) return this.priceCache.get('BANK NIFTY') || null;
        if (this.priceCache.has('NIFTY BANK')) return this.priceCache.get('NIFTY BANK') || null;
      }
      if (instUp.includes('MIDCAP') || instUp.includes('MIDCP')) {
        if (this.priceCache.has('MIDCAP NIFTY')) return this.priceCache.get('MIDCAP NIFTY') || null;
        if (this.priceCache.has('MIDCP NIFTY')) return this.priceCache.get('MIDCP NIFTY') || null;
      }
    }
    return null;
  }

  getAllAlerts() {
    const seen = new Set<string>();
    const unique: any[] = [];

    for (const a of this.alerts) {
      // Never show mock/unplaced conditional order alerts or mock SL alerts
      if (a.status === 'ACTIVE' && (a.hasConditionalOrder || a.isStopLossAlert) && !a.dhanAlertId) {
        continue;
      }
      const key = a.dhanAlertId || a.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(a);
      }
    }

    const alerts = unique.map((a) => {
      let expDateStr = a.expDate;
      if (!expDateStr && a.condition?.expDate) {
        if (Array.isArray(a.condition.expDate) && a.condition.expDate.length === 3) {
          const [y, m, day] = a.condition.expDate;
          expDateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        } else if (typeof a.condition.expDate === 'string') {
          expDateStr = a.condition.expDate;
        }
      }

      const rawOrders = (a.orders && a.orders.length > 0)
        ? a.orders
        : (a.conditionalOrders && a.conditionalOrders.length > 0 ? a.conditionalOrders : []);

      const orders = rawOrders.map((ord: any) => {
        let foundOpt: any;
        if (ord.securityId && this.instrumentsService && typeof this.instrumentsService.findBySecurityId === 'function') {
          foundOpt = this.instrumentsService.findBySecurityId(ord.securityId);
        }

        const sym = (foundOpt?.customSymbol && !foundOpt.customSymbol.startsWith('SEC-') ? foundOpt.customSymbol : null)
          || (foundOpt?.symbol && !foundOpt.symbol.startsWith('SEC-') ? foundOpt.symbol : null)
          || foundOpt?.tradingSymbol
          || (ord.customSymbol && !ord.customSymbol.startsWith('SEC-') ? ord.customSymbol : null)
          || (ord.instrumentName && ord.instrumentName.includes(' ') && !ord.instrumentName.startsWith('SEC-') ? ord.instrumentName : null)
          || (ord.symbol && !ord.symbol.startsWith('SEC-') ? ord.symbol : null)
          || ord.tradingSymbol;

        const expiryDate = ord.expiryDate || ord.expDate || foundOpt?.expiryDate || expDateStr;
        const strikePrice = ord.strikePrice || foundOpt?.strikePrice;
        const optionType = ord.optionType || foundOpt?.optionType;
        const instrumentName = foundOpt?.customSymbol || foundOpt?.name || (ord.instrumentName && !ord.instrumentName.startsWith('SEC-') ? ord.instrumentName : a.instrument);

        return {
          ...ord,
          symbol: sym || (ord.symbol && !ord.symbol.startsWith('SEC-') ? ord.symbol : null) || `SEC-${ord.securityId || 'UNKNOWN'}`,
          tradingSymbol: ord.tradingSymbol || foundOpt?.tradingSymbol,
          customSymbol: ord.customSymbol || foundOpt?.customSymbol || sym,
          expiryDate,
          strikePrice,
          optionType,
          instrumentName,
          transactionType: (ord.transactionType || ord.action || 'BUY').toUpperCase(),
          action: (ord.action || ord.transactionType || 'BUY').toUpperCase(),
          quantity: Number(ord.quantity || 0),
          orderType: (ord.orderType || 'MARKET').toUpperCase(),
          productType: (ord.productType || 'INTRADAY').toUpperCase(),
          price: ord.price !== undefined ? parseFloat(String(ord.price)) : 0,
          status: (ord.status || ord.orderStatus || 'PENDING').toUpperCase(),
          orderId: ord.orderId || null,
          executedAt: ord.executedAt || null,
        };
      });

      const firstOrd = orders[0];
      const attachedOrder = firstOrd ? {
        enabled: true,
        action: firstOrd.transactionType,
        transactionType: firstOrd.transactionType,
        symbol: firstOrd.symbol,
        tradingSymbol: firstOrd.tradingSymbol,
        customSymbol: firstOrd.customSymbol,
        expiryDate: firstOrd.expiryDate,
        strikePrice: firstOrd.strikePrice,
        optionType: firstOrd.optionType,
        instrumentName: firstOrd.instrumentName,
        securityId: firstOrd.securityId,
        exchangeSegment: firstOrd.exchangeSegment,
        productType: firstOrd.productType,
        orderType: firstOrd.orderType,
        quantity: firstOrd.quantity,
        price: firstOrd.price,
        status: firstOrd.status,
        orderId: firstOrd.orderId,
        executedAt: firstOrd.executedAt,
      } : undefined;

      let inst = a.instrument;
      if ((!inst || inst.startsWith('SEC-')) && a.securityId) {
        inst = this.resolveInstrumentName(a.securityId, a.remarks || a.condition?.userNote, a.tradingSymbol || a.symbol);
      }

      return {
        ...a,
        instrument: inst,
        expDate: expDateStr,
        orders,
        conditionalOrders: orders,
        hasConditionalOrder: orders.length > 0,
        attachedOrder,
        currentPrice: this.getCurrentPrice(inst, a.securityId, a.exchangeSegment),
      };
    });

    // Link parent and child stop loss alerts
    for (const a of alerts) {
      if (a.isStopLossAlert && a.parentAlertId) {
        const parent = alerts.find(
          (p: any) =>
            p.id === a.parentAlertId ||
            p.dhanAlertId === a.parentAlertId ||
            p.id === `DHAN-${a.parentAlertId}` ||
            (a.parentAlertId.startsWith('DHAN-') && p.id === a.parentAlertId.slice(5)),
        );
        if (parent) {
          parent.linkedStopLossAlert = a;
        }
      }
    }

    return alerts;
  }

  getGroupedAlerts() {
    const enriched = this.getAllAlerts();
    const groups: Record<string, any> = {};

    for (const alert of enriched) {
      const inst = alert.instrument || 'CUSTOM';
      if (!groups[inst]) {
        groups[inst] = {
          instrument: inst,
          currentPrice: this.getCurrentPrice(inst, alert.securityId, alert.exchangeSegment),
          activeCount: 0,
          triggeredCount: 0,
          alerts: [],
        };
      }
      groups[inst].alerts.push(alert);
      if (alert.status === 'ACTIVE') groups[inst].activeCount++;
      if (alert.status === 'TRIGGERED') groups[inst].triggeredCount++;
    }

    return Object.values(groups);
  }

  createAlert(dto: CreateAlertDto) {
    if (dto.attachedOrder && !dto.conditionalOrder) {
      dto.conditionalOrder = {
        symbol: dto.attachedOrder.symbol,
        securityId: dto.attachedOrder.securityId,
        exchangeSegment: dto.attachedOrder.exchangeSegment || 'NSE_FNO',
        transactionType: dto.attachedOrder.action || dto.attachedOrder.transactionType || 'BUY',
        orderType: dto.attachedOrder.orderType || 'MARKET',
        productType: dto.attachedOrder.productType || 'INTRADAY',
        quantity: dto.attachedOrder.quantity || 50,
        price: dto.attachedOrder.price || 0,
        validity: 'DAY',
      };
    }

    if (dto.conditionalOrder || (Array.isArray(dto.conditionalOrders) && dto.conditionalOrders.length > 0)) {
      return this.createConditionalAlert(dto as CreateConditionalAlertDto);
    }

    if (!dto.instrument && dto.securityId) {
      dto.instrument = this.resolveInstrumentName(dto.securityId, dto.remarks);
    }

    if (!dto.instrument && dto.securityId) {
      dto.instrument = this.resolveInstrumentName(dto.securityId, dto.remarks);
    }

    if (!dto.instrument || dto.targetPrice === undefined || dto.targetPrice === null) {
      throw new BadRequestException('Instrument and target price are required');
    }

    const priceNum = parseFloat(String(dto.targetPrice));
    if (isNaN(priceNum) || priceNum <= 0) {
      throw new BadRequestException('Target price must be a positive number');
    }

    let secId = dto.securityId;
    let instUpper = dto.instrument.toUpperCase().trim();

    if (secId && (!instUpper || instUpper.startsWith('SEC-') || /^\d+$/.test(instUpper))) {
      const resolved = this.resolveInstrumentName(secId, dto.remarks);
      if (resolved && !resolved.startsWith('SEC-')) {
        instUpper = resolved.toUpperCase();
        dto.instrument = resolved;
      }
    }

    const matchedIndex = POPULAR_NSE_INDICES.find(
      (i) =>
        i.name.toUpperCase() === instUpper ||
        (i.name === 'BANK NIFTY' && instUpper === 'NIFTY BANK') ||
        (i.name === 'MIDCAP NIFTY' && (instUpper === 'MIDCP NIFTY' || instUpper === 'MIDCPNIFTY')),
    );

    if (!secId && matchedIndex) secId = matchedIndex.securityId;
    if (!secId && this.instrumentsService) {
      const found = this.instrumentsService.findBySymbol(dto.instrument);
      if (found) {
        secId = found.securityId;
        if (!dto.exchangeSegment) dto.exchangeSegment = found.exchangeSegment;
      }
    }

    secId = secId || (matchedIndex ? matchedIndex.securityId : '0');
    const exSegment = dto.exchangeSegment || (matchedIndex ? matchedIndex.exchangeSegment : 'NSE_EQ');
    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    // Operator is decided automatically if omitted: GREATER_THAN if target >= current, LESS_THAN if target < current
    let validOp = dto.operator;
    if (!validOp || validOp === 'AUTO') {
      validOp = currentPrice && priceNum < currentPrice ? 'LESS_THAN' : 'GREATER_THAN';
    }

    const newAlert = {
      id: `ALT-${Date.now().toString().slice(-6)}`,
      instrument: instUpper === 'NIFTY BANK' ? 'NIFTY BANK' : (matchedIndex ? matchedIndex.name : instUpper),
      securityId: String(secId),
      exchangeSegment: exSegment,
      targetPrice: priceNum,
      currentPrice,
      operator: validOp,
      status: 'ACTIVE',
      remarks: dto.remarks ? dto.remarks.trim() : `Alert for ${dto.instrument} at ₹${priceNum}`,
      createdAt: new Date().toISOString(),
      triggeredAt: null,
      hasConditionalOrder: false,
      dhanMetadata: {
        monitoringMode: 'Live Dhan Marketfeed & In-Memory Check Engine',
        exchangeSegment: exSegment,
        securityId: String(secId),
      },
    };

    this.alerts.unshift(newAlert);

    // Trigger immediate live price tick check
    this.checkAndTick().catch(() => {});

    return {
      success: true,
      message: `Price alert successfully placed for ${newAlert.instrument} at ₹${newAlert.targetPrice}`,
      alert: newAlert,
    };
  }

  /**
   * Determine default Stop Loss points based on underlying index/instrument
   * NIFTY 50 -> 12 points
   * BANK NIFTY -> 20 points
   * Other instruments -> 15 points
   */
  getDefaultSlPoints(instrument: string): number {
    const upper = (instrument || '').toUpperCase();
    if (upper.includes('BANK')) return 20;
    if (upper.includes('MIDCAP') || upper.includes('MIDCP')) return 15;
    if (upper.includes('SENSEX')) return 30;
    if (upper.includes('NIFTY')) return 12;
    return 15;
  }

  /**
   * Place a Dhan alert with an attached conditional order.
   * Registers directly with Dhan HQ v2 (/alerts/orders) and runs locally in memory.
   */
  async createConditionalAlert(dto: CreateConditionalAlertDto) {
    if (dto.attachedOrder && !dto.conditionalOrder) {
      dto.conditionalOrder = {
        symbol: dto.attachedOrder.symbol,
        securityId: dto.attachedOrder.securityId,
        exchangeSegment: dto.attachedOrder.exchangeSegment || 'NSE_FNO',
        transactionType: dto.attachedOrder.action || dto.attachedOrder.transactionType || 'BUY',
        orderType: dto.attachedOrder.orderType || 'MARKET',
        productType: dto.attachedOrder.productType || 'INTRADAY',
        quantity: dto.attachedOrder.quantity || 50,
        price: dto.attachedOrder.price || 0,
        validity: 'DAY',
      };
    }

    if (!dto.instrument && dto.securityId) {
      dto.instrument = this.resolveInstrumentName(dto.securityId, dto.remarks);
    }

    if (!dto.instrument || dto.targetPrice === undefined || dto.targetPrice === null) {
      throw new BadRequestException('Instrument and target price are required');
    }

    const priceNum = parseFloat(String(dto.targetPrice));
    if (isNaN(priceNum) || priceNum <= 0) {
      throw new BadRequestException('Target price must be a positive number');
    }

    const rawOrders: ConditionalOrderDto[] = [];
    if (dto.conditionalOrder) {
      rawOrders.push(dto.conditionalOrder);
    }
    if (Array.isArray(dto.conditionalOrders)) {
      for (const ord of dto.conditionalOrders) {
        rawOrders.push(ord);
      }
    }

    if (rawOrders.length === 0) {
      throw new BadRequestException('At least one conditional order must be provided in conditionalOrder or conditionalOrders');
    }

    // Validate and enrich each order
    const validatedOrders = rawOrders.map((ord, idx) => {
      if (!ord.symbol || typeof ord.symbol !== 'string') {
        throw new BadRequestException(`Order at index ${idx} requires a valid symbol`);
      }
      let qty = parseInt(String(ord.quantity), 10);
      if (isNaN(qty) || qty <= 0) {
        throw new BadRequestException(`Order at index ${idx} requires a positive quantity`);
      }
      const side = (ord.transactionType || (ord as any).action || 'BUY').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') {
        throw new BadRequestException(`Order at index ${idx} transactionType must be BUY or SELL`);
      }

      let secId = ord.securityId;
      let contractLotSize = 1;
      let optDetails: any;
      if (this.instrumentsService) {
        if (secId && typeof this.instrumentsService.findBySecurityId === 'function') {
          optDetails = this.instrumentsService.findBySecurityId(secId);
        }
        if (!optDetails && typeof this.instrumentsService.findBySymbol === 'function') {
          optDetails = this.instrumentsService.findBySymbol(ord.symbol);
        }
        if (optDetails) {
          secId = optDetails.securityId || secId;
          if (optDetails.lotSize) contractLotSize = optDetails.lotSize;
        }
      }

      // Convert lots to total shares if lots parameter is supplied or if qty is specified as lots
      const ordLots = (ord as any).lots ? parseInt(String((ord as any).lots), 10) : 0;
      if (ordLots > 0 && contractLotSize > 1) {
        qty = ordLots * contractLotSize;
      } else if (contractLotSize > 1 && qty <= 15 && qty < contractLotSize && (ord.exchangeSegment === 'NSE_FNO' || ord.exchangeSegment === 'BSE_FNO' || !ord.exchangeSegment)) {
        // Defensive safeguard: e.g. 5 lots provided for Nifty (lot size 65) -> 5 * 65 = 325 shares
        qty = qty * contractLotSize;
      }

      const symName = (optDetails?.customSymbol && !optDetails.customSymbol.startsWith('SEC-') ? optDetails.customSymbol : null)
        || (optDetails?.symbol && !optDetails.symbol.startsWith('SEC-') ? optDetails.symbol : null)
        || optDetails?.tradingSymbol
        || (ord.symbol && !ord.symbol.startsWith('SEC-') ? ord.symbol.toUpperCase() : null)
        || ord.symbol?.toUpperCase();

      return {
        symbol: symName,
        tradingSymbol: optDetails?.tradingSymbol || (ord as any).tradingSymbol,
        customSymbol: optDetails?.customSymbol || (ord as any).customSymbol || symName,
        instrumentName: optDetails?.customSymbol || optDetails?.name || (ord as any).instrumentName || symName,
        strikePrice: optDetails?.strikePrice || (ord as any).strikePrice,
        optionType: optDetails?.optionType || (ord as any).optionType,
        expiryDate: optDetails?.expiryDate || (ord as any).expiryDate || dto.expDate,
        securityId: String(secId || '0'),
        exchangeSegment: ord.exchangeSegment || optDetails?.exchangeSegment || 'NSE_FNO',
        transactionType: side,
        orderType: (ord.orderType || 'MARKET').toUpperCase(),
        productType: (ord.productType || 'INTRADAY').toUpperCase(),
        quantity: qty,
        price: parseFloat(String(ord.price || 0)) || 0,
        triggerPrice: parseFloat(String(ord.triggerPrice || 0)) || 0,
        validity: (ord.validity || 'DAY').toUpperCase(),
        status: 'PENDING',
        orderId: null as string | null,
        executedAt: null as string | null,
      };
    });

    let secId = dto.securityId;
    let instUpper = dto.instrument.toUpperCase().trim();

    if (secId && (!instUpper || instUpper.startsWith('SEC-') || /^\d+$/.test(instUpper))) {
      const resolved = this.resolveInstrumentName(secId, dto.remarks);
      if (resolved && !resolved.startsWith('SEC-')) {
        instUpper = resolved.toUpperCase();
        dto.instrument = resolved;
      }
    }

    const matchedIndex = POPULAR_NSE_INDICES.find(
      (i) =>
        i.name.toUpperCase() === instUpper ||
        (i.name === 'BANK NIFTY' && instUpper === 'NIFTY BANK') ||
        (i.name === 'MIDCAP NIFTY' && (instUpper === 'MIDCP NIFTY' || instUpper === 'MIDCPNIFTY')),
    );

    let exSegment = dto.exchangeSegment;

    if (!secId && matchedIndex) secId = matchedIndex.securityId;
    if (!exSegment && matchedIndex) exSegment = matchedIndex.exchangeSegment;

    if (!secId && this.instrumentsService) {
      const found = this.instrumentsService.findBySymbol(dto.instrument);
      if (found) {
        secId = found.securityId;
        if (!exSegment) exSegment = found.exchangeSegment;
      }
    }

    secId = secId || '0';
    exSegment = exSegment || (matchedIndex ? matchedIndex.exchangeSegment : 'IDX_I');
    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    // Operator is decided automatically if omitted: GREATER_THAN if target >= current, LESS_THAN if target < current
    let validOp = dto.operator;
    if (!validOp || validOp === 'AUTO') {
      validOp = currentPrice && priceNum < currentPrice ? 'LESS_THAN' : 'GREATER_THAN';
    }

    // Map operator to official Dhan HQ API v2 enums
    // Dhan Web & Mobile natively support GREATER_THAN and LESS_THAN for PRICE_WITH_VALUE comparisons
    let dhanOp = validOp;
    if (validOp === 'GREATER_THAN' || validOp === 'GREATER_THAN_OR_EQUAL' || validOp === 'GREATER_THAN_EQUAL' || validOp === 'CROSSING_UP') {
      dhanOp = 'GREATER_THAN';
    } else if (validOp === 'LESS_THAN' || validOp === 'LESS_THAN_OR_EQUAL' || validOp === 'LESS_THAN_EQUAL' || validOp === 'CROSSING_DOWN') {
      dhanOp = 'LESS_THAN';
    } else if (validOp === 'CROSS_ANY_SIDE' || validOp === 'CROSSING_ANY_SIDE') {
      dhanOp = 'CROSSING_ANY_SIDE';
    }

    // Expiry date (mandatory for Dhan API)
    const expDate = dto.expDate || (() => {
      const d = new Date(Date.now() + 30 * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    // Automated Stop Loss configuration processing
    let stopLossConfig: any = null;
    if (dto.stopLoss && dto.stopLoss.enabled) {
      const defaultPts = this.getDefaultSlPoints(dto.instrument);
      const slPts = typeof dto.stopLoss.points === 'number' && dto.stopLoss.points > 0 ? dto.stopLoss.points : defaultPts;
      const firstOrder = validatedOrders[0];
      const orderSide = (firstOrder?.transactionType || 'BUY').toUpperCase();

      const symUpper = (firstOrder?.symbol || '').toUpperCase();
      const isPut = symUpper.endsWith('PE') || symUpper.includes(' PUT') || symUpper.includes('-PE');
      const isSellSide = orderSide === 'SELL';
      // User rule:
      // "if it is sell order then entry + 12 point. if buy order then entry - 12 point of nifty 50."
      // For options: buying Put or selling is bearish (entry + points), buying Call is bullish (entry - points)
      const isBearish = isPut || isSellSide || (dto.stopLoss.action === 'BUY' && isSellSide);

      let slTarget = dto.stopLoss.targetPrice;
      let slOp = dto.stopLoss.operator;
      // If user bought option (CE or PE), Stop Loss sells that option to exit
      const slAction = dto.stopLoss.action || (orderSide === 'BUY' ? 'SELL' : 'BUY');

      if (typeof slTarget !== 'number' || isNaN(slTarget) || slTarget <= 0) {
        if (isBearish) {
          // If bearish / sell order, SL is placed above entry (entry + points)
          slTarget = Math.round((priceNum + slPts) * 100) / 100;
          slOp = 'GREATER_THAN';
        } else {
          // If bullish / buy order, SL is placed below entry (entry - points)
          slTarget = Math.round((priceNum - slPts) * 100) / 100;
          slOp = 'LESS_THAN';
        }
      } else {
        if (!slOp) {
          slOp = slTarget < priceNum ? 'LESS_THAN' : 'GREATER_THAN';
        }
      }

      stopLossConfig = {
        enabled: true,
        points: slPts,
        targetPrice: slTarget,
        operator: slOp,
        action: slAction,
      };
    }

    // Dhan HQ API v2 /alerts/orders submission
    let dhanAlertId: string | null = null;
    let dhanApiResult: any = null;

    if (dto.executeViaDhanApi !== false) {
      const dhanPayload = {
        dhanClientId: this.config.clientId,
        condition: {
          comparisonType: 'PRICE_WITH_VALUE',
          exchangeSegment: exSegment,
          securityId: String(secId),
          operator: dhanOp,
          comparingValue: priceNum,
          expDate,
          userNote: dto.remarks ? dto.remarks.trim() : `Conditional order for ${dto.instrument} at ${priceNum}`,
          frequency: dto.frequency || 'ONCE',
        },
        orders: validatedOrders.map((o) => ({
          transactionType: o.transactionType,
          exchangeSegment: o.exchangeSegment,
          productType: o.productType,
          orderType: o.orderType,
          securityId: String(o.securityId),
          quantity: Number(o.quantity),
          price: o.price ? String(o.price) : '0',
          validity: o.validity || 'DAY',
          ...(o.triggerPrice ? { triggerPrice: String(o.triggerPrice) } : {}),
        })),
      };

      try {
        const res = await this.dhanService.createDhanAlert(dhanPayload);
        dhanApiResult = res;
        if (!res.ok) {
          const errMsg = res.data?.errorMessage || res.error || 'Dhan conditional alert placement rejected';
          console.warn('Dhan create alert rejected by Dhan API:', errMsg);
          throw new BadRequestException(`Failed to place alert on Dhan: ${errMsg}`);
        }
        dhanAlertId = String(res.data?.alertId || res.data?.id || '');
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(`Failed to place alert on Dhan: ${err.message}`);
      }
    }

    if (!dhanAlertId) {
      throw new BadRequestException('Failed to obtain Dhan Alert ID from Dhan HQ API');
    }

    const alertId = dhanAlertId;

    let slDhanAlertId: string | null = null;
    let slDhanApiResult: any = null;

    // Immediately place Stop Loss alert order on Dhan HQ API v2 if configured
    if (stopLossConfig && stopLossConfig.enabled && !(dto as any).isStopLossAlert) {
      const firstOrder = validatedOrders[0];
      const slAction = (stopLossConfig.action || (firstOrder.transactionType === 'BUY' ? 'SELL' : 'BUY')).toUpperCase();

      const slPayload = {
        dhanClientId: this.config.clientId,
        condition: {
          comparisonType: 'PRICE_WITH_VALUE',
          exchangeSegment: exSegment,
          securityId: String(secId),
          operator: stopLossConfig.operator,
          comparingValue: stopLossConfig.targetPrice,
          expDate,
          userNote: `[STOP LOSS] Exit for #${alertId} (${firstOrder.symbol})`,
          frequency: 'ONCE',
        },
        orders: [
          {
            symbol: firstOrder.symbol,
            tradingSymbol: firstOrder.tradingSymbol,
            customSymbol: firstOrder.customSymbol,
            instrumentName: firstOrder.instrumentName,
            strikePrice: firstOrder.strikePrice,
            optionType: firstOrder.optionType,
            expiryDate: firstOrder.expiryDate,
            transactionType: slAction,
            exchangeSegment: firstOrder.exchangeSegment,
            productType: firstOrder.productType,
            orderType: 'MARKET',
            securityId: String(firstOrder.securityId),
            quantity: Number(firstOrder.quantity),
            price: '0',
            validity: 'DAY',
          },
        ],
      };

      try {
        const slRes = await this.dhanService.createDhanAlert(slPayload);
        slDhanApiResult = slRes;
        if (slRes.ok && slRes.data) {
          slDhanAlertId = String(slRes.data.alertId || slRes.data.id || '');
        } else {
          const slErrMsg = slRes.data?.errorMessage || slRes.error || 'Stop Loss placement rejected by Dhan API';
          console.warn('Dhan Stop Loss alert placement rejected:', slErrMsg);
          // Rollback entry alert on Dhan to avoid unprotected execution
          await this.dhanService.cancelDhanAlert(alertId).catch(() => {});
          throw new BadRequestException(`Stop Loss alert rejected by Dhan: ${slErrMsg}. Primary alert was cancelled to prevent unprotected trade.`);
        }
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        await this.dhanService.cancelDhanAlert(alertId).catch(() => {});
        throw new BadRequestException(`Failed to place Stop Loss alert on Dhan: ${err.message}. Primary alert was cancelled.`);
      }
    }

    const newAlert = {
      id: alertId,
      instrument: matchedIndex ? matchedIndex.name : dto.instrument.toUpperCase(),
      securityId: String(secId),
      exchangeSegment: exSegment,
      targetPrice: priceNum,
      currentPrice,
      operator: validOp,
      status: 'ACTIVE',
      remarks: dto.remarks ? dto.remarks.trim() : `Conditional order alert for ${dto.instrument} at ₹${priceNum}`,
      createdAt: new Date().toISOString(),
      triggeredAt: null,
      hasConditionalOrder: true,
      conditionalOrders: validatedOrders,
      orders: validatedOrders,
      attachedOrder: validatedOrders.length > 0 ? {
        enabled: true,
        action: validatedOrders[0].transactionType,
        transactionType: validatedOrders[0].transactionType,
        symbol: validatedOrders[0].symbol,
        tradingSymbol: validatedOrders[0].tradingSymbol,
        customSymbol: validatedOrders[0].customSymbol,
        instrumentName: validatedOrders[0].instrumentName,
        strikePrice: validatedOrders[0].strikePrice,
        optionType: validatedOrders[0].optionType,
        expiryDate: validatedOrders[0].expiryDate,
        securityId: validatedOrders[0].securityId,
        exchangeSegment: validatedOrders[0].exchangeSegment,
        productType: validatedOrders[0].productType,
        orderType: validatedOrders[0].orderType,
        quantity: validatedOrders[0].quantity,
        price: validatedOrders[0].price,
        status: validatedOrders[0].status,
        orderId: validatedOrders[0].orderId,
        executedAt: validatedOrders[0].executedAt,
      } : undefined,
      autoExecuteOnTrigger: dto.autoExecuteOnTrigger !== false,
      stopLoss: stopLossConfig,
      stopLossAlertPlaced: Boolean(slDhanAlertId),
      stopLossAlertId: slDhanAlertId,
      isStopLossAlert: Boolean((dto as any).isStopLossAlert),
      parentAlertId: (dto as any).parentAlertId || null,
      dhanAlertId: alertId,
      dhanMetadata: {
        monitoringMode: 'Live Dhan Marketfeed & In-Memory Check Engine',
        dhanApiAlertCreated: true,
        dhanApiError: null,
        exchangeSegment: exSegment,
        securityId: String(secId),
      },
    };

    // Sync with Dhan to fetch both alerts straight from Dhan HQ API v2
    await this.syncWithDhan();

    // Ensure newAlert references are preserved in this.alerts
    const existingIdx = this.alerts.findIndex(
      (a) => a.id === alertId || a.dhanAlertId === alertId,
    );
    if (existingIdx >= 0) {
      this.alerts[existingIdx] = {
        ...this.alerts[existingIdx],
        ...newAlert,
        stopLoss: stopLossConfig || this.alerts[existingIdx].stopLoss,
        stopLossAlertPlaced: Boolean(slDhanAlertId) || this.alerts[existingIdx].stopLossAlertPlaced,
        stopLossAlertId: slDhanAlertId || this.alerts[existingIdx].stopLossAlertId,
      };
    } else {
      this.alerts.unshift(newAlert);
    }

    if (slDhanAlertId) {
      const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      const msg = `
🛡️ <b>CONDITIONAL ALERT & STOP LOSS ORDER PLACED ON DHAN</b> 🛡️

<b>Instrument:</b> ${newAlert.instrument}
<b>Entry Alert:</b> #${alertId} @ ₹${priceNum} (${dhanOp})
<b>Entry Order:</b> ${validatedOrders[0].transactionType} ${validatedOrders[0].quantity}x ${validatedOrders[0].symbol}
<b>Stop Loss Alert:</b> #${slDhanAlertId} @ ₹${stopLossConfig.targetPrice} (${stopLossConfig.operator})
<b>SL Square-off Order:</b> ${stopLossConfig.action || 'SELL'} ${validatedOrders[0].quantity}x ${validatedOrders[0].symbol}
<b>Time:</b> ${timeStr} IST
      `.trim();
      this.telegramService.sendMessage(msg).catch(() => {});
    }

    // Trigger tick check immediately
    this.checkAndTick().catch(() => {});

    const msg = slDhanAlertId
      ? `Alert #${alertId} placed on Dhan with Stop Loss #${slDhanAlertId} for ${newAlert.instrument}`
      : `Dhan alert #${alertId} with conditional order placed on Dhan for ${newAlert.instrument} at ₹${newAlert.targetPrice}`;

    return {
      success: true,
      message: msg,
      alert: this.alerts.find((a) => a.id === alertId || a.dhanAlertId === alertId) || newAlert,
      stopLossAlertId: slDhanAlertId,
      dhanApiResult,
    };
  }

  updateAlert(id: string, dto: UpdateAlertDto) {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) {
      throw new NotFoundException(`Alert ${id} not found`);
    }

    if (dto.targetPrice !== undefined) {
      const price = parseFloat(String(dto.targetPrice));
      if (!isNaN(price) && price > 0) alert.targetPrice = price;
    }
    if (dto.operator) alert.operator = dto.operator;
    if (dto.remarks !== undefined) alert.remarks = dto.remarks;
    if (dto.status) alert.status = dto.status;

    return { success: true, alert };
  }

  cancelAlert(id: string) {
    const foundAlert = this.alerts.find((a) => a.id === id || a.dhanAlertId === id);
    const rawId = foundAlert?.dhanAlertId || (id.startsWith('DHAN-') ? id.slice(5) : id);
    if (rawId && !rawId.startsWith('ALT-')) {
      this.dhanService.cancelDhanAlert(rawId).catch(() => {});
    }

    if (foundAlert?.stopLossAlertId) {
      this.cancelAlert(foundAlert.stopLossAlertId);
    }
    if (foundAlert?.parentAlertId) {
      const parent = this.alerts.find((p) => p.id === foundAlert.parentAlertId || p.dhanAlertId === foundAlert.parentAlertId);
      if (parent) {
        parent.stopLossAlertPlaced = false;
        parent.stopLossAlertId = null;
      }
    }

    const matched = this.alerts.filter((a) => a.id === id || a.id === rawId || a.dhanAlertId === rawId || a.dhanAlertId === id);
    for (const a of matched) {
      a.status = 'CANCELLED';
    }
    const matchedDhan = this.dhanAlerts.filter((a) => a.id === id || a.id === rawId || a.dhanAlertId === rawId || a.dhanAlertId === id);
    for (const a of matchedDhan) {
      a.status = 'CANCELLED';
    }

    const alert = matched[0] || matchedDhan[0] || { id, status: 'CANCELLED' };
    return { success: true, message: `Alert ${id} cancelled`, alert };
  }

  deleteAlert(id: string) {
    const foundAlert = this.alerts.find((a) => a.id === id || a.dhanAlertId === id);
    const rawId = foundAlert?.dhanAlertId || (id.startsWith('DHAN-') ? id.slice(5) : id);
    if (rawId && !rawId.startsWith('ALT-')) {
      this.dhanService.cancelDhanAlert(rawId).catch(() => {});
    }

    if (foundAlert?.stopLossAlertId) {
      this.deleteAlert(foundAlert.stopLossAlertId);
    }
    const childAlerts = this.alerts.filter(
      (a) =>
        a.isStopLossAlert &&
        (a.parentAlertId === id ||
          a.parentAlertId === rawId ||
          (foundAlert?.dhanAlertId && a.parentAlertId === foundAlert.dhanAlertId)),
    );
    for (const child of childAlerts) {
      if (child.id !== id && child.id !== foundAlert?.stopLossAlertId) {
        this.deleteAlert(child.id);
      }
    }
    if (foundAlert?.parentAlertId) {
      const parent = this.alerts.find((p) => p.id === foundAlert.parentAlertId || p.dhanAlertId === foundAlert.parentAlertId);
      if (parent) {
        parent.stopLossAlertPlaced = false;
        parent.stopLossAlertId = null;
      }
    }

    const removed = this.alerts.filter(
      (a) => a.id === id || a.id === rawId || a.dhanAlertId === rawId || a.dhanAlertId === id,
    );
    this.alerts = this.alerts.filter(
      (a) => a.id !== id && a.id !== rawId && a.dhanAlertId !== rawId && a.dhanAlertId !== id,
    );
    this.dhanAlerts = this.dhanAlerts.filter(
      (a) => a.id !== id && a.id !== rawId && a.dhanAlertId !== rawId && a.dhanAlertId !== id,
    );

    return { success: true, message: `Alert ${id} deleted`, alert: removed[0] };
  }

  startMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);

    this.monitorTimer = setInterval(() => {
      this.checkAndTick().catch(() => {});
    }, this.config.pollIntervalMs);

    if (this.monitorTimer && typeof this.monitorTimer.unref === 'function') {
      this.monitorTimer.unref();
    }
  }

  async checkAndTick() {
    if (this.isFetchingPrices) return;
    this.isFetchingPrices = true;

    try {
      const segmentsMap: Record<string, number[]> = {};

      for (const idx of POPULAR_NSE_INDICES) {
        if (!segmentsMap[idx.exchangeSegment]) {
          segmentsMap[idx.exchangeSegment] = [];
        }
        segmentsMap[idx.exchangeSegment].push(parseInt(idx.securityId, 10));
      }

      const allActive = [...this.alerts, ...this.dhanAlerts];
      for (const alert of allActive) {
        if (alert.status === 'ACTIVE' && alert.securityId && alert.exchangeSegment) {
          const seg = alert.exchangeSegment;
          if (!segmentsMap[seg]) {
            segmentsMap[seg] = [];
          }
          const numId = parseInt(alert.securityId, 10);
          if (!isNaN(numId) && !segmentsMap[seg].includes(numId)) {
            segmentsMap[seg].push(numId);
          }
        }
      }

      // 1. Try Dhan HQ API marketfeed
      try {
        const ltpResponse = await this.dhanService.getLtp(segmentsMap);

        if (ltpResponse.ok && ltpResponse.data && ltpResponse.data.data) {
          const feed = ltpResponse.data.data;
          for (const [seg, secObj] of Object.entries(feed)) {
            if (typeof secObj === 'object' && secObj !== null) {
              for (const [secId, quote] of Object.entries(secObj as any)) {
                const liveLtp = (quote as any)?.last_price || (quote as any)?.ltp;
                if (typeof liveLtp === 'number') {
                  this.priceCache.set(`${seg}:${secId}`, liveLtp);

                  const matched = POPULAR_NSE_INDICES.find(
                    (i) => i.securityId === secId && i.exchangeSegment === seg,
                  );
                  if (matched) {
                    this.priceCache.set(matched.name.toUpperCase(), liveLtp);
                    if (matched.name === 'BANK NIFTY') {
                      this.priceCache.set('NIFTY BANK', liveLtp);
                    }
                    if (matched.name === 'MIDCAP NIFTY') {
                      this.priceCache.set('MIDCP NIFTY', liveLtp);
                      this.priceCache.set('MIDCPNIFTY', liveLtp);
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // Dhan marketfeed error, continue to Yahoo Finance fallback
      }

      // 2. Fetch live prices from Yahoo Finance for indices & active alerts
      if (this.yahooService) {
        const symbolsToFetch = new Set<string>();
        for (const idx of POPULAR_NSE_INDICES) {
          symbolsToFetch.add(idx.name);
        }
        for (const alert of allActive) {
          if (alert.status === 'ACTIVE' && alert.instrument) {
            symbolsToFetch.add(alert.instrument);
          }
        }

        try {
          const quotes = await this.yahooService.getBatchLtp(Array.from(symbolsToFetch));
          for (const [sym, price] of Object.entries(quotes)) {
            if (typeof price === 'number') {
              this.priceCache.set(sym.toUpperCase(), price);

              const matchedIdx = POPULAR_NSE_INDICES.find(
                (i) =>
                  i.name.toUpperCase() === sym.toUpperCase() ||
                  (i.name === 'BANK NIFTY' && sym.toUpperCase() === 'NIFTY BANK') ||
                  (i.name === 'MIDCAP NIFTY' && (sym.toUpperCase() === 'MIDCP NIFTY' || sym.toUpperCase() === 'MIDCPNIFTY')),
              );
              if (matchedIdx) {
                this.priceCache.set(`${matchedIdx.exchangeSegment}:${matchedIdx.securityId}`, price);
                if (matchedIdx.name === 'BANK NIFTY') {
                  this.priceCache.set('NIFTY BANK', price);
                }
                if (matchedIdx.name === 'MIDCAP NIFTY') {
                  this.priceCache.set('MIDCP NIFTY', price);
                  this.priceCache.set('MIDCPNIFTY', price);
                }
              }

              for (const alert of allActive) {
                if (alert.instrument && alert.instrument.toUpperCase() === sym.toUpperCase()) {
                  if (alert.exchangeSegment && alert.securityId) {
                    this.priceCache.set(`${alert.exchangeSegment}:${alert.securityId}`, price);
                  }
                }
              }
            }
          }
        } catch {
          // Yahoo fetch error ignored
        }
      }

      let hasChanges = false;
      for (const alert of this.alerts) {
        if (alert.status !== 'ACTIVE') continue;

        const currentLtp = this.getCurrentPrice(alert.instrument, alert.securityId, alert.exchangeSegment);
        if (currentLtp === null || currentLtp === undefined) continue;

        let triggered = false;

        if (
          alert.operator === 'GREATER_THAN_OR_EQUAL' ||
          alert.operator === 'GREATER_THAN_EQUAL' ||
          alert.operator === 'GREATER_THAN' ||
          alert.operator === 'CROSSING_UP'
        ) {
          if (currentLtp >= alert.targetPrice) triggered = true;
        } else if (
          alert.operator === 'LESS_THAN_OR_EQUAL' ||
          alert.operator === 'LESS_THAN_EQUAL' ||
          alert.operator === 'LESS_THAN' ||
          alert.operator === 'CROSSING_DOWN'
        ) {
          if (currentLtp <= alert.targetPrice) triggered = true;
        } else if (alert.operator === 'CROSSING_ANY_SIDE' || alert.operator === 'CROSS_ANY_SIDE') {
          if (Math.abs(currentLtp - alert.targetPrice) <= currentLtp * 0.001) triggered = true;
        }

        if (triggered) {
          alert.status = 'TRIGGERED';
          alert.triggeredAt = new Date().toISOString();
          alert.triggeredPrice = currentLtp;
          hasChanges = true;

          this.triggeredEvents.push({
            id: alert.id,
            instrument: alert.instrument,
            targetPrice: alert.targetPrice,
            triggeredPrice: currentLtp,
            operator: alert.operator,
            remarks: alert.remarks,
            triggeredAt: alert.triggeredAt,
            hasConditionalOrder: Boolean(alert.hasConditionalOrder),
          });

          this.telegramService.sendAlertNotification(alert);

          // If attached conditional order exists and autoExecuteOnTrigger is enabled, place order on Dhan
          if (alert.hasConditionalOrder && alert.autoExecuteOnTrigger && Array.isArray(alert.conditionalOrders)) {
            for (const ord of alert.conditionalOrders) {
              if (ord.status === 'PENDING') {
                try {
                  const ordPayload = {
                    dhanClientId: this.config.clientId,
                    transactionType: ord.transactionType,
                    exchangeSegment: ord.exchangeSegment,
                    productType: ord.productType,
                    orderType: ord.orderType,
                    securityId: ord.securityId,
                    quantity: ord.quantity,
                    price: ord.price || 0,
                    triggerPrice: ord.triggerPrice || 0,
                    validity: ord.validity || 'DAY',
                  };

                  const ordRes = await this.dhanService.placeOrder(ordPayload);
                  if (ordRes.ok && ordRes.data) {
                    ord.orderId = String(ordRes.data.orderId || ordRes.data.dhanOrderId || ordRes.data.id || '');
                    ord.status = 'PLACED';
                    ord.executedAt = new Date().toISOString();
                    if (alert.attachedOrder) {
                      alert.attachedOrder.orderId = ord.orderId;
                      alert.attachedOrder.status = 'PLACED';
                      alert.attachedOrder.executedAt = ord.executedAt;
                    }

                    this.telegramService.sendOrderNotification({
                      orderId: ord.orderId,
                      symbol: ord.symbol,
                      transactionType: ord.transactionType,
                      quantity: ord.quantity,
                      price: ord.price || currentLtp,
                      orderType: ord.orderType,
                      productType: ord.productType,
                      status: 'PLACED',
                    }, 'PLACED').catch(() => {});

                    // Automatically deploy linked Stop Loss alert if configured
                    if (alert.stopLoss && alert.stopLoss.enabled && !alert.stopLossAlertPlaced) {
                      alert.stopLossAlertPlaced = true;
                      await this.deployStopLossAlert(alert, ord);
                    }
                  } else {
                    ord.status = 'FAILED';
                    ord.error = ordRes.error || ordRes.data?.message || 'Order placement failed';
                    if (alert.attachedOrder) {
                      alert.attachedOrder.status = 'FAILED';
                    }
                  }
                } catch (err: any) {
                  ord.status = 'FAILED';
                  ord.error = err.message;
                  if (alert.attachedOrder) {
                    alert.attachedOrder.status = 'FAILED';
                  }
                }
              }
            }
          }

          if (this.triggeredEvents.length > 30) {
            this.triggeredEvents.shift();
          }
        }
      }
    } finally {
      this.isFetchingPrices = false;
    }
  }

  getTriggeredEventsSince(lastEventId?: string) {
    if (!lastEventId) return this.triggeredEvents;
    const idx = this.triggeredEvents.findIndex((e) => e.id === lastEventId);
    if (idx === -1) return this.triggeredEvents;
    return this.triggeredEvents.slice(idx + 1);
  }

  /**
   * Automatically places a Stop Loss alert to square off / exit the executed order contract.
   * If entry was BUY 25000 CALL on Nifty 50 at 25017:
   * Stop Loss alert is placed at 25005 (entry - 12 pts) to SELL 25000 CALL.
   */
  async deployStopLossAlert(parentAlert: any, executedOrder: any) {
    const slConfig = parentAlert.stopLoss;
    if (!slConfig || !slConfig.enabled) return null;

    const slTargetPrice = slConfig.targetPrice;
    const slOperator = slConfig.operator || (slTargetPrice < parentAlert.targetPrice ? 'LESS_THAN' : 'GREATER_THAN');
    const slAction = (slConfig.action || (executedOrder.transactionType === 'BUY' ? 'SELL' : 'BUY')).toUpperCase();

    const slOrder: ConditionalOrderDto = {
      symbol: executedOrder.symbol,
      securityId: executedOrder.securityId,
      exchangeSegment: executedOrder.exchangeSegment || 'NSE_FNO',
      transactionType: slAction as 'BUY' | 'SELL',
      orderType: 'MARKET',
      productType: executedOrder.productType || 'INTRADAY',
      quantity: executedOrder.quantity,
      price: 0,
      validity: 'DAY',
    };

    const slAlertDto: any = {
      instrument: parentAlert.instrument,
      securityId: parentAlert.securityId,
      exchangeSegment: parentAlert.exchangeSegment,
      targetPrice: slTargetPrice,
      operator: slOperator,
      remarks: `[STOP LOSS] Exit for #${parentAlert.id} (${executedOrder.symbol})`,
      conditionalOrder: slOrder,
      executeViaDhanApi: true,
      autoExecuteOnTrigger: true,
      isStopLossAlert: true,
      parentAlertId: parentAlert.id,
    };

    try {
      const result = await this.createConditionalAlert(slAlertDto);
      if (result && result.alert) {
        result.alert.isStopLossAlert = true;
        result.alert.parentAlertId = parentAlert.id;
        parentAlert.stopLossAlertId = result.alert.id;

        const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        const msg = `
🛡️ <b>AUTOMATED STOP LOSS ALERT PLACED</b> 🛡️

<b>Parent Alert:</b> #${parentAlert.id} (${parentAlert.instrument} @ ₹${parentAlert.targetPrice})
<b>Stop Loss Level:</b> ₹${slTargetPrice} (${slOperator})
<b>Square-off Order:</b> ${slAction} ${executedOrder.quantity}x ${executedOrder.symbol}
<b>SL Alert ID:</b> <code>${result.alert.id}</code>
<b>Time:</b> ${timeStr} IST
        `.trim();
        this.telegramService.sendMessage(msg).catch(() => {});
      }
      return result;
    } catch (err: any) {
      console.warn(`Failed to deploy automated Stop Loss alert for #${parentAlert.id}:`, err.message);
      return null;
    }
  }

  triggerTestAlert(instrument = 'NIFTY 50') {
    const ltp = this.getCurrentPrice(instrument);
    const testEvent = {
      id: `TEST-${Date.now().toString().slice(-4)}`,
      instrument,
      targetPrice: ltp !== null ? ltp : 0,
      triggeredPrice: ltp !== null ? ltp : 0,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Test alert notification',
      triggeredAt: new Date().toISOString(),
      isTest: true,
    };
    this.triggeredEvents.push(testEvent);
    return testEvent;
  }
}
