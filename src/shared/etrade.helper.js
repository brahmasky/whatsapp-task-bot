/**
 * E*TRADE Service Helper
 *
 * Shared helper for creating authenticated ETradeService instances.
 * Used by the trade task, portfolio task, and E*TRADE MCP server.
 *
 * Reads OAuth tokens from the macOS keychain (stored by the auth flow)
 * and returns a ready-to-use ETradeService.
 */

import { ETradeService } from '../tasks/portfolio/etrade.service.js';
import { getStoredTokens, SHARED_USER_ID } from '../tasks/portfolio/keychain.service.js';

/**
 * Load stored tokens from the macOS keychain and return an authenticated ETradeService.
 * @throws {Error} if no tokens found — user needs to authenticate via /portfolio
 */
export async function getAuthenticatedService() {
  const tokens = await getStoredTokens(SHARED_USER_ID);
  if (!tokens) {
    throw new Error('Not authenticated with E*TRADE. Run /portfolio first to authenticate.');
  }
  const service = new ETradeService();
  service.setTokens(tokens.oauthToken, tokens.oauthTokenSecret);
  return service;
}
