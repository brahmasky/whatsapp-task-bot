import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { getETradeClient, getResearchClient } from '../../mcp/client.js';

/**
 * Portfolio Advisor Agent
 *
 * Uses Claude with tool use for dynamic, multi-step portfolio analysis.
 * Tools are provided by MCP servers (E*TRADE and Stock Research).
 */

// Tool definitions for Claude (matching MCP server tools)
const TOOLS = [
  {
    name: 'get_portfolio_summary',
    description: 'Get a high-level summary of the portfolio including total value, number of accounts, and position count.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_all_positions',
    description: 'Get all positions across all accounts with details including symbol, quantity, market value, cost basis, and gain/loss percentage.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_stock_news',
    description: 'Fetch recent news headlines for a specific stock symbol. Use this to understand recent developments affecting a position.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The stock ticker symbol (e.g., AAPL, GOOG, TSLA)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_stock_quote',
    description: 'Get current stock price, daily change, volume, and 52-week range.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The stock ticker symbol (e.g., AAPL, GOOG, TSLA)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_company_profile',
    description: 'Get detailed company information including sector, financials, valuation metrics, and analyst recommendations.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The stock ticker symbol (e.g., AAPL, GOOG, TSLA)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_worst_performers',
    description: 'Get positions with the worst performance (most negative gain/loss %). Useful for identifying problem areas.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of worst performers to return (default: 5)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_top_holdings',
    description: 'Get the largest positions by portfolio weight percentage. Useful for concentration analysis.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of top holdings to return (default: 5)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_sector_breakdown',
    description: 'Analyze positions by sector/category to assess diversification. Groups positions and calculates sector weights.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

const SYSTEM_PROMPT = `You are an expert portfolio advisor helping a retail investor analyze their E*TRADE portfolio.

Your goal is to provide actionable, personalized investment advice based on the user's actual holdings.

Approach:
1. First, get the portfolio summary to understand the overall picture
2. Get all positions to see the full holdings
3. Identify areas of concern (concentration, losses) and investigate with news
4. For positions you want to research deeper, use get_stock_quote and get_company_profile
5. Don't fetch news/quotes for every position - be selective and strategic

Provide your final analysis with:
- Brief portfolio overview
- Key concerns (concentration, major losses, etc.)
- News-informed insights for relevant positions
- 3-5 specific, actionable recommendations

Keep your final response under 3500 characters for WhatsApp. Be direct and practical.

IMPORTANT: This is informational only, not financial advice. Remind the user to consult a licensed financial advisor.`;

// Map tool names to their MCP server
const TOOL_SERVER_MAP = {
  // E*TRADE server tools
  get_portfolio_summary: 'etrade',
  get_all_positions: 'etrade',
  get_worst_performers: 'etrade',
  get_top_holdings: 'etrade',
  get_sector_breakdown: 'etrade',
  refresh_portfolio: 'etrade',
  // Stock Research server tools
  get_stock_news: 'research',
  get_stock_quote: 'research',
  get_company_profile: 'research',
  compare_stocks: 'research',
  research_stock: 'research',
};

/**
 * Execute a tool call via MCP
 */
async function executeTool(toolName, toolInput) {
  const serverType = TOOL_SERVER_MAP[toolName];

  if (!serverType) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const client = serverType === 'etrade'
    ? await getETradeClient()
    : await getResearchClient();

  return await client.callTool(toolName, toolInput);
}

/**
 * Run the portfolio advisor agent
 *
 * @param {Function} onUpdate - Callback for status updates (optional)
 * @returns {Promise<{analysis: string, usage: {inputTokens: number, outputTokens: number}, toolCalls: number}>}
 */
export async function runPortfolioAgent(onUpdate = null) {
  if (!config.claude.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({
    apiKey: config.claude.apiKey,
  });

  // Initial message
  const messages = [
    {
      role: 'user',
      content: 'Please analyze my portfolio and provide actionable investment advice. Start by getting an overview, then dig into areas that need attention.',
    },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  const maxIterations = 15; // Safety limit

  logger.info('Starting portfolio agent loop (using MCP servers)...');

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    // Check if we're done (no more tool use)
    if (response.stop_reason === 'end_turn') {
      const analysisText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      logger.info(`Agent completed after ${toolCallCount} tool calls`);

      return {
        analysis: analysisText,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        },
        toolCalls: toolCallCount,
      };
    }

    // Process tool calls
    if (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const toolInput = block.input;
          toolCallCount++;

          logger.info(`Agent calling MCP tool: ${toolName}`, toolInput);

          if (onUpdate) {
            const serverType = TOOL_SERVER_MAP[toolName] || 'unknown';
            onUpdate(`🔧 [${serverType}] ${toolName}${toolInput.symbol ? `: ${toolInput.symbol}` : ''}`);
          }

          try {
            const result = await executeTool(toolName, toolInput);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (error) {
            logger.error(`Tool ${toolName} failed:`, error.message);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ error: error.message }),
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  throw new Error('Agent exceeded maximum iterations');
}

export default { runPortfolioAgent };
