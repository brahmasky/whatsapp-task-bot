import logger from '../../utils/logger.js';

/**
 * Fetches recent news for stock symbols using Google News RSS
 * No API key required
 */

const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search';

/**
 * Parse RSS XML to extract news items
 */
function parseRSSItems(xml, limit = 3) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>([\s\S]*?)<\/title>/;
  const pubDateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/;
  const sourceRegex = /<source[^>]*>([\s\S]*?)<\/source>/;

  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const itemXml = match[1];

    const titleMatch = titleRegex.exec(itemXml);
    const dateMatch = pubDateRegex.exec(itemXml);
    const sourceMatch = sourceRegex.exec(itemXml);

    if (titleMatch) {
      // Clean up HTML entities
      const title = titleMatch[1]
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      const source = sourceMatch ? sourceMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '') : '';
      const pubDate = dateMatch ? new Date(dateMatch[1]).toLocaleDateString() : '';

      items.push({
        title: title.substring(0, 100), // Truncate long titles
        source,
        date: pubDate,
      });
    }
  }

  return items;
}

/**
 * Fetch news for a single stock symbol
 * @param {string} symbol Stock ticker symbol
 * @returns {Promise<Array<{title: string, source: string, date: string}>>}
 */
async function fetchNewsForSymbol(symbol) {
  try {
    const query = encodeURIComponent(`${symbol} stock`);
    const url = `${GOOGLE_NEWS_RSS_URL}?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
      },
    });

    if (!response.ok) {
      logger.warn(`Failed to fetch news for ${symbol}: ${response.status}`);
      return [];
    }

    const xml = await response.text();
    return parseRSSItems(xml, 3);
  } catch (error) {
    logger.warn(`Error fetching news for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Fetch news for multiple symbols (top holdings)
 * @param {string[]} symbols Array of stock ticker symbols
 * @param {number} maxSymbols Maximum number of symbols to fetch news for
 * @returns {Promise<Object>} Map of symbol -> news items
 */
export async function fetchMarketNews(symbols, maxSymbols = 5) {
  const newsMap = {};

  // Limit to top N symbols to avoid too many requests
  const symbolsToFetch = symbols.slice(0, maxSymbols);

  logger.info(`Fetching news for ${symbolsToFetch.length} symbols...`);

  // Fetch in parallel with small delay to be nice to Google
  const results = await Promise.all(
    symbolsToFetch.map(async (symbol, index) => {
      // Stagger requests slightly
      await new Promise(resolve => setTimeout(resolve, index * 200));
      const news = await fetchNewsForSymbol(symbol);
      return { symbol, news };
    })
  );

  for (const { symbol, news } of results) {
    if (news.length > 0) {
      newsMap[symbol] = news;
    }
  }

  return newsMap;
}

/**
 * Format news data for inclusion in Claude prompt
 * @param {Object} newsMap Map of symbol -> news items
 * @returns {string} Formatted news text
 */
export function formatNewsForAnalysis(newsMap) {
  const lines = ['RECENT MARKET NEWS FOR YOUR HOLDINGS:', ''];

  for (const [symbol, news] of Object.entries(newsMap)) {
    lines.push(`${symbol}:`);
    for (const item of news) {
      const sourceInfo = item.source ? ` (${item.source})` : '';
      lines.push(`  • ${item.title}${sourceInfo} - ${item.date}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export default { fetchMarketNews, formatNewsForAnalysis };
