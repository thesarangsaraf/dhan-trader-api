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
  { name: 'NIFTY BANK', securityId: '25', exchangeSegment: 'IDX_I' },
  { name: 'SENSEX', securityId: '51', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY FIN SERVICE', securityId: '27', exchangeSegment: 'IDX_I' },
  { name: 'MIDCP NIFTY', securityId: '442', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY NEXT 50', securityId: '18', exchangeSegment: 'IDX_I' },
  { name: 'INDIA VIX', securityId: '21', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY IT', securityId: '29', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY AUTO', securityId: '31', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY FMCG', securityId: '30', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY PHARMA', securityId: '32', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY METAL', securityId: '33', exchangeSegment: 'IDX_I' },
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

        // Remove any alert from this.alerts that originated from Dhan but is NO LONGER in Dhan (deleted on Dhan web/app)
        this.alerts = this.alerts.filter((a) => {
          const isDhanAlert = a.source === 'dhan_api' || Boolean(a.dhanAlertId) || a.id.startsWith('DHAN-') || /^\d+$/.test(a.id);
          if (isDhanAlert) {
            const rawId = a.dhanAlertId || (a.id.startsWith('DHAN-') ? a.id.slice(5) : a.id);
            if (!liveDhanIds.has(rawId)) {
              return false; // Alert was deleted on Dhan!
            }
            a.id = rawId; // Normalize ID without DHAN- prefix
            a.dhanAlertId = rawId;
          }
          return true;
        });

        this.dhanAlerts = dhanRes.data.map((d: any) => {
          const alertId = String(d.alertId || d.id);
          const localMatch = this.alerts.find(
            (a) => a.id === alertId || a.dhanAlertId === alertId || a.id === `DHAN-${alertId}`,
          );

          let instName = localMatch?.instrument;
          if (!instName) {
            const matchedIndex = POPULAR_NSE_INDICES.find(
              (i) => i.securityId === String(d.condition?.securityId || d.securityId),
            );
            instName = matchedIndex
              ? matchedIndex.name
              : (d.condition?.userNote || d.tradingSymbol || `SEC-${d.condition?.securityId || d.securityId}`);
          }

          return {
            id: alertId,
            instrument: instName,
            securityId: String(d.condition?.securityId || d.securityId || ''),
            exchangeSegment: d.condition?.exchangeSegment || d.exchangeSegment || 'NSE_EQ',
            targetPrice: parseFloat(d.condition?.comparingValue || d.targetPrice || 0),
            currentPrice: this.getCurrentPrice(instName, d.condition?.securityId, d.condition?.exchangeSegment),
            operator: d.condition?.operator || d.operator || 'GREATER_THAN_EQUAL',
            status: (d.alertStatus || d.status || 'ACTIVE').toUpperCase(),
            remarks: d.condition?.userNote || d.remarks || 'Dhan Conditional Trigger',
            createdAt: d.createdTime
              ? (typeof d.createdTime === 'number' ? new Date(d.createdTime * 1000).toISOString() : String(d.createdTime))
              : (localMatch?.createdAt || new Date().toISOString()),
            triggeredAt: d.triggeredAt || null,
            source: 'dhan_api',
            orders: d.orders || [],
            hasConditionalOrder: Boolean(d.orders && d.orders.length > 0),
            conditionalOrders: localMatch?.conditionalOrders || d.orders || [],
            dhanAlertId: alertId,
          };
        });

        // Reconcile this.alerts with this.dhanAlerts
        for (const da of this.dhanAlerts) {
          const localIdx = this.alerts.findIndex(
            (a) => a.id === da.id || a.dhanAlertId === da.id || a.id === `DHAN-${da.id}`,
          );
          if (localIdx >= 0) {
            this.alerts[localIdx].id = da.id;
            this.alerts[localIdx].status = da.status;
            this.alerts[localIdx].dhanAlertId = da.id;
            if (da.operator) this.alerts[localIdx].operator = da.operator;
            if (da.currentPrice) this.alerts[localIdx].currentPrice = da.currentPrice;
          } else {
            this.alerts.push(da);
          }
        }
      }
    } catch {
      // If Dhan API is offline or alerts not subscribed, retain local alerts
    }

    await this.checkAndTick();
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
    if (instrument && this.priceCache.has(instrument.toUpperCase())) {
      return this.priceCache.get(instrument.toUpperCase()) || null;
    }
    return null;
  }

  getAllAlerts() {
    const seen = new Set<string>();
    const unique: any[] = [];

    for (const a of this.alerts) {
      const key = a.dhanAlertId || a.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(a);
      }
    }

    return unique.map((a) => ({
      ...a,
      currentPrice: this.getCurrentPrice(a.instrument, a.securityId, a.exchangeSegment),
    }));
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

    if (!dto.instrument || dto.targetPrice === undefined || dto.targetPrice === null) {
      throw new BadRequestException('Instrument and target price are required');
    }

    const priceNum = parseFloat(String(dto.targetPrice));
    if (isNaN(priceNum) || priceNum <= 0) {
      throw new BadRequestException('Target price must be a positive number');
    }

    const matchedIndex = POPULAR_NSE_INDICES.find(
      (i) => i.name.toUpperCase() === dto.instrument.toUpperCase(),
    );

    const secId = dto.securityId || (matchedIndex ? matchedIndex.securityId : '0');
    const exSegment = dto.exchangeSegment || (matchedIndex ? matchedIndex.exchangeSegment : 'NSE_EQ');
    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    // Operator is decided automatically if omitted: GREATER_THAN_EQUAL if target >= current, LESS_THAN_EQUAL if target < current
    let validOp = dto.operator;
    if (!validOp || validOp === 'AUTO') {
      validOp = currentPrice && priceNum < currentPrice ? 'LESS_THAN_EQUAL' : 'GREATER_THAN_EQUAL';
    }

    const newAlert = {
      id: `ALT-${Date.now().toString().slice(-6)}`,
      instrument: matchedIndex ? matchedIndex.name : dto.instrument.toUpperCase(),
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
        noStaticIpRequired: true,
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
   * Place a Dhan alert with an attached conditional order.
   * Registers directly with Dhan HQ v2 (/alerts/orders) and runs locally in memory without static IP requirement.
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
      const qty = parseInt(String(ord.quantity), 10);
      if (isNaN(qty) || qty <= 0) {
        throw new BadRequestException(`Order at index ${idx} requires a positive quantity`);
      }
      const side = (ord.transactionType || (ord as any).action || 'BUY').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') {
        throw new BadRequestException(`Order at index ${idx} transactionType must be BUY or SELL`);
      }

      let secId = ord.securityId;
      if (!secId && this.instrumentsService) {
        const found = this.instrumentsService.findBySymbol(ord.symbol);
        if (found) {
          secId = found.securityId;
        }
      }

      return {
        symbol: ord.symbol.toUpperCase(),
        securityId: String(secId || '0'),
        exchangeSegment: ord.exchangeSegment || 'NSE_FNO',
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

    const matchedIndex = POPULAR_NSE_INDICES.find(
      (i) => i.name.toUpperCase() === dto.instrument.toUpperCase(),
    );

    let secId = dto.securityId;
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
    exSegment = exSegment || 'IDX_I';
    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    // Operator is decided automatically if omitted: GREATER_THAN_EQUAL if target >= current, LESS_THAN_EQUAL if target < current
    let validOp = dto.operator;
    if (!validOp || validOp === 'AUTO') {
      validOp = currentPrice && priceNum < currentPrice ? 'LESS_THAN_EQUAL' : 'GREATER_THAN_EQUAL';
    }

    // Map operator to official Dhan HQ API v2 enums
    // For PRICE_WITH_VALUE comparisons, Dhan Web UI natively supports GREATER_THAN_EQUAL and LESS_THAN_EQUAL
    let dhanOp = validOp;
    if (validOp === 'GREATER_THAN_OR_EQUAL' || validOp === 'CROSSING_UP') {
      dhanOp = 'GREATER_THAN_EQUAL';
    } else if (validOp === 'LESS_THAN_OR_EQUAL' || validOp === 'CROSSING_DOWN') {
      dhanOp = 'LESS_THAN_EQUAL';
    } else if (validOp === 'CROSS_ANY_SIDE' || validOp === 'CROSSING_ANY_SIDE') {
      dhanOp = 'CROSSING_ANY_SIDE';
    }

    // Expiry date (mandatory for Dhan API)
    const expDate = dto.expDate || (() => {
      const d = new Date(Date.now() + 30 * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    // Dhan HQ API v2 /alerts/orders submission
    let dhanAlertId: string | null = null;
    let dhanApiResult: any = null;

    if (dto.executeViaDhanApi !== false) {
      try {
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

        const res = await this.dhanService.createDhanAlert(dhanPayload);
        dhanApiResult = res;
        if (res.ok && res.data) {
          dhanAlertId = String(res.data.alertId || res.data.id || '');
          await this.syncWithDhan();
        } else if (!res.ok) {
          const errMsg = res.data?.errorMessage || res.error || 'Dhan conditional alert placement rejected';
          console.warn('Dhan create alert rejected by Dhan API, running via local monitoring engine:', errMsg);
        }
      } catch (err: any) {
        dhanApiResult = { ok: false, error: err.message };
        console.warn('Dhan create alert exception, running via local monitoring engine:', err.message);
      }
    }

    const alertId = dhanAlertId ? dhanAlertId : `ALT-${Date.now().toString().slice(-6)}`;

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
      autoExecuteOnTrigger: dto.autoExecuteOnTrigger !== false,
      dhanAlertId,
      dhanMetadata: {
        noStaticIpRequired: true,
        monitoringMode: 'Live Dhan Marketfeed & In-Memory Check Engine',
        dhanApiAlertCreated: Boolean(dhanAlertId),
        dhanApiError: dhanApiResult && !dhanApiResult.ok ? (dhanApiResult.data?.errorMessage || dhanApiResult.error) : null,
        exchangeSegment: exSegment,
        securityId: String(secId),
      },
    };

    // Update existing if already inserted by syncWithDhan to prevent duplicate cards in UI
    const existingIdx = this.alerts.findIndex(
      (a) => a.id === alertId || (dhanAlertId && a.dhanAlertId === dhanAlertId),
    );
    if (existingIdx >= 0) {
      this.alerts[existingIdx] = { ...this.alerts[existingIdx], ...newAlert };
    } else {
      this.alerts.unshift(newAlert);
    }

    // Trigger tick check immediately
    this.checkAndTick().catch(() => {});

    const isDhanRegistered = Boolean(dhanAlertId);
    const msg = isDhanRegistered
      ? `Dhan alert with conditional order placed on Dhan for ${newAlert.instrument} at ₹${newAlert.targetPrice}`
      : `Conditional alert placed in local engine for ${newAlert.instrument} at ₹${newAlert.targetPrice}${dhanApiResult?.data?.errorMessage ? ` (Dhan note: ${dhanApiResult.data.errorMessage})` : ''}`;

    return {
      success: true,
      message: msg,
      alert: newAlert,
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
    const rawId = id.startsWith('DHAN-') ? id.slice(5) : id;
    if (rawId) {
      this.dhanService.cancelDhanAlert(rawId).catch(() => {});
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
    const rawId = id.startsWith('DHAN-') ? id.slice(5) : id;
    if (rawId) {
      this.dhanService.cancelDhanAlert(rawId).catch(() => {});
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
                (i) => i.name.toUpperCase() === sym.toUpperCase(),
              );
              if (matchedIdx) {
                this.priceCache.set(`${matchedIdx.exchangeSegment}:${matchedIdx.securityId}`, price);
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
                  } else {
                    ord.status = 'FAILED';
                    ord.error = ordRes.error || ordRes.data?.message || 'Order placement failed';
                  }
                } catch (err: any) {
                  ord.status = 'FAILED';
                  ord.error = err.message;
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
