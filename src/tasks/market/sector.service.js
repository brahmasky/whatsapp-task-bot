/**
 * Sector ETF Data Service
 *
 * Fetches real-time data for S&P 500 sector ETFs and major indices.
 * Uses Yahoo Finance (free, no API key required).
 */

import logger from '../../utils/logger.js';
import { fetchQuote } from '../../shared/yahoo.service.js';

const YAHOO_FINANCE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// S&P 500 Sector ETFs
export const SECTOR_ETFS = {
  XLK: { name: 'Technology', emoji: '💻' },
  XLF: { name: 'Financials', emoji: '🏦' },
  XLE: { name: 'Energy', emoji: '⛽' },
  XLV: { name: 'Healthcare', emoji: '🏥' },
  XLI: { name: 'Industrials', emoji: '🏭' },
  XLP: { name: 'Consumer Staples', emoji: '🛒' },
  XLY: { name: 'Consumer Discretionary', emoji: '🛍️' },
  XLC: { name: 'Communications', emoji: '📱' },
  XLU: { name: 'Utilities', emoji: '⚡' },
  XLRE: { name: 'Real Estate', emoji: '🏠' },
  XLB: { name: 'Materials', emoji: '🧱' },
};

// Major indices
export const INDICES = {
  SPY: { name: 'S&P 500', emoji: '📊' },
  QQQ: { name: 'NASDAQ 100', emoji: '📈' },
  DIA: { name: 'Dow Jones', emoji: '🏛️' },
  IWM: { name: 'Russell 2000', emoji: '📉' },
};

// fetchQuote is provided by the shared Yahoo service (with 60s cache)

/**
 * Fetch all sector ETF data
 */
export async function fetchSectorData() {
  const symbols = Object.keys(SECTOR_ETFS);

  logger.info(`Fetching sector data for ${symbols.length} ETFs...`);

  const results = await Promise.all(
    symbols.map(async (symbol, index) => {
      // Stagger requests slightly
      await new Promise(resolve => setTimeout(resolve, index * 100));
      return fetchQuote(symbol);
    })
  );

  const sectors = {};
  for (const quote of results) {
    if (!quote.error) {
      sectors[quote.symbol] = {
        ...SECTOR_ETFS[quote.symbol],
        ...quote,
      };
    }
  }

  return sectors;
}

/**
 * Fetch major indices data
 */
export async function fetchIndicesData() {
  const symbols = Object.keys(INDICES);

  logger.info(`Fetching indices data for ${symbols.length} symbols...`);

  const results = await Promise.all(
    symbols.map(async (symbol, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 100));
      return fetchQuote(symbol);
    })
  );

  const indices = {};
  for (const quote of results) {
    if (!quote.error) {
      indices[quote.symbol] = {
        ...INDICES[quote.symbol],
        ...quote,
      };
    }
  }

  return indices;
}

/**
 * Fetch all market data (sectors + indices)
 */
export async function fetchAllMarketData() {
  const [sectors, indices] = await Promise.all([
    fetchSectorData(),
    fetchIndicesData(),
  ]);

  return { sectors, indices };
}

/**
 * Analyze sector rotation
 * Returns leaders, laggards, and rotation signal
 */
export function analyzeSectorRotation(sectors) {
  const sectorList = Object.entries(sectors)
    .map(([symbol, data]) => ({
      symbol,
      name: data.name,
      emoji: data.emoji,
      changePercent: data.changePercent,
    }))
    .filter(s => typeof s.changePercent === 'number')
    .sort((a, b) => b.changePercent - a.changePercent);

  if (sectorList.length < 4) {
    return { leaders: [], laggards: [], signal: 'insufficient data' };
  }

  const leaders = sectorList.slice(0, 3);
  const laggards = sectorList.slice(-3).reverse();

  // Calculate spread between best and worst
  const spread = leaders[0].changePercent - laggards[0].changePercent;

  // Determine rotation signal
  let signal = 'neutral';
  let signalEmoji = '➡️';

  // Check if defensive sectors (XLP, XLU, XLV) are leading
  const defensiveSymbols = ['XLP', 'XLU', 'XLV'];
  const cyclicalSymbols = ['XLY', 'XLK', 'XLF'];

  const defensiveAvg = sectorList
    .filter(s => defensiveSymbols.includes(s.symbol))
    .reduce((sum, s) => sum + s.changePercent, 0) / 3;

  const cyclicalAvg = sectorList
    .filter(s => cyclicalSymbols.includes(s.symbol))
    .reduce((sum, s) => sum + s.changePercent, 0) / 3;

  if (defensiveAvg > cyclicalAvg + 0.5) {
    signal = 'defensive (risk-off)';
    signalEmoji = '🛡️';
  } else if (cyclicalAvg > defensiveAvg + 0.5) {
    signal = 'cyclical (risk-on)';
    signalEmoji = '🚀';
  }

  return {
    leaders,
    laggards,
    spread: parseFloat(spread.toFixed(2)),
    signal,
    signalEmoji,
    defensiveAvg: parseFloat(defensiveAvg.toFixed(2)),
    cyclicalAvg: parseFloat(cyclicalAvg.toFixed(2)),
  };
}

/**
 * Fetch quote for a single stock (used for portfolio valuation)
 */
export async function fetchStockQuote(symbol) {
  return fetchQuote(symbol);
}

/**
 * Fetch quotes for multiple stocks
 */
export async function fetchMultipleQuotes(symbols) {
  const results = await Promise.all(
    symbols.map(async (symbol, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 50));
      return fetchQuote(symbol);
    })
  );

  const quotes = {};
  for (const quote of results) {
    quotes[quote.symbol] = quote;
  }

  return quotes;
}

/**
 * Fetch 5 trading days of daily % change history for all sector ETFs + SPY.
 * Uses range=15d to ensure we have enough prior closes to compute day-over-day changes.
 * Returns: { SPY: [{date, changePercent}, ...], XLE: [...], ... }
 */
export async function fetchSectorHistory() {
  const symbols = [...Object.keys(SECTOR_ETFS), 'SPY'];

  logger.info(`Fetching 5-day history for ${symbols.length} sector ETFs + SPY...`);

  const results = await Promise.all(
    symbols.map(async (symbol, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 100));
      try {
        const url = `${YAHOO_FINANCE_URL}/${symbol}?interval=1d&range=15d`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const result = data.chart?.result?.[0];
        if (!result) throw new Error('No data');

        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];

        // Build day-over-day % change for the last 5 complete trading days
        const days = [];
        for (let i = 1; i < closes.length; i++) {
          const prev = closes[i - 1];
          const curr = closes[i];
          if (prev == null || curr == null) continue;
          days.push({
            date: new Date(timestamps[i] * 1000),
            changePercent: parseFloat(((curr - prev) / prev * 100).toFixed(2)),
          });
        }

        return { symbol, days: days.slice(-5) };
      } catch (error) {
        logger.warn(`Failed to fetch history for ${symbol}: ${error.message}`);
        return { symbol, days: [] };
      }
    })
  );

  const history = {};
  for (const { symbol, days } of results) {
    history[symbol] = days;
  }
  return history;
}

export default {
  SECTOR_ETFS,
  INDICES,
  fetchSectorData,
  fetchIndicesData,
  fetchAllMarketData,
  analyzeSectorRotation,
  fetchStockQuote,
  fetchMultipleQuotes,
  fetchSectorHistory,
};
