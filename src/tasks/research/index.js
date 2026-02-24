/**
 * /research Task
 *
 * Runs a Sonnet agent loop to score a stock 0-100 and produce a
 * structured recommendation. Usage: /research AAPL
 */

import logger from '../../utils/logger.js';
import { replyLong } from '../../utils/message.js';
import { fetchFundamentals } from './fundamentals.service.js';
import { runResearchAgent } from './agent.service.js';
import { compareSymbols, formatCompareTable } from '../../shared/compare.service.js';
import { addPendingFill } from '../trade/alert.manager.js';
import { placeBuyOrder, calcQty, checkCashBalance, refreshPortfolioCache } from '../../shared/etrade.order.js';
import { cleanupAuthFlow } from '../../shared/auth.service.js';
import { startReAuth, handleReAuthPin } from '../../shared/reauth.js';
import { load, save, listKeys } from '../../utils/persistence.service.js';
import config from '../../config/index.js';

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toFixed(decimals);
}

function fmtBig(n) {
  if (n == null || isNaN(n)) return 'N/A';
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtUpside(price, target) {
  if (!price || !target) return '';
  const pct = ((target - price) / price) * 100;
  return ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
}

/** Render a 5-block progress bar, e.g. score 14/25 → "███░░" */
function scoreBar(score, max = 25) {
  const filled = Math.round((score / max) * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

/** Star rating out of 5 based on 0-100 score */
function starRating(score) {
  const stars = Math.round(score / 20);
  return '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
}

function formatFundamentals(f) {
  const lines = [];

  if (f.price != null) {
    const sign = f.changePercent >= 0 ? '+' : '';
    const hi = f.fiftyTwoWeekHigh != null ? `$${fmt(f.fiftyTwoWeekHigh, 2)}` : 'N/A';
    const lo = f.fiftyTwoWeekLow != null ? `$${fmt(f.fiftyTwoWeekLow, 2)}` : 'N/A';
    lines.push(`*Price*`);
    lines.push(`$${fmt(f.price, 2)} (${sign}${fmt(f.changePercent, 1)}%) | 52w: ${lo}–${hi}`);
    lines.push('');
  }

  const hasValuation = f.trailingPE != null || f.forwardPE != null;
  if (hasValuation) {
    lines.push(`*Valuation*`);
    lines.push(`P/E: ${fmt(f.trailingPE)} | Fwd P/E: ${fmt(f.forwardPE)} | P/B: ${fmt(f.priceToBook)}`);
    lines.push(`EPS: ${f.trailingEps != null ? '$' + fmt(f.trailingEps, 2) : 'N/A'} | Beta: ${fmt(f.beta, 2)}`);
    lines.push('');
  }

  const hasFinancials = f.totalRevenue != null || f.profitMargins != null;
  if (hasFinancials) {
    lines.push(`*Financials (TTM)*`);
    lines.push(`Revenue: ${fmtBig(f.totalRevenue)} | Gross Margin: ${fmtPct(f.grossMargins)}`);
    lines.push(`Net Margin: ${fmtPct(f.profitMargins)} | ROE: ${fmtPct(f.returnOnEquity)} | FCF: ${fmtBig(f.freeCashflow)}`);
    if (f.debtToEquity != null || f.currentRatio != null) {
      lines.push(`D/E: ${fmt(f.debtToEquity, 2)} | Current Ratio: ${fmt(f.currentRatio, 2)}`);
    }
    lines.push('');
  }

  // Forward EPS estimates + next earnings date
  const hasEstimates = f.epsEstimateCurrentQuarter != null || f.epsEstimateCurrentYear != null || f.nextEarningsDate != null;
  if (hasEstimates) {
    lines.push(`*Estimates*`);
    const epsParts = [
      f.epsEstimateCurrentQuarter != null ? `EPS (Q): $${fmt(f.epsEstimateCurrentQuarter, 2)}` : null,
      f.epsEstimateCurrentYear    != null ? `EPS (FY): $${fmt(f.epsEstimateCurrentYear, 2)}`   : null,
      f.epsEstimateNextYear       != null ? `EPS (+1Y): $${fmt(f.epsEstimateNextYear, 2)}`      : null,
    ].filter(Boolean);
    if (epsParts.length) lines.push(epsParts.join(' | '));
    if (f.nextEarningsDate) {
      const d = new Date(f.nextEarningsDate);
      lines.push(`Next earnings: ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
    }
    lines.push('');
  }

  if (f.targetMeanPrice != null) {
    lines.push(`*Analyst View*`);
    lines.push(`Target: $${fmt(f.targetMeanPrice, 2)}${fmtUpside(f.price, f.targetMeanPrice)}`);
    if (f.targetLowPrice != null && f.targetHighPrice != null) {
      lines.push(`Range: $${fmt(f.targetLowPrice, 2)} – $${fmt(f.targetHighPrice, 2)}`);
    }
    const consensus = [
      f.buyCount ? `${f.buyCount} Buy` : null,
      f.holdCount ? `${f.holdCount} Hold` : null,
      f.sellCount ? `${f.sellCount} Sell` : null,
    ].filter(Boolean).join(' / ');
    if (consensus) lines.push(consensus);
    lines.push('');
  }

  // Recent analyst upgrades/downgrades (last 3, with price target changes)
  if (f.recentUpgrades?.length > 0) {
    lines.push(`*Recent Actions*`);
    const actionWord = { '↑': '↑', '↓': '↓', '★': 'Init', '→': '→' };
    f.recentUpgrades.slice(0, 3).forEach(u => {
      let line = `${u.firm}: ${actionWord[u.action] || u.action} ${u.toGrade}`;
      if (u.currentTarget != null && u.priorTarget != null) {
        const pct = (((u.currentTarget - u.priorTarget) / u.priorTarget) * 100).toFixed(0);
        line += ` | $${u.priorTarget}→$${u.currentTarget} (${pct >= 0 ? '+' : ''}${pct}%)`;
      } else if (u.currentTarget != null) {
        line += ` | PT $${u.currentTarget}`;
      }
      lines.push(line);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function formatEntryPlan(plan, currentPrice) {
  if (!plan) return '';
  const { entryLow, entryHigh, takeProfit, stopLoss, rrRatio, notes } = plan;
  if (entryLow == null && entryHigh == null) return '';

  const midEntry = (entryLow != null && entryHigh != null) ? (entryLow + entryHigh) / 2 : (entryLow ?? entryHigh);
  const tpUpside = (takeProfit && midEntry) ? ((takeProfit - midEntry) / midEntry * 100) : null;
  const slDown   = (stopLoss  && midEntry) ? ((midEntry - stopLoss)  / midEntry * 100) : null;

  const lines = ['', '*Entry Plan*'];
  lines.push(`Zone:  $${fmt(entryLow, 2)} – $${fmt(entryHigh, 2)}`);
  if (takeProfit != null) lines.push(`TP:    $${fmt(takeProfit, 2)}${tpUpside != null ? ` (+${fmt(tpUpside, 1)}%)` : ''}`);
  if (stopLoss   != null) lines.push(`SL:    $${fmt(stopLoss,   2)}${slDown   != null ? ` (-${fmt(slDown,   1)}%)` : ''}`);
  if (rrRatio    != null) lines.push(`R/R:   ${rrRatio.toFixed(1)}:1`);
  if (notes)              lines.push(`📝 ${notes}`);
  return lines.join('\n');
}

function formatScore(analysis) {
  const { score, valuation, quality, momentum, sentiment, recommendation, summary } = analysis;

  const lines = [
    `*Score: ${score}/100* ${starRating(score)}`,
    '',
    `Valuation  ${scoreBar(valuation.score)}  ${valuation.score}/25`,
    `Quality    ${scoreBar(quality.score)}  ${quality.score}/25`,
    `Momentum   ${scoreBar(momentum.score)}  ${momentum.score}/25`,
    `Sentiment  ${scoreBar(sentiment.score)}  ${sentiment.score}/25`,
    '',
    `*Recommendation: ${recommendation}*`,
    '',
    summary,
  ];

  return lines.join('\n');
}

function formatCachedReport(cached) {
  let text = `🔍 *${cached.symbol}* (cached)\n\n` + formatScore(cached);
  if (cached.entryPlan) {
    text += formatEntryPlan(cached.entryPlan, null);
  }
  return text;
}

// ─── Task definition ──────────────────────────────────────────────────────────

const researchTask = {
  command: '/research',
  description: 'Score a stock 0-100 with AI analysis. Usage: /research AAPL',

  async start(ctx, args) {
    const rawSymbol = args?.[0]?.toUpperCase() || '';

    if (!rawSymbol) {
      await ctx.reply('Usage: /research TICKER\nExample: /research AAPL\n\nOther:\n  /research list — show cached reports\n  /research compare AAPL GOOGL — compare multiple stocks\n  /research AAPL refresh — force fresh fetch');
      ctx.completeTask();
      return;
    }

    // /research compare AAPL GOOGL MSFT
    if (rawSymbol === 'COMPARE') {
      const symbols = args.slice(1).map(s => s.toUpperCase()).filter(Boolean);
      if (symbols.length < 2) {
        await ctx.reply('Usage: /research compare AAPL GOOGL [MSFT AMZN NVDA]\nCompares up to 5 stocks.');
        ctx.completeTask();
        return;
      }
      await ctx.reply(`Comparing ${symbols.join(', ')}... (may take ~${symbols.length * 8}s)`);
      const results = await compareSymbols(symbols);
      const table = formatCompareTable(results);
      await ctx.reply(`Comparison (${symbols.length} stocks):\n\n${table}\n\n[c]=cached [f]=fresh`);
      ctx.completeTask();
      return;
    }

    // /research list
    if (rawSymbol === 'LIST') {
      const keys = listKeys('research-cache');
      if (keys.length === 0) {
        await ctx.reply('No cached research.');
        ctx.completeTask();
        return;
      }
      const rows = keys.map(k => {
        const c = load('research-cache/' + k);
        if (!c) return null;
        const age = Math.floor((Date.now() - c.cachedAt) / 3600000);
        const ageStr = age < 24 ? `${age}h` : `${Math.floor(age / 24)}d`;
        const rec = (c.recommendation ?? 'N/A').padEnd(11);
        return `${k.padEnd(6)} ${String(c.score ?? '?').padStart(3)}/100  ${rec} ${ageStr}`;
      }).filter(Boolean);
      await ctx.reply(`Research Cache (${rows.length}):\n\n${rows.join('\n')}`);
      ctx.completeTask();
      return;
    }

    const symbol = rawSymbol;
    const forceRefresh = args.slice(1).some(a => a.toLowerCase() === 'refresh');

    // Check cache
    const CACHE_TTL = 24 * 60 * 60 * 1000;
    const cached = !forceRefresh && load('research-cache/' + symbol);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
      const ageH = Math.floor((Date.now() - cached.cachedAt) / 3600000);
      await replyLong(ctx.reply.bind(ctx), `[cached ${ageH}h ago]\n\n` + formatCachedReport(cached));

      if (cached.entryPlan && ['BUY', 'STRONG BUY'].includes(cached.recommendation)) {
        ctx.updateTask('awaiting_trade', { symbol, entryPlan: cached.entryPlan });
        const { entryLow: _l, entryHigh: _h } = cached.entryPlan;
        const _goldenPrice = parseFloat((_l + (_h - _l) * 0.618).toFixed(2));
        await ctx.reply(
          `💡 Reply \`trade <budget>\` to place a GFD BUY LIMIT at $${_goldenPrice.toFixed(2)} (zone $${_l.toFixed(2)}–$${_h.toFixed(2)}, e.g. \`trade 1000\`)\n` +
          `or \`trade qty <shares>\` for a fixed quantity.\n` +
          `Type \`skip\` to dismiss. Use \`/research ${symbol} refresh\` for fresh data.`
        );
      } else {
        ctx.completeTask();
      }
      return;
    }

    await ctx.reply(`🔍 Researching ${symbol}...`);

    const fundamentals = await fetchFundamentals(symbol);

    if (fundamentals.error) {
      await ctx.reply(`Failed to fetch data for ${symbol}: ${fundamentals.error}`);
      ctx.completeTask();
      return;
    }

    // Header
    const header = [
      `🔍 *${symbol} - ${fundamentals.longName || symbol}*`,
      [fundamentals.sector, fundamentals.industry].filter(Boolean).join(' | '),
      '',
    ].join('\n');

    // Fundamentals section
    const fundamentalsText = formatFundamentals(fundamentals);

    // Agent loop — produces score + recommendation
    const analysis = await runResearchAgent(symbol, fundamentals);

    let scoreText = '';
    if (analysis) {
      scoreText = '\n' + formatScore(analysis);
      if (analysis.entryPlan) {
        scoreText += formatEntryPlan(analysis.entryPlan, fundamentals.price);
      }
      logger.info(`${symbol} scored ${analysis.score}/100 (${analysis.recommendation}) via ${analysis.toolCalls} tool calls${analysis.entryPlan ? ' [entry plan included]' : ''}`);

      // Save to cache
      save('research-cache/' + symbol, {
        symbol,
        score: analysis.score,
        valuation: analysis.valuation,
        quality: analysis.quality,
        momentum: analysis.momentum,
        sentiment: analysis.sentiment,
        recommendation: analysis.recommendation,
        summary: analysis.summary,
        entryPlan: analysis.entryPlan ?? null,
        cachedAt: Date.now(),
      });
    } else {
      scoreText = '\n_Analysis unavailable — Claude API key required for scoring._';
    }

    await replyLong(ctx.reply.bind(ctx), `${header}${fundamentalsText}${scoreText}`);

    // Keep task alive so user can set an alert inline on BUY/STRONG BUY
    if (analysis?.entryPlan && ['BUY', 'STRONG BUY'].includes(analysis.recommendation)) {
      ctx.updateTask('awaiting_trade', { symbol, entryPlan: analysis.entryPlan });
      const { entryLow: _l, entryHigh: _h } = analysis.entryPlan;
      const _goldenPrice = parseFloat((_l + (_h - _l) * 0.618).toFixed(2));
      await ctx.reply(
        `💡 Reply \`trade <budget>\` to place a GFD BUY LIMIT at $${_goldenPrice.toFixed(2)} (golden ratio of zone $${_l.toFixed(2)}–$${_h.toFixed(2)}, e.g. \`trade 1000\`)\n` +
        `or \`trade qty <shares>\` for a fixed quantity.\n` +
        `Type \`skip\` to dismiss.`
      );
    } else {
      ctx.completeTask();
    }
  },

  async onMessage(ctx, text) {
    const taskState = ctx.getState()?.taskState;

    // ── PIN handler (re-auth flow) ────────────────────────────────────────────
    if (taskState === 'awaiting_pin') {
      await handleReAuthPin(ctx, text, async () => {
        await ctx.reply('✅ Re-authenticated! Placing order now...');
        await _placeResearchOrder(ctx, ctx.getTaskData());
      });
      return;
    }

    // ── Trade setup handler ───────────────────────────────────────────────────
    if (taskState !== 'awaiting_trade') {
      await ctx.reply('Use /research TICKER for a new research report.');
      ctx.completeTask();
      return;
    }

    const { symbol, entryPlan } = ctx.getTaskData();
    const lower = text.toLowerCase().trim();

    // Dismiss
    if (lower === 'skip' || lower === 'cancel') {
      await ctx.reply('Alert dismissed.');
      ctx.completeTask();
      return;
    }

    // trade <budget>  or  trade qty <shares>
    const budgetMatch = lower.match(/^trade\s+([\d.]+)$/);
    const qtyMatch    = lower.match(/^trade\s+qty\s+(\d+)$/i);

    if (!budgetMatch && !qtyMatch) {
      await ctx.reply(
        'Reply `trade <budget>` to place a GFD BUY LIMIT (e.g. `trade 1000`),\n' +
        'or `trade qty <shares>` for a fixed quantity.\n' +
        'Type `skip` to dismiss.'
      );
      return;
    }

    const budget   = budgetMatch ? parseFloat(budgetMatch[1]) : null;
    const fixedQty = qtyMatch    ? parseInt(qtyMatch[1], 10)  : null;

    const { entryLow, entryHigh, takeProfit, stopLoss } = entryPlan;
    const limitPrice = parseFloat((entryLow + (entryHigh - entryLow) * 0.618).toFixed(2));
    const qty = fixedQty ?? calcQty(budget, limitPrice);

    if (qty <= 0) {
      await ctx.reply(
        `❌ Budget $${budget?.toFixed(2)} is less than the limit price $${limitPrice.toFixed(2)}.\n` +
        `Minimum budget: $${limitPrice.toFixed(2)} for 1 share. Try again or type \`skip\` to dismiss.`
      );
      return;
    }

    // Save plan before any API calls — needed for re-auth retry
    const plan = { symbol, entryLow, entryHigh, takeProfit, stopLoss, limitPrice, qty, budget };
    ctx.updateTask('placing_order', plan);

    // Cash balance check — treat 401 same as order placement 401
    try {
      const { cash, cost, sufficient } = await checkCashBalance(qty, limitPrice);
      if (!sufficient) {
        const maxShares = Math.floor(cash / limitPrice);
        const suggestion = maxShares > 0
          ? `Try \`trade qty ${maxShares}\` (${maxShares} shares @ $${limitPrice.toFixed(2)}) or type \`skip\` to dismiss.`
          : 'Insufficient cash for even 1 share. Type `skip` to dismiss.';
        await ctx.reply(
          `⚠️ *Insufficient cash — order not placed.*\n\n` +
          `Order cost:      $${cost.toFixed(2)} (${qty} × $${limitPrice.toFixed(2)})\n` +
          `Cash available:  $${cash.toFixed(2)}\n` +
          `Shortfall:       $${(cost - cash).toFixed(2)}\n\n` +
          suggestion
        );
        ctx.updateTask('awaiting_trade', { symbol, entryPlan });
        return;
      }
    } catch (err) {
      if (err.status === 401) {
        await startReAuth(ctx, REAUTH_NOTE);
        return;
      }
      logger.warn(`Cash balance check failed for ${symbol}: ${err.message} — proceeding`);
      await ctx.reply(`⚠️ Could not verify cash balance (${err.message}) — proceeding with order.`);
    }

    await _placeResearchOrder(ctx, plan);
  },

  cleanup(ctx) {
    cleanupAuthFlow(ctx.userId);
  },
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const REAUTH_NOTE = 'Your trade plan is saved — order will be placed after re-auth.';

async function _placeResearchOrder(ctx, plan) {
  const { symbol, entryLow, entryHigh, takeProfit, stopLoss, limitPrice, qty, budget } = plan;

  await ctx.reply(`⏳ Placing BUY LIMIT order for ${symbol}...`);

  try {
    const { buyOrderId, accountIdKey, verification } = await placeBuyOrder(symbol, qty, limitPrice, 'GOOD_FOR_DAY');

    const tag = config.etrade?.sandbox ? ' [🧪 SANDBOX]' : '';
    const v = verification?.[String(buyOrderId)];
    const idStr = buyOrderId ? ` — #${buyOrderId}` : '';
    const statusStr = v?.found ? ` ✓ ${v.status}` : buyOrderId ? ' ⚠️ unverified' : '';
    const sizeDesc = budget != null ? `$${budget.toFixed(2)} budget` : `${qty} shares`;

    addPendingFill({ symbol, userId: ctx.userId, buyOrderId, accountIdKey, qty, takeProfit, stopLoss, limitPrice, buyLow: entryLow, buyHigh: entryHigh, budget });
    refreshPortfolioCache().catch(err => logger.warn(`Post-BUY cache refresh failed: ${err.message}`));

    await ctx.reply(
      `✅ BUY LIMIT set for *${symbol}*${tag}\n` +
      `📈 Entry: ≤$${limitPrice.toFixed(2)} (zone $${entryLow.toFixed(2)}–$${entryHigh.toFixed(2)})\n` +
      `🎯 Take profit: $${takeProfit.toFixed(2)}\n` +
      `🛑 Stop loss: $${stopLoss.toFixed(2)}\n` +
      `💰 ${sizeDesc} → ${qty} shares\n` +
      `Order${idStr}${statusStr} active GFD — monitoring for fill.`
    );
    ctx.completeTask();
  } catch (err) {
    if (err.status === 401) {
      await startReAuth(ctx, REAUTH_NOTE);
    } else {
      logger.error(`Research inline trade failed for ${symbol}: ${err.message}`);
      await ctx.reply(`❌ Order placement failed: ${err.message}`);
      ctx.completeTask();
    }
  }
}

export default researchTask;
