import { Injectable, BadRequestException, BadGatewayException } from '@nestjs/common';
import { DhanService } from '../dhan/dhan.service';
import { TelegramService } from '../telegram/telegram.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { AutoSlDto } from './dto/auto-sl.dto';

@Injectable()
export class OrdersService {
  public autoSlLogs: any[] = [];

  constructor(
    private readonly dhanService: DhanService,
    private readonly telegramService: TelegramService,
    private readonly instrumentsService: InstrumentsService,
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

    let fundInfo = {
      availableBalance: 0,
      utilizedMargin: 0,
      collateralAmount: 0,
    };

    if (fundsResult.ok && fundsResult.data) {
      const fd = fundsResult.data as any;
      fundInfo = {
        availableBalance: fd.availMargin || fd.availableBalance || fd.cash || 0,
        utilizedMargin: fd.utilizedMargin || fd.marginUtilized || 0,
        collateralAmount: fd.collateralAmount || 0,
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

  async getHoldings() {
    const apiResult = await this.dhanService.getHoldings();

    // Dhan returns HTTP 500 DH-1111 when user has 0 Demat holdings
    if (apiResult.status === 500 && (apiResult.data?.errorMessage === 'No holdings available' || apiResult.data?.errorCode === 'DH-1111')) {
      return [];
    }

    if (!apiResult.ok) {
      const errorMsg = apiResult.data?.errorMessage
        || apiResult.data?.message
        || apiResult.data?.data?.['808']
        || apiResult.error
        || `Failed to fetch holdings from Dhan API (HTTP ${apiResult.status})`;
      throw new BadGatewayException(errorMsg);
    }

    const rawHoldings = Array.isArray(apiResult.data) ? apiResult.data : [];
    return rawHoldings.map((h: any) => ({
      symbol: h.tradingSymbol || h.symbol || String(h.securityId),
      securityId: String(h.securityId),
      exchange: h.exchange || 'NSE',
      totalQty: h.totalQty || h.quantity || 0,
      dpQty: h.dpQty || 0,
      avgCostPrice: h.avgCostPrice || h.averagePrice || 0,
      ltp: h.ltp || h.lastPrice || 0,
      currentValue: Math.round(((h.totalQty || 0) * (h.ltp || 0)) * 100) / 100,
      pnl: Math.round((((h.ltp || 0) - (h.avgCostPrice || 0)) * (h.totalQty || 0)) * 100) / 100,
    }));
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

      this.telegramService.sendOrderNotification(liveOrder, 'PLACED');

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
      this.telegramService.sendOrderNotification({ orderId, status: 'CANCELLED', symbol: 'ORDER' }, 'CANCELLED');
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

  async executeAutoSLTarget(dto: AutoSlDto) {
    if (!dto.entryPrice || isNaN(Number(dto.entryPrice)) || Number(dto.entryPrice) <= 0) {
      throw new BadRequestException('Valid positive entryPrice is required');
    }
    if (!dto.quantity || isNaN(Number(dto.quantity)) || Number(dto.quantity) <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    const targetSymbol = dto.symbol ? dto.symbol.trim().toUpperCase() : '';
    if (!targetSymbol) {
      throw new BadRequestException('Symbol is required');
    }

    const qty = parseInt(String(dto.quantity), 10);
    const entry = parseFloat(String(dto.entryPrice));

    let secId = dto.securityId ? String(dto.securityId).trim() : '';
    if (!secId) {
      const matched = this.instrumentsService.findBySymbol(targetSymbol);
      if (matched) {
        secId = matched.securityId;
      } else {
        throw new BadRequestException(`securityId is required for symbol ${targetSymbol}`);
      }
    }

    const slPts = 7.0;
    const targetPts = 30.0;
    const slPrice = Math.round((entry - slPts) * 100) / 100;
    const targetPrice = Math.round((entry + targetPts) * 100) / 100;

    const logs: string[] = [];
    const timestamp = () => new Date().toLocaleTimeString('en-IN', { hour12: false });

    logs.push(`[${timestamp()}] 🎯 Initiating Real Nifty Auto-SL Runner for ${targetSymbol}`);
    logs.push(`[${timestamp()}] 📊 Parameters: Entry = ₹${entry}, Stop Loss = ₹${slPrice} (-${slPts} pts), Target = ₹${targetPrice} (+${targetPts} pts), Qty = ${qty}`);

    const buyResult = await this.placeOrder({
      symbol: targetSymbol,
      securityId: secId,
      exchangeSegment: 'NSE_FNO',
      transactionType: 'BUY',
      orderType: 'MARKET',
      productType: 'INTRADAY',
      quantity: qty,
      price: entry,
    });
    logs.push(`[${timestamp()}] ✅ Long Entry Placed on Dhan: ${qty} Qty @ ₹${entry} (Order ID: ${buyResult.order.orderId})`);

    const slResult = await this.placeOrder({
      symbol: targetSymbol,
      securityId: secId,
      exchangeSegment: 'NSE_FNO',
      transactionType: 'SELL',
      orderType: 'SL-M',
      productType: 'INTRADAY',
      quantity: qty,
      triggerPrice: slPrice,
      price: 0,
    });
    logs.push(`[${timestamp()}] 🛡️ Stop Loss Trigger Placed on Dhan: Trigger @ ₹${slPrice} (Order ID: ${slResult.order.orderId})`);

    const targetResult = await this.placeOrder({
      symbol: targetSymbol,
      securityId: secId,
      exchangeSegment: 'NSE_FNO',
      transactionType: 'SELL',
      orderType: 'LIMIT',
      productType: 'INTRADAY',
      quantity: qty,
      price: targetPrice,
    });
    logs.push(`[${timestamp()}] 🚀 Profit Target Order Placed on Dhan: Limit @ ₹${targetPrice} (Order ID: ${targetResult.order.orderId})`);
    logs.push(`[${timestamp()}] ⚡ Real Bracket Deployed! Risk:Reward ratio 1:${(targetPts / slPts).toFixed(2)} active.`);

    const executionSummary = {
      strategy: 'NIFTY_LONG_AUTO_SL_TARGET',
      symbol: targetSymbol,
      quantity: qty,
      entryPrice: entry,
      slPrice,
      targetPrice,
      slPoints: slPts,
      targetPoints: targetPts,
      riskRewardRatio: `1:${(targetPts / slPts).toFixed(2)}`,
      orders: {
        entryOrder: buyResult.order,
        stopLossOrder: slResult.order,
        targetOrder: targetResult.order,
      },
      logs,
      executedAt: new Date().toISOString(),
    };

    this.autoSlLogs.unshift(executionSummary);
    this.telegramService.sendStrategyNotification(executionSummary);

    return executionSummary;
  }

  getAutoSlLogs() {
    return this.autoSlLogs;
  }
}
