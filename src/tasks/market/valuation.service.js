/**
 * Portfolio Valuation Service
 *
 * Calculates real-time portfolio value using:
 * - Cached positions (from /portfolio command)
 * - Live prices (from Yahoo Finance)
 *
 * No E*TRADE API calls needed for daily updates.
 */

import { fetchMultipleQuotes, SECTOR_ETFS } from './sector.service.js';
import { loadPortfolioCache } from './cache.service.js';
import logger from '../../utils/logger.js';

/**
 * Get live portfolio valuation
 * Uses cached positions + live Yahoo prices
 */
export async function getLivePortfolioValuation() {
  // Load cached portfolio
  const cache = await loadPortfolioCache();

  if (!cache || !cache.positions || cache.positions.length === 0) {
    return {
      available: false,
      reason: 'No portfolio data. Run /portfolio to sync.',
    };
  }

  // Get unique symbols
  const symbols = [...new Set(cache.positions.map(p => p.symbol))];

  logger.info(`Fetching live prices for ${symbols.length} symbols...`);

  // Fetch live quotes
  const quotes = await fetchMultipleQuotes(symbols);

  // Calculate current values
  let totalCurrentValue = 0;
  let totalCostBasis = 0;
  let totalDayChange = 0;

  const positions = cache.positions.map(pos => {
    const quote = quotes[pos.symbol];

    if (!quote || quote.error) {
      // Use cached value if quote unavailable
      return {
        ...pos,
        currentPrice: null,
        currentValue: pos.marketValue,
        dayChange: 0,
        dayChangePercent: 0,
        totalGain: 0,
        totalGainPercent: 0,
        quoteError: quote?.error || 'No quote',
      };
    }

    const currentValue = pos.quantity * quote.price;
    const dayChange = pos.quantity * (quote.change || 0);
    const dayChangePercent = quote.changePercent || 0;
    const totalGain = currentValue - pos.costBasis;
    const totalGainPercent = pos.costBasis > 0 ? (totalGain / pos.costBasis) * 100 : 0;

    totalCurrentValue += currentValue;
    totalCostBasis += pos.costBasis;
    totalDayChange += dayChange;

    return {
      symbol: pos.symbol,
      sector: pos.sector,
      quantity: pos.quantity,
      costBasis: pos.costBasis,
      currentPrice: quote.price,
      currentValue: parseFloat(currentValue.toFixed(2)),
      dayChange: parseFloat(dayChange.toFixed(2)),
      dayChangePercent: parseFloat(dayChangePercent.toFixed(2)),
      totalGain: parseFloat(totalGain.toFixed(2)),
      totalGainPercent: parseFloat(totalGainPercent.toFixed(2)),
    };
  });

  // Sort positions by current value (descending)
  positions.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));

  // Get top movers
  const movers = [...positions]
    .filter(p => p.currentPrice !== null)
    .sort((a, b) => Math.abs(b.dayChangePercent) - Math.abs(a.dayChangePercent));

  const topGainers = movers.filter(p => p.dayChangePercent > 0).slice(0, 3);
  const topLosers = movers.filter(p => p.dayChangePercent < 0).slice(0, 3);

  // Calculate sector performance
  const sectorPerformance = calculateSectorPerformance(positions);

  // Overall portfolio stats
  const totalGain = totalCurrentValue - totalCostBasis;
  const totalGainPercent = totalCostBasis > 0 ? (totalGain / totalCostBasis) * 100 : 0;
  const dayChangePercent = cache.totalValue > 0 ? (totalDayChange / cache.totalValue) * 100 : 0;

  return {
    available: true,
    cacheAge: cache.cacheAge,
    fetchedAt: cache.fetchedAt,
    valuedAt: new Date().toISOString(),
    summary: {
      totalValue: parseFloat(totalCurrentValue.toFixed(2)),
      totalCostBasis: parseFloat(totalCostBasis.toFixed(2)),
      dayChange: parseFloat(totalDayChange.toFixed(2)),
      dayChangePercent: parseFloat(dayChangePercent.toFixed(2)),
      totalGain: parseFloat(totalGain.toFixed(2)),
      totalGainPercent: parseFloat(totalGainPercent.toFixed(2)),
      positionCount: positions.length,
    },
    movers: {
      gainers: topGainers,
      losers: topLosers,
    },
    sectorPerformance,
    positions,
  };
}

/**
 * Calculate performance by sector
 */
function calculateSectorPerformance(positions) {
  const sectors = {};

  for (const pos of positions) {
    const sector = pos.sector || 'Other';

    if (!sectors[sector]) {
      sectors[sector] = {
        value: 0,
        dayChange: 0,
        positions: [],
      };
    }

    sectors[sector].value += pos.currentValue || 0;
    sectors[sector].dayChange += pos.dayChange || 0;
    sectors[sector].positions.push(pos.symbol);
  }

  // Calculate percentages and sort
  const totalValue = Object.values(sectors).reduce((sum, s) => sum + s.value, 0);

  const sectorList = Object.entries(sectors).map(([name, data]) => ({
    name,
    value: parseFloat(data.value.toFixed(2)),
    weight: totalValue > 0 ? parseFloat(((data.value / totalValue) * 100).toFixed(1)) : 0,
    dayChange: parseFloat(data.dayChange.toFixed(2)),
    dayChangePercent: data.value > 0
      ? parseFloat(((data.dayChange / (data.value - data.dayChange)) * 100).toFixed(2))
      : 0,
    positions: data.positions,
  }));

  // Sort by weight
  sectorList.sort((a, b) => b.weight - a.weight);

  return sectorList;
}

/**
 * Compare portfolio performance to market (SPY)
 */
export async function compareToMarket(portfolioDayChangePercent) {
  const quotes = await fetchMultipleQuotes(['SPY']);
  const spy = quotes.SPY;

  if (!spy || spy.error) {
    return null;
  }

  const spyChangePercent = spy.changePercent || 0;
  const alpha = portfolioDayChangePercent - spyChangePercent;

  return {
    spyChange: parseFloat(spyChangePercent.toFixed(2)),
    portfolioChange: parseFloat(portfolioDayChangePercent.toFixed(2)),
    alpha: parseFloat(alpha.toFixed(2)),
    outperformed: alpha > 0,
  };
}

/**
 * Get portfolio sector alignment with market sectors
 */
export function getSectorAlignment(portfolioSectors, marketSectorRotation) {
  const alignment = [];

  for (const sector of portfolioSectors) {
    // Find corresponding market sector ETF
    const sectorToEtf = {
      Technology: 'XLK',
      Financials: 'XLF',
      Energy: 'XLE',
      Healthcare: 'XLV',
      Industrials: 'XLI',
      'Consumer Staples': 'XLP',
      'Consumer Discretionary': 'XLY',
      Communications: 'XLC',
      Utilities: 'XLU',
      'Real Estate': 'XLRE',
      Materials: 'XLB',
    };

    const etf = sectorToEtf[sector.name];
    const isLeader = marketSectorRotation.leaders?.some(l => l.symbol === etf);
    const isLaggard = marketSectorRotation.laggards?.some(l => l.symbol === etf);

    alignment.push({
      sector: sector.name,
      portfolioWeight: sector.weight,
      etf,
      status: isLeader ? 'leader' : isLaggard ? 'laggard' : 'neutral',
      emoji: isLeader ? '✅' : isLaggard ? '⚠️' : '➡️',
    });
  }

  // Calculate overall alignment score
  const leaderWeight = alignment
    .filter(a => a.status === 'leader')
    .reduce((sum, a) => sum + a.portfolioWeight, 0);

  const laggardWeight = alignment
    .filter(a => a.status === 'laggard')
    .reduce((sum, a) => sum + a.portfolioWeight, 0);

  return {
    details: alignment,
    leaderWeight: parseFloat(leaderWeight.toFixed(1)),
    laggardWeight: parseFloat(laggardWeight.toFixed(1)),
    alignmentScore: parseFloat((leaderWeight - laggardWeight).toFixed(1)),
  };
}

export default {
  getLivePortfolioValuation,
  compareToMarket,
  getSectorAlignment,
};
