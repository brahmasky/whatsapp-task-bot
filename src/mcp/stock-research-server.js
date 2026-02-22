#!/usr/bin/env node

/**
 * Stock Research MCP Server
 *
 * Provides stock research tools for investment analysis.
 * Can be used for portfolio analysis, pre-trade investigation, or general research.
 *
 * Usage:
 *   node src/mcp/stock-research-server.js
 *
 * For Claude Desktop, add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "stock-research": {
 *         "command": "node",
 *         "args": ["/path/to/whatsapp-task-bot/src/mcp/stock-research-server.js"]
 *       }
 *     }
 *   }
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import yahooFinance from 'yahoo-finance2';
import { fetchMarketNews } from '../tasks/portfolio/news.service.js';
import { fetchQuote } from '../shared/yahoo.service.js';

// Singleton yahoo-finance2 instance (handles crumb/cookie auth automatically)
const _yf = new yahooFinance({ suppressNotices: ['yahooSurvey'] });

const YAHOO_MODULES = [
  'assetProfile', 'summaryDetail', 'financialData', 'defaultKeyStatistics',
  'recommendationTrend', 'calendarEvents', 'earningsTrend', 'upgradeDowngradeHistory',
];

/**
 * Fetch company profile and key stats from Yahoo Finance via yahoo-finance2.
 * Uses same modules as fundamentals.service.js for consistency.
 */
async function fetchCompanyProfile(symbol) {
  const result = await _yf.quoteSummary(symbol, { modules: YAHOO_MODULES });

  const profile   = result.assetProfile             || {};
  const summary   = result.summaryDetail            || {};
  const financial = result.financialData            || {};
  const stats     = result.defaultKeyStatistics     || {};
  const recs      = result.recommendationTrend?.trend || [];
  const calendar  = result.calendarEvents?.earnings || {};
  const trend     = result.earningsTrend?.trend     || [];
  const upgrades  = result.upgradeDowngradeHistory?.history || [];

  // Next earnings date — yahoo-finance2 returns real Date objects
  const earningsDates = calendar.earningsDate || [];
  const nextEarningsDate = earningsDates.length > 0
    ? earningsDates[0].toISOString().split('T')[0]
    : null;

  // Forward EPS estimates
  const trendFor = period => trend.find(t => t.period === period) || {};
  const epsCurrentQuarter = trendFor('0q').earningsEstimate?.avg ?? null;
  const epsCurrentYear    = trendFor('0y').earningsEstimate?.avg ?? null;
  const epsNextYear       = trendFor('+1y').earningsEstimate?.avg ?? null;

  // Recent analyst actions (last 5, with price target changes)
  const actionLabel = { up: '↑', down: '↓', main: '→', init: '★', reit: '→' };
  const recentActions = upgrades.slice(0, 5).map(h => ({
    date:          h.epochGradeDate ? new Date(h.epochGradeDate).toISOString().split('T')[0] : null,
    firm:          h.firm        || null,
    action:        actionLabel[h.action] || h.action || null,
    toGrade:       h.toGrade    || null,
    fromGrade:     h.fromGrade  || null,
    currentTarget: h.currentPriceTarget ?? null,
    priorTarget:   h.priorPriceTarget   ?? null,
  }));

  // D/E ratio — divide by 100 (Yahoo returns as percentage)
  const debtToEquity = financial.debtToEquity != null
    ? parseFloat((financial.debtToEquity / 100).toFixed(2))
    : null;

  return {
    symbol,
    company: {
      name:        profile.name,
      sector:      profile.sector,
      industry:    profile.industry,
      website:     profile.website,
      employees:   profile.fullTimeEmployees,
      description: profile.longBusinessSummary?.substring(0, 500),
    },
    valuation: {
      marketCap:     summary.marketCap,
      trailingPE:    summary.trailingPE,
      forwardPE:     summary.forwardPE,
      priceToBook:   summary.priceToBook,
      dividendYield: summary.dividendYield,
      trailingEps:   stats.trailingEps,
    },
    financials: {
      revenue:           financial.totalRevenue,
      revenueGrowth:     financial.revenueGrowth,
      grossMargin:       financial.grossMargins,
      operatingMargin:   financial.operatingMargins,
      profitMargin:      financial.profitMargins,
      returnOnEquity:    financial.returnOnEquity,
      freeCashflow:      financial.freeCashflow,
      debtToEquity,
      currentPrice:      financial.currentPrice,
      targetMeanPrice:   financial.targetMeanPrice,
      recommendationKey: financial.recommendationKey,
    },
    estimates: {
      epsCurrentQuarter,
      epsCurrentYear,
      epsNextYear,
      nextEarningsDate,
    },
    analystRecommendations: recs.slice(0, 2).map(t => ({
      period:     t.period,
      strongBuy:  t.strongBuy,
      buy:        t.buy,
      hold:       t.hold,
      sell:       t.sell,
      strongSell: t.strongSell,
    })),
    recentAnalystActions: recentActions,
  };
}

/**
 * Create and configure the MCP server
 */
function createServer() {
  const server = new McpServer({
    name: 'stock-research',
    version: '1.0.0',
    description: 'Stock research tools for investment analysis and pre-trade investigation',
  });

  // Tool: Get stock news
  server.tool(
    'get_stock_news',
    'Fetch recent news headlines for a stock symbol. Use this to understand recent developments, earnings announcements, or market sentiment.',
    {
      symbol: z.string().describe('The stock ticker symbol (e.g., AAPL, GOOG, TSLA)'),
    },
    async ({ symbol }) => {
      const newsMap = await fetchMarketNews([symbol.toUpperCase()], 1);
      const news = newsMap[symbol.toUpperCase()] || [];

      const result = {
        symbol: symbol.toUpperCase(),
        news,
        message: news.length === 0 ? `No recent news found for ${symbol}` : `Found ${news.length} recent articles`,
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool: Get stock quote
  server.tool(
    'get_stock_quote',
    'Get current stock price, daily change, volume, and 52-week range. Use this for quick price checks.',
    {
      symbol: z.string().describe('The stock ticker symbol (e.g., AAPL, GOOG, TSLA)'),
    },
    async ({ symbol }) => {
      const q = await fetchQuote(symbol.toUpperCase());
      if (q.error) throw new Error(q.error);
      // Preserve existing MCP output shape for Claude Desktop consumers
      const quote = {
        symbol: q.symbol, name: q.name, exchange: q.exchange, currency: q.currency,
        currentPrice: q.price, previousClose: q.previousClose,
        change: q.change, changePercent: q.changePercent != null ? q.changePercent.toFixed(2) + '%' : null,
        dayHigh: q.dayHigh, dayLow: q.dayLow, volume: q.volume, marketCap: q.marketCap,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh, fiftyTwoWeekLow: q.fiftyTwoWeekLow,
      };
      return { content: [{ type: 'text', text: JSON.stringify(quote, null, 2) }] };
    }
  );

  // Tool: Get company profile
  server.tool(
    'get_company_profile',
    'Get detailed company information including sector, financials, valuation metrics, and analyst recommendations. Use this for fundamental analysis before investing.',
    {
      symbol: z.string().describe('The stock ticker symbol (e.g., AAPL, GOOG, TSLA)'),
    },
    async ({ symbol }) => {
      const profile = await fetchCompanyProfile(symbol.toUpperCase());
      return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
    }
  );

  // Tool: Compare stocks
  server.tool(
    'compare_stocks',
    'Compare multiple stocks side by side. Gets quotes for all symbols for comparison.',
    {
      symbols: z.array(z.string()).describe('Array of stock ticker symbols to compare (e.g., ["AAPL", "MSFT", "GOOG"])'),
    },
    async ({ symbols }) => {
      const quotes = await Promise.all(
        symbols.map(symbol => fetchQuote(symbol.toUpperCase()))
      );
      return { content: [{ type: 'text', text: JSON.stringify(quotes, null, 2) }] };
    }
  );

  // Tool: Research stock (comprehensive)
  server.tool(
    'research_stock',
    'Comprehensive stock research: fetches quote, company profile, and recent news in one call. Use this for thorough pre-trade investigation.',
    {
      symbol: z.string().describe('The stock ticker symbol (e.g., AAPL, GOOG, TSLA)'),
    },
    async ({ symbol }) => {
      const upperSymbol = symbol.toUpperCase();

      const [quote, profile, newsMap] = await Promise.all([
        fetchQuote(upperSymbol),
        fetchCompanyProfile(upperSymbol).catch(e => ({ error: e.message })),
        fetchMarketNews([upperSymbol], 1).catch(() => ({})),
      ]);

      const result = {
        symbol: upperSymbol,
        quote,
        profile,
        news: newsMap[upperSymbol] || [],
        fetchedAt: new Date().toISOString(),
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

/**
 * Main entry point
 */
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch(console.error);
