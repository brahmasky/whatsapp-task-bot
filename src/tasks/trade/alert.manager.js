/**
 * Trade Alert Manager
 *
 * Monitors a set of price alerts in the background (cron, every 60s).
 * When a stock price enters the buy zone, fires a WhatsApp notification
 * and sets up the /trade task state for order confirmation.
 *
 * Also maintains a rolling price history per symbol (last 30 observations,
 * ~30 min at 60s polling) so the alert includes a trend summary.
 *
 * Lives outside the task state machine so alerts survive /trade task completion.
 */

import cron from 'node-cron';
import logger from '../../utils/logger.js';
import { fetchStockQuote } from '../market/sector.service.js';
import { getOrderStatus, placeExitOrders } from './order.service.js';
import stateManager from '../../core/state.manager.js';
import config from '../../config/index.js';

const HISTORY_MAX = 30; // observations to keep (~30 min at 60s)

// ─── State ────────────────────────────────────────────────────────────────────

// key: `${SYMBOL}:${userId}`, value: plan object
const alerts = new Map();

// key: `${SYMBOL}:${userId}`, value: { symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, placedAt }
const pendingFills = new Map();

// key: symbol (shared across all users watching that symbol)
// value: [{ price, ts }]  — rolling buffer, newest last
const priceHistory = new Map();

let monitorJob = null;
let sendFn = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a price alert.
 * @param {object} plan - { symbol, buyLow, buyHigh, takeProfit, stopLoss, budget, qty, userId }
 */
export function addAlert(plan) {
  const key = `${plan.symbol.toUpperCase()}:${plan.userId}`;
  alerts.set(key, { ...plan, symbol: plan.symbol.toUpperCase(), addedAt: Date.now() });
  logger.info(`Trade alert added: ${plan.symbol} buy $${plan.buyLow}–$${plan.buyHigh} for user ${plan.userId}`);
}

/**
 * Remove a price alert (and clean up history if no other alerts watch that symbol).
 * @returns {boolean} true if an alert was found and removed
 */
export function removeAlert(symbol, userId) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  const existed = alerts.has(key);
  if (existed) {
    alerts.delete(key);
    logger.info(`Trade alert removed: ${symbol} for user ${userId}`);
    _pruneHistory(symbol.toUpperCase());
  }
  return existed;
}

/**
 * List active alerts for a user.
 * @returns {object[]}
 */
export function listAlerts(userId) {
  const result = [];
  for (const plan of alerts.values()) {
    if (plan.userId === userId) result.push(plan);
  }
  return result;
}

/**
 * Register a pending BUY fill to monitor.
 * Called after a BUY order is placed — TP/SL will be placed once the fill is confirmed.
 */
export function addPendingFill({ symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss }) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  pendingFills.set(key, {
    symbol: symbol.toUpperCase(),
    userId,
    buyOrderId,
    accountIdKey,
    qty,
    takeProfit,
    stopLoss,
    placedAt: Date.now(),
  });
  logger.info(`Monitoring fill for BUY ${symbol} #${buyOrderId} (${qty} shares)`);
}

/**
 * Remove a pending fill (e.g. user cancelled before fill).
 */
export function removePendingFill(symbol, userId) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  const existed = pendingFills.has(key);
  if (existed) {
    pendingFills.delete(key);
    logger.info(`Pending fill removed: ${symbol} for user ${userId}`);
  }
  return existed;
}

/**
 * List pending fills for a user.
 */
export function listPendingFills(userId) {
  return [...pendingFills.values()].filter(f => f.userId === userId);
}

/**
 * Force-trigger exit order placement for a pending fill (sandbox testing only).
 * Skips fill status check and immediately places TP + SL.
 * @returns {boolean} true if a pending fill was found and triggered
 */
export async function forceTriggerFill(symbol, userId) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  const fill = pendingFills.get(key);
  if (!fill) return false;

  logger.info(`Force-triggering fill for ${symbol} #${fill.buyOrderId} (sandbox test)`);
  pendingFills.delete(key);
  await _placeFillExits(fill);
  return true;
}

/**
 * Start the 60-second price polling cron job.
 * @param {Function} send - gateway sendFn: ({ type, userId, text }) => Promise<void>
 */
export function initAlertMonitor(send) {
  sendFn = send;

  if (monitorJob) {
    monitorJob.stop();
    monitorJob = null;
  }

  monitorJob = cron.schedule('*/1 * * * *', async () => {
    try {
      await _checkPrices();
      await _checkFills();
    } catch (err) {
      logger.error(`Alert monitor error: ${err.message}`);
    }
  });

  logger.info('Trade alert monitor initialized — polling every 60s');
}

/**
 * Stop the polling cron job.
 */
export function stopAlertMonitor() {
  if (monitorJob) {
    monitorJob.stop();
    monitorJob = null;
    logger.info('Trade alert monitor stopped');
  }
}

// ─── Price history helpers ────────────────────────────────────────────────────

function _recordPrice(symbol, price) {
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const buf = priceHistory.get(symbol);
  buf.push({ price, ts: Date.now() });
  if (buf.length > HISTORY_MAX) buf.shift();
}

/** Remove history for a symbol if no alerts are watching it anymore. */
function _pruneHistory(symbol) {
  const stillWatched = [...alerts.values()].some(p => p.symbol === symbol);
  if (!stillWatched) priceHistory.delete(symbol);
}

/**
 * Build a trend summary string from the price history buffer.
 * Returns null if fewer than 2 observations.
 */
function _buildTrendSummary(symbol, currentPrice) {
  const buf = priceHistory.get(symbol);
  if (!buf || buf.length < 2) return null;

  const prices = buf.map(o => o.price);
  const oldest = prices[0];
  const newest = currentPrice;
  const totalPct = ((newest - oldest) / oldest) * 100;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const durationMin = Math.round((Date.now() - buf[0].ts) / 60000);

  // Direction
  const direction = totalPct <= -0.5 ? '↘ trending down'
    : totalPct >= 0.5 ? '↗ trending up'
    : '↔ ranging';

  // Sparkline from last ≤10 prices using unicode blocks
  const sample = prices.slice(-10);
  const lo = Math.min(...sample);
  const hi = Math.max(...sample);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const sparkline = sample.map(p => {
    if (hi === lo) return blocks[3];
    const idx = Math.round(((p - lo) / (hi - lo)) * (blocks.length - 1));
    return blocks[idx];
  }).join('');

  const sign = totalPct >= 0 ? '+' : '';

  return [
    `📊 *Price trend* (last ${durationMin} min, ${buf.length} polls)`,
    `${sparkline}  ${direction}`,
    `Range: $${minPrice.toFixed(2)} – $${maxPrice.toFixed(2)}  |  Change: ${sign}${totalPct.toFixed(2)}%`,
  ].join('\n');
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _checkPrices() {
  if (alerts.size === 0) return;

  // Group by symbol to minimise Yahoo Finance fetches
  const bySymbol = new Map();
  for (const plan of alerts.values()) {
    if (!bySymbol.has(plan.symbol)) bySymbol.set(plan.symbol, []);
    bySymbol.get(plan.symbol).push(plan);
  }

  for (const [symbol, plans] of bySymbol) {
    let quote;
    try {
      quote = await fetchStockQuote(symbol);
    } catch (err) {
      logger.warn(`Alert monitor: failed to fetch ${symbol}: ${err.message}`);
      continue;
    }

    if (quote.error || quote.price == null) {
      logger.warn(`Alert monitor: no price for ${symbol}`);
      continue;
    }

    const price = quote.price;

    // Record every poll regardless of zone
    _recordPrice(symbol, price);

    for (const plan of plans) {
      if (price >= plan.buyLow && price <= plan.buyHigh) {
        logger.info(`Alert triggered: ${symbol} @ $${price} (zone $${plan.buyLow}–$${plan.buyHigh})`);
        await _fireAlert(plan, price);
      }
    }
  }
}

async function _checkFills() {
  if (pendingFills.size === 0) return;

  for (const [key, fill] of pendingFills) {
    try {
      const status = await getOrderStatus(fill.accountIdKey, fill.buyOrderId);
      logger.debug(`Fill check ${fill.symbol} #${fill.buyOrderId}: ${status}`);

      if (status === 'EXECUTED') {
        logger.info(`BUY filled: ${fill.symbol} #${fill.buyOrderId}`);
        pendingFills.delete(key);
        await _placeFillExits(fill);

      } else if (status === 'CANCELLED' || status === 'EXPIRED') {
        logger.info(`BUY order ${status}: ${fill.symbol} #${fill.buyOrderId}`);
        pendingFills.delete(key);
        if (sendFn) {
          await sendFn({
            type: 'text',
            userId: fill.userId,
            text: `⚠️ Your BUY order for *${fill.symbol}* was ${status}.\nNo exit orders were placed.`,
          });
        }
      }
      // OPEN / PARTIAL — keep monitoring
    } catch (err) {
      logger.warn(`Fill check error for ${fill.symbol} #${fill.buyOrderId}: ${err.message}`);
    }
  }
}

async function _placeFillExits(fill) {
  const { symbol, userId, accountIdKey, qty, takeProfit, stopLoss } = fill;
  const sandboxTag = config.etrade.sandbox ? ' [🧪 SANDBOX]' : '';

  try {
    const { tpOrderId, slOrderId, verification } = await placeExitOrders(
      accountIdKey, symbol, qty, takeProfit, stopLoss
    );

    const tpVerif = verification?.[String(tpOrderId)];
    const slVerif = verification?.[String(slOrderId)];

    const tpLine = `✅ SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (LIMIT, take profit)${tpOrderId ? ` — #${tpOrderId}` : ''}${tpVerif?.found ? ` ✓ ${tpVerif.status}` : ''}${sandboxTag}`;
    const slLine = `✅ SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (STOP, stop loss)${slOrderId ? ` — #${slOrderId}` : ''}${slVerif?.found ? ` ✓ ${slVerif.status}` : ''}${sandboxTag}`;

    if (sendFn) {
      await sendFn({
        type: 'text',
        userId,
        text: [
          `🎯 *${symbol} BUY FILLED!*${sandboxTag}`,
          `${qty} shares bought @ $${(takeProfit + stopLoss) / 2 > 0 ? '' : ''}market price`,
          '',
          'Exit orders placed:',
          tpLine,
          slLine,
          '',
          'Good luck! 🤞',
        ].join('\n'),
      });
    }
  } catch (err) {
    logger.error(`Failed to place exit orders for ${symbol}: ${err.message}`);
    if (sendFn) {
      await sendFn({
        type: 'text',
        userId,
        text: [
          `⚠️ *${symbol} BUY FILLED* — but exit orders failed: ${err.message}`,
          '',
          `Please manually place:`,
          `• SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (take profit)`,
          `• SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (stop loss)`,
        ].join('\n'),
      });
    }
  }
}

async function _fireAlert(plan, triggerPrice) {
  const { symbol, userId, buyLow, buyHigh, takeProfit, stopLoss, budget, qty: fixedQty } = plan;

  // Snapshot trend before removing alert (which may prune history)
  const trendSummary = _buildTrendSummary(symbol, triggerPrice);

  // Remove alert — it fires once
  removeAlert(symbol, userId);

  const qty = fixedQty != null ? fixedQty : Math.floor(budget / triggerPrice);
  const total = qty * triggerPrice;
  const sandboxTag = config.etrade.sandbox ? ' [🧪 SANDBOX]' : '';

  const parts = [
    `🟢 *${symbol} BUY ALERT*${sandboxTag}`,
    `Price $${triggerPrice.toFixed(2)} is in your buy zone ($${buyLow.toFixed(2)}–$${buyHigh.toFixed(2)})`,
  ];

  if (trendSummary) {
    parts.push('', trendSummary);
  }

  parts.push(
    '',
    `Order to place: BUY ${qty} shares ${symbol} @ $${triggerPrice.toFixed(2)} (LIMIT, GTC)`,
    `Total: $${total.toFixed(2)} (${qty} × $${triggerPrice.toFixed(2)}${budget != null ? `, from $${budget.toFixed(2)} budget` : ''})`,
    `Take profit: $${takeProfit.toFixed(2)} | Stop loss: $${stopLoss.toFixed(2)}`,
  );

  parts.push('', `Reply *confirm* to place orders, *cancel* to dismiss.`);

  const alertMsg = parts.join('\n');

  // Set up confirmation task state only if user is idle
  if (!stateManager.hasActiveTask(userId)) {
    stateManager.startTask(userId, '/trade', {
      symbol,
      buyLow,
      buyHigh,
      takeProfit,
      stopLoss,
      budget,
      qty: fixedQty,
      triggerPrice,
      calcQty: qty,
    });
    stateManager.updateTask(userId, 'awaiting_confirmation');
  } else {
    logger.warn(`Alert for ${symbol}: user ${userId} has an active task, skipping state setup`);
  }

  if (sendFn) {
    try {
      await sendFn({ type: 'text', userId, text: alertMsg });
    } catch (err) {
      logger.error(`Alert monitor: failed to send alert to ${userId}: ${err.message}`);
    }
  }
}
