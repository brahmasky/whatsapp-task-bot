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
 * Get ET date/time components for any Date using Intl.DateTimeFormat.
 * Returns { year, month, day, hour, minute, second, weekday } as strings.
 * hour is 0-23 ('24' from some implementations is normalised to '0').
 */
function getETComponents(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(date);

  return parts.reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

/**
 * Get current time. Use getETComponents() for ET-specific day/hour checks.
 */
export function getEasternTime() {
  return new Date();
}

/**
 * Format date as YYYY-MM-DD in ET timezone
 */
export function formatDate(date) {
  const et = getETComponents(date);
  return `${et.year}-${et.month}-${et.day}`;
}

/**
 * Check if a given date falls on a weekend in ET timezone
 */
export function isWeekend(date = new Date()) {
  const { weekday } = getETComponents(date);
  return weekday === 'Saturday' || weekday === 'Sunday';
}

/**
 * Check if a given date is a US market holiday (ET date)
 */
export function isMarketHoliday(date = new Date()) {
  return MARKET_HOLIDAYS_2026.includes(formatDate(date));
}

/**
 * Check if US market is open today (ET)
 */
export function isMarketDay(date = new Date()) {
  return !isWeekend(date) && !isMarketHoliday(date);
}

/**
 * Check if we're currently in market hours (9:30 AM - 4:00 PM ET)
 */
export function isMarketOpen() {
  const now = new Date();
  if (!isMarketDay(now)) return false;

  const et = getETComponents(now);
  const timeInMinutes = (parseInt(et.hour) % 24) * 60 + parseInt(et.minute);

  return timeInMinutes >= 9 * 60 + 30 && timeInMinutes < 16 * 60;
}

/**
 * Check if we're in pre-market hours (4:00 AM - 9:30 AM ET)
 */
export function isPreMarket() {
  const now = new Date();
  if (!isMarketDay(now)) return false;

  const et = getETComponents(now);
  const timeInMinutes = (parseInt(et.hour) % 24) * 60 + parseInt(et.minute);

  return timeInMinutes >= 4 * 60 && timeInMinutes < 9 * 60 + 30;
}

/**
 * Check if we're in after-hours (4:00 PM - 8:00 PM ET)
 */
export function isAfterHours() {
  const now = new Date();
  if (!isMarketDay(now)) return false;

  const et = getETComponents(now);
  const timeInMinutes = (parseInt(et.hour) % 24) * 60 + parseInt(et.minute);

  return timeInMinutes >= 16 * 60 && timeInMinutes < 20 * 60;
}

/**
 * Get market status string
 */
export function getMarketStatus() {
  const now = new Date();

  if (!isMarketDay(now)) {
    return isWeekend(now) ? 'closed (weekend)' : 'closed (holiday)';
  }

  if (isPreMarket()) return 'pre-market';
  if (isMarketOpen()) return 'open';
  if (isAfterHours()) return 'after-hours';
  return 'closed';
}

/**
 * Get time until market opens (in minutes)
 * Returns null if market is open or it's not a market day
 */
export function getMinutesUntilOpen() {
  const now = new Date();
  if (!isMarketDay(now)) return null;

  const et = getETComponents(now);
  const timeInMinutes = (parseInt(et.hour) % 24) * 60 + parseInt(et.minute);
  const marketOpen = 9 * 60 + 30;

  if (timeInMinutes >= marketOpen) return null;
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
