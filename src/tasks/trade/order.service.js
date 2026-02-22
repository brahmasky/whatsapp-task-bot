/**
 * Order Service
 *
 * Wraps ETradeService with order-specific helpers.
 * Orders are placed in two stages:
 *   1. placeBuyOrder()   — limit BUY only (GTC)
 *   2. placeExitOrders() — TP + SL, called only after BUY is confirmed EXECUTED
 */

import crypto from 'crypto';
import logger from '../../utils/logger.js';
import { getAuthenticatedService } from '../../shared/etrade.helper.js';
import { savePortfolioCache } from '../market/cache.service.js';

export { getAuthenticatedService };

/**
 * Return the accountIdKey of the first brokerage account.
 * @param {ETradeService} service
 */
export async function getFirstBrokerageAccount(service) {
  const accounts = await service.getAccounts();
  if (!accounts || accounts.length === 0) {
    throw new Error('No E*TRADE accounts found.');
  }
  const brokerage = accounts.find(a => a.institutionType === 'BROKERAGE') || accounts[0];
  return brokerage.accountIdKey;
}

/**
 * Calculate share quantity from a dollar budget and price.
 */
export function calcQty(budget, price) {
  return Math.floor(budget / price);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildInstrument(symbol, qty, action) {
  return {
    Product: { securityType: 'EQ', symbol },
    orderAction: action,
    quantityType: 'QUANTITY',
    quantity: String(qty),
  };
}

function buildOrderDetail(priceType, price, instrument, orderTerm = 'GOOD_FOR_DAY') {
  const detail = {
    allOrNone: 'false',
    priceType,
    orderTerm,
    marketSession: 'REGULAR',
    Instrument: [instrument],
  };
  if (priceType === 'LIMIT') {
    detail.limitPrice = price.toFixed(2);
  } else if (priceType === 'STOP') {
    detail.stopPrice = price.toFixed(2);
  }
  return detail;
}

// E*TRADE clientOrderId must be unique and ≤20 chars
function shortOrderId() {
  return crypto.randomBytes(10).toString('hex');
}

async function previewThenPlace(service, accountIdKey, orderDetail) {
  const clientOrderId = shortOrderId();

  const previewPayload = {
    PreviewOrderRequest: {
      orderType: 'EQ',
      clientOrderId,
      Order: [orderDetail],
    },
  };

  const preview = await service.previewOrder(accountIdKey, previewPayload);
  const previewId = preview?.PreviewIds?.[0]?.previewId;

  if (previewId == null) {
    throw new Error(`Preview returned no previewId: ${JSON.stringify(preview)}`);
  }

  const placePayload = {
    PlaceOrderRequest: {
      orderType: 'EQ',
      clientOrderId,
      PreviewIds: [{ previewId }],
      Order: [orderDetail],
    },
  };

  const placed = await service.placeOrder(accountIdKey, placePayload);
  return placed?.OrderIds?.[0]?.orderId ?? null;
}

// ─── Cash balance check ───────────────────────────────────────────────────────

/**
 * Fetch available cash and compare against a proposed order cost.
 * Uses cashAvailableForInvestment from the first brokerage account.
 *
 * @param {number} qty   - Number of shares to buy
 * @param {number} price - Limit price per share
 * @returns {Promise<{ cash: number, cost: number, sufficient: boolean }>}
 */
export async function checkCashBalance(qty, price) {
  const service = await getAuthenticatedService();
  const accountIdKey = await getFirstBrokerageAccount(service);
  const balances = await service.getAccountBalances(accountIdKey);
  const cash = parseFloat(balances?.Computed?.cashAvailableForInvestment ?? 0);
  const cost = qty * price;
  return { cash, cost, sufficient: cost <= cash };
}

/**
 * Refresh the on-disk portfolio cache after a trade changes cash or positions.
 * Fire-and-forget safe — callers should .catch() any errors.
 */
export async function refreshPortfolioCache() {
  const service = await getAuthenticatedService();
  const portfolioData = await service.fetchPortfolioData();
  await savePortfolioCache(portfolioData);
  logger.info('Portfolio cache refreshed after trade');
}

// ─── Order status ──────────────────────────────────────────────────────────────

/**
 * Fetch the current status of an order by scanning recent orders.
 * Returns the orderStatus string (e.g. 'OPEN', 'EXECUTED', 'CANCELLED', 'EXPIRED')
 * or null if not found.
 */
export async function getOrderStatus(accountIdKey, orderId) {
  const service = await getAuthenticatedService();
  const orders = await service.getOrders(accountIdKey, { count: 25 });
  const order = orders.find(o => String(o.orderId) === String(orderId));
  return order?.orderStatus ?? null;
}

// ─── Order placement ──────────────────────────────────────────────────────────

/**
 * Stage 1: Place a BUY LIMIT order.
 * @param {string} orderTerm - 'GOOD_FOR_DAY' (default) or 'GOOD_UNTIL_CANCEL'
 * Returns accountIdKey + buyOrderId for fill monitoring.
 */
export async function placeBuyOrder(symbol, qty, entryPrice, orderTerm = 'GOOD_FOR_DAY') {
  const service = await getAuthenticatedService();
  const accountIdKey = await getFirstBrokerageAccount(service);

  logger.info(`Placing BUY LIMIT order: ${qty} ${symbol} @ ≤$${entryPrice} (${orderTerm})`);

  const detail = buildOrderDetail('LIMIT', entryPrice, buildInstrument(symbol, qty, 'BUY'), orderTerm);
  const buyOrderId = await previewThenPlace(service, accountIdKey, detail);

  logger.info(`BUY order placed: ${symbol} #${buyOrderId}`);

  // Verify it appears in the account
  const verification = await _verifyOrders(service, accountIdKey, [buyOrderId].filter(Boolean));

  return { buyOrderId, accountIdKey, verification };
}

/**
 * Cancel a pending BUY order on E*TRADE.
 */
export async function cancelBuyOrder(accountIdKey, orderId) {
  const service = await getAuthenticatedService();
  await service.cancelOrder(accountIdKey, orderId);
  logger.info(`BUY order #${orderId} cancelled`);
}

/**
 * Stage 2: Place TP (limit SELL) + SL (stop SELL) after BUY is filled.
 * Reuses the accountIdKey returned from placeBuyOrder.
 */
export async function placeExitOrders(accountIdKey, symbol, qty, takeProfit, stopLoss) {
  const service = await getAuthenticatedService();

  logger.info(`Placing exit orders: ${qty} ${symbol} | TP $${takeProfit} | SL $${stopLoss}`);

  const tpDetail = buildOrderDetail('LIMIT', takeProfit, buildInstrument(symbol, qty, 'SELL'));
  const tpOrderId = await previewThenPlace(service, accountIdKey, tpDetail);
  logger.info(`TP SELL order placed: ${symbol} #${tpOrderId}`);

  const slDetail = buildOrderDetail('STOP', stopLoss, buildInstrument(symbol, qty, 'SELL'));
  const slOrderId = await previewThenPlace(service, accountIdKey, slDetail);
  logger.info(`SL STOP order placed: ${symbol} #${slOrderId}`);

  const verification = await _verifyOrders(service, accountIdKey, [tpOrderId, slOrderId].filter(Boolean));

  return { tpOrderId, slOrderId, verification };
}

// ─── Internal verification ────────────────────────────────────────────────────

async function _verifyOrders(service, accountIdKey, orderIds) {
  const results = {};
  for (const id of orderIds) results[id] = { found: false, status: null };

  try {
    const orders = await service.getOrders(accountIdKey, { count: 25 });
    for (const order of orders) {
      const id = String(order.orderId);
      if (results[id] === undefined) continue;
      const detail = order.OrderDetail?.[0] ?? {};
      const instrument = detail.Instrument?.[0] ?? {};
      results[id] = {
        found: true,
        status: order.orderStatus ?? null,
        action: instrument.orderAction ?? null,
        qty: instrument.orderedQuantity ?? null,
        priceType: detail.priceType ?? null,
        limitPrice: detail.limitPrice ?? null,
        stopPrice: detail.stopPrice ?? null,
      };
      logger.info(
        `Verified order #${id}: ${results[id].status} | ` +
        `${results[id].action} ${results[id].qty} @ ` +
        `${results[id].limitPrice ?? results[id].stopPrice} (${results[id].priceType})`
      );
    }
    for (const [id, r] of Object.entries(results)) {
      if (!r.found) logger.warn(`Order #${id} not found in recent order list`);
    }
  } catch (err) {
    logger.warn(`Could not verify orders: ${err.message}`);
  }

  return results;
}
