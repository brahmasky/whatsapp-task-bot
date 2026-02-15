/**
 * Market Update Task
 *
 * Provides daily market updates with sector rotation analysis
 * and portfolio context.
 *
 * Commands:
 * - /market - Get current market status and analysis
 * - /market pre - Force pre-market style update
 * - /market post - Force post-market style update
 * - /market weekly - Force weekly summary
 */

import { fetchAllMarketData, analyzeSectorRotation } from './sector.service.js';
import { getLivePortfolioValuation, compareToMarket, getSectorAlignment } from './valuation.service.js';
import { analyzeMarket } from './analyzer.service.js';
import { isMarketDay, getMarketStatus } from './calendar.js';
import {
  formatPreMarketUpdate,
  formatPostMarketUpdate,
  formatWeeklySummary,
  formatMarketCheck,
  formatStaleWarning,
} from './formatter.js';
import { initScheduler, getSchedulerStatus } from './scheduler.js';
import { fetchMarketNews } from '../portfolio/news.service.js';
import logger from '../../utils/logger.js';

/**
 * Generate a market update
 */
export async function generateMarketUpdate(updateType = 'check') {
  logger.info(`Generating ${updateType} market update...`);

  // Fetch market data
  const { sectors, indices } = await fetchAllMarketData();

  // Analyze sector rotation
  const sectorRotation = analyzeSectorRotation(sectors);

  // Get live portfolio valuation
  const portfolio = await getLivePortfolioValuation();

  // Compare to market if portfolio available
  let comparison = null;
  let news = [];
  if (portfolio.available) {
    comparison = await compareToMarket(portfolio.summary.dayChangePercent);

    // Fetch news for top movers (gainers + losers)
    const movers = [
      ...(portfolio.movers?.gainers || []).slice(0, 2),
      ...(portfolio.movers?.losers || []).slice(0, 2),
    ];
    const moverSymbols = movers.map(m => m.symbol);

    if (moverSymbols.length > 0) {
      logger.info(`Fetching news for movers: ${moverSymbols.join(', ')}`);
      const newsMap = await fetchMarketNews(moverSymbols, 4);

      // Flatten news with symbol context
      for (const [symbol, articles] of Object.entries(newsMap)) {
        for (const article of articles.slice(0, 1)) { // 1 headline per stock
          news.push({
            symbol,
            title: article.title,
            source: article.source,
          });
        }
      }
    }
  }

  // Prepare data for analysis
  const data = {
    indices,
    sectors,
    sectorRotation,
    portfolio,
    comparison,
    news,
  };

  // Generate insight (hybrid: template/haiku/sonnet based on conditions)
  const analysis = await analyzeMarket(data, updateType);

  // Add analysis to data
  data.analysis = analysis;

  // Format message based on update type
  let message;
  switch (updateType) {
    case 'pre-market':
      message = formatPreMarketUpdate(data);
      break;
    case 'post-market':
      message = formatPostMarketUpdate(data);
      break;
    case 'weekly':
      message = formatWeeklySummary(data);
      break;
    default:
      message = formatMarketCheck(data);
  }

  // Add stale cache warning if needed
  if (portfolio.cacheAge) {
    message += formatStaleWarning(portfolio.cacheAge);
  }

  return message;
}

/**
 * Task definition for /market command
 */
export default {
  command: '/market',
  description: 'Get market update with sector rotation and portfolio context',

  async start(ctx, args) {
    try {
      // Parse arguments
      const arg = args?.[0]?.toLowerCase();

      let updateType = 'check';
      if (arg === 'pre' || arg === 'premarket') {
        updateType = 'pre-market';
      } else if (arg === 'post' || arg === 'postmarket') {
        updateType = 'post-market';
      } else if (arg === 'weekly' || arg === 'week') {
        updateType = 'weekly';
      } else if (arg === 'status') {
        // Show scheduler status
        const status = getSchedulerStatus();
        let statusMsg = `*Market Scheduler Status*\n\n`;
        statusMsg += `Active: ${status.active ? 'Yes' : 'No'}\n`;
        statusMsg += `Jobs: ${status.jobs}\n\n`;

        if (status.nextRuns?.length > 0) {
          statusMsg += `*Next Updates (local time)*\n`;
          for (const run of status.nextRuns) {
            const time = new Date(run.time).toLocaleString('en-AU', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            });
            statusMsg += `${run.type}: ${time}\n`;
          }
        }

        await ctx.reply(statusMsg);
        ctx.completeTask();
        return;
      }

      await ctx.reply('Fetching market data...');

      const message = await generateMarketUpdate(updateType);

      await ctx.reply(message);
    } catch (error) {
      logger.error('Market update failed:', error.message);
      await ctx.reply(`Error getting market update: ${error.message}`);
    }

    ctx.completeTask();
  },

  async onMessage(ctx, text) {
    await ctx.reply('Use /market to get an update, or /market status to check scheduler.');
    ctx.completeTask();
  },
};

// Export for scheduler and other modules
export { initScheduler, getSchedulerStatus };
