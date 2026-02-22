/**
 * /research Task
 *
 * Runs a Sonnet agent loop to score a stock 0-100 and produce a
 * structured recommendation. Usage: /research AAPL
 */

import logger from '../../utils/logger.js';
import { fetchFundamentals } from './fundamentals.service.js';
import { runResearchAgent } from './agent.service.js';

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

// ─── Task definition ──────────────────────────────────────────────────────────

const researchTask = {
  command: '/research',
  description: 'Score a stock 0-100 with AI analysis. Usage: /research AAPL',

  async start(ctx, args) {
    const symbol = args?.[0]?.toUpperCase() || '';

    if (!symbol) {
      await ctx.reply('Usage: /research TICKER\nExample: /research AAPL');
      ctx.completeTask();
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
      logger.info(`${symbol} scored ${analysis.score}/100 (${analysis.recommendation}) via ${analysis.toolCalls} tool calls`);
    } else {
      scoreText = '\n_Analysis unavailable — Claude API key required for scoring._';
    }

    await ctx.reply(`${header}${fundamentalsText}${scoreText}`);
    ctx.completeTask();
  },

  async onMessage(ctx) {
    await ctx.reply('Use /research TICKER for a new research report.');
  },
};

export default researchTask;
