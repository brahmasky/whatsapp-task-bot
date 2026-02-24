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
 *   /trade list                       — show pending orders with live E*TRADE status
 *   /trade track TICKER ORDER_ID ...  — re-register an order after bot restart
 *   /trade cancel UBER                — cancel the pending BUY order on E*TRADE
 *   /trade fill UBER                  — simulate a fill (sandbox only)
 *
 * After /trade TICKER, send:
 *   buy <low> <high> tp <target> sl <stop> budget <amount>
 *   buy <low> <high> tp <target> sl <stop> qty <shares>
 */

import fs from 'fs';
import { cleanupAuthFlow } from '../../shared/auth.service.js';
import { startReAuth, handleReAuthPin } from '../../shared/reauth.js';
import logger from '../../utils/logger.js';
import { fetchStockQuote } from '../market/sector.service.js';
import { isMarketDay, isMarketOpen, isPreMarket, isWeekend } from '../market/calendar.js';
import { placeBuyOrder, calcQty, checkCashBalance, cancelBuyOrder, cancelOrder, getOrderStatus, getAuthenticatedService, getFirstBrokerageAccount, placeExitOrders } from '../../shared/etrade.order.js';
import { load, loadLines, save } from '../../utils/persistence.service.js';
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

// tp and sl are both independently optional
const PLAN_REGEX = /buy\s+([\d.]+)\s+([\d.]+)(?:\s+tp\s+([\d.]+))?(?:\s+sl\s+([\d.]+))?\s+(?:budget\s+([\d.]+)|qty\s+([\d]+))/i;
const PLAN_MARKET_REGEX = /buy\s+market(?:\s+tp\s+([\d.]+))?(?:\s+sl\s+([\d.]+))?\s+(?:budget\s+([\d.]+)|qty\s+([\d]+))/i;

function parsePlan(text) {
  // Limit zone order
  const m = text.match(PLAN_REGEX);
  if (m) {
    return {
      isMarket:   false,
      buyLow:     parseFloat(m[1]),
      buyHigh:    parseFloat(m[2]),
      takeProfit: m[3] ? parseFloat(m[3]) : null,
      stopLoss:   m[4] ? parseFloat(m[4]) : null,
      budget:     m[5] ? parseFloat(m[5]) : null,
      fixedQty:   m[6] ? parseInt(m[6], 10) : null,
    };
  }
  // Market order
  const mm = text.match(PLAN_MARKET_REGEX);
  if (mm) {
    return {
      isMarket:   true,
      buyLow:     null,
      buyHigh:    null,
      takeProfit: mm[1] ? parseFloat(mm[1]) : null,
      stopLoss:   mm[2] ? parseFloat(mm[2]) : null,
      budget:     mm[3] ? parseFloat(mm[3]) : null,
      fixedQty:   mm[4] ? parseInt(mm[4], 10) : null,
    };
  }
  return null;
}

// ─── Order placement (shared between handleParams and post-reauth) ─────────────

async function placeAndTrack(ctx, { symbol, limitPrice, qty, takeProfit, stopLoss, buyLow, buyHigh, budget, currentPrice }) {
  const { buyOrderId, accountIdKey, verification } = await placeBuyOrder(symbol, qty, limitPrice, 'GOOD_FOR_DAY');

  const tag = sandboxTag();
  const v = verification?.[String(buyOrderId)];
  const idStr = buyOrderId ? ` — #${buyOrderId}` : '';
  const statusStr = v?.found ? ` ✓ ${v.status}` : buyOrderId ? ' ⚠️ unverified' : '';
  const sizeDesc = budget != null ? `$${budget.toFixed(2)} budget` : `${qty} shares`;

  addPendingFill({ symbol, userId: ctx.userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice, buyLow, buyHigh, budget });

  const refPrice = limitPrice ?? currentPrice;
  const entryLine = limitPrice != null
    ? `📈 Entry: ≤$${limitPrice.toFixed(2)} (zone $${buyLow.toFixed(2)}–$${buyHigh.toFixed(2)})\n`
    : `📈 Entry: MARKET${currentPrice ? ` (quoted ~$${currentPrice.toFixed(2)})` : ''}\n`;
  const tpLine = takeProfit != null
    ? `🎯 Take profit: $${takeProfit.toFixed(2)}${refPrice ? ` (${signedPct(refPrice, takeProfit)})` : ''}\n`
    : '';
  const slLine = stopLoss != null
    ? `🛑 Stop loss: $${stopLoss.toFixed(2)}${refPrice ? ` (${signedPct(refPrice, stopLoss)})` : ''}\n`
    : '';
  const noExitNote = (takeProfit == null && stopLoss == null)
    ? `ℹ️ No exit orders — manage position manually.\n`
    : '';

  await ctx.reply(
    `✅ BUY ${limitPrice != null ? 'LIMIT' : 'MARKET'} set for *${symbol}*${tag}\n` +
    entryLine +
    tpLine +
    slLine +
    noExitNote +
    `💰 ${sizeDesc} → ${qty} shares\n` +
    `Order${idStr}${statusStr} active GFD — monitoring for fill.`
  );
  ctx.completeTask();
}

// ─── GFD timing check ─────────────────────────────────────────────────────────

/**
 * Returns a warning string if the current time is bad for a GFD order,
 * or null if timing is fine (market open with plenty of time left).
 */
function getGfdWindowWarning() {
  const now = new Date();

  if (!isMarketDay(now)) {
    const reason = isWeekend(now) ? 'weekend' : 'holiday';
    return `⚠️ Market is closed (${reason}) — this GFD will be active the next trading day only.`;
  }

  // Pre-market: full trading day ahead, no concern
  if (isPreMarket(now)) return null;

  if (isMarketOpen(now)) {
    // Compute minutes remaining until 4:00 PM ET
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et = new Date(etStr);
    const minutesToClose = (16 * 60) - (et.getHours() * 60 + et.getMinutes());
    if (minutesToClose <= 30) {
      return `⚠️ Market closes in ~${minutesToClose} min — this GFD will almost certainly expire unfilled today.`;
    }
    return null;
  }

  // After-hours or late-night on a market day
  return `⚠️ Market is closed — this GFD will be active tomorrow only.`;
}

// ─── Re-auth flow ─────────────────────────────────────────────────────────────

const REAUTH_NOTE = 'Your trade plan is saved — order will be placed after re-auth.';

// ─── Cash check + placement (shared between confirmation handler and re-auth) ─

async function checkAndPlace(ctx, plan) {
  const { symbol, limitPrice, qty, buyLow, buyHigh, takeProfit, stopLoss, budget, currentPrice } = plan;
  ctx.updateTask('placing_order', plan);

  // Cash balance check — use current price as estimate for market orders
  const checkPrice = limitPrice ?? currentPrice;
  if (checkPrice != null) {
    try {
      const { cash, cost, sufficient } = await checkCashBalance(qty, checkPrice);
      if (!sufficient) {
        const maxShares = Math.floor(cash / checkPrice);
        const suggestion = maxShares > 0
          ? limitPrice != null
            ? `Try \`buy ${buyLow} ${buyHigh} tp ${takeProfit} sl ${stopLoss} qty ${maxShares}\``
            : `Try \`buy market tp ${takeProfit} sl ${stopLoss} qty ${maxShares}\``
          : 'Insufficient cash for even 1 share.';
        await ctx.reply(
          `⚠️ *Insufficient cash — order not placed.*\n\n` +
          `Order cost:      $${cost.toFixed(2)} (${qty} × ~$${checkPrice.toFixed(2)})\n` +
          `Cash available:  $${cash.toFixed(2)}\n` +
          `Shortfall:       $${(cost - cash).toFixed(2)}\n\n` +
          `${suggestion} or type /cancel to abort.`
        );
        ctx.updateTask('awaiting_params', { symbol });
        return;
      }
      logger.info(`Cash check OK: cost ~$${cost.toFixed(2)} vs available $${cash.toFixed(2)} for ${symbol}`);
    } catch (err) {
      logger.warn(`Cash balance check failed for ${symbol}: ${err.message} — proceeding`);
      await ctx.reply(`⚠️ Could not verify cash balance (${err.message}) — proceeding with order.`);
    }
  }

  const orderTypeStr = limitPrice != null ? 'BUY LIMIT' : 'BUY MARKET';
  await ctx.reply(`⏳ Placing ${orderTypeStr} order for ${symbol}...`);

  try {
    await placeAndTrack(ctx, plan);
  } catch (err) {
    logger.error(`Failed to place trade order for ${symbol}: ${err.message}`, { stack: err.stack });
    if (err.status === 401) {
      await startReAuth(ctx, REAUTH_NOTE);
    } else {
      await ctx.reply(`❌ Failed to place order: ${err.message}\n\nTry again or type /cancel.`);
      ctx.completeTask();
    }
  }
}

// ─── Plan handler — validates params and shows confirmation summary ────────────

async function handleParams(ctx, text, data) {
  const { symbol, currentPrice } = data;

  const parsed = parsePlan(text);
  if (!parsed) {
    await ctx.reply(
      'Could not parse trade plan. Format:\n' +
      '`buy <low> <high> [tp <target>] [sl <stop>] budget <amount>`\n' +
      '`buy market [tp <target>] [sl <stop>] budget <amount>`\n\n' +
      'tp and sl are optional. Examples:\n' +
      '`buy 70 73 tp 81.30 sl 68 budget 1000`  ← full bracket\n' +
      '`buy 70 73 budget 1000`                  ← no exits\n' +
      '`buy market tp 85 sl 68 qty 10`          ← market with exits'
    );
    return;
  }

  const { isMarket, buyLow, buyHigh, takeProfit, stopLoss, budget, fixedQty } = parsed;

  // Validate TP/SL relative to entry (only if provided)
  if (!isMarket) {
    if (buyLow >= buyHigh) { await ctx.reply('❌ Buy low must be less than buy high.'); return; }
    if (takeProfit != null && takeProfit <= buyHigh) { await ctx.reply('❌ Take profit must be above the buy high.'); return; }
    if (stopLoss  != null && stopLoss  >= buyLow)   { await ctx.reply('❌ Stop loss must be below buy low.'); return; }
  } else if (currentPrice != null) {
    if (takeProfit != null && takeProfit <= currentPrice) { await ctx.reply('❌ Take profit must be above the current price.'); return; }
    if (stopLoss  != null && stopLoss  >= currentPrice)   { await ctx.reply('❌ Stop loss must be below the current price.'); return; }
  }
  if (budget  != null && budget  <= 0) { await ctx.reply('❌ Budget must be greater than 0.'); return; }
  if (fixedQty != null && fixedQty <= 0) { await ctx.reply('❌ Quantity must be greater than 0.'); return; }

  const limitPrice = isMarket ? null : parseFloat((buyLow + (buyHigh - buyLow) * 0.618).toFixed(2));
  const refPrice = limitPrice ?? currentPrice; // used for qty, cash check, R/R
  const qty = fixedQty ?? calcQty(budget, refPrice);

  if (qty <= 0) {
    const priceDesc = limitPrice != null
      ? `the limit price $${limitPrice.toFixed(2)}`
      : `the current price $${currentPrice?.toFixed(2)}`;
    await ctx.reply(`❌ Budget $${budget?.toFixed(2)} is less than ${priceDesc}.`);
    return;
  }

  const rrRatio = (takeProfit != null && stopLoss != null && refPrice != null)
    ? ((takeProfit - refPrice) / (refPrice - stopLoss)).toFixed(1)
    : null;
  const sizeDesc = budget != null ? `$${budget.toFixed(2)} budget → ${qty} shares` : `${qty} shares`;
  const estCost = refPrice ? `$${(qty * refPrice).toFixed(2)}` : 'unknown';
  const gfdWarning = getGfdWindowWarning();

  const reviewLine = limitPrice != null
    ? `• BUY ${qty} ${symbol} @ ≤$${limitPrice.toFixed(2)} (61.8% of $${buyLow}–$${buyHigh})`
    : `• BUY ${qty} ${symbol} @ MARKET${currentPrice ? ` (current ~$${currentPrice.toFixed(2)})` : ''}`;
  const tpSlLine = `• TP: ${takeProfit != null ? '$' + takeProfit.toFixed(2) : 'none'} | SL: ${stopLoss != null ? '$' + stopLoss.toFixed(2) : 'none'}`;
  const costLine = `• ${sizeDesc} | Est. cost: ${estCost}${rrRatio != null ? ` | R/R: 1:${rrRatio}` : ''}`;

  const plan = { symbol, limitPrice, qty, takeProfit, stopLoss, buyLow, buyHigh, budget, currentPrice };
  ctx.updateTask('awaiting_confirmation', plan);
  await ctx.reply(
    `Review order:\n` +
    `${reviewLine}\n` +
    `${tpSlLine}\n` +
    `${costLine}\n` +
    (gfdWarning ? `\n${gfdWarning}\n` : '') +
    `\nReply \`confirm\` to place, \`edit\` to change.`
  );
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
        ctx.completeTask();
        return;
      }

      await ctx.reply('Checking order status with E*TRADE...');

      const lines = ['*Pending Orders:*'];
      for (const f of fills) {
        const limitStr = f.limitPrice != null ? `≤$${f.limitPrice.toFixed(2)}` : 'limit';
        let statusStr = '';
        try {
          const status = await getOrderStatus(f.accountIdKey, f.buyOrderId);
          const emoji = status === 'EXECUTED' ? '✅' : status === 'EXPIRED' || status === 'CANCELLED' ? '❌' : '⏳';
          statusStr = ` — ${emoji} ${status}`;
        } catch (err) {
          statusStr = ` — ⚠️ status unavailable`;
        }
        const tpStr = f.takeProfit != null ? `TP $${f.takeProfit.toFixed(2)}` : 'no TP';
        const slStr = f.stopLoss  != null ? `SL $${f.stopLoss.toFixed(2)}`  : 'no SL';
        lines.push(
          `• *${f.symbol}* #${f.buyOrderId}${statusStr}\n` +
          `  BUY ${f.qty} @ ${limitStr} | ${tpStr} | ${slStr}`
        );
      }
      await ctx.reply(lines.join('\n'));
      ctx.completeTask();
      return;
    }

    // /trade track TICKER ORDER_ID qty N tp X sl Y [limit P]
    // Re-register an existing order with the fill monitor after a bot restart
    if (sub === 'track') {
      const rest = args.slice(1).join(' ');
      const m = rest.match(/^(\w+)\s+(\d+)\s+qty\s+(\d+)\s+tp\s+([\d.]+)\s+sl\s+([\d.]+)(?:\s+limit\s+([\d.]+))?/i);
      if (!m) {
        await ctx.reply(
          'Usage: /trade track TICKER ORDER_ID qty N tp X sl Y [limit P]\n\n' +
          'Example:\n  /trade track MU 267 qty 2 tp 420 sl 390 limit 401.18'
        );
        ctx.completeTask();
        return;
      }
      const symbol = m[1].toUpperCase();
      const buyOrderId = parseInt(m[2], 10);
      const qty = parseInt(m[3], 10);
      const takeProfit = parseFloat(m[4]);
      const stopLoss = parseFloat(m[5]);
      const limitPrice = m[6] ? parseFloat(m[6]) : null;

      await ctx.reply(`🔍 Verifying order #${buyOrderId} on E*TRADE...`);

      let accountIdKey;
      try {
        const service = await getAuthenticatedService(userId);
        accountIdKey = await getFirstBrokerageAccount(service);
      } catch (err) {
        await ctx.reply(`❌ Could not connect to E*TRADE: ${err.message}`);
        ctx.completeTask();
        return;
      }

      let status;
      try {
        status = await getOrderStatus(accountIdKey, buyOrderId);
      } catch (err) {
        await ctx.reply(`❌ Could not fetch order status: ${err.message}`);
        ctx.completeTask();
        return;
      }

      if (status === 'EXECUTED') {
        await ctx.reply(
          `⚠️ Order #${buyOrderId} is already *EXECUTED* — not adding to monitor.\n` +
          `Please place TP/SL manually:\n` +
          `• SELL ${qty} ${symbol} @ $${takeProfit.toFixed(2)} (take profit)\n` +
          `• SELL ${qty} ${symbol} @ $${stopLoss.toFixed(2)} (stop loss)`
        );
        ctx.completeTask();
        return;
      }

      if (status === 'CANCELLED' || status === 'EXPIRED') {
        await ctx.reply(`ℹ️ Order #${buyOrderId} is ${status} — nothing to track.`);
        ctx.completeTask();
        return;
      }

      addPendingFill({ symbol, userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice });
      const limitStr = limitPrice ? ` ≤$${limitPrice.toFixed(2)}` : '';
      await ctx.reply(
        `✅ Now tracking *${symbol}* #${buyOrderId} (${status})\n` +
        `BUY ${qty} shares${limitStr} | TP $${takeProfit.toFixed(2)} | SL $${stopLoss.toFixed(2)}\n\n` +
        `Fill monitor will auto-place exit orders on execution.`
      );
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

    // /trade history
    if (sub === 'history') {
      const lines = loadLines('trade-history').slice(-10).reverse();
      if (lines.length === 0) {
        await ctx.reply('No trade history yet.');
        ctx.completeTask();
        return;
      }
      const text = lines.map(e =>
        `${new Date(e.ts).toLocaleDateString()} ${e.symbol} ${e.qty}sh @ $${e.limitPrice?.toFixed(2) ?? '?'} → TP $${e.takeProfit?.toFixed(2) ?? '?'} SL $${e.stopLoss?.toFixed(2) ?? '?'}`
      ).join('\n');
      await ctx.reply(`Recent trades (last ${lines.length}):\n\n${text}`);
      ctx.completeTask();
      return;
    }

    // /trade retry-exits TICKER
    if (sub === 'retry-exits') {
      const ticker = args?.[1]?.toUpperCase();
      if (!ticker) { await ctx.reply('Usage: /trade retry-exits TICKER'); ctx.completeTask(); return; }

      const pending = load(`pending-exits/${ticker}-${userId}`);
      if (!pending || pending.cleared) {
        await ctx.reply(`No pending exit retry for ${ticker}.`);
        ctx.completeTask();
        return;
      }

      try {
        const { tpOrderId, slOrderId } = await placeExitOrders(
          pending.accountIdKey, ticker, pending.qty, pending.takeProfit, pending.stopLoss
        );
        save(`pending-exits/${ticker}-${userId}`, { cleared: true, clearedAt: Date.now() });
        await ctx.reply(`✅ Exit orders placed: TP #${tpOrderId}, SL #${slOrderId}`);
      } catch (err) {
        logger.error(`retry-exits failed for ${ticker}: ${err.message}`);
        await ctx.reply(`Failed to place exit orders: ${err.message}`);
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
        removePendingFill(ticker, userId, fill.buyOrderId);
        await ctx.reply(`✅ BUY order #${fill.buyOrderId} for ${ticker} cancelled.`);
      } catch (err) {
        logger.error(`Failed to cancel order #${fill.buyOrderId} for ${ticker}: ${err.message}`);
        removePendingFill(ticker, userId, fill.buyOrderId);
        await ctx.reply(
          `⚠️ Could not cancel on E*TRADE: ${err.message}\n` +
          `Removed from local tracking — please cancel #${fill.buyOrderId} manually if still open.`
        );
      }
      ctx.completeTask();
      return;
    }

    // /trade modify TICKER [tp X] [sl Y]
    if (sub === 'modify') {
      const symbol = args[1]?.toUpperCase();
      const tpIdx = args.indexOf('tp');
      const slIdx = args.indexOf('sl');
      const tp = tpIdx >= 0 ? parseFloat(args[tpIdx + 1]) : null;
      const sl = slIdx >= 0 ? parseFloat(args[slIdx + 1]) : null;

      if (!symbol || (tp == null && sl == null)) {
        await ctx.reply('Usage: /trade modify TICKER [tp PRICE] [sl PRICE]\nExample: /trade modify UBER tp 90 sl 68');
        ctx.completeTask();
        return;
      }

      const history = loadLines('trade-history');
      const last = [...history].reverse().find(e => e.symbol === symbol && e.tpOrderId && e.slOrderId);
      if (!last) {
        await ctx.reply(`No trade history with TP/SL orders found for ${symbol}.`);
        ctx.completeTask();
        return;
      }

      await ctx.reply(`Cancelling existing TP/SL orders for ${symbol}...`);

      try {
        const service = await getAuthenticatedService();
        const accountIdKey = await getFirstBrokerageAccount(service);

        if (last.tpOrderId) await cancelOrder(accountIdKey, last.tpOrderId);
        if (last.slOrderId) await cancelOrder(accountIdKey, last.slOrderId);

        const newTp = tp ?? last.takeProfit;
        const newSl = sl ?? last.stopLoss;
        const { tpOrderId, slOrderId } = await placeExitOrders(accountIdKey, symbol, last.qty, newTp, newSl);

        await ctx.reply(
          `✅ Orders updated for ${symbol}:\n` +
          `• TP #${tpOrderId} @ $${newTp.toFixed(2)}\n` +
          `• SL #${slOrderId} @ $${newSl.toFixed(2)}`
        );
      } catch (err) {
        logger.error(`/trade modify failed for ${symbol}: ${err.message}`);
        await ctx.reply(`Failed to modify orders: ${err.message}`);
      }
      ctx.completeTask();
      return;
    }

    // /trade journal [csv]
    if (sub === 'journal') {
      const history = loadLines('trade-history');
      if (history.length === 0) {
        await ctx.reply('No trade history to export.');
        ctx.completeTask();
        return;
      }

      const header = 'Date,Ticker,Entry,Qty,TakeProfit,StopLoss,BuyOrderId,TpOrderId,SlOrderId';
      const rows = history.map(e =>
        [
          new Date(e.ts).toLocaleDateString('en-US'),
          e.symbol,
          e.limitPrice?.toFixed(2) ?? '',
          e.qty ?? '',
          e.takeProfit?.toFixed(2) ?? '',
          e.stopLoss?.toFixed(2) ?? '',
          e.buyOrderId ?? '',
          e.tpOrderId ?? '',
          e.slOrderId ?? '',
        ].join(',')
      );
      const csv = [header, ...rows].join('\n');
      const tmpPath = `/tmp/trade-journal-${Date.now()}.csv`;
      fs.writeFileSync(tmpPath, csv, 'utf8');

      await ctx.sendDocument(tmpPath, 'trade-journal.csv', 'text/csv', `Trade journal — ${history.length} trades`);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      ctx.completeTask();
      return;
    }

    // /trade (no args)
    if (!sub) {
      await ctx.reply(
        'Usage: /trade TICKER\n\nExamples:\n' +
        '  /trade UBER\n' +
        '  /trade list\n' +
        '  /trade cancel UBER\n' +
        '  /trade history\n' +
        '  /trade modify UBER tp 90 sl 68\n' +
        '  /trade journal\n' +
        '  /trade retry-exits UBER'
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
      `Enter your buy plan — tp and sl are optional:\n\n` +
      `Limit zone:\n` +
      `\`buy <low> <high> [tp <target>] [sl <stop>] budget <amount>\`\n\n` +
      `Market order:\n` +
      `\`buy market [tp <target>] [sl <stop>] budget <amount>\`\n\n` +
      `Examples:\n` +
      `\`buy ${(quote.price * 0.96).toFixed(2)} ${(quote.price * 0.98).toFixed(2)} tp ${(quote.price * 1.10).toFixed(2)} sl ${(quote.price * 0.94).toFixed(2)} budget 1000\`\n` +
      `\`buy ${(quote.price * 0.96).toFixed(2)} ${(quote.price * 0.98).toFixed(2)} budget 1000\`\n` +
      `\`buy market budget 1000\``
    );
  },

  async onMessage(ctx, text) {
    const taskState = ctx.getState()?.taskState;
    const data = ctx.getTaskData();

    if (taskState === 'placing_order') {
      await ctx.reply('Order is being placed — please wait.');
      return;
    }

    if (taskState === 'awaiting_confirmation') {
      const cmd = text.trim().toLowerCase();
      if (cmd === 'confirm') {
        await checkAndPlace(ctx, data);
      } else if (cmd === 'edit') {
        ctx.updateTask('awaiting_params', { symbol: data.symbol });
        await ctx.reply('Enter your plan again:\n`buy <low> <high> tp <target> sl <stop> budget <amount>`');
      } else {
        await ctx.reply('Reply `confirm` to place the order, or `edit` to change the plan.');
      }
      return;
    }

    if (taskState === 'awaiting_params') {
      await handleParams(ctx, text, data);
      return;
    }

    if (taskState === 'awaiting_pin') {
      await handleReAuthPin(ctx, text, async () => {
        await ctx.reply('✅ Re-authenticated! Placing order now...');
        const data = ctx.getTaskData();
        try {
          await placeAndTrack(ctx, data);
        } catch (placeErr) {
          logger.error(`Order placement failed after re-auth: ${placeErr.message}`);
          await ctx.reply(`❌ Order placement failed: ${placeErr.message}`);
          ctx.completeTask();
        }
      });
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
