/**
 * Market Analyzer Service
 *
 * Hybrid approach for market analysis:
 * - Routine days: Template-based (free)
 * - Notable moves: Haiku (fast, cheap)
 * - Major events: Sonnet (smart)
 * - Weekly summaries: Sonnet
 */

import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * Determine analysis level based on market conditions
 */
export function determineAnalysisLevel(data) {
  const { indices, sectorRotation, portfolio } = data;

  // Major market move (SPY > 1.5%)
  const spyMove = Math.abs(indices?.SPY?.changePercent || 0);
  if (spyMove > 1.5) {
    return { level: 'sonnet', reason: `Major market move: SPY ${spyMove > 0 ? '+' : ''}${spyMove.toFixed(1)}%` };
  }

  // Big portfolio swing (> 2%)
  const portfolioMove = Math.abs(portfolio?.summary?.dayChangePercent || 0);
  if (portfolioMove > 2) {
    return { level: 'sonnet', reason: `Large portfolio move: ${portfolioMove > 0 ? '+' : ''}${portfolioMove.toFixed(1)}%` };
  }

  // Strong sector rotation (spread > 3%)
  const spread = sectorRotation?.spread || 0;
  if (spread > 3) {
    return { level: 'haiku', reason: `Strong sector rotation: ${spread.toFixed(1)}% spread` };
  }

  // Notable move (SPY 1-1.5% or portfolio 1-2%)
  if (spyMove > 1 || portfolioMove > 1.5) {
    return { level: 'haiku', reason: 'Notable market activity' };
  }

  // Routine day
  return { level: 'template', reason: 'Routine market day' };
}

/**
 * Generate analysis using Claude
 */
async function generateClaudeAnalysis(data, updateType, model = 'claude-sonnet-4-20250514') {
  if (!config.claude?.apiKey) {
    logger.warn('Claude API key not configured, using template');
    return null;
  }

  const client = new Anthropic({
    apiKey: config.claude.apiKey,
  });

  const systemPrompt = getSystemPrompt(updateType);
  const userPrompt = formatDataForClaude(data, updateType);

  try {
    logger.info(`Generating ${updateType} analysis with ${model}...`);

    const response = await client.messages.create({
      model,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const analysis = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    logger.info(`Analysis generated: ${response.usage?.output_tokens || 0} tokens`);

    return {
      text: analysis,
      tokens: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
      },
    };
  } catch (error) {
    logger.error('Claude analysis failed:', error.message);
    return null;
  }
}

/**
 * Get system prompt based on update type
 */
function getSystemPrompt(updateType) {
  const basePrompt = `You are a concise market analyst providing insights for a retail investor's WhatsApp updates.
Keep responses under 280 characters. Be direct and actionable. No disclaimers needed.`;

  switch (updateType) {
    case 'pre-market':
      return `${basePrompt}
Focus on: What to watch today based on pre-market moves and sector positioning.`;

    case 'post-market':
      return `${basePrompt}
Focus on: Key takeaway from today's session and how the portfolio performed relative to sectors.`;

    case 'weekly':
      return `${basePrompt}
Focus on: Week's rotation trend, portfolio positioning, and one actionable suggestion for next week.
Can be slightly longer (up to 400 chars).`;

    case 'breaking':
      return `${basePrompt}
Focus on: Impact of the news/event on sectors and the specific portfolio. What action, if any, to consider.`;

    default:
      return basePrompt;
  }
}

/**
 * Format market data for Claude prompt
 */
function formatDataForClaude(data, updateType) {
  const { indices, sectorRotation, portfolio } = data;

  let prompt = `Market Data:\n`;

  // Indices
  if (indices) {
    prompt += `Indices: `;
    prompt += Object.entries(indices)
      .map(([sym, d]) => `${sym} ${d.changePercent > 0 ? '+' : ''}${d.changePercent}%`)
      .join(', ');
    prompt += '\n';
  }

  // Sector rotation
  if (sectorRotation) {
    prompt += `Sector Leaders: ${sectorRotation.leaders?.map(s => `${s.symbol} ${s.changePercent > 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    prompt += `Sector Laggards: ${sectorRotation.laggards?.map(s => `${s.symbol} ${s.changePercent > 0 ? '+' : ''}${s.changePercent}%`).join(', ')}\n`;
    prompt += `Rotation Signal: ${sectorRotation.signal}\n`;
  }

  // Portfolio
  if (portfolio?.available) {
    prompt += `\nPortfolio:\n`;
    prompt += `Value: $${portfolio.summary.totalValue.toLocaleString()} (${portfolio.summary.dayChangePercent > 0 ? '+' : ''}${portfolio.summary.dayChangePercent}% today)\n`;

    if (portfolio.movers?.gainers?.length > 0) {
      prompt += `Top Gainers: ${portfolio.movers.gainers.map(p => `${p.symbol} ${p.dayChangePercent > 0 ? '+' : ''}${p.dayChangePercent}%`).join(', ')}\n`;
    }
    if (portfolio.movers?.losers?.length > 0) {
      prompt += `Top Losers: ${portfolio.movers.losers.map(p => `${p.symbol} ${p.dayChangePercent}%`).join(', ')}\n`;
    }

    // Sector exposure
    const topSectors = portfolio.sectorPerformance?.slice(0, 3) || [];
    if (topSectors.length > 0) {
      prompt += `Sector Exposure: ${topSectors.map(s => `${s.name} ${s.weight}%`).join(', ')}\n`;
    }
  }

  prompt += `\nProvide a brief ${updateType} insight:`;

  return prompt;
}

/**
 * Generate template-based insight (no API cost)
 */
function generateTemplateInsight(data) {
  const { indices, sectorRotation, portfolio } = data;

  const spy = indices?.SPY;
  const spyMove = spy?.changePercent || 0;

  // Determine market sentiment
  let sentiment;
  if (spyMove > 0.5) sentiment = 'Positive day';
  else if (spyMove < -0.5) sentiment = 'Negative day';
  else sentiment = 'Quiet day';

  // Rotation comment
  let rotationComment = '';
  if (sectorRotation?.signal?.includes('defensive')) {
    rotationComment = 'Defensive sectors leading.';
  } else if (sectorRotation?.signal?.includes('cyclical')) {
    rotationComment = 'Cyclical sectors leading.';
  }

  // Portfolio comment
  let portfolioComment = '';
  if (portfolio?.available) {
    const portfolioMove = portfolio.summary.dayChangePercent;
    const alpha = portfolioMove - spyMove;

    if (alpha > 0.5) {
      portfolioComment = `Portfolio outperformed SPY by ${alpha.toFixed(1)}%.`;
    } else if (alpha < -0.5) {
      portfolioComment = `Portfolio lagged SPY by ${Math.abs(alpha).toFixed(1)}%.`;
    }
  }

  return `${sentiment}. ${rotationComment} ${portfolioComment}`.trim();
}

/**
 * Main analysis function with hybrid approach
 */
export async function analyzeMarket(data, updateType = 'post-market', forceLevel = null) {
  // Determine analysis level
  const { level, reason } = forceLevel
    ? { level: forceLevel, reason: 'Forced' }
    : determineAnalysisLevel(data);

  logger.info(`Analysis level: ${level} (${reason})`);

  // Weekly always uses Sonnet
  const effectiveLevel = updateType === 'weekly' ? 'sonnet' : level;

  let insight;
  let analysisMethod;

  switch (effectiveLevel) {
    case 'sonnet':
      insight = await generateClaudeAnalysis(data, updateType, 'claude-sonnet-4-20250514');
      analysisMethod = 'claude-sonnet';
      break;

    case 'haiku':
      insight = await generateClaudeAnalysis(data, updateType, 'claude-haiku-3-5-20241022');
      analysisMethod = 'claude-haiku';
      break;

    default:
      insight = { text: generateTemplateInsight(data), tokens: { input: 0, output: 0 } };
      analysisMethod = 'template';
  }

  // Fallback to template if Claude fails
  if (!insight) {
    insight = { text: generateTemplateInsight(data), tokens: { input: 0, output: 0 } };
    analysisMethod = 'template-fallback';
  }

  return {
    insight: insight.text,
    method: analysisMethod,
    level: effectiveLevel,
    reason,
    tokens: insight.tokens,
  };
}

export default {
  determineAnalysisLevel,
  analyzeMarket,
};
