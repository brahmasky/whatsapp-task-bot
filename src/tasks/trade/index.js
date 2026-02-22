/**
 * /trade Task
 *
 * Set a bracket-style trade plan (buy zone + take-profit + stop-loss) for a
 * stock. The alert manager monitors price in the background and fires a
 * WhatsApp alert when the price enters the buy zone. On confirmation, the bot
 * places three E*TRADE orders: limit BUY, limit take-profit SELL, stop-loss SELL.
 *
 * If the E*TRADE OAuth token is expired at confirmation time, the task
 * handles re-authentication inline — no need to visit /portfolio.
 *
 * Usage:
 *   /trade UBER                       — set a new trade plan
 *   /trade list                       — show active alerts
 *   /trade cancel UBER                — remove an alert
 *
 * After setting a plan, send:
 *   buy <low> <high> tp <target> sl <stop> budget <amount>
 *   buy <low> <high> tp <target> sl <stop> qty <shares>
 */

import { startAuthFlow, exchangePin, cleanupAuthFlow } from '../../shared/auth.service.js';
import logger from '../../utils/logger.js';
import { fetchStockQuote } from '../market/sector.service.js';
import { placeBuyOrder, calcQty } from './order.service.js';
import {
  addAlert,
  removeAlert,
  listAlerts,
  addPendingFill,
  removePendingFill,
  listPendingFills,
  forceTriggerFill,
  initAlertMonitor,
  stopAlertMonitor,
} from './alert.manager.js';
import config from '../../config/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sandboxTag() {
  return config.etrade.sandbox ? ' [🧪 SANDBOX]' : '';
}

function signedPct(from, to) {
  const val = ((to - from) / from) * 100;
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

// ─── Param parsing ────────────────────────────────────────────────────────────

const PLAN_REGEX = /buy\s+([\d.]+)\s+([\d.]+)\s+tp\s+([\d.]+)\s+sl\s+([\d.]+)\s+(?:budget\s+([\d.]+)|qty\s+([\d]+))/i;

function parsePlan(text) {
  const m = text.match(PLAN_REGEX);
  if (!m) return null;
  return {
    buyLow: parseFloat(m[1]),
    buyHigh: parseFloat(m[2]),
    takeProfit: parseFloat(m[3]),
    stopLoss: parseFloat(m[4]),
    budget: m[5] ? parseFloat(m[5]) : null,
    fixedQty: m[6] ? parseInt(m[6], 10) : null,
  };
}

// ─── Re-auth flow ─────────────────────────────────────────────────────────────

/**
 * Start inline OAuth re-authentication.
 * Clears expired tokens, gets a new auth URL, stores the service instance,
 * and switches task state to awaiting_pin (plan data is preserved).
 */
async function startReAuth(ctx) {
  const { authUrl } = await startAuthFlow(ctx.userId);
  ctx.updateTask('awaiting_pin'); // plan data preserved via state merge

  const envNote = config.etrade.sandbox ? ' (SANDBOX)' : '';
  await ctx.reply(
    `🔐 E*TRADE session expired. Re-authentication required${envNote}.\n\n` +
    `1. Open this link to authorize:\n${authUrl}\n\n` +
    `2. Log in to E*TRADE and click "Accept"\n` +
    `3. Copy the PIN and reply with it here\n\n` +
    `Your trade plan is saved — orders will be placed after re-auth.\n` +
    `Type /cancel to abort.`
  );
}

async function handlePin(ctx, pin) {
  if (!pin || pin.trim().length < 4 || pin.trim().length > 20) {
    await ctx.reply(
      'Invalid PIN format. Please enter the verification code from E*TRADE\n' +
      '(shown after clicking "Accept" on the authorization page).'
    );
    return;
  }

  try {
    await ctx.reply('Verifying PIN...');
    await exchangePin(ctx.userId, pin.trim());
    logger.info('Trade task: re-authentication successful');

    ctx.updateTask('awaiting_confirmation');
    await ctx.reply(
      `✅ Re-authenticated successfully!\n\n` +
      `Reply *confirm* to place your orders, or *cancel* to dismiss.`
    );
  } catch (err) {
    if (err.status === 401) {
      await ctx.reply(
        'Invalid or expired PIN. Please get a fresh PIN from the authorization page and try again.'
      );
    } else {
      cleanupAuthFlow(ctx.userId);
      logger.error(`Trade re-auth PIN exchange failed: ${err.message}`);
      await ctx.reply(`Re-authentication failed: ${err.message}`);
      ctx.completeTask();
    }
  }
}

// ─── Task handlers ────────────────────────────────────────────────────────────

async function handleParams(ctx, text, data) {
  const { symbol } = data;

  const parsed = parsePlan(text);
  if (!parsed) {
    await ctx.reply(
      'Could not parse trade plan. Expected format:\n' +
      '`buy <low> <high> tp <target> sl <stop> budget <amount>`\n' +
      'or\n' +
      '`buy <low> <high> tp <target> sl <stop> qty <shares>`\n\n' +
      'Example: `buy 70 72.50 tp 81.30 sl 68 budget 1000`'
    );
    return;
  }

  const { buyLow, buyHigh, takeProfit, stopLoss, budget, fixedQty } = parsed;

  if (buyLow >= buyHigh) {
    await ctx.reply('❌ Buy low must be less than buy high.');
    return;
  }
  if (takeProfit <= buyHigh) {
    await ctx.reply('❌ Take profit must be above the buy high.');
    return;
  }
  if (stopLoss >= buyLow) {
    await ctx.reply('❌ Stop loss must be below buy low.');
    return;
  }
  if (budget != null && budget <= 0) {
    await ctx.reply('❌ Budget must be greater than 0.');
    return;
  }
  if (fixedQty != null && fixedQty <= 0) {
    await ctx.reply('❌ Quantity must be greater than 0.');
    return;
  }

  const midpoint = (buyLow + buyHigh) / 2;
  const estQty = fixedQty != null ? fixedQty : calcQty(budget, midpoint);

  const plan = {
    symbol,
    buyLow,
    buyHigh,
    takeProfit,
    stopLoss,
    budget: budget ?? null,
    qty: fixedQty ?? null,
    userId: ctx.userId,
  };

  addAlert(plan);

  const sizeLine = budget != null
    ? `💰 Budget: $${budget.toFixed(2)} (~${estQty} shares at midpoint $${midpoint.toFixed(2)})`
    : `💰 Quantity: ${estQty} shares`;

  await ctx.reply(
    `✅ Trade plan set for *${symbol}*\n` +
    `📈 Buy zone: $${buyLow.toFixed(2)} – $${buyHigh.toFixed(2)}\n` +
    `🎯 Take profit: $${takeProfit.toFixed(2)} (${signedPct(midpoint, takeProfit)} from midpoint)\n` +
    `🛑 Stop loss: $${stopLoss.toFixed(2)} (${signedPct(midpoint, stopLoss)} from midpoint)\n` +
    `${sizeLine}\n` +
    `${sandboxTag() ? sandboxTag() + ' ' : ''}Monitoring price every 60s...`
  );

  ctx.completeTask();
}

async function handleConfirmation(ctx, text, data) {
  const lower = text.toLowerCase().trim();

  if (lower === 'cancel') {
    await ctx.reply('Alert dismissed.');
    ctx.completeTask();
    return;
  }

  if (lower !== 'confirm') {
    await ctx.reply('Reply *confirm* to place orders, or *cancel* to dismiss.');
    return;
  }

  const { symbol, triggerPrice, takeProfit, stopLoss, budget, qty: fixedQty } = data;
  const qty = fixedQty != null ? fixedQty : calcQty(budget, triggerPrice);

  if (qty <= 0) {
    await ctx.reply(`❌ Calculated quantity is 0. Budget $${budget?.toFixed(2)} is less than price $${triggerPrice?.toFixed(2)}.`);
    ctx.completeTask();
    return;
  }

  await ctx.reply('⏳ Placing BUY order...');

  try {
    const { buyOrderId, accountIdKey, verification } = await placeBuyOrder(symbol, qty, triggerPrice);

    const tag = sandboxTag();
    const v = verification?.[String(buyOrderId)];
    const idStr = buyOrderId ? ` — #${buyOrderId}` : '';
    const statusStr = v?.found ? ` ✓ ${v.status}` : buyOrderId ? ' ⚠️ unverified' : '';

    await ctx.reply(
      `✅ BUY ${qty} ${symbol} @ $${triggerPrice.toFixed(2)} (LIMIT, GTC)${idStr}${statusStr}${tag}\n\n` +
      `Monitoring for fill — TP ($${takeProfit.toFixed(2)}) and SL ($${stopLoss.toFixed(2)}) will be placed automatically once the buy executes.`
    );

    addPendingFill({ symbol, userId: ctx.userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss });
    ctx.completeTask();
  } catch (err) {
    logger.error(`Failed to place trade orders for ${symbol}: ${err.message}`, { stack: err.stack });

    if (err.status === 401) {
      // Token expired — start inline re-auth, keep task alive
      try {
        await startReAuth(ctx);
      } catch (reAuthErr) {
        logger.error(`Failed to start re-auth: ${reAuthErr.message}`);
        await ctx.reply(`Failed to start re-authentication: ${reAuthErr.message}`);
        ctx.completeTask();
      }
    } else {
      await ctx.reply(`❌ Failed to place orders: ${err.message}\n\nTry again or type /cancel.`);
      ctx.completeTask();
    }
  }
}

// ─── Task definition ──────────────────────────────────────────────────────────

const tradeTask = {
  command: '/trade',
  description: 'Set price alerts and place bracket orders via E*TRADE. Usage: /trade TICKER',

  async start(ctx, args) {
    const { userId } = ctx;
    const sub = args?.[0]?.toLowerCase() || '';

    // /trade list
    if (sub === 'list') {
      const userAlerts = listAlerts(userId);
      const fills = listPendingFills(userId);
      const lines = [];

      if (userAlerts.length > 0) {
        lines.push('*Price Alerts (watching):*');
        for (const a of userAlerts) {
          const sizeDesc = a.qty != null ? `${a.qty} shares` : `$${a.budget.toFixed(2)} budget`;
          lines.push(
            `• *${a.symbol}*: buy $${a.buyLow.toFixed(2)}–$${a.buyHigh.toFixed(2)} | ` +
            `TP $${a.takeProfit.toFixed(2)} | SL $${a.stopLoss.toFixed(2)} | ${sizeDesc}`
          );
        }
      }

      if (fills.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('*Awaiting Fill (BUY placed, exits pending):*');
        for (const f of fills) {
          lines.push(
            `• *${f.symbol}*: BUY ${f.qty} shares #${f.buyOrderId} | ` +
            `TP $${f.takeProfit.toFixed(2)} | SL $${f.stopLoss.toFixed(2)}`
          );
        }
      }

      if (lines.length === 0) {
        await ctx.reply('No active trade alerts or pending fills.\nUse /trade TICKER to set one.');
      } else {
        await ctx.reply(lines.join('\n'));
      }
      ctx.completeTask();
      return;
    }

    // /trade fill TICKER  (sandbox testing only — simulates a BUY fill)
    if (sub === 'fill') {
      const ticker = args?.[1]?.toUpperCase();
      if (!ticker) {
        await ctx.reply('Usage: /trade fill TICKER');
        ctx.completeTask();
        return;
      }
      if (!config.etrade.sandbox) {
        await ctx.reply('⚠️ /trade fill is only available in sandbox mode.');
        ctx.completeTask();
        return;
      }
      await ctx.reply(`⏳ Simulating fill for ${ticker} — placing exit orders...`);
      const triggered = await forceTriggerFill(ticker, userId);
      if (!triggered) {
        await ctx.reply(`No pending fill found for ${ticker}.\nUse /trade list to see pending fills.`);
      }
      ctx.completeTask();
      return;
    }

    // /trade cancel TICKER
    if (sub === 'cancel') {
      const ticker = args?.[1]?.toUpperCase();
      if (!ticker) {
        await ctx.reply('Usage: /trade cancel TICKER');
        ctx.completeTask();
        return;
      }
      const removed = removeAlert(ticker, userId);
      await ctx.reply(removed ? `Alert for ${ticker} removed.` : `No active alert found for ${ticker}.`);
      ctx.completeTask();
      return;
    }

    // /trade (no args)
    if (!sub) {
      await ctx.reply(
        'Usage: /trade TICKER\n\nExamples:\n' +
        '  /trade UBER\n' +
        '  /trade list\n' +
        '  /trade cancel UBER'
      );
      ctx.completeTask();
      return;
    }

    // /trade TICKER — fetch price and prompt for plan
    const symbol = sub.toUpperCase();
    await ctx.reply(`🔍 Fetching price for ${symbol}...`);

    let quote;
    try {
      quote = await fetchStockQuote(symbol);
    } catch (err) {
      await ctx.reply(`Failed to fetch price for ${symbol}: ${err.message}`);
      ctx.completeTask();
      return;
    }

    if (quote.error || quote.price == null) {
      await ctx.reply(`Could not get price for ${symbol}. Check the ticker symbol.`);
      ctx.completeTask();
      return;
    }

    ctx.updateTask('awaiting_params', { symbol, currentPrice: quote.price });

    await ctx.reply(
      `Current price: *$${quote.price.toFixed(2)}*\n\n` +
      `Enter your trade plan:\n` +
      `\`buy <low> <high> tp <target> sl <stop> budget <amount>\`\n` +
      `or\n` +
      `\`buy <low> <high> tp <target> sl <stop> qty <shares>\`\n\n` +
      `Example:\n` +
      `\`buy ${(quote.price * 0.96).toFixed(2)} ${(quote.price * 0.98).toFixed(2)} tp ${(quote.price * 1.10).toFixed(2)} sl ${(quote.price * 0.94).toFixed(2)} budget 1000\``
    );
  },

  async onMessage(ctx, text) {
    const state = ctx.getState();
    const taskState = state?.taskState;
    const data = ctx.getTaskData();

    if (taskState === 'awaiting_params') {
      await handleParams(ctx, text, data);
      return;
    }

    if (taskState === 'awaiting_confirmation') {
      await handleConfirmation(ctx, text, data);
      return;
    }

    if (taskState === 'awaiting_pin') {
      await handlePin(ctx, text);
      return;
    }

    await ctx.reply('Use /trade TICKER to set a new trade plan.');
    ctx.completeTask();
  },

  cleanup(ctx) {
    cleanupAuthFlow(ctx.userId);
  },
};

export { initAlertMonitor, stopAlertMonitor };
export default tradeTask;
