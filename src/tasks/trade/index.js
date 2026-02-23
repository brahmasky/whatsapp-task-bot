/**
 * /trade Task
 *
 * Place a GFD BUY LIMIT order at the top of your entry zone immediately.
 * E*TRADE handles execution; the fill monitor places TP + SL automatically
 * once the buy is confirmed EXECUTED.
 *
 * If the E*TRADE OAuth token is expired at order placement, the task
 * handles re-authentication inline — no need to visit /portfolio.
 *
 * Usage:
 *   /trade UBER                       — set a new trade plan
 *   /trade list                       — show pending orders
 *   /trade cancel UBER                — cancel the pending BUY order on E*TRADE
 *   /trade fill UBER                  — simulate a fill (sandbox only)
 *
 * After /trade TICKER, send:
 *   buy <low> <high> tp <target> sl <stop> budget <amount>
 *   buy <low> <high> tp <target> sl <stop> qty <shares>
 */

import { startAuthFlow, exchangePin, cleanupAuthFlow } from '../../shared/auth.service.js';
import logger from '../../utils/logger.js';
import { fetchStockQuote } from '../market/sector.service.js';
import { placeBuyOrder, calcQty, checkCashBalance, cancelBuyOrder, refreshPortfolioCache } from './order.service.js';
import {
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
    buyLow:   parseFloat(m[1]),
    buyHigh:  parseFloat(m[2]),
    takeProfit: parseFloat(m[3]),
    stopLoss: parseFloat(m[4]),
    budget:   m[5] ? parseFloat(m[5]) : null,
    fixedQty: m[6] ? parseInt(m[6], 10) : null,
  };
}

// ─── Order placement (shared between handleParams and post-reauth) ─────────────

async function placeAndTrack(ctx, { symbol, limitPrice, qty, takeProfit, stopLoss, buyLow, buyHigh, budget }) {
  const { buyOrderId, accountIdKey, verification } = await placeBuyOrder(symbol, qty, limitPrice, 'GOOD_FOR_DAY');

  const tag = sandboxTag();
  const v = verification?.[String(buyOrderId)];
  const idStr = buyOrderId ? ` — #${buyOrderId}` : '';
  const statusStr = v?.found ? ` ✓ ${v.status}` : buyOrderId ? ' ⚠️ unverified' : '';
  const sizeDesc = budget != null ? `$${budget.toFixed(2)} budget` : `${qty} shares`;

  addPendingFill({ symbol, userId: ctx.userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice });
  refreshPortfolioCache().catch(err => logger.warn(`Post-BUY cache refresh failed: ${err.message}`));

  await ctx.reply(
    `✅ BUY LIMIT set for *${symbol}*${tag}\n` +
    `📈 Entry: ≤$${limitPrice.toFixed(2)} (zone $${buyLow.toFixed(2)}–$${buyHigh.toFixed(2)})\n` +
    `🎯 Take profit: $${takeProfit.toFixed(2)} (${signedPct(limitPrice, takeProfit)})\n` +
    `🛑 Stop loss: $${stopLoss.toFixed(2)} (${signedPct(limitPrice, stopLoss)})\n` +
    `💰 ${sizeDesc} → ${qty} shares\n` +
    `Order${idStr}${statusStr} active GFD — monitoring for fill.`
  );
  ctx.completeTask();
}

// ─── Re-auth flow ─────────────────────────────────────────────────────────────

async function startReAuth(ctx) {
  const { authUrl } = await startAuthFlow(ctx.userId);
  ctx.updateTask('awaiting_pin'); // plan data preserved via state merge

  const envNote = config.etrade.sandbox ? ' (SANDBOX)' : '';
  await ctx.reply(
    `🔐 E*TRADE session expired. Re-authentication required${envNote}.\n\n` +
    `1. Open this link to authorize:\n${authUrl}\n\n` +
    `2. Log in to E*TRADE and click "Accept"\n` +
    `3. Copy the PIN and reply with it here\n\n` +
    `Your trade plan is saved — order will be placed after re-auth.\n` +
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

    await ctx.reply('✅ Re-authenticated! Placing order now...');

    const data = ctx.getTaskData();
    try {
      await placeAndTrack(ctx, data);
    } catch (placeErr) {
      logger.error(`Order placement failed after re-auth: ${placeErr.message}`);
      await ctx.reply(`❌ Order placement failed: ${placeErr.message}`);
      ctx.completeTask();
    }
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

// ─── Plan handler — validates, checks cash, places order ─────────────────────

async function handleParams(ctx, text, data) {
  const { symbol } = data;

  const parsed = parsePlan(text);
  if (!parsed) {
    await ctx.reply(
      'Could not parse trade plan. Expected format:\n' +
      '`buy <low> <high> tp <target> sl <stop> budget <amount>`\n' +
      'or\n' +
      '`buy <low> <high> tp <target> sl <stop> qty <shares>`\n\n' +
      'Example: `buy 70 73 tp 81.30 sl 68 budget 1000`'
    );
    return;
  }

  const { buyLow, buyHigh, takeProfit, stopLoss, budget, fixedQty } = parsed;

  if (buyLow >= buyHigh)       { await ctx.reply('❌ Buy low must be less than buy high.'); return; }
  if (takeProfit <= buyHigh)   { await ctx.reply('❌ Take profit must be above the buy high.'); return; }
  if (stopLoss >= buyLow)      { await ctx.reply('❌ Stop loss must be below buy low.'); return; }
  if (budget != null && budget <= 0) { await ctx.reply('❌ Budget must be greater than 0.'); return; }
  if (fixedQty != null && fixedQty <= 0) { await ctx.reply('❌ Quantity must be greater than 0.'); return; }

  const limitPrice = parseFloat((buyLow + (buyHigh - buyLow) * 0.618).toFixed(2));
  const qty = fixedQty ?? calcQty(budget, limitPrice);

  if (qty <= 0) {
    await ctx.reply(`❌ Budget $${budget?.toFixed(2)} is less than the limit price $${limitPrice.toFixed(2)}.`);
    return;
  }

  const plan = { symbol, limitPrice, qty, takeProfit, stopLoss, buyLow, buyHigh, budget };

  // Store plan in task data — needed if 401 triggers re-auth mid-flow
  ctx.updateTask('placing_order', plan);

  // Cash balance check
  try {
    const { cash, cost, sufficient } = await checkCashBalance(qty, limitPrice);
    if (!sufficient) {
      await ctx.reply(
        `⚠️ *Insufficient cash — order not placed.*\n\n` +
        `Order cost:      $${cost.toFixed(2)} (${qty} × $${limitPrice.toFixed(2)})\n` +
        `Cash available:  $${cash.toFixed(2)}\n` +
        `Shortfall:       $${(cost - cash).toFixed(2)}\n\n` +
        `Reduce your budget and try again with /trade ${symbol}.`
      );
      ctx.completeTask();
      return;
    }
    logger.info(`Cash check OK: cost $${cost.toFixed(2)} vs available $${cash.toFixed(2)} for ${symbol}`);
  } catch (err) {
    logger.warn(`Cash balance check failed for ${symbol}: ${err.message} — proceeding`);
    await ctx.reply(`⚠️ Could not verify cash balance (${err.message}) — proceeding with order.`);
  }

  await ctx.reply(`⏳ Placing BUY LIMIT order for ${symbol}...`);

  try {
    await placeAndTrack(ctx, plan);
  } catch (err) {
    logger.error(`Failed to place trade order for ${symbol}: ${err.message}`, { stack: err.stack });

    if (err.status === 401) {
      try {
        await startReAuth(ctx);
      } catch (reAuthErr) {
        logger.error(`Failed to start re-auth: ${reAuthErr.message}`);
        await ctx.reply(`Failed to start re-authentication: ${reAuthErr.message}`);
        ctx.completeTask();
      }
    } else {
      await ctx.reply(`❌ Failed to place order: ${err.message}\n\nTry again or type /cancel.`);
      ctx.completeTask();
    }
  }
}

// ─── Task definition ──────────────────────────────────────────────────────────

const tradeTask = {
  command: '/trade',
  description: 'Place a GFD BUY LIMIT + auto TP/SL on fill via E*TRADE. Usage: /trade TICKER',

  async start(ctx, args) {
    const { userId } = ctx;
    const sub = args?.[0]?.toLowerCase() || '';

    // /trade list
    if (sub === 'list') {
      const fills = listPendingFills(userId);
      if (fills.length === 0) {
        await ctx.reply('No pending orders.\nUse /trade TICKER to place one.');
      } else {
        const lines = ['*Pending Orders (BUY placed, awaiting fill):*'];
        for (const f of fills) {
          const limitStr = f.limitPrice != null ? `≤$${f.limitPrice.toFixed(2)}` : 'limit';
          lines.push(
            `• *${f.symbol}*: BUY ${f.qty} shares ${limitStr} #${f.buyOrderId} | ` +
            `TP $${f.takeProfit.toFixed(2)} | SL $${f.stopLoss.toFixed(2)}`
          );
        }
        await ctx.reply(lines.join('\n'));
      }
      ctx.completeTask();
      return;
    }

    // /trade fill TICKER  (sandbox testing only)
    if (sub === 'fill') {
      const ticker = args?.[1]?.toUpperCase();
      if (!ticker) { await ctx.reply('Usage: /trade fill TICKER'); ctx.completeTask(); return; }
      if (!config.etrade.sandbox) {
        await ctx.reply('⚠️ /trade fill is only available in sandbox mode.');
        ctx.completeTask();
        return;
      }
      await ctx.reply(`⏳ Simulating fill for ${ticker} — placing exit orders...`);
      const triggered = await forceTriggerFill(ticker, userId);
      if (!triggered) {
        await ctx.reply(`No pending order found for ${ticker}.\nUse /trade list to see pending orders.`);
      }
      ctx.completeTask();
      return;
    }

    // /trade cancel TICKER
    if (sub === 'cancel') {
      const ticker = args?.[1]?.toUpperCase();
      if (!ticker) { await ctx.reply('Usage: /trade cancel TICKER'); ctx.completeTask(); return; }

      const fills = listPendingFills(userId).filter(f => f.symbol === ticker);
      if (fills.length === 0) {
        await ctx.reply(`No pending order found for ${ticker}.`);
        ctx.completeTask();
        return;
      }

      const fill = fills[0];
      try {
        await cancelBuyOrder(fill.accountIdKey, fill.buyOrderId);
        removePendingFill(ticker, userId);
        await ctx.reply(`✅ BUY order #${fill.buyOrderId} for ${ticker} cancelled.`);
      } catch (err) {
        logger.error(`Failed to cancel order #${fill.buyOrderId} for ${ticker}: ${err.message}`);
        removePendingFill(ticker, userId);
        await ctx.reply(
          `⚠️ Could not cancel on E*TRADE: ${err.message}\n` +
          `Removed from local tracking — please cancel #${fill.buyOrderId} manually if still open.`
        );
      }
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

    // /trade TICKER — fetch current price for reference, then prompt for plan
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
      `A BUY LIMIT at your zone ceiling will be placed immediately (GFD).\n\n` +
      `Example:\n` +
      `\`buy ${(quote.price * 0.96).toFixed(2)} ${(quote.price * 0.98).toFixed(2)} tp ${(quote.price * 1.10).toFixed(2)} sl ${(quote.price * 0.94).toFixed(2)} budget 1000\``
    );
  },

  async onMessage(ctx, text) {
    const taskState = ctx.getState()?.taskState;
    const data = ctx.getTaskData();

    if (taskState === 'awaiting_params') {
      await handleParams(ctx, text, data);
      return;
    }

    if (taskState === 'awaiting_pin') {
      await handlePin(ctx, text);
      return;
    }

    await ctx.reply('Use /trade TICKER to place a new order.');
    ctx.completeTask();
  },

  cleanup(ctx) {
    cleanupAuthFlow(ctx.userId);
  },
};

export { initAlertMonitor, stopAlertMonitor };
export default tradeTask;
