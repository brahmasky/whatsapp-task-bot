/**
 * Research Agent Service
 *
 * Runs a Sonnet agent loop to score a stock 0-100 across four dimensions:
 *   Valuation | Quality | Momentum | Sentiment
 *
 * The agent receives pre-loaded fundamentals and can call get_news to
 * investigate recent catalysts before producing its final scored analysis.
 *
 * Cost: ~$0.05/call (Sonnet × 3 turns)
 */

import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { fetchMarketNews } from '../portfolio/news.service.js';
import { runAgentLoop } from '../../shared/agent.service.js';

const MAX_ITERATIONS = 4;
const MAX_TOKENS_PER_TURN = 2000;

const TOOLS = [
  {
    name: 'get_news',
    description: 'Fetch recent news headlines for a stock symbol or search query. Use this to check for recent earnings, catalysts, or sentiment shifts.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The stock ticker symbol to fetch news for (e.g. AAPL)',
        },
      },
      required: ['symbol'],
    },
  },
];

const SYSTEM_PROMPT = `You are a quantitative equity analyst scoring a stock for a retail investor.

## Scratchpad (required every turn)
Start EVERY response with a <scratchpad> block. Use it to track your reasoning and lock in scores as you gain confidence:

<scratchpad>
VALUATION: [score/25] [LOCKED|PENDING] — reason
QUALITY:   [score/25] [LOCKED|PENDING] — reason
MOMENTUM:  [score/25] [LOCKED|PENDING] — reason
SENTIMENT: [score/25] [LOCKED|PENDING] — reason
Next: what I still need to do (or "ready to finalise")
</scratchpad>

Rules:
- Mark a dimension [LOCKED] once you have enough data to score it confidently
- Mark [PENDING] when you need more information (e.g. news not yet fetched)
- You may revise a [LOCKED] score if new evidence warrants it — note the revision
- SENTIMENT must stay [PENDING] until you have called get_news at least once

## Scoring dimensions (0-25 each)
- Valuation: P/E vs sector norms, P/B, discount/premium to analyst target. If data is N/A, score 12 (neutral) — missing data is not a bearish signal.
- Quality: profit margins, ROE, FCF generation, balance sheet strength. If data is N/A, score 12 (neutral).
- Momentum: price position in 52-week range AND recent price action. IMPORTANT: being near the 52-week low on a profitable, established company may indicate a value entry point — weigh this carefully rather than treating it as automatically bearish.
- Sentiment: news tone and recency of catalysts ONLY — do not reuse analyst counts already in Valuation

## Entry plan (BUY / STRONG BUY only)
When recommendation is BUY or STRONG BUY, include an entryPlan in the JSON output.

Guidelines:
- entryLow / entryHigh: use recent 7-day support as the floor; prefer pullback entries, not chasing
- takeProfit: analyst mean target is the primary reference; adjust down if earnings imminent and stock may gap
- stopLoss: place below the most recent meaningful support (7-day low or 52w low, whichever is tighter); keep risk defined
- rrRatio: (takeProfit − midEntry) / (midEntry − stopLoss), rounded to 1 decimal — aim for ≥ 2.0
- notes: flag upcoming earnings, notable target cuts/raises from recent actions, or any timing caution

## Final output
When all four dimensions are [LOCKED], output the final result as JSON immediately after your scratchpad — no markdown fences, no extra text:
{
  "score": <0-100>,
  "valuation": {"score": <0-25>, "reason": "<brief>"},
  "quality": {"score": <0-25>, "reason": "<brief>"},
  "momentum": {"score": <0-25>, "reason": "<brief>"},
  "sentiment": {"score": <0-25>, "reason": "<brief>"},
  "recommendation": "<STRONG BUY | BUY | HOLD | SELL | STRONG SELL>",
  "summary": "<2-3 sentence investment thesis>",
  "entryPlan": {
    "entryLow": <price or null>,
    "entryHigh": <price or null>,
    "takeProfit": <price or null>,
    "stopLoss": <price or null>,
    "rrRatio": <number or null>,
    "notes": "<timing notes, earnings caution, etc.>"
  }
}
Omit entryPlan entirely (do not include the key) when recommendation is HOLD, SELL, or STRONG SELL.`;

function formatFundamentalsForAgent(symbol, f) {
  const pct = n => (n == null ? 'N/A' : `${(n * 100).toFixed(1)}%`);
  const num = (n, d = 1) => (n == null ? 'N/A' : n.toFixed(d));
  const big = n => {
    if (n == null) return 'N/A';
    if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toFixed(0)}`;
  };

  const upside = f.price && f.targetMeanPrice
    ? `${(((f.targetMeanPrice - f.price) / f.price) * 100).toFixed(1)}%`
    : 'N/A';

  const targetStr = f.targetMeanPrice
    ? `$${num(f.targetMeanPrice, 2)} (${upside} upside)${f.targetLowPrice && f.targetHighPrice ? ` | Range: $${num(f.targetLowPrice, 2)}–$${num(f.targetHighPrice, 2)}` : ''}`
    : 'N/A';

  const rangePos = f.price && f.fiftyTwoWeekHigh && f.fiftyTwoWeekLow
    ? `${(((f.price - f.fiftyTwoWeekLow) / (f.fiftyTwoWeekHigh - f.fiftyTwoWeekLow)) * 100).toFixed(0)}% of 52w range`
    : 'N/A';

  const earningsDateStr = f.nextEarningsDate
    ? new Date(f.nextEarningsDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'N/A';

  const epsEstimates = [
    f.epsEstimateCurrentQuarter != null ? `CQ: $${num(f.epsEstimateCurrentQuarter, 2)}` : null,
    f.epsEstimateCurrentYear    != null ? `CY: $${num(f.epsEstimateCurrentYear, 2)}`    : null,
    f.epsEstimateNextYear       != null ? `NY: $${num(f.epsEstimateNextYear, 2)}`       : null,
  ].filter(Boolean).join(' | ') || 'N/A';

  const upgradesStr = f.recentUpgrades?.length > 0
    ? f.recentUpgrades.slice(0, 5).map(u => {
        let line = `${u.date}: ${u.firm} ${u.action} ${u.toGrade}${u.fromGrade ? ` (from ${u.fromGrade})` : ''}`;
        if (u.currentTarget != null && u.priorTarget != null) {
          const pct = (((u.currentTarget - u.priorTarget) / u.priorTarget) * 100).toFixed(0);
          line += ` | Target: $${u.priorTarget}→$${u.currentTarget} (${pct >= 0 ? '+' : ''}${pct}%)`;
        } else if (u.currentTarget != null) {
          line += ` | Target: $${u.currentTarget}`;
        }
        return line;
      }).join('\n')
    : 'No recent actions';

  const recent7High = f.recentOHLCV?.length > 0
    ? Math.max(...f.recentOHLCV.map(d => d.high ?? 0))
    : null;
  const recent7Low = f.recentOHLCV?.length > 0
    ? Math.min(...f.recentOHLCV.map(d => d.low ?? Infinity))
    : null;
  const ohlcvTable = f.recentOHLCV?.length > 0
    ? f.recentOHLCV.map(d => `  ${d.date}  O:$${d.open} H:$${d.high} L:$${d.low} C:$${d.close}`).join('\n')
    : '  N/A';

  return `Research request: ${symbol} — ${f.longName || symbol}
Sector: ${f.sector || 'N/A'} | Industry: ${f.industry || 'N/A'}

PRICE & MOMENTUM
Current: $${num(f.price, 2)} (${f.changePercent >= 0 ? '+' : ''}${num(f.changePercent, 1)}% today)
52w range: $${num(f.fiftyTwoWeekLow, 2)} – $${num(f.fiftyTwoWeekHigh, 2)} | Position: ${rangePos}
7d high: ${recent7High != null ? '$' + num(recent7High, 2) : 'N/A'} | 7d low: ${recent7Low != null ? '$' + num(recent7Low, 2) : 'N/A'}
Recent daily OHLCV (newest last):
${ohlcvTable}

VALUATION
P/E: ${num(f.trailingPE)} | Fwd P/E: ${num(f.forwardPE)} | P/B: ${num(f.priceToBook)}
EPS (trailing): ${f.trailingEps != null ? '$' + num(f.trailingEps, 2) : 'N/A'} | Beta: ${num(f.beta, 2)}
Analyst target: ${targetStr}
EPS estimates — ${epsEstimates}

QUALITY
Revenue: ${big(f.totalRevenue)} | Gross Margin: ${pct(f.grossMargins)}
Net Margin: ${pct(f.profitMargins)} | ROE: ${pct(f.returnOnEquity)} | FCF: ${big(f.freeCashflow)}
D/E ratio: ${num(f.debtToEquity, 2)} | Current Ratio: ${num(f.currentRatio, 2)}

ANALYST SENTIMENT
${f.buyCount != null ? `Buy: ${f.buyCount} | Hold: ${f.holdCount} | Sell: ${f.sellCount}` : f.recommendationKey ? `Consensus: ${f.recommendationKey}` : 'No analyst data'}

RECENT ANALYST ACTIONS (last 5)
${upgradesStr}

UPCOMING
Next earnings: ${earningsDateStr}

Use get_news to check recent sentiment and catalysts, then produce your scored analysis.`;
}

/** Extract and log scratchpad, return text with scratchpad stripped */
function processScatchpad(text, iteration) {
  const match = text.match(/<scratchpad>([\s\S]*?)<\/scratchpad>/);
  if (match) {
    logger.info(`[research agent turn ${iteration}] scratchpad:\n${match[1].trim()}`);
    return text.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/, '').trim();
  }
  return text;
}

function parseAgentOutput(text) {
  // Extract JSON from the agent's final response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Validate required fields
    if (typeof parsed.score !== 'number') return null;
    if (!parsed.recommendation) return null;
    // entryPlan is optional — only present on BUY/STRONG BUY
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Run the research agent loop for a symbol.
 *
 * @param {string} symbol
 * @param {object} fundamentals - from fetchFundamentals()
 * @returns {Promise<{score, valuation, quality, momentum, sentiment, recommendation, summary, toolCalls} | null>}
 */
export async function runResearchAgent(symbol, fundamentals) {
  if (!config.claude?.apiKey) {
    logger.warn('Claude API key not configured, skipping agent analysis');
    return null;
  }

  const messages = [
    { role: 'user', content: formatFundamentalsForAgent(symbol, fundamentals) },
  ];

  logger.info(`Starting research agent loop for ${symbol}...`);

  try {
    const { text: rawText, usage, toolCalls } = await runAgentLoop({
      model: 'claude-sonnet-4-20250514',
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
      maxIterations: MAX_ITERATIONS,
      maxTokens: MAX_TOKENS_PER_TURN,
      executeTool: async (name, input) => {
        if (name === 'get_news') {
          const newsMap = await fetchMarketNews([input.symbol.toUpperCase()], 1);
          return newsMap[input.symbol.toUpperCase()] || [];
        }
        throw new Error(`Unknown tool: ${name}`);
      },
      onToolCall: (name, input) => {
        logger.info(`Research agent calling: ${name}(${input.symbol || ''})`);
      },
      onTurnText: (text, iteration) => {
        processScatchpad(text, iteration); // log scratchpad from mid-turn text blocks
      },
    });

    const cleanText = processScatchpad(rawText, 'final');
    const result = parseAgentOutput(cleanText);
    if (!result) {
      logger.warn('Agent produced unparseable output, raw:', cleanText.substring(0, 200));
      return null;
    }

    logger.info(`Research agent done: score=${result.score}, ${toolCalls} tool calls, ${usage.inputTokens + usage.outputTokens} tokens`);
    return { ...result, toolCalls };
  } catch (err) {
    if (err.message.includes('exceeded maximum iterations')) {
      logger.warn(`Research agent hit max iterations (${MAX_ITERATIONS}) for ${symbol}`);
    } else {
      logger.error(`Research agent failed for ${symbol}: ${err.message}`);
    }
    return null;
  }
}

export default { runResearchAgent };
