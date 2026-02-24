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
import { append, save } from '../../utils/persistence.service.js';
import config from '../../config/index.js';

const FILLS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/pending-fills.json'
);

// key: `${SYMBOL}:${userId}:${buyOrderId}`
// value: { symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice, buyLow, buyHigh, budget, placedAt }
const pendingFills = new Map();

function _key(symbol, userId, buyOrderId) {
  return `${symbol.toUpperCase()}:${userId}:${buyOrderId}`;
}

let monitorJob = null;
let sendFn = null;

// ─── Pre-expiry warning ────────────────────────────────────────────────────────

/**
 * Returns true if current time in US/Eastern is between 3:30 PM and 3:59 PM
 * on a weekday — the 30-minute window before GFD orders expire at market close.
 */
function _isPreExpiryWindow() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hour = et.getHours();
  const minute = et.getMinutes();
  return day >= 1 && day <= 5 && hour === 15 && minute >= 30;
}

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

// ─── Count (for /status health) ───────────────────────────────────────────────

export function getPendingFillsCount() {
  return pendingFills.size;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a pending BUY order to monitor for fill.
 * Called immediately after a BUY LIMIT order is placed.
 */
export function addPendingFill({ symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice, buyLow, buyHigh, budget }) {
  const key = _key(symbol, userId, buyOrderId);
  pendingFills.set(key, {
    symbol: symbol.toUpperCase(),
    userId,
    buyOrderId,
    accountIdKey,
    qty,
    takeProfit,
    stopLoss,
    limitPrice: limitPrice ?? null,
    buyLow: buyLow ?? null,
    buyHigh: buyHigh ?? null,
    budget: budget ?? null,
    placedAt: Date.now(),
    preExpiryWarned: false,
  });
  _saveFills();
  logger.info(`Monitoring fill for BUY ${symbol} #${buyOrderId} (${qty} shares ≤ $${limitPrice})`);
}

/**
 * Remove a pending fill (e.g. user cancelled the order).
 * @returns {boolean} true if an entry was found and removed
 */
export function removePendingFill(symbol, userId, buyOrderId) {
  const key = _key(symbol, userId, buyOrderId);
  const existed = pendingFills.has(key);
  if (existed) {
    pendingFills.delete(key);
    _saveFills();
    logger.info(`Pending fill removed: ${symbol} #${buyOrderId} for user ${userId}`);
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
  const upperSymbol = symbol.toUpperCase();
  let key = null;
  let fill = null;
  for (const [k, v] of pendingFills) {
    if (v.symbol === upperSymbol && v.userId === userId) {
      key = k;
      fill = v;
      break;
    }
  }
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
      const key = _key(fill.symbol, fill.userId, fill.buyOrderId);
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
          let msg;
          if (status === 'EXPIRED' && fill.buyLow != null && fill.buyHigh != null) {
            const tpPart = fill.takeProfit != null ? ` tp ${fill.takeProfit.toFixed(2)}` : '';
            const slPart = fill.stopLoss  != null ? ` sl ${fill.stopLoss.toFixed(2)}`   : '';
            const sizePart = fill.budget != null ? ` budget ${fill.budget.toFixed(2)}` : '';
            const reEntry = `/trade ${fill.symbol} → buy ${fill.buyLow.toFixed(2)} ${fill.buyHigh.toFixed(2)}${tpPart}${slPart}${sizePart}`;
            msg = `ℹ️ *${fill.symbol}* GFD order expired at market close.\n\nTo re-enter tomorrow:\n${reEntry}`;
          } else if (status === 'EXPIRED') {
            msg = `ℹ️ Your GFD BUY order for *${fill.symbol}* expired at market close.\nRun /trade ${fill.symbol} again tomorrow if the setup is still valid.`;
          } else {
            msg = `ℹ️ Your BUY order for *${fill.symbol}* was cancelled. No exit orders were placed.`;
          }
          await sendFn({ type: 'text', userId: fill.userId, text: msg });
        }
      }
      // OPEN / PARTIAL — keep monitoring; warn user if close to market close
      if (status === 'OPEN' && !fill.preExpiryWarned && _isPreExpiryWindow()) {
        fill.preExpiryWarned = true;
        pendingFills.set(key, fill);
        _saveFills();
        if (sendFn) {
          await sendFn({
            type: 'text',
            userId: fill.userId,
            text:
              `⏰ GFD BUY order for *${fill.symbol}* #${fill.buyOrderId} expires at 4 PM ET today.\n` +
              `If it doesn't fill in the next 30 min, run /trade ${fill.symbol} again tomorrow.`,
          });
        }
      }
    } catch (err) {
      logger.warn(`Fill check error for ${fill.symbol} #${fill.buyOrderId}: ${err.message}`);
    }
  }
}

async function _placeFillExits(fill) {
  const { symbol, userId, accountIdKey, qty, takeProfit, stopLoss } = fill;
  const sandboxTag = config.etrade.sandbox ? ' [🧪 SANDBOX]' : '';
  const hasTP = takeProfit != null;
  const hasSL = stopLoss  != null;

  // No exit orders configured — just notify and archive
  if (!hasTP && !hasSL) {
    append('trade-history', {
      ts: Date.now(), symbol, qty,
      limitPrice: fill.limitPrice,
      buyOrderId: fill.buyOrderId,
      tpOrderId: null, slOrderId: null,
    });
    refreshPortfolioCache().catch(err => logger.warn(`Post-fill cache refresh failed: ${err.message}`));
    if (sendFn) {
      await sendFn({
        type: 'text',
        userId,
        text: `✅ *${symbol} BUY FILLED!*${sandboxTag}\n\n${qty} shares acquired. No exit orders set — manage your position manually.`,
      });
    }
    return;
  }

  try {
    const { tpOrderId, slOrderId, verification } = await placeExitOrders(
      accountIdKey, symbol, qty, takeProfit, stopLoss
    );

    append('trade-history', {
      ts: Date.now(), symbol, qty,
      limitPrice: fill.limitPrice,
      takeProfit: takeProfit ?? null,
      stopLoss:   stopLoss  ?? null,
      buyOrderId: fill.buyOrderId,
      tpOrderId:  tpOrderId ?? null,
      slOrderId:  slOrderId ?? null,
    });

    refreshPortfolioCache().catch(err => logger.warn(`Post-fill cache refresh failed: ${err.message}`));

    const exitLines = [];
    if (tpOrderId != null) {
      const tpVerif = verification?.[String(tpOrderId)];
      exitLines.push(`✅ SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (LIMIT, take profit) — #${tpOrderId}${tpVerif?.found ? ` ✓ ${tpVerif.status}` : ''}${sandboxTag}`);
    }
    if (slOrderId != null) {
      const slVerif = verification?.[String(slOrderId)];
      exitLines.push(`✅ SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (STOP, stop loss) — #${slOrderId}${slVerif?.found ? ` ✓ ${slVerif.status}` : ''}${sandboxTag}`);
    }
    if (hasTP && !hasSL) exitLines.push(`ℹ️ No stop loss — manage the downside manually.`);
    if (!hasTP && hasSL) exitLines.push(`ℹ️ No take profit — manage the upside manually.`);

    if (sendFn) {
      await sendFn({
        type: 'text',
        userId,
        text: [
          `🎯 *${symbol} BUY FILLED!*${sandboxTag}`,
          '',
          'Exit orders placed:',
          ...exitLines,
          '',
          'Good luck! 🤞',
        ].join('\n'),
      });
    }
  } catch (err) {
    logger.error(`Failed to place exit orders for ${symbol}: ${err.message}`);

    save(`pending-exits/${symbol}-${userId}`, {
      symbol, userId, accountIdKey, qty,
      takeProfit: takeProfit ?? null,
      stopLoss:   stopLoss  ?? null,
      failedAt: Date.now(),
      error: err.message,
    });

    const manualLines = [
      hasTP ? `• SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (take profit)` : null,
      hasSL ? `• SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (stop loss)`     : null,
    ].filter(Boolean);

    if (sendFn) {
      await sendFn({
        type: 'text',
        userId,
        text: [
          `⚠️ *${symbol} BUY FILLED* — but exit orders failed: ${err.message}`,
          '',
          'Please manually place or run `/trade retry-exits ' + symbol + '`:',
          ...manualLines,
        ].join('\n'),
      });
    }
  }
}
