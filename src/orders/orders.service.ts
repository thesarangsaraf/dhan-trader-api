import { Injectable, BadRequestException, BadGatewayException, Optional } from '@nestjs/common';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { GetTradeHistoryDto } from './dto/get-trade-history.dto';
import { getAvailableFinancialYears, resolveFinancialYearDates } from './utils/financial-year.util';

@Injectable()
export class OrdersService {
  constructor(
    private readonly dhanService: DhanService,
    private readonly telegramService: TelegramService,
    @Optional() private readonly instrumentsService?: InstrumentsService,
  ) {}

  async getOrders() {
    const apiResult = await this.dhanService.getOrders();

    if (apiResult.ok && Array.isArray(apiResult.data)) {
      return apiResult.data.map((ord: any) => ({
        orderId: String(ord.orderId || ord.order_id || ord.dhanOrderId || ''),
        dhanClientId: ord.dhanClientId,
        symbol: ord.tradingSymbol || ord.symbol || `${ord.securityId || ''}`,
        securityId: String(ord.securityId || ''),
        exchangeSegment: ord.exchangeSegment || 'NSE_EQ',
        transactionType: (ord.transactionType || 'BUY').toUpperCase(),
        orderType: (ord.orderType || 'MARKET').toUpperCase(),
        productType: (ord.productType || 'INTRADAY').toUpperCase(),
        quantity: parseInt(ord.quantity || ord.orderQty || 0, 10),
        price: parseFloat(ord.price || 0),
        triggerPrice: parseFloat(ord.triggerPrice || 0),
        status: (ord.orderStatus || ord.status || 'PENDING').toUpperCase(),
        createTime: ord.createTime || ord.orderTimestamp || new Date().toISOString(),
        updateTime: ord.updateTime || new Date().toISOString(),
      }));
    }

    if (!apiResult.ok) {
      const errorMsg = apiResult.data?.errorMessage
        || apiResult.data?.message
        || apiResult.data?.data?.['808']
        || apiResult.error
        || `Dhan API error (HTTP ${apiResult.status})`;
      throw new BadGatewayException(errorMsg);
    }

    return [];
  }

  async getPositions() {
    const [posResult, fundsResult] = await Promise.all([
      this.dhanService.getPositions(),
      this.dhanService.getFundLimits(),
    ]);

    if (!posResult.ok) {
      const errorMsg = posResult.data?.errorMessage
        || posResult.data?.message
        || posResult.data?.data?.['808']
        || posResult.error
        || `Failed to fetch positions from Dhan API (HTTP ${posResult.status})`;
      throw new BadGatewayException(errorMsg);
    }

    const rawPositions = Array.isArray(posResult.data) ? posResult.data : [];
    const positionsList = rawPositions.map((p: any) => ({
      positionId: p.positionId || `POS-${p.securityId}`,
      symbol: p.tradingSymbol || p.symbol || `SEC-${p.securityId}`,
      securityId: String(p.securityId || ''),
      exchangeSegment: p.exchangeSegment || 'NSE_EQ',
      productType: p.productType || 'INTRADAY',
      netQty: p.netQty !== undefined ? p.netQty : ((p.buyQty || 0) - (p.sellQty || 0)),
      buyQty: p.buyQty || 0,
      sellQty: p.sellQty || 0,
      buyAvg: p.buyAvg || p.costPrice || 0,
      sellAvg: p.sellAvg || 0,
      ltp: p.ltp || p.lastPrice || 0,
      realizedPnL: p.realizedProfit !== undefined ? p.realizedProfit : (p.realizedPnL || 0),
      unrealizedPnL: p.unrealizedProfit !== undefined ? p.unrealizedProfit : (p.unrealizedPnL || 0),
    }));

    let fundInfo: any = null;

    if (fundsResult.ok && fundsResult.data) {
      const fd = fundsResult.data as any;
      fundInfo = {
        availableBalance:
          parseFloat(String(
            fd.availabelBalance ??
            fd.availableBalance ??
            fd.availMargin ??
            fd.sodLimit ??
            fd.cash ??
            0
          )) || 0,
        utilizedMargin:
          parseFloat(String(
            fd.utilizedAmount ??
            fd.utilizedMargin ??
            fd.marginUtilized ??
            0
          )) || 0,
        collateralAmount:
          parseFloat(String(
            fd.collateralAmount ??
            0
          )) || 0,
        withdrawableBalance:
          parseFloat(String(
            fd.withdrawableBalance ??
            fd.cash ??
            0
          )) || 0,
        dhanClientId: fd.dhanClientId || (this.dhanService as any)?.config?.clientId || undefined,
      };
    }

    let totalRealized = 0;
    let totalUnrealized = 0;
    for (const p of positionsList) {
      totalRealized += parseFloat(String(p.realizedPnL || 0));
      totalUnrealized += parseFloat(String(p.unrealizedPnL || 0));
    }

    return {
      positions: positionsList,
      funds: fundInfo,
      summary: {
        totalRealized: Math.round(totalRealized * 100) / 100,
        totalUnrealized: Math.round(totalUnrealized * 100) / 100,
        netPnL: Math.round((totalRealized + totalUnrealized) * 100) / 100,
        openPositionsCount: positionsList.filter((p: any) => p.netQty !== 0).length,
        closedPositionsCount: positionsList.filter((p: any) => p.netQty === 0).length,
      },
    };
  }

  async getFunds() {
    const holdingsPromise =
      typeof this.dhanService.getHoldings === 'function'
        ? this.dhanService.getHoldings()
        : Promise.resolve({ ok: true, data: [] });

    const [fundsResult, holdingsResult] = await Promise.all([
      this.dhanService.getFundLimits(),
      holdingsPromise,
    ]);

    if (!fundsResult.ok && !holdingsResult.ok) {
      const errorMsg =
        fundsResult.data?.errorMessage ||
        fundsResult.data?.message ||
        fundsResult.data?.data?.['808'] ||
        fundsResult.error ||
        `Failed to fetch fund limits from Dhan API (HTTP ${fundsResult.status})`;
      throw new BadGatewayException(errorMsg);
    }

    const fd = (fundsResult.ok && fundsResult.data ? fundsResult.data : {}) as any;

    // Available Trading Balance: Handles Dhan HQ API typo "availabelBalance" and sodLimit
    const availableBalance =
      parseFloat(String(
        fd.availabelBalance ??
        fd.availableBalance ??
        fd.availMargin ??
        fd.sodLimit ??
        fd.cash ??
        0
      )) || 0;

    const utilizedMargin =
      parseFloat(String(
        fd.utilizedAmount ??
        fd.utilizedMargin ??
        fd.marginUtilized ??
        0
      )) || 0;

    const collateralAmount =
      parseFloat(String(
        fd.collateralAmount ??
        0
      )) || 0;

    const withdrawableBalance =
      parseFloat(String(
        fd.withdrawableBalance ??
        fd.cash ??
        availableBalance
      )) || 0;

    // Demat Portfolio Stock Holdings Value from /holdings
    let dematHoldingsValue = 0;
    let holdingsCount = 0;
    if (holdingsResult.ok && Array.isArray(holdingsResult.data)) {
      holdingsCount = holdingsResult.data.length;
      for (const h of holdingsResult.data) {
        const qty = parseFloat(String(h.totalQty || h.quantity || h.dpQty || 0));
        const price = parseFloat(String(h.currentValue || h.ltp || h.lastPrice || h.avgCostPrice || h.costPrice || 0));
        if (h.currentValue) {
          dematHoldingsValue += parseFloat(String(h.currentValue));
        } else {
          dematHoldingsValue += qty * price;
        }
      }
    }
    dematHoldingsValue = Math.round(dematHoldingsValue * 100) / 100;
    const totalAccountValue = Math.round((availableBalance + dematHoldingsValue + collateralAmount) * 100) / 100;

    return {
      availableBalance,
      utilizedMargin,
      collateralAmount,
      withdrawableBalance,
      dematHoldingsValue,
      holdingsCount,
      totalAccountValue,
      dhanClientId: fd.dhanClientId || (this.dhanService as any)?.config?.clientId || undefined,
    };
  }

  async placeOrder(dto: PlaceOrderDto) {
    const qty = parseInt(String(dto.quantity), 10);
    if (isNaN(qty) || qty <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const orderPrice = parseFloat(String(dto.price || 0)) || 0;
    const trigger = parseFloat(String(dto.triggerPrice || 0)) || 0;

    const apiResult = await this.dhanService.placeOrder({
      dhanClientId: this.dhanService['config'].clientId,
      transactionType: dto.transactionType.toUpperCase(),
      exchangeSegment: dto.exchangeSegment || 'NSE_FNO',
      productType: (dto.productType || 'INTRADAY').toUpperCase(),
      orderType: (dto.orderType || 'MARKET').toUpperCase(),
      validity: 'DAY',
      securityId: String(dto.securityId),
      quantity: qty,
      price: orderPrice,
      triggerPrice: trigger,
    });

    if (apiResult.ok && apiResult.data) {
      const liveOrderId = String(
        apiResult.data.orderId || apiResult.data.dhanOrderId || apiResult.data.id || '',
      );
      if (!liveOrderId) {
        throw new BadGatewayException('Dhan API response did not contain an order ID');
      }

      const liveOrder = {
        orderId: liveOrderId,
        dhanClientId: this.dhanService['config'].clientId,
        symbol: dto.symbol.toUpperCase(),
        securityId: String(dto.securityId),
        exchangeSegment: dto.exchangeSegment || 'NSE_FNO',
        transactionType: dto.transactionType.toUpperCase(),
        orderType: (dto.orderType || 'MARKET').toUpperCase(),
        productType: (dto.productType || 'INTRADAY').toUpperCase(),
        quantity: qty,
        price: orderPrice,
        triggerPrice: trigger,
        status: (apiResult.data.orderStatus || 'PENDING').toUpperCase(),
        createTime: new Date().toISOString(),
        updateTime: new Date().toISOString(),
      };

      // Event notifications stopped per user instruction
      // this.telegramService.sendOrderNotification(liveOrder, 'PLACED');

      return {
        success: true,
        source: 'dhan_api',
        order: liveOrder,
      };
    }

    const errorMsg = apiResult.data?.errorMessage
      || apiResult.data?.message
      || apiResult.data?.data?.['808']
      || apiResult.error
      || `Dhan API order rejection (HTTP ${apiResult.status})`;

    throw new BadRequestException(errorMsg);
  }

  async cancelOrder(orderId: string) {
    if (!orderId) {
      throw new BadRequestException('Order ID is required');
    }

    const apiResult = await this.dhanService.cancelOrder(orderId);

    if (apiResult.ok) {
      // Event notifications stopped per user instruction
      // this.telegramService.sendOrderNotification({ orderId, status: 'CANCELLED', symbol: 'ORDER' }, 'CANCELLED');
      return {
        success: true,
        source: 'dhan_api',
        orderId,
        message: `Order ${orderId} cancelled successfully on Dhan`,
      };
    }

    const errorMsg = apiResult.data?.errorMessage
      || apiResult.data?.message
      || apiResult.data?.data?.['808']
      || apiResult.error
      || `Failed to cancel order ${orderId} on Dhan API`;

    throw new BadRequestException(errorMsg);
  }

  getFinancialYears() {
    return getAvailableFinancialYears();
  }

  async getTrades() {
    const apiResult = await this.dhanService.getTrades();
    if (apiResult.ok && Array.isArray(apiResult.data)) {
      return this.mapTradeRecords(apiResult.data);
    }
    if (!apiResult.ok) {
      const errorMsg = apiResult.data?.errorMessage
        || apiResult.data?.message
        || apiResult.data?.data?.['808']
        || apiResult.error
        || `Dhan API error (HTTP ${apiResult.status})`;
      throw new BadGatewayException(errorMsg);
    }
    return [];
  }

  async getTradeHistory(dto: GetTradeHistoryDto = {}) {
    const { financialYear, fromDate, toDate, isCurrent } = resolveFinancialYearDates(
      dto.financialYear,
      dto.fromDate,
      dto.toDate,
    );

    const page = dto.page !== undefined ? Number(dto.page) : 0;
    let rawTrades: any[] = [];

    const shouldFetchAll = dto.fetchAll === true || (dto.fetchAll === undefined && dto.page === undefined);
    if (shouldFetchAll) {
      for (let p = 0; p < 50; p++) {
        const pageResult = await this.dhanService.getTradeHistory(fromDate, toDate, p);
        if (!pageResult.ok) {
          if (p === 0) {
            const errorMsg = pageResult.data?.errorMessage
              || pageResult.data?.message
              || pageResult.data?.data?.['808']
              || pageResult.error
              || `Failed to fetch trades from Dhan API (HTTP ${pageResult.status})`;
            throw new BadGatewayException(errorMsg);
          }
          break;
        }

        const batch = Array.isArray(pageResult.data)
          ? pageResult.data
          : Array.isArray(pageResult.data?.data)
          ? pageResult.data.data
          : [];

        if (batch.length === 0) break;
        rawTrades.push(...batch);
        // Dhan HQ API v2 returns 20 records per page; fewer than 20 indicates the terminal page
        if (batch.length < 20) break;
      }
    } else {
      const apiResult = await this.dhanService.getTradeHistory(fromDate, toDate, page);
      if (!apiResult.ok) {
        const errorMsg = apiResult.data?.errorMessage
          || apiResult.data?.message
          || apiResult.data?.data?.['808']
          || apiResult.error
          || `Failed to fetch trade history from Dhan API (HTTP ${apiResult.status})`;
        throw new BadGatewayException(errorMsg);
      }

      rawTrades = Array.isArray(apiResult.data)
        ? apiResult.data
        : Array.isArray(apiResult.data?.data)
        ? apiResult.data.data
        : [];
    }

    const rawTradeFills = this.mapTradeRecords(rawTrades);
    const trades = this.pairTradeFills(rawTradeFills);

    let totalRealizedPnL = 0;
    let closedTradesCount = 0;
    let profitableTradesCount = 0;
    let lossTradesCount = 0;
    let totalQuantity = 0;
    let totalCharges = 0;

    for (const t of trades) {
      totalQuantity += t.quantity;
      if (t.totalCharges) {
        totalCharges += t.totalCharges;
      }
      if (t.status === 'CLOSED' && typeof t.pnl === 'number') {
        closedTradesCount++;
        totalRealizedPnL += t.pnl;
        if (t.pnl > 0) {
          profitableTradesCount++;
        } else if (t.pnl < 0) {
          lossTradesCount++;
        }
      }
    }

    const winRate = closedTradesCount > 0
      ? Math.round((profitableTradesCount / closedTradesCount) * 1000) / 10
      : 0;

    const netRealizedPnL = Math.round((totalRealizedPnL - totalCharges) * 100) / 100;

    return {
      financialYear,
      fromDate,
      toDate,
      isCurrent,
      page,
      availableFinancialYears: getAvailableFinancialYears(),
      summary: {
        totalTrades: trades.length,
        closedTradesCount,
        profitableTradesCount,
        lossTradesCount,
        winRate,
        totalRealizedPnL: Math.round(totalRealizedPnL * 100) / 100,
        totalCharges: Math.round(totalCharges * 100) / 100,
        netRealizedPnL,
        totalQuantity,
      },
      trades,
      rawTrades: rawTradeFills,
    };
  }

  private mapTradeRecords(rawList: any[]) {
    return rawList.map((t: any, idx: number) => {
      const qty = parseInt(t.tradedQuantity || t.quantity || t.orderQty || 0, 10);
      const price = parseFloat(t.tradedPrice || t.price || t.averageTradedPrice || 0);
      const val = parseFloat(t.tradeValue || (qty * price) || 0);

      const secId = String(t.securityId || '');
      // Look up human-readable name from Firestore index options or Dhan's direct customSymbol
      const matched = this.instrumentsService?.findBySecurityId(secId);
      const humanName = (typeof matched === 'string' ? matched : (matched?.customSymbol || matched?.symbol || matched?.name))
        || t.customSymbol
        || t.tradingSymbol
        || t.symbol
        || (secId ? `Security #${secId}` : 'UNKNOWN');

      // Taxes and brokerage charges from Dhan HQ API v2
      const brokerage = parseFloat(t.brokerageCharges || 0);
      const stt = parseFloat(t.stt || 0);
      const sebiTax = parseFloat(t.sebiTax || 0);
      const serviceTax = parseFloat(t.serviceTax || 0);
      const exchangeCharges = parseFloat(t.exchangeTransactionCharges || 0);
      const stampDuty = parseFloat(t.stampDuty || 0);
      const totalCharges = Math.round((brokerage + stt + sebiTax + serviceTax + exchangeCharges + stampDuty) * 100) / 100;

      // Robust execution timestamp resolution combining tradeDate and exchangeTime/createTime
      const tradeDate = t.tradeDate || (t.createTime && String(t.createTime).includes('-') ? String(t.createTime).split(' ')[0] : '');
      const rawTime = String(t.exchangeTime || t.createTime || t.updateTime || '').trim();
      let executionTime = '';

      if (rawTime.includes('T')) {
        executionTime = rawTime;
      } else if (rawTime.includes('-') && rawTime.includes(':')) {
        executionTime = rawTime.replace(' ', 'T');
      } else if (tradeDate && rawTime) {
        executionTime = `${tradeDate}T${rawTime}`;
      } else if (tradeDate) {
        executionTime = `${tradeDate}T09:15:00`;
      } else if (rawTime) {
        executionTime = rawTime;
      } else {
        executionTime = new Date().toISOString();
      }

      return {
        tradeId: String(t.tradeId || t.exchangeTradeId || t.orderId || `TR-${idx + 1}`),
        orderId: String(t.orderId || ''),
        exchangeOrderId: t.exchangeOrderId ? String(t.exchangeOrderId) : undefined,
        exchangeTradeId: t.exchangeTradeId ? String(t.exchangeTradeId) : undefined,
        symbol: humanName,
        securityId: secId,
        exchangeSegment: t.exchangeSegment || 'NSE_EQ',
        transactionType: (t.transactionType || 'BUY').toUpperCase() as 'BUY' | 'SELL',
        productType: (t.productType || 'INTRADAY').toUpperCase(),
        orderType: (t.orderType || 'MARKET').toUpperCase(),
        tradedQuantity: qty,
        tradedPrice: price,
        tradeValue: Math.round(val * 100) / 100,
        tradeDate: tradeDate || (executionTime.includes('T') ? executionTime.split('T')[0] : ''),
        exchangeTime: t.exchangeTime || rawTime,
        createTime: executionTime,
        executionTime,
        brokerage,
        stt,
        sebiTax,
        serviceTax,
        exchangeCharges,
        stampDuty,
        totalCharges,
      };
    });
  }

  /**
   * Consolidates BUY and SELL trade fills of the same instrument into single round-trip trades.
   */
  private pairTradeFills(tradeFills: any[]) {
    const grouped = new Map<string, any[]>();
    for (const t of tradeFills) {
      const key = t.securityId || t.symbol;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(t);
    }

    const pairedResults: any[] = [];
    let pairCounter = 1;

    for (const [key, fills] of grouped.entries()) {
      // Sort chronologically ascending
      const sorted = [...fills].sort((a, b) => {
        const timeA = new Date(a.executionTime || a.createTime).getTime() || 0;
        const timeB = new Date(b.executionTime || b.createTime).getTime() || 0;
        return timeA - timeB;
      });

      const buyQueue: Array<{ qty: number; price: number; time: string; date: string; fill: any }> = [];
      const sellQueue: Array<{ qty: number; price: number; time: string; date: string; fill: any }> = [];

      for (const fill of sorted) {
        let remainingQty = fill.tradedQuantity;
        const fillPrice = fill.tradedPrice;
        const fillTime = fill.executionTime || fill.createTime;
        const fillDate = fill.tradeDate;

        if (fill.transactionType === 'BUY') {
          // Check for existing short positions in sellQueue
          while (remainingQty > 0 && sellQueue.length > 0) {
            const sellItem = sellQueue[0];
            const matchedQty = Math.min(remainingQty, sellItem.qty);
            const pnl = Math.round((sellItem.price - fillPrice) * matchedQty * 100) / 100;
            const pnlPercentage = sellItem.price > 0
              ? Math.round(((sellItem.price - fillPrice) / sellItem.price) * 10000) / 100
              : 0;

            const buyRatio = fill.tradedQuantity > 0 ? (matchedQty / fill.tradedQuantity) : 1;
            const sellRatio = sellItem.fill.tradedQuantity > 0 ? (matchedQty / sellItem.fill.tradedQuantity) : 1;
            const matchedCharges = Math.round((
              (fill.totalCharges || 0) * buyRatio +
              (sellItem.fill.totalCharges || 0) * sellRatio
            ) * 100) / 100;

            pairedResults.push({
              tradeId: `PAIR-${pairCounter++}`,
              symbol: fill.symbol,
              securityId: fill.securityId,
              quantity: matchedQty,
              buyPrice: fillPrice,
              sellPrice: sellItem.price,
              pnl,
              pnlPercentage,
              totalCharges: matchedCharges,
              netPnL: Math.round((pnl - matchedCharges) * 100) / 100,
              status: 'CLOSED',
              isProfit: pnl >= 0,
              tradeDate: fillDate || sellItem.date,
              executionTime: fillTime,
              buyTime: fillTime,
              sellTime: sellItem.time,
            });

            remainingQty -= matchedQty;
            sellItem.qty -= matchedQty;
            if (sellItem.qty <= 0) {
              sellQueue.shift();
            }
          }

          if (remainingQty > 0) {
            buyQueue.push({
              qty: remainingQty,
              price: fillPrice,
              time: fillTime,
              date: fillDate,
              fill,
            });
          }
        } else {
          // TransactionType === 'SELL'
          // Match against long positions in buyQueue
          while (remainingQty > 0 && buyQueue.length > 0) {
            const buyItem = buyQueue[0];
            const matchedQty = Math.min(remainingQty, buyItem.qty);
            const pnl = Math.round((fillPrice - buyItem.price) * matchedQty * 100) / 100;
            const pnlPercentage = buyItem.price > 0
              ? Math.round(((fillPrice - buyItem.price) / buyItem.price) * 10000) / 100
              : 0;

            const buyRatio = buyItem.fill.tradedQuantity > 0 ? (matchedQty / buyItem.fill.tradedQuantity) : 1;
            const sellRatio = fill.tradedQuantity > 0 ? (matchedQty / fill.tradedQuantity) : 1;
            const matchedCharges = Math.round((
              (buyItem.fill.totalCharges || 0) * buyRatio +
              (fill.totalCharges || 0) * sellRatio
            ) * 100) / 100;

            pairedResults.push({
              tradeId: `PAIR-${pairCounter++}`,
              symbol: fill.symbol,
              securityId: fill.securityId,
              quantity: matchedQty,
              buyPrice: buyItem.price,
              sellPrice: fillPrice,
              pnl,
              pnlPercentage,
              totalCharges: matchedCharges,
              netPnL: Math.round((pnl - matchedCharges) * 100) / 100,
              status: 'CLOSED',
              isProfit: pnl >= 0,
              tradeDate: fillDate || buyItem.date,
              executionTime: fillTime,
              buyTime: buyItem.time,
              sellTime: fillTime,
            });

            remainingQty -= matchedQty;
            buyItem.qty -= matchedQty;
            if (buyItem.qty <= 0) {
              buyQueue.shift();
            }
          }

          if (remainingQty > 0) {
            sellQueue.push({
              qty: remainingQty,
              price: fillPrice,
              time: fillTime,
              date: fillDate,
              fill,
            });
          }
        }
      }

      // Any remaining unmatched buys (open long positions)
      for (const buyItem of buyQueue) {
        pairedResults.push({
          tradeId: `PAIR-${pairCounter++}`,
          symbol: buyItem.fill.symbol,
          securityId: buyItem.fill.securityId,
          quantity: buyItem.qty,
          buyPrice: buyItem.price,
          sellPrice: null,
          pnl: null,
          pnlPercentage: null,
          status: 'OPEN_BUY',
          isProfit: null,
          tradeDate: buyItem.date,
          executionTime: buyItem.time,
          buyTime: buyItem.time,
        });
      }

      // Any remaining unmatched sells (open short positions / sold from delivery)
      for (const sellItem of sellQueue) {
        pairedResults.push({
          tradeId: `PAIR-${pairCounter++}`,
          symbol: sellItem.fill.symbol,
          securityId: sellItem.fill.securityId,
          quantity: sellItem.qty,
          buyPrice: null,
          sellPrice: sellItem.price,
          pnl: null,
          pnlPercentage: null,
          status: 'OPEN_SELL',
          isProfit: null,
          tradeDate: sellItem.date,
          executionTime: sellItem.time,
          sellTime: sellItem.time,
        });
      }
    }

    // Sort descending by execution time (newest trades first)
    pairedResults.sort((a, b) => {
      const timeA = new Date(a.executionTime || a.tradeDate).getTime() || 0;
      const timeB = new Date(b.executionTime || b.tradeDate).getTime() || 0;
      return timeB - timeA;
    });

    return pairedResults;
  }
}
