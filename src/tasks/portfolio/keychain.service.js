import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execAsync = promisify(exec);
const SERVICE_NAME = 'ETrade';
const KEYCHAIN_NAME = 'TPGBot.keychain-db';
const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', KEYCHAIN_NAME);

// Shared user ID for single-user mode (used by both WhatsApp bot and MCP server)
export const SHARED_USER_ID = 'etrade-default-user';

/**
 * Ensures the bot's dedicated keychain exists and is unlocked.
 */
async function ensureKeychain() {
  if (!fs.existsSync(KEYCHAIN_PATH)) {
    await execAsync(`security create-keychain -p "" "${KEYCHAIN_NAME}"`);
  }
  await execAsync(`security unlock-keychain -p "" "${KEYCHAIN_PATH}"`);
}

/**
 * Escapes special characters for shell commands
 */
function escapeForShell(str) {
  return str.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

/**
 * Retrieves OAuth tokens from the keychain for a given user.
 *
 * @param {string} userId The user identifier
 * @returns {Promise<{oauthToken: string, oauthTokenSecret: string}|null>}
 */
export async function getStoredTokens(userId) {
  try {
    await ensureKeychain();

    const tokenKey = `${SERVICE_NAME}:oauth_token:${userId}`;
    const secretKey = `${SERVICE_NAME}:oauth_secret:${userId}`;

    const { stdout: oauthToken } = await execAsync(
      `security find-generic-password -s "${tokenKey}" -w "${KEYCHAIN_PATH}"`
    );
    const { stdout: oauthTokenSecret } = await execAsync(
      `security find-generic-password -s "${secretKey}" -w "${KEYCHAIN_PATH}"`
    );

    return {
      oauthToken: oauthToken.trim(),
      oauthTokenSecret: oauthTokenSecret.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Stores OAuth tokens in the keychain for a given user.
 *
 * @param {string} userId The user identifier
 * @param {string} oauthToken The OAuth token
 * @param {string} oauthTokenSecret The OAuth token secret
 * @returns {Promise<boolean>} True if successful
 */
export async function storeTokens(userId, oauthToken, oauthTokenSecret) {
  try {
    await ensureKeychain();

    const tokenKey = `${SERVICE_NAME}:oauth_token:${userId}`;
    const secretKey = `${SERVICE_NAME}:oauth_secret:${userId}`;

    // Store oauth token (use -U to update if exists)
    await execAsync(
      `security add-generic-password -a "${userId}" -s "${tokenKey}" -l "${tokenKey}" -U -w "${escapeForShell(oauthToken)}" "${KEYCHAIN_PATH}"`
    );

    // Store oauth token secret
    await execAsync(
      `security add-generic-password -a "${userId}" -s "${secretKey}" -l "${secretKey}" -U -w "${escapeForShell(oauthTokenSecret)}" "${KEYCHAIN_PATH}"`
    );

    return true;
  } catch (error) {
    console.error('Failed to save tokens to keychain:', error.stderr?.trim() || error.message);
    return false;
  }
}

/**
 * Deletes OAuth tokens from the keychain for a given user.
 *
 * @param {string} userId The user identifier
 * @returns {Promise<boolean>} True if successful
 */
export async function deleteTokens(userId) {
  try {
    await ensureKeychain();

    const tokenKey = `${SERVICE_NAME}:oauth_token:${userId}`;
    const secretKey = `${SERVICE_NAME}:oauth_secret:${userId}`;

    try {
      await execAsync(
        `security delete-generic-password -s "${tokenKey}" "${KEYCHAIN_PATH}"`
      );
    } catch {
      // Ignore if not found
    }

    try {
      await execAsync(
        `security delete-generic-password -s "${secretKey}" "${KEYCHAIN_PATH}"`
      );
    } catch {
      // Ignore if not found
    }

    return true;
  } catch (error) {
    console.error('Failed to delete tokens from keychain:', error.stderr?.trim() || error.message);
    return false;
  }
}
