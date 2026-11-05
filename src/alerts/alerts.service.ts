import { Injectable, OnModuleInit, OnModuleDestroy, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../config/config.service';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { CreateAlertDto } from './dto/create-alert.dto';
import { UpdateAlertDto } from './dto/update-alert.dto';

const ALERTS_FILE = path.resolve(__dirname, '..', '..', 'data', 'alerts.json');

export const POPULAR_NSE_INDICES = [
  { name: 'NIFTY 50', securityId: '13', exchangeSegment: 'IDX_I' },
  { name: 'NIFTY BANK', securityId: '25', exchangeSegment: 'IDX_I' },
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
  public priceCache: Map<string, number> = new Map();
  public triggeredEvents: any[] = [];

  private monitorTimer: NodeJS.Timeout | null = null;
  private isFetchingPrices = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dhanService: DhanService,
    private readonly telegramService: TelegramService,
  ) {
    this.loadAlerts();
  }

  onModuleInit() {
    this.startMonitor();
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
        this.alerts = JSON.parse(raw);
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
    return this.alerts.map((a) => ({
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
      dhanMetadata: {
        noStaticIpRequired: true,
        monitoringMode: 'Live Dhan Marketfeed & In-Memory Check Engine',
        exchangeSegment: exSegment,
        securityId: String(secId),
      },
    };

    this.alerts.unshift(newAlert);
    this.saveAlerts();

    // Trigger immediate price tick check
    this.checkAndTick().catch(() => {});

    return {
      success: true,
      message: `Price alert successfully placed for ${newAlert.instrument} at ₹${newAlert.targetPrice}`,
      alert: newAlert,
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
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    alert.status = 'CANCELLED';
    this.saveAlerts();
    return { success: true, message: `Alert ${id} cancelled`, alert };
  }

  deleteAlert(id: string) {
    const idx = this.alerts.findIndex((a) => a.id === id);
    if (idx === -1) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    const removed = this.alerts.splice(idx, 1)[0];
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

      for (const alert of this.alerts) {
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
          });

          this.telegramService.sendAlertNotification(alert);

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
    const ltp = this.getCurrentPrice(instrument) || 24500.0;
    const testEvent = {
      id: `TEST-${Date.now().toString().slice(-4)}`,
      instrument,
      targetPrice: ltp,
      triggeredPrice: ltp,
      operator: 'GREATER_THAN_OR_EQUAL',
      remarks: 'Test alert notification',
      triggeredAt: new Date().toISOString(),
      isTest: true,
    };
    this.triggeredEvents.push(testEvent);
    return testEvent;
  }
}
