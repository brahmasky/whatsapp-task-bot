/**
 * Yahoo Finance Quote Service
 *
 * Single implementation of Yahoo Finance v8/finance/chart fetching,
 * shared across market, research, trade, and MCP tasks.
 *
 * Includes a 60-second in-memory cache to avoid duplicate fetches
 * during batch operations (e.g. /market fetching 15 ETFs at once).
 *
 * Returns a normalised quote shape — never throws, returns { symbol, error }
 * on failure so callers can handle gracefully.
 */

import logger from '../utils/logger.js';

const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const CACHE_TTL = 60_000; // 60 seconds

// key: SYMBOL (uppercase), value: { quote, expiresAt }
const _cache = new Map();

function _getCached(symbol) {
  const entry = _cache.get(symbol);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(symbol);
    return null;
  }
  return entry.quote;
}

function _setCache(symbol, quote) {
  _cache.set(symbol, { quote, expiresAt: Date.now() + CACHE_TTL });
}

/**
 * Fetch a current quote from Yahoo Finance.
 *
 * Returns:
 *   { symbol, name, price, previousClose, change, changePercent,
 *     dayHigh, dayLow, volume, marketCap,
 *     fiftyTwoWeekHigh, fiftyTwoWeekLow, exchange, currency }
 *
 * On error returns:
 *   { symbol, error: string }
 *
 * Results are cached for 60 seconds.
 */
export async function fetchQuote(symbol) {
  const sym = symbol.toUpperCase();

  const cached = _getCached(sym);
  if (cached) {
    logger.debug(`Yahoo cache hit: ${sym}`);
    return cached;
  }

  try {
    const url = `${YAHOO_URL}/${sym}?interval=1d&range=5d`;
    const response = await fetch(url, { headers: { 'User-Agent': UA } });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('Symbol not found');

    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const previousClose = closes[closes.length - 2] ?? meta.chartPreviousClose;
    const price = meta.regularMarketPrice;
    const change = price - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : null;

    const quote = {
      symbol: sym,
      name: meta.shortName || meta.longName || sym,
      price,
      previousClose,
      change: parseFloat(change.toFixed(2)),
      changePercent: changePercent != null ? parseFloat(changePercent.toFixed(4)) : null,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      marketCap: meta.marketCap ?? null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      exchange: meta.exchangeName ?? null,
      currency: meta.currency ?? null,
    };

    _setCache(sym, quote);
    return quote;
  } catch (err) {
    logger.warn(`Yahoo Finance: failed to fetch ${sym}: ${err.message}`);
    return { symbol: sym, error: err.message };
  }
}
