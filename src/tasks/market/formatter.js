/**
 * Market Update Formatter
 *
 * Formats market data into WhatsApp-friendly messages.
 */

import { getMarketStatus, formatDate, getEasternTime } from './calendar.js';

/**
 * Format pre-market update
 */
export function formatPreMarketUpdate(data) {
  const { indices, sectorRotation, portfolio, analysis, news } = data;
  const now = getEasternTime();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  let msg = `📊 *Pre-Market - ${dateStr}*\n\n`;

  // Futures/Indices
  msg += `*Futures*\n`;
  if (indices) {
    for (const [symbol, d] of Object.entries(indices)) {
      const arrow = d.changePercent >= 0 ? '🟢' : '🔴';
      msg += `${arrow} ${d.name}: ${d.changePercent >= 0 ? '+' : ''}${d.changePercent}%\n`;
    }
  }
  msg += '\n';

  // Sector setup
  if (sectorRotation) {
    msg += `*Sector Setup*\n`;
    msg += `Leading: ${sectorRotation.leaders?.map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(' | ')}\n`;
    msg += `Lagging: ${sectorRotation.laggards?.map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(' | ')}\n`;
    msg += `Signal: ${sectorRotation.signalEmoji} ${sectorRotation.signal}\n\n`;
  }

  // Portfolio snapshot
  if (portfolio?.available) {
    msg += `*Portfolio*\n`;
    msg += `Value: $${portfolio.summary.totalValue.toLocaleString()}\n`;

    // Sector alignment warning
    const topSector = portfolio.sectorPerformance?.[0];
    if (topSector && sectorRotation?.laggards?.some(l => l.name === topSector.name)) {
      msg += `⚠️ Heavy in ${topSector.name} (${topSector.weight}%) - lagging sector\n`;
    }
    msg += '\n';
  }

  // News for holdings
  if (news && news.length > 0) {
    msg += `*Headlines*\n`;
    for (const item of news) {
      msg += `• ${item.symbol}: ${item.title}\n`;
    }
    msg += '\n';
  }

  // Insight
  if (analysis?.insight) {
    msg += `💡 *Watch*\n${analysis.insight}`;
  }

  return msg;
}

/**
 * Format post-market update
 */
export function formatPostMarketUpdate(data) {
  const { indices, sectorRotation, portfolio, analysis, comparison, news } = data;
  const now = getEasternTime();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  let msg = `📊 *Market Close - ${dateStr}*\n\n`;

  // Indices
  msg += `*Indices*\n`;
  if (indices) {
    const indexLine = Object.entries(indices)
      .map(([symbol, d]) => {
        const sign = d.changePercent >= 0 ? '+' : '';
        return `${symbol}: ${sign}${d.changePercent}%`;
      })
      .join('  ');
    msg += `${indexLine}\n\n`;
  }

  // Sector rotation
  if (sectorRotation) {
    msg += `*Sectors*\n`;
    msg += `🟢 ${sectorRotation.leaders?.map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(' | ')}\n`;
    msg += `🔴 ${sectorRotation.laggards?.map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(' | ')}\n`;
    msg += `${sectorRotation.signalEmoji} ${sectorRotation.signal}\n\n`;
  }

  // Portfolio
  if (portfolio?.available) {
    msg += `*Portfolio*\n`;
    const sign = portfolio.summary.dayChangePercent >= 0 ? '+' : '';
    msg += `$${portfolio.summary.totalValue.toLocaleString()} (${sign}${portfolio.summary.dayChangePercent}%)\n`;

    // Day change in dollars
    const daySign = portfolio.summary.dayChange >= 0 ? '+' : '';
    msg += `Today: ${daySign}$${Math.abs(portfolio.summary.dayChange).toLocaleString()}\n`;

    // Top movers
    if (portfolio.movers?.gainers?.length > 0 || portfolio.movers?.losers?.length > 0) {
      msg += '\nMovers:\n';
      for (const p of portfolio.movers.gainers.slice(0, 2)) {
        msg += `  🟢 ${p.symbol} +${p.dayChangePercent}%\n`;
      }
      for (const p of portfolio.movers.losers.slice(0, 2)) {
        msg += `  🔴 ${p.symbol} ${p.dayChangePercent}%\n`;
      }
    }

    // vs Market
    if (comparison) {
      const alphaSign = comparison.alpha >= 0 ? '+' : '';
      const result = comparison.outperformed ? 'Outperformed' : 'Lagged';
      msg += `\nvs SPY: ${result} by ${alphaSign}${comparison.alpha}%\n`;
    }
    msg += '\n';
  } else if (portfolio?.reason) {
    msg += `*Portfolio*\n⚠️ ${portfolio.reason}\n\n`;
  }

  // News for movers
  if (news && news.length > 0) {
    msg += `*News*\n`;
    for (const item of news) {
      msg += `• ${item.symbol}: ${item.title}\n`;
    }
    msg += '\n';
  }

  // Insight
  if (analysis?.insight) {
    msg += `💡 ${analysis.insight}`;
  }

  return msg;
}

/**
 * Format weekly summary
 */
export function formatWeeklySummary(data) {
  const { indices, sectorRotation, portfolio, analysis, weeklyStats } = data;
  const now = getEasternTime();
  const weekEnd = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  let msg = `📊 *Weekly Summary - ${weekEnd}*\n\n`;

  // Weekly index performance
  if (weeklyStats?.indices) {
    msg += `*Week Performance*\n`;
    for (const [symbol, d] of Object.entries(weeklyStats.indices)) {
      const sign = d.weekChange >= 0 ? '+' : '';
      msg += `${symbol}: ${sign}${d.weekChange}%\n`;
    }
    msg += '\n';
  }

  // Sector rotation trend
  if (sectorRotation) {
    msg += `*Sector Trend*\n`;
    msg += `Leaders: ${sectorRotation.leaders?.map(s => s.symbol).join(', ')}\n`;
    msg += `Laggards: ${sectorRotation.laggards?.map(s => s.symbol).join(', ')}\n`;
    msg += `Trend: ${sectorRotation.signalEmoji} ${sectorRotation.signal}\n\n`;
  }

  // Portfolio weekly
  if (portfolio?.available && weeklyStats?.portfolio) {
    msg += `*Portfolio Week*\n`;
    msg += `Value: $${portfolio.summary.totalValue.toLocaleString()}\n`;
    const sign = weeklyStats.portfolio.weekChange >= 0 ? '+' : '';
    msg += `Week: ${sign}${weeklyStats.portfolio.weekChange}% (${sign}$${Math.abs(weeklyStats.portfolio.weekChangeDollars).toLocaleString()})\n\n`;
  }

  // Insight
  if (analysis?.insight) {
    msg += `💡 *Outlook*\n${analysis.insight}`;
  }

  return msg;
}

/**
 * Format on-demand market check
 */
export function formatMarketCheck(data) {
  const { indices, sectorRotation, portfolio, analysis, news } = data;
  const now = getEasternTime();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const status = getMarketStatus();

  let msg = `📊 *Market Check - ${timeStr} ET*\n`;
  msg += `Status: ${status}\n\n`;

  // Indices
  if (indices) {
    msg += `*Indices*\n`;
    for (const [symbol, d] of Object.entries(indices)) {
      const sign = d.changePercent >= 0 ? '+' : '';
      msg += `${symbol}: $${d.price?.toFixed(2)} (${sign}${d.changePercent}%)\n`;
    }
    msg += '\n';
  }

  // Sectors (condensed)
  if (sectorRotation) {
    msg += `*Sectors*\n`;
    msg += `🟢 ${sectorRotation.leaders?.slice(0, 2).map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    msg += `🔴 ${sectorRotation.laggards?.slice(0, 2).map(s => `${s.symbol} ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    msg += `${sectorRotation.signalEmoji} ${sectorRotation.signal}\n\n`;
  }

  // Portfolio
  if (portfolio?.available) {
    const sign = portfolio.summary.dayChangePercent >= 0 ? '+' : '';
    msg += `*Portfolio*\n`;
    msg += `$${portfolio.summary.totalValue.toLocaleString()} (${sign}${portfolio.summary.dayChangePercent}%)\n\n`;
  }

  // Breaking news
  if (news && news.length > 0) {
    msg += `*Headlines*\n`;
    for (const item of news.slice(0, 3)) {
      msg += `• ${item.title}\n`;
    }
    msg += '\n';
  }

  // Insight
  if (analysis?.insight) {
    msg += `💡 ${analysis.insight}`;
  }

  return msg;
}

/**
 * Format stale cache warning
 */
export function formatStaleWarning(cacheAge) {
  if (cacheAge.isVeryStale) {
    return `\n\n⚠️ _Portfolio data is ${cacheAge.days.toFixed(0)} days old. Run /portfolio to refresh._`;
  }
  if (cacheAge.isStale) {
    return `\n\n⚠️ _Portfolio data from ${cacheAge.hours.toFixed(0)}h ago._`;
  }
  return '';
}

export default {
  formatPreMarketUpdate,
  formatPostMarketUpdate,
  formatWeeklySummary,
  formatMarketCheck,
  formatStaleWarning,
};
