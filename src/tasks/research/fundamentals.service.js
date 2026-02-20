/**
 * Fundamentals Service — Yahoo Finance + FMP
 *
 * Yahoo v8/finance/chart  → price, 52w range           (no key, no rate limit)
 * FMP /stable/profile     → sector, industry, beta, name
 * FMP /stable/ratios-ttm  → P/E, P/B, margins, ROE
 * FMP /stable/quote       → EPS, earnings date, shares outstanding
 * FMP /stable/key-metrics-ttm       → revenue/FCF per share (× shares = absolute total)
 * FMP /stable/price-target-consensus → analyst mean/high/low price targets
 *
 * All five FMP calls run in parallel (1 round-trip, 5 of 250 daily quota).
 * FMP fundamentals are best-effort — price always shows even if FMP fails.
 *
 * Requires: FMP_API_KEY env var (free at financialmodelingprep.com)
 */

import config from '../../config/index.js';
import logger from '../../utils/logger.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FMP = 'https://financialmodelingprep.com/stable';

// ─── Yahoo v8/chart (price) ───────────────────────────────────────────────────

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);

  const data = await resp.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error('Symbol not found');

  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const previousClose = closes[closes.length - 2] || meta.chartPreviousClose;
  const price = meta.regularMarketPrice;

  return {
    longName: meta.longName || meta.shortName || symbol,
    price,
    previousClose,
    changePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
  };
}

// ─── FMP helpers ──────────────────────────────────────────────────────────────

async function fmpGet(path, key) {
  const url = `${FMP}${path}&apikey=${key}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });

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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchFundamentals(symbol) {
  // 1. Price from Yahoo — mandatory, no key needed
  let yahoo;
  try {
    yahoo = await fetchYahooQuote(symbol);
  } catch (err) {
    logger.error(`Yahoo quote failed for ${symbol}: ${err.message}`);
    return { error: err.message };
  }

  // 2. FMP fundamentals — best-effort, requires key
  const key = config.fmp?.apiKey;
  if (!key) {
    logger.warn('FMP_API_KEY not configured — showing price only');
    return buildResult(yahoo, {}, {}, {}, {});
  }

  const [profileRes, ratiosRes, quoteRes, metricsRes, targetRes] = await Promise.allSettled([
    fmpGet(`/profile?symbol=${symbol}`, key),
    fmpGet(`/ratios-ttm?symbol=${symbol}`, key),
    fmpGet(`/quote?symbol=${symbol}`, key),
    fmpGet(`/key-metrics-ttm?symbol=${symbol}`, key),
    fmpGet(`/price-target-consensus?symbol=${symbol}`, key),
  ]);

  // Stable endpoints return arrays for profile/quote/metrics, object for ratios-ttm and price-target
  const first = v => (Array.isArray(v) ? v[0] : v) ?? {};
  const profile = profileRes.status  === 'fulfilled' ? first(profileRes.value)  : {};
  const ratios  = ratiosRes.status   === 'fulfilled' ? first(ratiosRes.value)   : {};
  const quote   = quoteRes.status    === 'fulfilled' ? first(quoteRes.value)    : {};
  const metrics = metricsRes.status  === 'fulfilled' ? first(metricsRes.value)  : {};
  const target  = targetRes.status   === 'fulfilled' ? first(targetRes.value)   : {};

  if (profileRes.status  === 'rejected') logger.warn(`FMP profile failed for ${symbol}: ${profileRes.reason.message}`);
  if (ratiosRes.status   === 'rejected') logger.warn(`FMP ratios failed for ${symbol}: ${ratiosRes.reason.message}`);
  if (quoteRes.status    === 'rejected') logger.warn(`FMP quote failed for ${symbol}: ${quoteRes.reason.message}`);
  if (metricsRes.status  === 'rejected') logger.warn(`FMP key-metrics failed for ${symbol}: ${metricsRes.reason.message}`);
  if (targetRes.status   === 'rejected') logger.warn(`FMP price-target failed for ${symbol}: ${targetRes.reason.message}`);

  logger.info(`FMP data fetched for ${symbol}: ${profile.companyName || symbol}`);
  return buildResult(yahoo, profile, ratios, quote, metrics, target);
}

function buildResult(yahoo, profile, ratios, quote, metrics, target = {}) {
  const earningsTs = quote.earningsAnnouncement
    ? new Date(quote.earningsAnnouncement)
    : null;

  // Compute absolute revenue and FCF from per-share × shares outstanding
  const shares = n(quote.sharesOutstanding);
  const revenuePerShare = n(metrics.revenuePerShareTTM);
  const fcfPerShare     = n(metrics.freeCashFlowPerShareTTM);
  const totalRevenue    = (revenuePerShare && shares) ? revenuePerShare * shares : null;
  const freeCashflow    = (fcfPerShare && shares)     ? fcfPerShare * shares     : null;

  // ROE: prefer key-metrics-ttm (more reliable), fall back to ratios-ttm
  const returnOnEquity = n(metrics.returnOnEquityTTM) ?? n(ratios.returnOnEquityTTM);

  return {
    // Identity
    longName:  profile.companyName || yahoo.longName,
    sector:    profile.sector   || null,
    industry:  profile.industry || null,

    // Price (Yahoo)
    price:            yahoo.price,
    previousClose:    yahoo.previousClose,
    changePercent:    yahoo.changePercent,
    fiftyTwoWeekHigh: yahoo.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:  yahoo.fiftyTwoWeekLow,

    // Valuation (FMP ratios-ttm + quote)
    trailingPE:   n(ratios.priceToEarningsRatioTTM),
    forwardPE:    null,
    priceToBook:  n(ratios.priceToBookRatioTTM),
    trailingEps:  n(quote.eps),
    beta:         n(profile.beta),

    // Financials TTM
    totalRevenue,
    grossMargins:   n(ratios.grossProfitMarginTTM),
    profitMargins:  n(ratios.netProfitMarginTTM),
    returnOnEquity,
    freeCashflow,

    // Analyst (FMP price-target-consensus)
    targetMeanPrice:   n(target.targetConsensus),
    targetHighPrice:   n(target.targetHigh),
    targetLowPrice:    n(target.targetLow),
    recommendationKey: null,
    buyCount:          null,
    holdCount:         null,
    sellCount:         null,

    // Earnings (FMP quote)
    nextEarningsDate: earningsTs,
    nextEpsEstimate:  null,
    recentActions:    [],
  };
}

export default { fetchFundamentals };
