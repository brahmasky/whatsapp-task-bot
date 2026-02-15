/**
 * US Market Calendar
 *
 * Checks if the US stock market is open (NYSE/NASDAQ).
 * Handles weekends and US market holidays.
 */

// US Market holidays for 2026 (NYSE/NASDAQ closed)
// Update annually or fetch from an API
const MARKET_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
];

/**
 * Get current time in US Eastern timezone
 */
export function getEasternTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Check if a given date is a weekend
 */
export function isWeekend(date = new Date()) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

/**
 * Check if a given date is a US market holiday
 */
export function isMarketHoliday(date = new Date()) {
  const dateStr = formatDate(date);
  return MARKET_HOLIDAYS_2026.includes(dateStr);
}

/**
 * Check if US market is open today
 */
export function isMarketDay(date = new Date()) {
  return !isWeekend(date) && !isMarketHoliday(date);
}

/**
 * Check if we're currently in market hours (9:30 AM - 4:00 PM ET)
 */
export function isMarketOpen() {
  const now = getEasternTime();

  if (!isMarketDay(now)) {
    return false;
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  const marketOpen = 9 * 60 + 30;  // 9:30 AM
  const marketClose = 16 * 60;      // 4:00 PM

  return timeInMinutes >= marketOpen && timeInMinutes < marketClose;
}

/**
 * Check if we're in pre-market hours (4:00 AM - 9:30 AM ET)
 */
export function isPreMarket() {
  const now = getEasternTime();

  if (!isMarketDay(now)) {
    return false;
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  const preMarketOpen = 4 * 60;     // 4:00 AM
  const marketOpen = 9 * 60 + 30;   // 9:30 AM

  return timeInMinutes >= preMarketOpen && timeInMinutes < marketOpen;
}

/**
 * Check if we're in after-hours (4:00 PM - 8:00 PM ET)
 */
export function isAfterHours() {
  const now = getEasternTime();

  if (!isMarketDay(now)) {
    return false;
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  const marketClose = 16 * 60;      // 4:00 PM
  const afterHoursClose = 20 * 60;  // 8:00 PM

  return timeInMinutes >= marketClose && timeInMinutes < afterHoursClose;
}

/**
 * Get market status string
 */
export function getMarketStatus() {
  const now = getEasternTime();

  if (!isMarketDay(now)) {
    if (isWeekend(now)) {
      return 'closed (weekend)';
    }
    return 'closed (holiday)';
  }

  if (isPreMarket()) {
    return 'pre-market';
  }

  if (isMarketOpen()) {
    return 'open';
  }

  if (isAfterHours()) {
    return 'after-hours';
  }

  return 'closed';
}

/**
 * Get time until market opens (in minutes)
 * Returns null if market is open or it's not a market day
 */
export function getMinutesUntilOpen() {
  const now = getEasternTime();

  if (!isMarketDay(now)) {
    return null;
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  const marketOpen = 9 * 60 + 30; // 9:30 AM

  if (timeInMinutes >= marketOpen) {
    return null; // Market already open or closed
  }

  return marketOpen - timeInMinutes;
}

export default {
  getEasternTime,
  formatDate,
  isWeekend,
  isMarketHoliday,
  isMarketDay,
  isMarketOpen,
  isPreMarket,
  isAfterHours,
  getMarketStatus,
  getMinutesUntilOpen,
};
