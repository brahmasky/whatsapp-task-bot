/**
 * Deep Market Analyzer
 *
 * Lightweight agent loop for major market events.
 * Uses research MCP tools to investigate what's driving significant moves.
 * Only triggers on extreme days (SPY > 2.5%, etc.) to keep costs low.
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { getResearchClient } from '../../mcp/client.js';

const TOOLS = [
  {
    name: 'get_stock_news',
    description: 'Fetch recent news headlines for a specific stock symbol. Use this to investigate what is driving a move.',
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
    description: 'Get current stock price, daily change, volume, and 52-week range for a specific symbol.',
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
    name: 'research_stock',
    description: 'Comprehensive deep dive on a stock: quote, company profile, and recent news combined.',
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
];

const SYSTEM_PROMPT = `You are investigating a significant market event for a retail investor's WhatsApp update.

All basic market data (indices, sectors, portfolio positions) is provided upfront in the first message. You do NOT need to fetch portfolio data — it's already there.

Use tools ONLY to dig deeper into specific holdings or search for context on what's driving the move. Focus on:
- WHY the market moved (check news for affected sectors/holdings)
- Which portfolio holdings are most impacted and why
- Any specific catalysts (earnings, macro events, policy changes)

Be selective with tool calls — investigate the 2-3 most relevant symbols, not everything.

Provide your final analysis in under 500 characters for WhatsApp. Be direct, specific, and actionable. No disclaimers.`;

const MAX_ITERATIONS = 5;
const MAX_TOKENS_PER_TURN = 1500;

/**
 * Execute a research tool via MCP
 */
async function executeResearchTool(toolName, toolInput) {
  const client = await getResearchClient();
  return await client.callTool(toolName, toolInput);
}

/**
 * Format market data as context for the agent (reuses analyzer pattern)
 */
function formatDataForAgent(data, updateType) {
  const { indices, sectorRotation, portfolio } = data;

  let prompt = `Market Data:\n`;

  if (indices) {
    prompt += `Indices: `;
    prompt += Object.entries(indices)
      .map(([sym, d]) => `${sym} ${d.changePercent > 0 ? '+' : ''}${d.changePercent}%`)
      .join(', ');
    prompt += '\n';
  }

  if (sectorRotation) {
    prompt += `Sector Leaders: ${sectorRotation.leaders?.map(s => `${s.symbol} ${s.changePercent > 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    prompt += `Sector Laggards: ${sectorRotation.laggards?.map(s => `${s.symbol} ${s.changePercent > 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    prompt += `Rotation Signal: ${sectorRotation.signal}\n`;
  }

  if (portfolio?.available) {
    prompt += `\nPortfolio:\n`;
    prompt += `Value: $${portfolio.summary.totalValue.toLocaleString()} (${portfolio.summary.dayChangePercent > 0 ? '+' : ''}${portfolio.summary.dayChangePercent}% today)\n`;

    if (portfolio.movers?.gainers?.length > 0) {
      prompt += `Top Gainers: ${portfolio.movers.gainers.map(p => `${p.symbol} ${p.dayChangePercent > 0 ? '+' : ''}${p.dayChangePercent}%`).join(', ')}\n`;
    }
    if (portfolio.movers?.losers?.length > 0) {
      prompt += `Top Losers: ${portfolio.movers.losers.map(p => `${p.symbol} ${p.dayChangePercent}%`).join(', ')}\n`;
    }

    const topSectors = portfolio.sectorPerformance?.slice(0, 3) || [];
    if (topSectors.length > 0) {
      prompt += `Sector Exposure: ${topSectors.map(s => `${s.name} ${s.weight}%`).join(', ')}\n`;
    }
  }

  prompt += `\nThis is a significant market event. Investigate what's driving the move and provide a ${updateType} insight. Use tools to dig into the most affected holdings.`;

  return prompt;
}

/**
 * Run deep analysis agent loop
 *
 * @param {object} data - Market data (indices, sectors, portfolio, etc.)
 * @param {string} updateType - Type of update (pre-market, post-market, etc.)
 * @returns {Promise<{text: string, tokens: {input: number, output: number}, toolCalls: number} | null>}
 */
export async function runDeepAnalysis(data, updateType) {
  if (!config.claude?.apiKey) {
    logger.warn('Claude API key not configured, skipping deep analysis');
    return null;
  }

  const client = new Anthropic({
    apiKey: config.claude.apiKey,
  });

  const messages = [
    { role: 'user', content: formatDataForAgent(data, updateType) },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;

  logger.info('Starting deep market analysis agent loop...');

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: MAX_TOKENS_PER_TURN,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;

      if (response.stop_reason === 'end_turn') {
        const text = response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');

        logger.info(`Deep analysis completed: ${toolCallCount} tool calls, ${totalInputTokens + totalOutputTokens} tokens`);

        return {
          text,
          tokens: { input: totalInputTokens, output: totalOutputTokens },
          toolCalls: toolCallCount,
        };
      }

      if (response.stop_reason === 'tool_use') {
        const assistantContent = response.content;
        messages.push({ role: 'assistant', content: assistantContent });

        const toolResults = [];

        for (const block of assistantContent) {
          if (block.type === 'tool_use') {
            toolCallCount++;
            logger.info(`Deep analyzer calling: ${block.name}${block.input.symbol ? ` (${block.input.symbol})` : ''}`);

            try {
              const result = await executeResearchTool(block.name, block.input);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
              });
            } catch (error) {
              logger.error(`Tool ${block.name} failed:`, error.message);
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

    logger.warn('Deep analysis hit max iterations');
    return null;
  } catch (error) {
    logger.error('Deep analysis failed:', error.message);
    return null;
  }
}

export default { runDeepAnalysis };
