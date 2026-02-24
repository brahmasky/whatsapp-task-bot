/**
 * /sell Task
 *
 * Place a SELL order for an existing position via E*TRADE.
 *
 * Usage:
 *   /sell UBER                       — start sell flow for UBER
 *
 * After /sell TICKER, send:
 *   sell <qty> <price>               — LIMIT SELL, GFD
 *   sell <qty> market                — MARKET SELL
 *   sell all <price>                 — LIMIT SELL full position, GFD
 *   sell all market                  — MARKET SELL full position
 */

import logger from '../../utils/logger.js';
import { cleanupAuthFlow } from '../../shared/auth.service.js';
import { startReAuth, handleReAuthPin } from '../../shared/reauth.js';
import { placeSellOrder, getPositionQty } from '../../shared/etrade.order.js';

// ─── Param parsing ────────────────────────────────────────────────────────────

// Matches: sell <qty|all> <price|market>
const SELL_REGEX = /^sell\s+(all|\d+(?:\.\d+)?)\s+([\d.]+|market)$/i;

function parseSellParams(text) {
  const m = text.trim().match(SELL_REGEX);
  if (!m) return null;
  const isAll = m[1].toLowerCase() === 'all';
  const isMarket = m[2].toLowerCase() === 'market';
  return {
    isAll,
    isMarket,
    qty: isAll ? null : parseFloat(m[1]),
    limitPrice: isMarket ? null : parseFloat(m[2]),
  };
}

// ─── Order placement ──────────────────────────────────────────────────────────

async function checkAndPlaceSell(ctx, plan) {
  const { symbol, qty, limitPrice } = plan;
  ctx.updateTask('placing_order', plan);

  const priceStr = limitPrice !== null ? `@ $${limitPrice.toFixed(2)} GFD` : '@ MARKET';
  await ctx.reply(`⏳ Placing SELL order: ${qty} ${symbol} ${priceStr}...`);

  try {
    const { orderId } = await placeSellOrder(symbol, qty, limitPrice);
    await ctx.reply(`✅ SELL order placed: #${orderId}\n${qty} ${symbol} ${priceStr}`);
    ctx.completeTask();
  } catch (err) {
    logger.error(`SELL order failed for ${symbol}: ${err.message}`, { stack: err.stack });
    if (err.status === 401) {
      await startReAuth(ctx, 'Your sell plan is saved — order will be placed after re-auth.');
    } else {
      await ctx.reply(`❌ Failed to place SELL order: ${err.message}\n\nTry again or /cancel.`);
      ctx.completeTask();
    }
  }
}

// ─── Task definition ──────────────────────────────────────────────────────────

const sellTask = {
  command: '/sell',
  description: 'Place a SELL order for an existing position. Usage: /sell TICKER',

  async start(ctx, args) {
    const symbol = args?.[0]?.toUpperCase() || '';

    if (!symbol) {
      await ctx.reply('Usage: /sell TICKER\nExample: /sell UBER');
      ctx.completeTask();
      return;
    }

    ctx.updateTask('awaiting_params', { symbol });
    await ctx.reply(
      `Selling *${symbol}*. Enter your sell plan:\n\n` +
      '`sell <qty> <price>`      — limit sell, GFD\n' +
      '`sell <qty> market`       — market sell\n' +
      '`sell all <price>`        — sell full position, limit GFD\n' +
      '`sell all market`         — sell full position at market\n\n' +
      'Example: `sell 50 85.00`'
    );
  },

  async onMessage(ctx, text) {
    const taskState = ctx.getState()?.taskState;
    const data = ctx.getTaskData();

    if (taskState === 'placing_order') {
      await ctx.reply('Order is being placed — please wait.');
      return;
    }

    if (taskState === 'awaiting_pin') {
      await handleReAuthPin(ctx, text, async () => {
        await ctx.reply('✅ Re-authenticated! Placing sell order now...');
        await checkAndPlaceSell(ctx, ctx.getTaskData());
      });
      return;
    }

    if (taskState === 'awaiting_confirmation') {
      const cmd = text.trim().toLowerCase();
      if (cmd === 'confirm') {
        await checkAndPlaceSell(ctx, data);
      } else if (cmd === 'edit') {
        ctx.updateTask('awaiting_params', { symbol: data.symbol });
        await ctx.reply('Enter your sell plan:\n`sell <qty> at <price>` or `sell all at market`');
      } else {
        await ctx.reply('Reply `confirm` to place the order, or `edit` to change.');
      }
      return;
    }

    if (taskState === 'awaiting_params') {
      const { symbol } = data;
      const parsed = parseSellParams(text);
      if (!parsed) {
        await ctx.reply(
          'Could not parse sell plan. Expected:\n' +
          '`sell <qty> <price>`  or  `sell all market`\n\n' +
          'Example: `sell 50 85.00`'
        );
        return;
      }

      let { qty, limitPrice, isAll } = parsed;

      // Resolve "sell all" by fetching position from E*TRADE
      if (isAll) {
        await ctx.reply(`🔍 Fetching position size for ${symbol}...`);
        try {
          const { qty: positionQty } = await getPositionQty(symbol);
          if (!positionQty || positionQty <= 0) {
            await ctx.reply(`No open position found for ${symbol}. Check the ticker or /cancel to abort.`);
            return;
          }
          qty = positionQty;
        } catch (err) {
          if (err.status === 401) {
            await startReAuth(ctx, 'Your sell plan will be ready after re-auth.');
            return;
          }
          await ctx.reply(`❌ Could not fetch position: ${err.message}\n\nTry again or /cancel.`);
          return;
        }
      }

      if (!qty || qty <= 0) {
        await ctx.reply('❌ Quantity must be greater than 0.');
        return;
      }

      const plan = { symbol, qty, limitPrice };
      const priceStr = limitPrice !== null
        ? `@ $${limitPrice.toFixed(2)} GFD. Est. proceeds: $${(qty * limitPrice).toFixed(2)}.`
        : '@ MARKET';

      ctx.updateTask('awaiting_confirmation', plan);
      await ctx.reply(
        `Review sell order:\n` +
        `• SELL ${qty} ${symbol} ${priceStr}\n\n` +
        `Reply \`confirm\` to place, \`edit\` to change.`
      );
      return;
    }

    await ctx.reply('Use /sell TICKER to place a sell order.');
    ctx.completeTask();
  },

  cleanup(ctx) {
    cleanupAuthFlow(ctx.userId);
  },
};

export default sellTask;
