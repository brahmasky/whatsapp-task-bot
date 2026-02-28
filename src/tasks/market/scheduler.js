/**
 * Market Update Scheduler
 *
 * Handles scheduled market updates:
 * - Post-market: 4:30 PM ET on market days
 * - Weekly: 9:00 AM ET on Saturdays
 *
 * Uses setInterval polling (every 30s) instead of node-cron to avoid a timing
 * precision bug in node-cron v4: its heartbeat uses exact-second matching
 * (second === 0 for 5-field expressions). When the heartbeat fires even 1s
 * late, the match fails and the next execution is scheduled 24h later —
 * silently dropping the update. Polling every 30s gives a 60-second window to
 * catch the target minute, which is robust against normal timer drift.
 */

import { isMarketDay, getEasternTime, formatDate } from './calendar.js';
import { generateMarketUpdate } from './index.js';
import logger from '../../utils/logger.js';

let schedulerInterval = null;
let sendFunction = null;
let targetUserId = null;
let isReadyFn = () => true;

// Track the last ET date (YYYY-MM-DD) each update type was fired to prevent
// duplicate executions within the same minute (interval fires every 30s).
const lastFired = {};

/**
 * Get current ET hour, minute, and weekday.
 */
function getETNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    hour: parseInt(parts.hour) % 24,
    minute: parseInt(parts.minute),
    weekday: parts.weekday,
    now,
  };
}

/**
 * Wait for the messaging channel to become ready, polling every 5s.
 * Returns true if ready within the timeout, false if it timed out.
 */
async function waitForReady(timeoutMs = 120_000) {
  if (isReadyFn()) return true;
  logger.info('Channel not ready — waiting up to 2 min before sending update...');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000));
    if (isReadyFn()) return true;
  }
  return false;
}

/**
 * Initialize the scheduler
 * @param {Function} send - Function to send WhatsApp messages
 * @param {string} userId - User ID to send updates to
 * @param {Function} [isReady] - Optional: returns true when the channel is connected
 */
export function initScheduler(send, userId, isReady = () => true) {
  sendFunction = send;
  targetUserId = userId;
  isReadyFn = isReady;

  // Clear any existing interval
  stopScheduler();

  schedulerInterval = setInterval(() => {
    const { hour, minute, weekday, now } = getETNow();
    const dateStr = formatDate(now); // YYYY-MM-DD in ET — dedup key

    // Post-market: 4:30 PM ET, Mon-Fri (market days only)
    if (hour === 16 && minute === 30 && isMarketDay(now) && lastFired['post-market'] !== dateStr) {
      lastFired['post-market'] = dateStr;
      runScheduledUpdate('post-market');
    }

    // Weekly: 9:00 AM ET, Saturday
    if (hour === 9 && minute === 0 && weekday === 'Saturday' && lastFired['weekly'] !== dateStr) {
      lastFired['weekly'] = dateStr;
      runScheduledUpdate('weekly');
    }
  }, 30_000);

  logger.info('Market update scheduler initialized');
  logger.info('  Post-market: 4:30 PM ET, Mon-Fri');
  logger.info('  Weekly:      9:00 AM ET, Saturday');
}

/**
 * Run a scheduled update
 */
async function runScheduledUpdate(updateType) {
  // Log first — before any early-return checks — so we can confirm the tick fired
  logger.info(`Scheduled tick: ${updateType} → ${targetUserId}`);

  if (!sendFunction || !targetUserId) {
    logger.warn(`Cannot send ${updateType} update - no send function configured`);
    return;
  }

  try {
    logger.info(`Running scheduled ${updateType} update...`);

    const message = await generateMarketUpdate(updateType);

    // Ensure the channel is connected before sending — it may have briefly dropped
    const ready = await waitForReady();
    if (!ready) {
      logger.error(`${updateType} update generated but channel not ready after 2 min — discarding`);
      return;
    }

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
 * Stop the scheduler interval
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  logger.info('Market update scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    active: !!schedulerInterval,
    jobs: schedulerInterval ? 2 : 0, // post-market + weekly
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

  const nextPost = findNext(16, 30, isMarketDay);
  if (nextPost) times.push({ type: 'post-market', time: nextPost.toISOString() });

  // Weekly: 9 AM ET on Saturday
  const nextWeekly = findNext(9, 0, (d) => getETComponents(d).weekday === 'Saturday');
  if (nextWeekly) times.push({ type: 'weekly', time: nextWeekly.toISOString() });

  return times;
}

/**
 * Update the target user JID for scheduled sends.
 * Called when the actual JID is learned from an incoming message — the JID
 * constructed at startup from ALLOWED_USERS uses @s.whatsapp.net but in
 * newer multi-device WhatsApp the user's real JID is @lid, which is what
 * actually routes correctly.
 */
export function setTargetUser(userId) {
  if (userId && userId !== targetUserId) {
    logger.info(`Scheduler target updated: ${targetUserId} → ${userId}`);
    targetUserId = userId;
  }
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
    text: `Scheduler ping test\ntargetUserId: ${targetUserId}\ntime: ${new Date().toISOString()}`,
  });
}

/**
 * Schedule a one-time test ping in N minutes.
 * Used to verify the send path is working on this machine.
 */
export function scheduleTestIn(minutes = 3) {
  const fireAt = new Date(Date.now() + minutes * 60 * 1000);
  logger.info(`Scheduling test ping in ~${minutes} min (at ${fireAt.toISOString()})`);
  setTimeout(async () => {
    logger.info('Test timer fired!');
    try {
      await sendSchedulerPing();
      logger.info('Test ping sent successfully');
    } catch (err) {
      logger.error('Test ping failed:', err.message);
    }
  }, minutes * 60 * 1000);
}

export default {
  initScheduler,
  stopScheduler,
  getSchedulerStatus,
  triggerUpdate,
};
