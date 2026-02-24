/**
 * Shared E*TRADE re-authentication helpers for mid-task token expiry.
 *
 * Used by /trade and /research when a 401 fires during order placement.
 * Portfolio uses its own initial-auth flow (different UX pattern).
 *
 * Typical usage:
 *
 *   // On 401:
 *   await startReAuth(ctx, 'Your trade plan is saved — order will be placed after re-auth.');
 *
 *   // In onMessage when taskState === 'awaiting_pin':
 *   await handleReAuthPin(ctx, text, async () => {
 *     await ctx.reply('Placing order now...');
 *     await doTheThingThatNeededAuth(ctx.getTaskData());
 *   });
 */

import { startAuthFlow, exchangePin, cleanupAuthFlow } from './auth.service.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Start re-authentication: generate auth URL, set state to awaiting_pin,
 * send instructions to the user.
 *
 * @param {object} ctx - Task context
 * @param {string} contextNote - Extra line telling the user what will happen after re-auth
 *                               (e.g. "Your trade plan is saved — order will be placed after re-auth.")
 */
export async function startReAuth(ctx, contextNote = '') {
  try {
    const { authUrl } = await startAuthFlow(ctx.userId);
    ctx.updateTask('awaiting_pin'); // preserves existing task data via state merge

    const envNote = config.etrade.sandbox ? ' (SANDBOX)' : '';
    await ctx.reply(
      `🔐 E*TRADE session expired. Re-authentication required${envNote}.\n\n` +
      `1. Open this link to authorize:\n${authUrl}\n\n` +
      `2. Log in to E*TRADE and click "Accept"\n` +
      `3. Copy the PIN and reply with it here\n\n` +
      (contextNote ? `${contextNote}\n\n` : '') +
      `Type /cancel to abort.`
    );
  } catch (err) {
    logger.error(`Failed to start re-auth: ${err.message}`);
    await ctx.reply(`Failed to start re-authentication: ${err.message}`);
    ctx.completeTask();
  }
}

/**
 * Handle a PIN reply during the awaiting_pin state.
 * Validates format, exchanges for tokens, then calls onSuccess.
 * Handles 401 (bad PIN) and other errors consistently.
 *
 * @param {object} ctx - Task context
 * @param {string} pin - Raw text from user
 * @param {Function} onSuccess - async callback called after successful token exchange;
 *                               responsible for post-auth action and completing the task
 */
export async function handleReAuthPin(ctx, pin, onSuccess) {
  if (!pin || pin.trim().length < 4 || pin.trim().length > 20) {
    await ctx.reply(
      'Invalid PIN format. Please enter the verification code from E*TRADE\n' +
      '(shown after clicking "Accept" on the authorization page).'
    );
    return;
  }

  try {
    await ctx.reply('Verifying PIN...');
    await exchangePin(ctx.userId, pin.trim());
    logger.info('Re-authentication successful');
    await onSuccess();
  } catch (err) {
    if (err.status === 401) {
      await ctx.reply(
        'Invalid or expired PIN. Please get a fresh PIN from the authorization page and try again.'
      );
    } else {
      cleanupAuthFlow(ctx.userId);
      logger.error(`Re-auth PIN exchange failed: ${err.message}`);
      await ctx.reply(`Re-authentication failed: ${err.message}`);
      ctx.completeTask();
    }
  }
}
