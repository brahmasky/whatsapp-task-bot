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
import { fetchMarketNews } from '../tasks/portfolio/news.service.js';

// Yahoo Finance API (no key required for basic data)
const YAHOO_FINANCE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';

/**
 * Fetch stock quote from Yahoo Finance
 */
async function fetchStockQuote(symbol) {
  const url = `${YAHOO_FINANCE_URL}/${symbol}?interval=1d&range=5d`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch quote for ${symbol}: ${response.status}`);
  }

  const data = await response.json();
  const result = data.chart?.result?.[0];

  if (!result) {
    throw new Error(`No data found for ${symbol}`);
  }

  const meta = result.meta;
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close || [];
  const previousClose = closes[closes.length - 2] || meta.chartPreviousClose;
  const currentPrice = meta.regularMarketPrice;
  const change = currentPrice - previousClose;
  const changePercent = (change / previousClose) * 100;

  return {
    symbol: meta.symbol,
    name: meta.shortName || meta.longName || symbol,
    exchange: meta.exchangeName,
    currency: meta.currency,
    currentPrice,
    previousClose,
    change: change.toFixed(2),
    changePercent: changePercent.toFixed(2) + '%',
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    marketCap: meta.marketCap,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
  };
}

/**
 * Fetch company profile and key stats from Yahoo Finance
 */
async function fetchCompanyProfile(symbol) {
  const modules = 'assetProfile,summaryDetail,financialData,recommendationTrend';
  const url = `${YAHOO_QUOTE_URL}/${symbol}?modules=${modules}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch profile for ${symbol}: ${response.status}`);
  }

  const data = await response.json();
  const result = data.quoteSummary?.result?.[0];

  if (!result) {
    throw new Error(`No profile data found for ${symbol}`);
  }

  const profile = result.assetProfile || {};
  const summary = result.summaryDetail || {};
  const financial = result.financialData || {};
  const recommendations = result.recommendationTrend?.trend || [];

  return {
    symbol,
    company: {
      name: profile.name,
      sector: profile.sector,
      industry: profile.industry,
      website: profile.website,
      employees: profile.fullTimeEmployees,
      description: profile.longBusinessSummary?.substring(0, 500) + '...',
    },
    valuation: {
      marketCap: summary.marketCap?.fmt,
      trailingPE: summary.trailingPE?.fmt,
      forwardPE: summary.forwardPE?.fmt,
      priceToBook: summary.priceToBook?.fmt,
      dividendYield: summary.dividendYield?.fmt,
    },
    financials: {
      revenue: financial.totalRevenue?.fmt,
      revenueGrowth: financial.revenueGrowth?.fmt,
      grossMargin: financial.grossMargins?.fmt,
      operatingMargin: financial.operatingMargins?.fmt,
      profitMargin: financial.profitMargins?.fmt,
      returnOnEquity: financial.returnOnEquity?.fmt,
      debtToEquity: financial.debtToEquity?.fmt,
      currentPrice: financial.currentPrice?.fmt,
      targetMeanPrice: financial.targetMeanPrice?.fmt,
      recommendationKey: financial.recommendationKey,
    },
    analystRecommendations: recommendations.slice(0, 2).map(t => ({
      period: t.period,
      strongBuy: t.strongBuy,
      buy: t.buy,
      hold: t.hold,
      sell: t.sell,
      strongSell: t.strongSell,
    })),
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
      const quote = await fetchStockQuote(symbol.toUpperCase());
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
        symbols.map(async (symbol) => {
          try {
            return await fetchStockQuote(symbol.toUpperCase());
          } catch (error) {
            return { symbol: symbol.toUpperCase(), error: error.message };
          }
        })
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
        fetchStockQuote(upperSymbol).catch(e => ({ error: e.message })),
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
