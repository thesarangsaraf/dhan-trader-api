import { Injectable, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { YahooFinanceService } from '../yahoo/yahoo.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';
import { CreateConditionalAlertDto } from './dto/create-conditional-alert.dto';
import { ConditionalOrderDto } from './dto/conditional-order.dto';

const ALERTS_FILE = path.resolve(__dirname, '..', '..', 'data', 'alerts.json');

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
  ) {
    this.loadAlerts();
  }

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

  loadAlerts() {
    try {
      if (fs.existsSync(ALERTS_FILE)) {
        const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.alerts = Array.isArray(parsed) ? parsed : [];
      } else {
        this.alerts = [];
        this.saveAlerts();
      }
    } catch (err) {
      console.error('Failed to load alerts file, initializing empty:', err);
      this.alerts = [];
    }
  }

  saveAlerts() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      const dir = path.dirname(ALERTS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(this.alerts, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save alerts to file:', err);
    }
  }

  /**
   * Sync active conditional triggers from Dhan HQ API v2 and refresh live LTP.
   */
  async syncWithDhan() {
    try {
      const dhanRes = await this.dhanService.getAlerts();
      if (dhanRes.ok && Array.isArray(dhanRes.data)) {
        this.dhanAlerts = dhanRes.data.map((d: any) => ({
          id: String(d.alertId || d.id),
          instrument: d.condition?.userNote || d.tradingSymbol || `SEC-${d.condition?.securityId || d.securityId}`,
          securityId: String(d.condition?.securityId || d.securityId || ''),
          exchangeSegment: d.condition?.exchangeSegment || d.exchangeSegment || 'NSE_EQ',
          targetPrice: parseFloat(d.condition?.comparingValue || d.targetPrice || 0),
          currentPrice: this.getCurrentPrice(d.condition?.userNote, d.condition?.securityId, d.condition?.exchangeSegment),
          operator: d.condition?.operator || d.operator || 'GREATER_THAN_OR_EQUAL',
          status: (d.alertStatus || d.status || 'ACTIVE').toUpperCase(),
          remarks: d.condition?.userNote || d.remarks || 'Dhan Conditional Trigger',
          createdAt: d.createdTime || d.createdAt || new Date().toISOString(),
          triggeredAt: d.triggeredAt || null,
          source: 'dhan_api',
          orders: d.orders || [],
        }));
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
    const combined = [...this.alerts];
    for (const da of this.dhanAlerts) {
      if (!combined.some((a) => a.id === da.id)) {
        combined.push(da);
      }
    }

    return combined.map((a) => ({
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
    const validOp = dto.operator || 'GREATER_THAN_OR_EQUAL';

    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    const newAlert = {
      id: `ALT-${Date.now().toString().slice(-6)}`,
      instrument: matchedIndex ? matchedIndex.name : dto.instrument.toUpperCase(),
      securityId: String(secId),
      exchangeSegment: exSegment,
      targetPrice: priceNum,
      currentPrice,
      operator: validOp,
      status: 'ACTIVE',
      remarks: dto.remarks ? dto.remarks.trim() : `Alert for ${dto.instrument} at ${priceNum}`,
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
    this.saveAlerts();

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
      const side = (ord.transactionType || 'BUY').toUpperCase();
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
    const validOp = dto.operator || 'GREATER_THAN_OR_EQUAL';
    const currentPrice = this.getCurrentPrice(dto.instrument, secId, exSegment);

    // Dhan HQ API v2 /alerts/orders submission
    let dhanAlertId: string | null = null;
    let dhanApiResult: any = null;

    if (dto.executeViaDhanApi !== false) {
      try {
        const dhanPayload = {
          dhanClientId: this.config.clientId,
          condition: {
            comparisonType: dto.comparisonType || 'PRICE',
            exchangeSegment: exSegment,
            securityId: String(secId),
            operator: validOp,
            comparingValue: priceNum,
            userNote: dto.remarks ? dto.remarks.trim() : `Conditional order for ${dto.instrument} at ${priceNum}`,
            frequency: dto.frequency || 'ONCE',
          },
          orders: validatedOrders.map((o) => ({
            transactionType: o.transactionType,
            exchangeSegment: o.exchangeSegment,
            productType: o.productType,
            orderType: o.orderType,
            securityId: o.securityId,
            quantity: o.quantity,
            price: o.price,
            validity: o.validity,
            ...(o.triggerPrice ? { triggerPrice: o.triggerPrice } : {}),
          })),
        };

        const res = await this.dhanService.createDhanAlert(dhanPayload);
        dhanApiResult = res;
        if (res.ok && res.data) {
          dhanAlertId = String(res.data.alertId || res.data.id || '');
        }
      } catch (err: any) {
        dhanApiResult = { ok: false, error: err.message };
      }
    }

    const alertId = dhanAlertId ? `DHAN-${dhanAlertId}` : `ALT-${Date.now().toString().slice(-6)}`;

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
        exchangeSegment: exSegment,
        securityId: String(secId),
      },
    };

    this.alerts.unshift(newAlert);
    this.saveAlerts();

    // Trigger tick check immediately
    this.checkAndTick().catch(() => {});

    return {
      success: true,
      message: `Dhan alert with conditional order successfully placed for ${newAlert.instrument} at ₹${newAlert.targetPrice}`,
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

    this.saveAlerts();
    return { success: true, alert };
  }

  cancelAlert(id: string) {
    if (this.dhanAlerts.some((da) => da.id === id)) {
      this.dhanService.cancelDhanAlert(id).catch(() => {});
      this.dhanAlerts = this.dhanAlerts.filter((da) => da.id !== id);
    }

    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) {
      if (this.dhanAlerts.some((da) => da.id === id)) {
        return { success: true, message: `Dhan alert ${id} cancelled` };
      }
      throw new NotFoundException(`Alert ${id} not found`);
    }

    alert.status = 'CANCELLED';
    if (alert.dhanAlertId) {
      this.dhanService.cancelDhanAlert(alert.dhanAlertId).catch(() => {});
    }

    this.saveAlerts();
    return { success: true, message: `Alert ${id} cancelled`, alert };
  }

  deleteAlert(id: string) {
    if (this.dhanAlerts.some((da) => da.id === id)) {
      this.dhanService.cancelDhanAlert(id).catch(() => {});
      this.dhanAlerts = this.dhanAlerts.filter((da) => da.id !== id);
    }

    const idx = this.alerts.findIndex((a) => a.id === id);
    if (idx === -1) {
      return { success: true, message: `Alert ${id} deleted` };
    }
    const removed = this.alerts.splice(idx, 1)[0];
    if (removed.dhanAlertId) {
      this.dhanService.cancelDhanAlert(removed.dhanAlertId).catch(() => {});
    }

    this.saveAlerts();
    return { success: true, message: `Alert ${id} deleted`, alert: removed };
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

        if (alert.operator === 'GREATER_THAN_OR_EQUAL' || alert.operator === 'CROSSING_UP') {
          if (currentLtp >= alert.targetPrice) triggered = true;
        } else if (alert.operator === 'LESS_THAN_OR_EQUAL' || alert.operator === 'CROSSING_DOWN') {
          if (currentLtp <= alert.targetPrice) triggered = true;
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

      if (hasChanges) {
        this.saveAlerts();
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
