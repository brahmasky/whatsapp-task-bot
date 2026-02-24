/**
 * Trade Fill Monitor
 *
 * Monitors pending BUY LIMIT orders for execution (cron, every 60s).
 * When a BUY is confirmed EXECUTED, automatically places TP + SL exit orders.
 *
 * The entry order (BUY LIMIT, GFD) is placed immediately when the user sets
 * a plan — E*TRADE handles price monitoring and execution. This module only
 * watches for fills so it can place the matching exit orders.
 *
 * GFD orders expire at market close — the monitor will detect EXPIRED status
 * and notify the user so they can re-run /trade the next day if needed.
 *
 * State persistence: pending fills are written to data/pending-fills.json on
 * every change and restored on startup, so a bot restart (nodemon, crash) does
 * not lose track of open orders.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import logger from '../../utils/logger.js';
import { getOrderStatus, placeExitOrders, refreshPortfolioCache } from '../../shared/etrade.order.js';
import config from '../../config/index.js';

const FILLS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/pending-fills.json'
);

// key: `${SYMBOL}:${userId}`
// value: { symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice, placedAt }
const pendingFills = new Map();

let monitorJob = null;
let sendFn = null;

// ─── Persistence ──────────────────────────────────────────────────────────────

function _saveFills() {
  try {
    const entries = [...pendingFills.values()];
    fs.writeFileSync(FILLS_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`Could not save pending fills: ${err.message}`);
  }
}

function _loadFills() {
  try {
    if (!fs.existsSync(FILLS_FILE)) return [];
    const raw = fs.readFileSync(FILLS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`Could not load pending fills: ${err.message}`);
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a pending BUY order to monitor for fill.
 * Called immediately after a BUY LIMIT order is placed.
 */
export function addPendingFill({ symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice }) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  pendingFills.set(key, {
    symbol: symbol.toUpperCase(),
    userId,
    buyOrderId,
    accountIdKey,
    qty,
    takeProfit,
    stopLoss,
    limitPrice: limitPrice ?? null,
    placedAt: Date.now(),
  });
  _saveFills();
  logger.info(`Monitoring fill for BUY ${symbol} #${buyOrderId} (${qty} shares ≤ $${limitPrice})`);
}

/**
 * Remove a pending fill (e.g. user cancelled the order).
 * @returns {boolean} true if an entry was found and removed
 */
export function removePendingFill(symbol, userId) {
  const key = `${symbol.toUpperCase()}:${userId}`;
  const existed = pendingFills.has(key);
  if (existed) {
    pendingFills.delete(key);
    _saveFills();
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
  _saveFills();
  await _placeFillExits(fill);
  return true;
}

/**
 * Start the 60-second fill monitoring cron job.
 * Restores any pending fills persisted from a previous run and immediately
 * checks their status — they may have filled or expired while the bot was down.
 * @param {Function} send - gateway sendFn: ({ type, userId, text }) => Promise<void>
 */
export function initAlertMonitor(send) {
  sendFn = send;

  if (monitorJob) {
    monitorJob.stop();
    monitorJob = null;
  }

  // Restore persisted fills from previous run
  const restored = _loadFills();
  if (restored.length > 0) {
    for (const fill of restored) {
      const key = `${fill.symbol}:${fill.userId}`;
      pendingFills.set(key, fill);
    }
    logger.info(`Restored ${restored.length} pending fill(s) from disk — checking status now`);
    // Check immediately rather than waiting up to 60s — orders may have
    // filled or expired while the bot was down
    _checkFills().catch(err => logger.error(`Post-restore fill check error: ${err.message}`));
  }

  monitorJob = cron.schedule('*/1 * * * *', async () => {
    try {
      await _checkFills();
    } catch (err) {
      logger.error(`Fill monitor error: ${err.message}`);
    }
  });

  logger.info('Trade fill monitor initialized — polling every 60s');
}

/**
 * Stop the polling cron job.
 */
export function stopAlertMonitor() {
  if (monitorJob) {
    monitorJob.stop();
    monitorJob = null;
    logger.info('Trade fill monitor stopped');
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _checkFills() {
  if (pendingFills.size === 0) return;

  for (const [key, fill] of pendingFills) {
    try {
      const status = await getOrderStatus(fill.accountIdKey, fill.buyOrderId);
      logger.debug(`Fill check ${fill.symbol} #${fill.buyOrderId}: ${status}`);

      if (status === 'EXECUTED') {
        logger.info(`BUY filled: ${fill.symbol} #${fill.buyOrderId}`);
        pendingFills.delete(key);
        _saveFills();
        await _placeFillExits(fill);

      } else if (status === 'CANCELLED' || status === 'EXPIRED') {
        logger.info(`BUY order ${status}: ${fill.symbol} #${fill.buyOrderId}`);
        pendingFills.delete(key);
        _saveFills();
        if (sendFn) {
          const msg = status === 'EXPIRED'
            ? `ℹ️ Your GFD BUY order for *${fill.symbol}* expired at market close.\nRun /trade ${fill.symbol} again tomorrow if the setup is still valid.`
            : `ℹ️ Your BUY order for *${fill.symbol}* was cancelled. No exit orders were placed.`;
          await sendFn({ type: 'text', userId: fill.userId, text: msg });
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

    // Position has landed in portfolio — refresh cache in background
    refreshPortfolioCache().catch(err => logger.warn(`Post-fill cache refresh failed: ${err.message}`));

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
          'Please manually place:',
          `• SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (take profit)`,
          `• SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (stop loss)`,
        ].join('\n'),
      });
    }
  }
}
