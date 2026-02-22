/**
 * Fundamentals Service — Yahoo Finance (primary) + FMP (fallback)
 *
 * Data sources:
 *   Yahoo v8/finance/chart      → price, 52w range           (via shared yahoo.service.js, cached 60s)
 *   Yahoo quoteSummary          → full fundamentals           (via yahoo-finance2 library, handles auth)
 *   FMP /stable/ endpoints      → fallback if Yahoo sparse    (key required, 250 calls/day)
 *
 * Yahoo is primary because it has better coverage for non-US companies (e.g. CHKP, TSM, BABA)
 * and requires no API key. FMP is used as a fallback when Yahoo quoteSummary returns sparse data.
 *
 * "Sparse" = fewer than 2 of the 5 key metrics are non-null
 * (P/E, gross margin, net margin, ROE, revenue).
 *
 * Yahoo quoteSummary modules used:
 *   assetProfile            → sector, industry, description
 *   summaryDetail           → P/E, P/B, beta, dividend yield
 *   financialData           → margins, ROE, FCF, analyst targets, D/E
 *   defaultKeyStatistics    → trailing EPS
 *   recommendationTrend     → buy/hold/sell counts
 *   calendarEvents          → next earnings date
 *   earningsTrend           → forward EPS estimates (CQ, CY, NY)
 *   upgradeDowngradeHistory → recent analyst upgrades/downgrades
 *   balanceSheetHistory     → current ratio (currentAssets / currentLiabilities)
 */

import yahooFinance from 'yahoo-finance2';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { fetchQuote } from '../../shared/yahoo.service.js';

// Singleton yahoo-finance2 instance (handles crumb/cookie auth automatically)
const _yf = new yahooFinance({ suppressNotices: ['yahooSurvey'] });

const FMP = 'https://financialmodelingprep.com/stable';

// Modules to fetch — excludes balanceSheetHistory (broken since Nov 2024, returns no data)
const YAHOO_MODULES = [
  'assetProfile', 'summaryDetail', 'financialData', 'defaultKeyStatistics',
  'recommendationTrend', 'calendarEvents', 'earningsTrend', 'upgradeDowngradeHistory',
];

// ─── Yahoo quoteSummary via yahoo-finance2 (primary fundamentals) ─────────────
// Uses yahoo-finance2 library which handles crumb/cookie auth automatically.
// Values are already parsed numbers/Dates — no { raw, fmt } unwrapping needed.

async function fetchYahooFundamentals(symbol) {
  const result = await _yf.quoteSummary(symbol, { modules: YAHOO_MODULES });

  const profile   = result.assetProfile             || {};
  const summary   = result.summaryDetail            || {};
  const financial = result.financialData            || {};
  const stats     = result.defaultKeyStatistics     || {};
  const recs      = result.recommendationTrend?.trend || [];
  const rec0      = recs[0] || {};
  const calendar  = result.calendarEvents?.earnings || {};
  const trend     = result.earningsTrend?.trend     || [];
  const upgrades  = result.upgradeDowngradeHistory?.history || [];

  // Next earnings date — yahoo-finance2 returns real Date objects
  const earningsDates = calendar.earningsDate || [];
  const nextEarningsDate = earningsDates.length > 0 ? earningsDates[0] : null;

  // Forward EPS estimates (periods: 0q = current quarter, 0y = current year, +1y = next year)
  const trendFor = period => trend.find(t => t.period === period) || {};
  const epsEstimateCurrentQuarter = trendFor('0q').earningsEstimate?.avg ?? null;
  const epsEstimateCurrentYear    = trendFor('0y').earningsEstimate?.avg ?? null;
  const epsEstimateNextYear       = trendFor('+1y').earningsEstimate?.avg ?? null;

  // Recent analyst upgrades/downgrades — includes bonus price target data
  const actionLabel = { up: '↑', down: '↓', main: '→', init: '★', reit: '→' };
  const recentUpgrades = upgrades.slice(0, 5).map(h => ({
    date:          h.epochGradeDate ? new Date(h.epochGradeDate).toISOString().split('T')[0] : null,
    firm:          h.firm        || null,
    action:        actionLabel[h.action] || h.action || null,
    toGrade:       h.toGrade    || null,
    fromGrade:     h.fromGrade  || null,
    currentTarget: h.currentPriceTarget ?? null,
    priorTarget:   h.priorPriceTarget   ?? null,
    targetAction:  h.priceTargetAction  || null,
  }));

  // D/E ratio — Yahoo returns as percentage (68.4 = 68.4% = 0.68 ratio), divide by 100
  const debtToEquity = financial.debtToEquity != null ? financial.debtToEquity / 100 : null;

  return {
    sector:    profile.sector   || null,
    industry:  profile.industry || null,

    beta:         summary.beta         ?? null,
    trailingPE:   summary.trailingPE   ?? null,
    forwardPE:    summary.forwardPE    ?? null,
    priceToBook:  summary.priceToBook  ?? null,
    trailingEps:  stats.trailingEps    ?? null,

    totalRevenue:   financial.totalRevenue   ?? null,
    grossMargins:   financial.grossMargins   ?? null,
    profitMargins:  financial.profitMargins  ?? null,
    returnOnEquity: financial.returnOnEquity ?? null,
    freeCashflow:   financial.freeCashflow   ?? null,
    debtToEquity,
    currentRatio:   null,  // balanceSheetHistory broken since Nov 2024

    targetMeanPrice:   financial.targetMeanPrice   ?? null,
    targetHighPrice:   financial.targetHighPrice   ?? null,
    targetLowPrice:    financial.targetLowPrice    ?? null,
    recommendationKey: financial.recommendationKey || null,

    // Combine strong buy/buy and strong sell/sell for simplicity
    buyCount:  (rec0.strongBuy != null) ? rec0.strongBuy + (rec0.buy || 0) : null,
    holdCount: rec0.hold ?? null,
    sellCount: (rec0.strongSell != null) ? rec0.strongSell + (rec0.sell || 0) : null,

    nextEarningsDate,
    epsEstimateCurrentQuarter,
    epsEstimateCurrentYear,
    epsEstimateNextYear,
    recentUpgrades,
  };
}

// ─── FMP (fallback) ───────────────────────────────────────────────────────────

const FMP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function fmpGet(path, key) {
  const url = `${FMP}${path}&apikey=${key}`;
  const resp = await fetch(url, { headers: { 'User-Agent': FMP_UA } });

  if (resp.status === 403) throw new Error(`FMP 403 — endpoint requires a paid plan: ${path}`);
  if (resp.status === 402) throw new Error(`FMP 402 — ticker requires a paid plan: ${path}`);
  if (resp.status === 401) throw new Error(`FMP 401 — invalid or missing API key`);
  if (!resp.ok) throw new Error(`FMP HTTP ${resp.status}`);

  const data = await resp.json();
  if (data?.['Error Message']) throw new Error(data['Error Message']);
  if (data?.message?.toLowerCase().includes('not found')) throw new Error(data.message);
  return data;
}

function n(v) {
  if (v == null || v === '' || v === 'NA') return null;
  const x = parseFloat(v);
  return isNaN(x) ? null : x;
}

async function fetchFmpFundamentals(symbol, key) {
  const [profileRes, ratiosRes, quoteRes, metricsRes, targetRes] = await Promise.allSettled([
    fmpGet(`/profile?symbol=${symbol}`, key),
    fmpGet(`/ratios-ttm?symbol=${symbol}`, key),
    fmpGet(`/quote?symbol=${symbol}`, key),
    fmpGet(`/key-metrics-ttm?symbol=${symbol}`, key),
    fmpGet(`/price-target-consensus?symbol=${symbol}`, key),
  ]);

  const first = v => (Array.isArray(v) ? v[0] : v) ?? {};
  const profile  = profileRes.status  === 'fulfilled' ? first(profileRes.value)  : {};
  const ratios   = ratiosRes.status   === 'fulfilled' ? first(ratiosRes.value)   : {};
  const quote    = quoteRes.status    === 'fulfilled' ? first(quoteRes.value)    : {};
  const metrics  = metricsRes.status  === 'fulfilled' ? first(metricsRes.value)  : {};
  const target   = targetRes.status   === 'fulfilled' ? first(targetRes.value)   : {};

  if (profileRes.status  === 'rejected') logger.warn(`FMP profile failed for ${symbol}: ${profileRes.reason.message}`);
  if (ratiosRes.status   === 'rejected') logger.warn(`FMP ratios failed for ${symbol}: ${ratiosRes.reason.message}`);
  if (quoteRes.status    === 'rejected') logger.warn(`FMP quote failed for ${symbol}: ${quoteRes.reason.message}`);
  if (metricsRes.status  === 'rejected') logger.warn(`FMP key-metrics failed for ${symbol}: ${metricsRes.reason.message}`);
  if (targetRes.status   === 'rejected') logger.warn(`FMP price-target failed for ${symbol}: ${targetRes.reason.message}`);

  // FMP key-metrics returns per-share values — multiply by shares to get totals
  const shares         = n(quote.sharesOutstanding);
  const revenuePerShare = n(metrics.revenuePerShareTTM);
  const fcfPerShare     = n(metrics.freeCashFlowPerShareTTM);

  return {
    sector:    profile.sector   || null,
    industry:  profile.industry || null,

    beta:         n(profile.beta),
    trailingPE:   n(ratios.priceToEarningsRatioTTM),
    forwardPE:    null,
    priceToBook:  n(ratios.priceToBookRatioTTM),
    trailingEps:  n(quote.eps),

    totalRevenue:   (revenuePerShare && shares) ? revenuePerShare * shares : null,
    grossMargins:   n(ratios.grossProfitMarginTTM),
    profitMargins:  n(ratios.netProfitMarginTTM),
    returnOnEquity: n(metrics.returnOnEquityTTM) ?? n(ratios.returnOnEquityTTM),
    freeCashflow:   (fcfPerShare && shares) ? fcfPerShare * shares : null,
    debtToEquity:   n(ratios.debtToEquityRatioTTM) ?? n(metrics.debtToEquityTTM),
    currentRatio:   n(metrics.currentRatioTTM),

    targetMeanPrice: n(target.targetConsensus),
    targetHighPrice: n(target.targetHigh),
    targetLowPrice:  n(target.targetLow),
    recommendationKey: null,
    buyCount:  null,
    holdCount: null,
    sellCount: null,

    nextEarningsDate:         quote.earningsAnnouncement ? new Date(quote.earningsAnnouncement) : null,
    epsEstimateCurrentQuarter: null,
    epsEstimateCurrentYear:    null,
    epsEstimateNextYear:       null,
    recentUpgrades:            [],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the fundamentals object is too sparse to be useful.
 * Sparse = fewer than 2 of 5 key metrics are non-null.
 */
function isSparse(f) {
  const keyMetrics = [f.trailingPE, f.grossMargins, f.profitMargins, f.returnOnEquity, f.totalRevenue];
  return keyMetrics.filter(v => v != null).length < 2;
}

function buildResult(yahoo, f) {
  return {
    longName:  yahoo.name,
    sector:    f.sector   || null,
    industry:  f.industry || null,

    price:            yahoo.price,
    previousClose:    yahoo.previousClose,
    changePercent:    yahoo.changePercent,
    fiftyTwoWeekHigh: yahoo.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:  yahoo.fiftyTwoWeekLow,

    trailingPE:   f.trailingPE   ?? null,
    forwardPE:    f.forwardPE    ?? null,
    priceToBook:  f.priceToBook  ?? null,
    trailingEps:  f.trailingEps  ?? null,
    beta:         f.beta         ?? null,

    totalRevenue:   f.totalRevenue   ?? null,
    grossMargins:   f.grossMargins   ?? null,
    profitMargins:  f.profitMargins  ?? null,
    returnOnEquity: f.returnOnEquity ?? null,
    freeCashflow:   f.freeCashflow   ?? null,
    debtToEquity:   f.debtToEquity   ?? null,
    currentRatio:   f.currentRatio   ?? null,

    targetMeanPrice:   f.targetMeanPrice   ?? null,
    targetHighPrice:   f.targetHighPrice   ?? null,
    targetLowPrice:    f.targetLowPrice    ?? null,
    recommendationKey: f.recommendationKey ?? null,
    buyCount:          f.buyCount          ?? null,
    holdCount:         f.holdCount         ?? null,
    sellCount:         f.sellCount         ?? null,

    nextEarningsDate:          f.nextEarningsDate          ?? null,
    epsEstimateCurrentQuarter: f.epsEstimateCurrentQuarter ?? null,
    epsEstimateCurrentYear:    f.epsEstimateCurrentYear    ?? null,
    epsEstimateNextYear:       f.epsEstimateNextYear       ?? null,
    recentUpgrades:            f.recentUpgrades            ?? [],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchFundamentals(symbol) {
  // 1. Price from Yahoo v8/chart — always required
  const yahoo = await fetchQuote(symbol);
  if (yahoo.error) {
    logger.error(`Yahoo quote failed for ${symbol}: ${yahoo.error}`);
    return { error: yahoo.error };
  }

  // 2. Try Yahoo quoteSummary first — no key needed, better international coverage
  let fundamentals = null;
  let source = 'none';

  try {
    fundamentals = await fetchYahooFundamentals(symbol);
    if (!isSparse(fundamentals)) {
      source = 'yahoo';
      logger.info(`Yahoo quoteSummary data fetched for ${symbol} (${fundamentals.sector || 'no sector'})`);
    } else {
      logger.warn(`Yahoo quoteSummary sparse for ${symbol} — trying FMP fallback`);
      fundamentals = null;
    }
  } catch (err) {
    logger.warn(`Yahoo quoteSummary failed for ${symbol}: ${err.message} — trying FMP fallback`);
  }

  // 3. FMP fallback — if Yahoo sparse or failed
  if (!fundamentals) {
    const key = config.fmp?.apiKey;
    if (key) {
      try {
        fundamentals = await fetchFmpFundamentals(symbol, key);
        source = 'fmp';
        logger.info(`FMP fallback data fetched for ${symbol}`);
      } catch (err) {
        logger.warn(`FMP fallback also failed for ${symbol}: ${err.message}`);
      }
    } else {
      logger.warn(`FMP_API_KEY not configured — Yahoo quoteSummary was the only option`);
    }
  }

  logger.info(`Research fundamentals source: ${source} for ${symbol}`);
  return buildResult(yahoo, fundamentals || {});
}

export default { fetchFundamentals };
