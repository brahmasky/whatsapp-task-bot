#!/usr/bin/env node

/**
 * E*TRADE MCP Server
 *
 * Exposes E*TRADE portfolio tools via the Model Context Protocol.
 * Can be used by Claude Desktop, WhatsApp bot, or any MCP client.
 *
 * Usage:
 *   node src/mcp/etrade-server.js
 *
 * For Claude Desktop, add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "etrade": {
 *         "command": "node",
 *         "args": ["/path/to/whatsapp-task-bot/src/mcp/etrade-server.js"]
 *       }
 *     }
 *   }
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getAuthenticatedService } from '../shared/etrade.helper.js';

// Cache portfolio data to avoid repeated API calls within a session
let cachedPortfolioData = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sanitize data for JSON serialization (handle NaN, Infinity, undefined)
 */
function sanitizeForJson(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return 0;
    if (value === undefined) return null;
    return value;
  }));
}

/**
 * Get or refresh portfolio data
 */
async function getPortfolioData() {
  // Return cached data if still fresh
  if (cachedPortfolioData && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedPortfolioData;
  }

  const etrade = await getAuthenticatedService();
  cachedPortfolioData = await etrade.fetchPortfolioData();
  cacheTimestamp = Date.now();

  return cachedPortfolioData;
}

/**
 * Create and configure the MCP server
 */
function createServer() {
  const server = new McpServer({
    name: 'etrade',
    version: '1.0.0',
    description: 'E*TRADE portfolio tools for investment analysis',
  });

  // Tool: Get portfolio summary
  server.tool(
    'get_portfolio_summary',
    'Get a high-level summary of the portfolio including total value, number of accounts, and position count.',
    {},
    async () => {
      const portfolioData = await getPortfolioData();
      const allPositions = portfolioData.accounts.flatMap(acc => acc.positions);

      const result = {
        totalValue: portfolioData.totalValue,
        totalValueFormatted: `$${portfolioData.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        accountCount: portfolioData.accounts.length,
        positionCount: allPositions.length,
        accounts: portfolioData.accounts.map(acc => ({
          name: acc.accountName || acc.accountId,
          type: acc.accountType,
          positionCount: acc.positions.length,
        })),
        fetchedAt: portfolioData.fetchedAt,
      };

      return { content: [{ type: 'text', text: JSON.stringify(sanitizeForJson(result), null, 2) }] };
    }
  );

  // Tool: Get all positions
  server.tool(
    'get_all_positions',
    'Get all positions across all accounts with details including symbol, quantity, market value, cost basis, and gain/loss percentage.',
    {},
    async () => {
      const portfolioData = await getPortfolioData();
      const totalValue = portfolioData.totalValue || 1;
      const allPositions = portfolioData.accounts.flatMap(acc => acc.positions);

      const positions = allPositions.map(pos => ({
        symbol: pos.Product?.symbol || pos.symbolDescription || 'Unknown',
        quantity: pos.quantity || 0,
        marketValue: pos.marketValue || 0,
        costBasis: pos.totalCost || 0,
        gainLoss: pos.totalGain || 0,
        gainLossPct: pos.totalGainPct || 0,
        portfolioWeight: ((pos.marketValue || 0) / totalValue * 100).toFixed(2) + '%',
      }));

      return { content: [{ type: 'text', text: JSON.stringify(sanitizeForJson(positions), null, 2) }] };
    }
  );

  // Tool: Get worst performers
  server.tool(
    'get_worst_performers',
    'Get positions with the worst performance (most negative gain/loss %). Useful for identifying problem areas.',
    {
      limit: z.number().optional().default(5).describe('Number of worst performers to return (default: 5)'),
    },
    async ({ limit }) => {
      const portfolioData = await getPortfolioData();
      const allPositions = portfolioData.accounts.flatMap(acc => acc.positions);

      const worstPerformers = allPositions
        .map(pos => ({
          symbol: pos.Product?.symbol || pos.symbolDescription || 'Unknown',
          gainLossPct: pos.totalGainPct || 0,
          gainLoss: pos.totalGain || 0,
          marketValue: pos.marketValue || 0,
        }))
        .filter(p => p.gainLossPct < 0)
        .sort((a, b) => a.gainLossPct - b.gainLossPct)
        .slice(0, limit);

      return { content: [{ type: 'text', text: JSON.stringify(sanitizeForJson(worstPerformers), null, 2) }] };
    }
  );

  // Tool: Get top holdings
  server.tool(
    'get_top_holdings',
    'Get the largest positions by portfolio weight percentage. Useful for concentration analysis.',
    {
      limit: z.number().optional().default(5).describe('Number of top holdings to return (default: 5)'),
    },
    async ({ limit }) => {
      const portfolioData = await getPortfolioData();
      const totalValue = portfolioData.totalValue || 1;
      const allPositions = portfolioData.accounts.flatMap(acc => acc.positions);

      const topHoldings = allPositions
        .map(pos => ({
          symbol: pos.Product?.symbol || pos.symbolDescription || 'Unknown',
          marketValue: pos.marketValue || 0,
          portfolioWeight: ((pos.marketValue || 0) / totalValue * 100).toFixed(2) + '%',
          gainLossPct: pos.totalGainPct || 0,
        }))
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, limit);

      return { content: [{ type: 'text', text: JSON.stringify(sanitizeForJson(topHoldings), null, 2) }] };
    }
  );

  // Tool: Get sector breakdown
  server.tool(
    'get_sector_breakdown',
    'Analyze positions by sector/category to assess diversification. Groups positions and calculates sector weights.',
    {},
    async () => {
      const portfolioData = await getPortfolioData();
      const totalValue = portfolioData.totalValue || 1;
      const allPositions = portfolioData.accounts.flatMap(acc => acc.positions);

      const categories = {
        'Leveraged/Inverse ETFs': [],
        'Sector ETFs': [],
        'Individual Stocks': [],
        'Other': [],
      };

      for (const pos of allPositions) {
        const symbol = pos.Product?.symbol || '';
        const value = pos.marketValue || 0;
        const weight = ((value / totalValue) * 100).toFixed(2);

        const item = { symbol, value, weight: `${weight}%` };

        if (/^(TQQQ|SQQQ|UVXY|UVIX|SPXU|UPRO|TNA|TZA)$/i.test(symbol)) {
          categories['Leveraged/Inverse ETFs'].push(item);
        } else if (/^(XL|IY|VG|SPY|QQQ|IWM|XBI|GLDM|GLD|SLV|USO)/.test(symbol)) {
          categories['Sector ETFs'].push(item);
        } else if (symbol.length <= 5 && /^[A-Z]+$/.test(symbol)) {
          categories['Individual Stocks'].push(item);
        } else {
          categories['Other'].push(item);
        }
      }

      const breakdown = {};
      for (const [category, positions] of Object.entries(categories)) {
        if (positions.length > 0) {
          const totalCatValue = positions.reduce((sum, p) => sum + p.value, 0);
          breakdown[category] = {
            positions,
            totalValue: totalCatValue,
            portfolioWeight: ((totalCatValue / totalValue) * 100).toFixed(2) + '%',
          };
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(sanitizeForJson(breakdown), null, 2) }] };
    }
  );

  // Tool: Refresh portfolio data
  server.tool(
    'refresh_portfolio',
    'Force refresh portfolio data from E*TRADE. Use this if data seems stale.',
    {},
    async () => {
      cachedPortfolioData = null;
      cacheTimestamp = null;

      const portfolioData = await getPortfolioData();

      return {
        content: [{
          type: 'text',
          text: `Portfolio refreshed at ${portfolioData.fetchedAt}. Total value: $${portfolioData.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        }],
      };
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
