import Anthropic from '@anthropic-ai/sdk';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

const ANALYSIS_PROMPT = `You are an expert portfolio advisor providing analysis for a retail investor. Analyze the following portfolio data and recent market news to provide actionable insights.

Your analysis should include:

1. **Portfolio Summary**: Brief overview of total value, number of accounts, and position count.

2. **Asset Allocation**: Assess diversification across sectors, asset types, and individual positions. Flag any concentration risks (e.g., single stock >20% of portfolio).

3. **Top Holdings Analysis**: For the top 5 positions by value, briefly comment on each:
   - Current performance (gain/loss %)
   - Recent news impact (if news provided)
   - Any notable concerns or opportunities

4. **Risk Assessment**:
   - Overall portfolio risk level (conservative/moderate/aggressive)
   - Key risk factors to monitor (consider recent news)
   - Any positions with significant losses that may warrant attention

5. **Actionable Recommendations** (3-5 bullet points):
   - Specific, actionable steps the investor could consider
   - Factor in recent news and market developments
   - Be clear about what's a suggestion vs. what needs attention

Keep your response concise and under 3500 characters to fit in a WhatsApp message. Use plain text formatting (no markdown headers, use simple labels instead). Be direct and practical.

IMPORTANT: This is informational only, not financial advice. The investor should consult a licensed financial advisor for personalized recommendations.`;

/**
 * Analyzes portfolio data using Claude API
 *
 * @param {string} portfolioText Formatted portfolio data
 * @param {string} [marketNews] Optional formatted market news
 * @returns {Promise<{analysis: string, usage: {inputTokens: number, outputTokens: number}}>}
 */
export async function analyzePortfolio(portfolioText, marketNews = '') {
  if (!config.claude.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  logger.info('Sending portfolio to Claude for analysis...');

  const client = new Anthropic({
    apiKey: config.claude.apiKey,
  });

  // Build the content with portfolio data and optional news
  let content = `${ANALYSIS_PROMPT}\n\n--- PORTFOLIO DATA ---\n\n${portfolioText}`;

  if (marketNews) {
    content += `\n\n--- ${marketNews}`;
  }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content,
      },
    ],
  });

  const analysisText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  logger.info('Portfolio analysis complete');

  // Extract token usage from response
  const usage = {
    inputTokens: message.usage?.input_tokens || 0,
    outputTokens: message.usage?.output_tokens || 0,
  };

  return {
    analysis: analysisText,
    usage,
  };
}

export default { analyzePortfolio };
