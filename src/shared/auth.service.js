/**
 * E*TRADE Auth Service
 *
 * Shared OAuth 1.0a PIN flow used by both /portfolio and /trade tasks.
 * Manages the ETradeService instance lifecycle during authentication.
 *
 * Usage:
 *   const { authUrl } = await startAuthFlow(userId);
 *   // send authUrl to user, wait for PIN
 *   const tokens = await exchangePin(userId, pin);
 *   // tokens stored in keychain automatically
 */

import { ETradeService } from '../tasks/portfolio/etrade.service.js';
import { storeTokens, deleteTokens, SHARED_USER_ID } from '../tasks/portfolio/keychain.service.js';
import logger from '../utils/logger.js';

// Stores ETradeService instances mid-OAuth flow, keyed by userId
const pendingServices = new Map();

/**
 * Step 1: Begin OAuth flow.
 * Clears any expired tokens, creates a new ETradeService, fetches the
 * authorization URL, and stores the service instance for PIN exchange.
 *
 * @param {string} userId
 * @returns {Promise<{ authUrl: string }>}
 */
export async function startAuthFlow(userId) {
  await deleteTokens(SHARED_USER_ID);

  const service = new ETradeService();
  pendingServices.set(userId, service);

  try {
    const { authUrl } = await service.getAuthorizationUrl();
    logger.info(`Auth flow started for user ${userId}`);
    return { authUrl };
  } catch (err) {
    pendingServices.delete(userId);
    throw err;
  }
}

/**
 * Step 2: Exchange the PIN for access tokens.
 * Uses the pending ETradeService from startAuthFlow, exchanges the PIN,
 * stores tokens in keychain, and cleans up the pending service.
 *
 * @param {string} userId
 * @param {string} pin
 * @returns {Promise<{ oauthToken: string, oauthTokenSecret: string }>}
 * @throws {Error} if no pending auth flow or PIN is invalid
 */
export async function exchangePin(userId, pin) {
  const service = pendingServices.get(userId);
  if (!service) {
    throw new Error('No pending auth flow. Please start again.');
  }

  try {
    const tokens = await service.exchangeToken(pin);
    await storeTokens(SHARED_USER_ID, tokens.oauthToken, tokens.oauthTokenSecret);
    pendingServices.delete(userId);
    logger.info(`Auth flow completed for user ${userId}, tokens stored`);
    return tokens;
  } catch (err) {
    // On invalid PIN (401), keep service alive so user can retry
    if (err.status !== 401) {
      pendingServices.delete(userId);
    }
    throw err;
  }
}

/**
 * Clean up a pending auth flow (e.g. on task cancel).
 * @param {string} userId
 */
export function cleanupAuthFlow(userId) {
  pendingServices.delete(userId);
}

/**
 * Check if there is a pending auth flow for a user.
 * @param {string} userId
 * @returns {boolean}
 */
export function hasPendingAuthFlow(userId) {
  return pendingServices.has(userId);
}
