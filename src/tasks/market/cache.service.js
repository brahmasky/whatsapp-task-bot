/**
 * Portfolio Cache Service
 *
 * Caches portfolio data locally to avoid frequent E*TRADE API calls.
 * Portfolio is refreshed only when /portfolio command is run.
 * Market updates use cached positions + live Yahoo prices.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import logger from '../../utils/logger.js';

const CACHE_DIR = path.join(os.homedir(), '.whatsapp-bot');
const PORTFOLIO_CACHE_FILE = path.join(CACHE_DIR, 'portfolio.json');

// Sector mapping for common stocks (fallback if Yahoo lookup fails)
const SECTOR_OVERRIDES = {
  // Tech
  AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', GOOG: 'Technology',
  META: 'Technology', NVDA: 'Technology', AMD: 'Technology', INTC: 'Technology',
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary',
  // ETFs map to their sector
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare',
  XLI: 'Industrials', XLP: 'Consumer Staples', XLY: 'Consumer Discretionary',
  XLC: 'Communications', XLU: 'Utilities', XLRE: 'Real Estate', XLB: 'Materials',
  SPY: 'Index', QQQ: 'Index', DIA: 'Index', IWM: 'Index',
  // Leveraged ETFs
  TQQQ: 'Technology', SQQQ: 'Technology', UPRO: 'Index', SPXU: 'Index',
  UVXY: 'Volatility', UVIX: 'Volatility',
};

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Fetch sector for a symbol from Yahoo Finance
 */
async function fetchSectorFromYahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=assetProfile`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const profile = data.quoteSummary?.result?.[0]?.assetProfile;

    return profile?.sector || null;
  } catch {
    return null;
  }
}

/**
 * Get sector for a symbol (uses override map first, then Yahoo)
 */
export async function getSectorForSymbol(symbol) {
  const upperSymbol = symbol.toUpperCase();

  // Check overrides first
  if (SECTOR_OVERRIDES[upperSymbol]) {
    return SECTOR_OVERRIDES[upperSymbol];
  }

  // Try Yahoo Finance
  const sector = await fetchSectorFromYahoo(upperSymbol);
  return sector || 'Other';
}

/**
 * Map all positions to their sectors
 */
export async function mapPositionsToSectors(positions) {
  const mappedPositions = [];

  for (const position of positions) {
    const symbol = position.symbol || position.Product?.symbol || 'Unknown';
    const sector = await getSectorForSymbol(symbol);

    mappedPositions.push({
      ...position,
      symbol,
      sector,
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return mappedPositions;
}

/**
 * Calculate sector exposure from positions
 */
export function calculateSectorExposure(positions, totalValue) {
  const sectorTotals = {};

  for (const position of positions) {
    const sector = position.sector || 'Other';
    const value = position.marketValue || 0;

    if (!sectorTotals[sector]) {
      sectorTotals[sector] = { value: 0, positions: [] };
    }

    sectorTotals[sector].value += value;
    sectorTotals[sector].positions.push({
      symbol: position.symbol,
      value,
      quantity: position.quantity,
      costBasis: position.totalCost || position.costBasis,
    });
  }

  // Calculate percentages
  const exposure = {};
  for (const [sector, data] of Object.entries(sectorTotals)) {
    exposure[sector] = {
      value: data.value,
      percent: totalValue > 0 ? parseFloat(((data.value / totalValue) * 100).toFixed(2)) : 0,
      positions: data.positions,
    };
  }

  return exposure;
}

/**
 * Save portfolio data to cache
 */
export async function savePortfolioCache(portfolioData) {
  await ensureCacheDir();

  // Map positions to sectors
  const allPositions = portfolioData.accounts?.flatMap(acc => acc.positions) || [];
  const mappedPositions = await mapPositionsToSectors(allPositions);

  // Calculate sector exposure
  const sectorExposure = calculateSectorExposure(mappedPositions, portfolioData.totalValue);

  const cacheData = {
    fetchedAt: new Date().toISOString(),
    totalValue: portfolioData.totalValue,
    accounts: portfolioData.accounts?.map(acc => ({
      accountId: acc.accountId,
      accountName: acc.accountName,
      accountType: acc.accountType,
    })),
    positions: mappedPositions.map(pos => ({
      symbol: pos.symbol,
      quantity: pos.quantity || 0,
      costBasis: pos.totalCost || pos.costBasis || 0,
      marketValue: pos.marketValue || 0,
      sector: pos.sector,
    })),
    sectorExposure,
  };

  await fs.writeFile(PORTFOLIO_CACHE_FILE, JSON.stringify(cacheData, null, 2));

  logger.info(`Portfolio cache saved: ${mappedPositions.length} positions`);

  return cacheData;
}

/**
 * Load portfolio data from cache
 */
export async function loadPortfolioCache() {
  try {
    const data = await fs.readFile(PORTFOLIO_CACHE_FILE, 'utf-8');
    const cache = JSON.parse(data);

    // Calculate cache age
    const fetchedAt = new Date(cache.fetchedAt);
    const ageMs = Date.now() - fetchedAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const ageDays = ageHours / 24;

    cache.cacheAge = {
      hours: parseFloat(ageHours.toFixed(1)),
      days: parseFloat(ageDays.toFixed(1)),
      isStale: ageHours > 24,
      isVeryStale: ageDays > 7,
    };

    logger.info(`Portfolio cache loaded: ${cache.positions?.length || 0} positions, ${cache.cacheAge.hours}h old`);

    return cache;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.info('No portfolio cache found');
      return null;
    }
    logger.error('Error loading portfolio cache:', error.message);
    return null;
  }
}

/**
 * Check if portfolio cache exists and is recent
 */
export async function hasFreshCache(maxAgeHours = 24) {
  const cache = await loadPortfolioCache();

  if (!cache) {
    return false;
  }

  return cache.cacheAge.hours <= maxAgeHours;
}

/**
 * Clear portfolio cache
 */
export async function clearPortfolioCache() {
  try {
    await fs.unlink(PORTFOLIO_CACHE_FILE);
    logger.info('Portfolio cache cleared');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export default {
  getSectorForSymbol,
  mapPositionsToSectors,
  calculateSectorExposure,
  savePortfolioCache,
  loadPortfolioCache,
  hasFreshCache,
  clearPortfolioCache,
};
