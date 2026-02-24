/**
 * Compare Service
 *
 * Runs parallel research on multiple symbols and returns a ranked table.
 * Reuses the 24h research cache — symbols already cached are served instantly.
 *
 * Used by: /research compare, /market ideas
 */

import { fetchFundamentals } from '../tasks/research/fundamentals.service.js';
import { runResearchAgent } from '../tasks/research/agent.service.js';
import { load, save } from '../utils/persistence.service.js';
import logger from '../utils/logger.js';

const CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Research up to 5 symbols in parallel, using cache where available.
 * @param {string[]} symbols - Uppercase ticker symbols (max 5)
 * @returns {Promise<Array<{symbol, score, recommendation, fromCache, error?}>>}
 */
export async function compareSymbols(symbols) {
  const syms = symbols.slice(0, 5);

  const results = await Promise.all(syms.map(async (symbol) => {
    // Serve from cache if fresh
    const cached = load('research-cache/' + symbol);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
      logger.info(`compare: ${symbol} served from cache`);
      return { symbol, ...cached, fromCache: true };
    }

    // Run fresh research
    try {
      const fundamentals = await fetchFundamentals(symbol);
      if (fundamentals.error) return { symbol, error: fundamentals.error };

      const analysis = await runResearchAgent(symbol, fundamentals);
      if (!analysis) return { symbol, error: 'Agent returned null' };

      const result = {
        symbol,
        score: analysis.score,
        recommendation: analysis.recommendation,
        summary: analysis.summary,
        valuation: analysis.valuation,
        quality: analysis.quality,
        momentum: analysis.momentum,
        sentiment: analysis.sentiment,
        entryPlan: analysis.entryPlan ?? null,
        cachedAt: Date.now(),
        fromCache: false,
      };
      save('research-cache/' + symbol, result);
      logger.info(`compare: ${symbol} scored ${analysis.score}/100 (${analysis.recommendation})`);
      return result;
    } catch (err) {
      logger.warn(`compare: ${symbol} failed — ${err.message}`);
      return { symbol, error: err.message };
    }
  }));

  return results;
}

/**
 * Format a comparison result array as a ranked text table.
 * @param {Array} results - Output from compareSymbols()
 * @returns {string}
 */
export function formatCompareTable(results) {
  const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rows = sorted.map((r, i) => {
    if (r.error) return `${i + 1}. ${r.symbol.padEnd(6)} ERROR: ${r.error}`;
    const cached = r.fromCache ? '[c]' : '[f]';
    return `${i + 1}. ${r.symbol.padEnd(6)} ${String(r.score).padStart(3)}/100  ${(r.recommendation ?? 'N/A').padEnd(11)} ${cached}`;
  });
  return rows.join('\n');
}
