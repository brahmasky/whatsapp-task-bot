/**
 * Market Update Scheduler
 *
 * Handles scheduled market updates:
 * - Pre-market: 8:00 AM ET on market days
 * - Post-market: 4:30 PM ET on market days
 * - Weekly: 9:00 AM ET on Saturdays
 */

import cron from 'node-cron';
import { isMarketDay, isWeekend, getEasternTime } from './calendar.js';
import { generateMarketUpdate } from './index.js';
import logger from '../../utils/logger.js';

let scheduledJobs = [];
let sendFunction = null;
let targetUserId = null;

/**
 * Initialize the scheduler
 * @param {Function} send - Function to send WhatsApp messages
 * @param {string} userId - User ID to send updates to
 */
export function initScheduler(send, userId) {
  sendFunction = send;
  targetUserId = userId;

  // Clear any existing jobs
  stopScheduler();

  // Pre-market: 8:00 AM ET, Mon-Fri
  // Cron uses server timezone, so we need to handle ET conversion
  // For simplicity, assuming server is in ET or we adjust accordingly
  const preMarketJob = cron.schedule('0 8 * * 1-5', async () => {
    await runScheduledUpdate('pre-market');
  }, {
    timezone: 'America/New_York',
  });
  scheduledJobs.push(preMarketJob);

  // Post-market: 4:30 PM ET, Mon-Fri
  const postMarketJob = cron.schedule('30 16 * * 1-5', async () => {
    await runScheduledUpdate('post-market');
  }, {
    timezone: 'America/New_York',
  });
  scheduledJobs.push(postMarketJob);

  // Weekly summary: 9:00 AM ET, Saturday
  const weeklyJob = cron.schedule('0 9 * * 6', async () => {
    await runScheduledUpdate('weekly');
  }, {
    timezone: 'America/New_York',
  });
  scheduledJobs.push(weeklyJob);

  logger.info('Market update scheduler initialized');
  logger.info('  Pre-market:  8:00 AM ET, Mon-Fri');
  logger.info('  Post-market: 4:30 PM ET, Mon-Fri');
  logger.info('  Weekly:      9:00 AM ET, Saturday');
}

/**
 * Run a scheduled update
 */
async function runScheduledUpdate(updateType) {
  const now = getEasternTime();

  // Skip pre/post market on non-market days
  if ((updateType === 'pre-market' || updateType === 'post-market') && !isMarketDay(now)) {
    logger.info(`Skipping ${updateType} update - market closed`);
    return;
  }

  if (!sendFunction || !targetUserId) {
    logger.warn(`Cannot send ${updateType} update - no send function configured`);
    return;
  }

  try {
    logger.info(`Running scheduled ${updateType} update...`);

    const message = await generateMarketUpdate(updateType);

    await sendFunction({
      type: 'text',
      userId: targetUserId,
      text: message,
    });

    logger.info(`${updateType} update sent successfully`);
  } catch (error) {
    logger.error(`Failed to send ${updateType} update:`, error.message);
  }
}

/**
 * Stop all scheduled jobs
 */
export function stopScheduler() {
  for (const job of scheduledJobs) {
    job.stop();
  }
  scheduledJobs = [];
  logger.info('Market update scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    active: scheduledJobs.length > 0,
    jobs: scheduledJobs.length,
    targetUser: targetUserId,
    nextRuns: getNextRunTimes(),
  };
}

/**
 * Calculate next run times
 */
function getNextRunTimes() {
  const now = getEasternTime();
  const times = [];

  // Find next pre-market (8 AM ET, weekday)
  let nextPreMarket = new Date(now);
  nextPreMarket.setHours(8, 0, 0, 0);
  if (now.getHours() >= 8) {
    nextPreMarket.setDate(nextPreMarket.getDate() + 1);
  }
  while (!isMarketDay(nextPreMarket)) {
    nextPreMarket.setDate(nextPreMarket.getDate() + 1);
  }
  times.push({ type: 'pre-market', time: nextPreMarket.toISOString() });

  // Find next post-market (4:30 PM ET, weekday)
  let nextPostMarket = new Date(now);
  nextPostMarket.setHours(16, 30, 0, 0);
  if (now.getHours() >= 16 && now.getMinutes() >= 30) {
    nextPostMarket.setDate(nextPostMarket.getDate() + 1);
  }
  while (!isMarketDay(nextPostMarket)) {
    nextPostMarket.setDate(nextPostMarket.getDate() + 1);
  }
  times.push({ type: 'post-market', time: nextPostMarket.toISOString() });

  // Find next weekly (9 AM ET, Saturday)
  let nextWeekly = new Date(now);
  nextWeekly.setHours(9, 0, 0, 0);
  const daysUntilSaturday = (6 - now.getDay() + 7) % 7;
  nextWeekly.setDate(nextWeekly.getDate() + (daysUntilSaturday === 0 && now.getHours() >= 9 ? 7 : daysUntilSaturday));
  times.push({ type: 'weekly', time: nextWeekly.toISOString() });

  return times;
}

/**
 * Manually trigger an update (for testing)
 */
export async function triggerUpdate(updateType) {
  return runScheduledUpdate(updateType);
}

export default {
  initScheduler,
  stopScheduler,
  getSchedulerStatus,
  triggerUpdate,
};
