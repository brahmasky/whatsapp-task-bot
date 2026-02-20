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
    logger.error(`Failed to send ${updateType} update: ${error.message}\n${error.stack}`);
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
 * Calculate next run times, returning correct UTC timestamps regardless of server timezone.
 */
function getNextRunTimes() {
  const now = new Date();
  const times = [];

  // Get ET date/time components from a real Date
  function getETComponents(date) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hour12: false,
    }).formatToParts(date).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  }

  // Get the UTC Date for targetHour:targetMinute ET on the ET calendar day of 'date'.
  // Tries both EST (-05:00) and EDT (-04:00) offsets and picks whichever verifies correctly.
  function utcForETTime(date, hour, minute) {
    const et = getETComponents(date);
    const dateStr = `${et.year}-${et.month}-${et.day}`;
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    for (const offset of ['-05:00', '-04:00']) {
      const candidate = new Date(`${dateStr}T${timeStr}${offset}`);
      const verify = getETComponents(candidate);
      if (parseInt(verify.hour) % 24 === hour && parseInt(verify.minute) === minute) {
        return candidate;
      }
    }
    return new Date(`${dateStr}T${timeStr}-05:00`); // fallback
  }

  // Find the next occurrence of targetHour:targetMinute ET that satisfies filter(utcDate)
  function findNext(targetHour, targetMinute, filter) {
    for (let offset = 0; offset <= 14; offset++) {
      const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
      const target = utcForETTime(candidate, targetHour, targetMinute);
      if (target > now && filter(target)) return target;
    }
    return null;
  }

  const nextPre = findNext(8, 0, isMarketDay);
  if (nextPre) times.push({ type: 'pre-market', time: nextPre.toISOString() });

  const nextPost = findNext(16, 30, isMarketDay);
  if (nextPost) times.push({ type: 'post-market', time: nextPost.toISOString() });

  // Weekly: 9 AM ET on Saturday
  const nextWeekly = findNext(9, 0, (d) => getETComponents(d).weekday === 'Saturday');
  if (nextWeekly) times.push({ type: 'weekly', time: nextWeekly.toISOString() });

  return times;
}

/**
 * Manually trigger an update via the scheduled send path (bypasses market day check)
 */
export async function triggerUpdate(updateType) {
  return runScheduledUpdate(updateType);
}

/**
 * Send a direct ping via the scheduled send path (no market check, no update generation)
 * Used to test whether sendFunction and targetUserId are wired up correctly.
 */
export async function sendSchedulerPing() {
  if (!sendFunction || !targetUserId) {
    throw new Error(`Scheduler not configured - sendFunction: ${!!sendFunction}, targetUserId: ${targetUserId}`);
  }
  await sendFunction({
    type: 'text',
    userId: targetUserId,
    text: `🔔 Scheduler ping test\ntargetUserId: ${targetUserId}\ntime: ${new Date().toISOString()}`,
  });
}

/**
 * Register a one-time cron job that fires in N minutes and sends a ping.
 * Used to verify cron is actually triggering on this machine.
 */
export function scheduleTestIn(minutes = 3) {
  const fireAt = new Date(Date.now() + minutes * 60 * 1000);
  const m = fireAt.getUTCMinutes();
  const h = fireAt.getUTCHours();
  const d = fireAt.getUTCDate();
  const mon = fireAt.getUTCMonth() + 1;

  const pattern = `${m} ${h} ${d} ${mon} *`;
  logger.info(`Scheduling test cron at UTC ${h}:${String(m).padStart(2, '0')} (in ~${minutes} min), pattern: ${pattern}`);

  const testJob = cron.schedule(pattern, async () => {
    logger.info('Test cron job fired!');
    try {
      await sendSchedulerPing();
      logger.info('Test ping sent successfully');
    } catch (err) {
      logger.error('Test ping failed:', err.message);
    }
    testJob.stop();
  }, { timezone: 'UTC' }); // pattern is in UTC
}

export default {
  initScheduler,
  stopScheduler,
  getSchedulerStatus,
  triggerUpdate,
};
