import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../utils/logger.js';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = 'TPG';
const KEYCHAIN_NAME = 'TPGBot.keychain-db';
const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', KEYCHAIN_NAME);

/**
 * Ensures the bot's dedicated keychain exists and is unlocked.
 * Uses a separate keychain to avoid "User interaction is not allowed"
 * errors when writing to the default login keychain non-interactively.
 */
async function ensureKeychain() {
  if (!fs.existsSync(KEYCHAIN_PATH)) {
    await execFileAsync('security', ['create-keychain', '-p', '', KEYCHAIN_NAME]);
  }
  await execFileAsync('security', ['unlock-keychain', '-p', '', KEYCHAIN_PATH]);
}

/**
 * Retrieves the password from the bot's dedicated keychain.
 * Falls back to searching all keychains by label for backwards compatibility.
 *
 * @param {string} account The username/account
 * @returns {Promise<string|null>} The password or null if not found
 */
export async function getStoredPassword(account) {
  try {
    await ensureKeychain();
    const { stdout } = await execFileAsync(
      'security', ['find-generic-password', '-s', SERVICE_NAME, '-a', account, '-w', KEYCHAIN_PATH]
    );
    return stdout.trim();
  } catch {
    // Fallback: search default keychains by label
    try {
      const { stdout } = await execFileAsync(
        'security', ['find-generic-password', '-l', SERVICE_NAME, '-w']
      );
      return stdout.trim();
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Stores the password in the bot's dedicated keychain.
 *
 * @param {string} account The username/account
 * @param {string} password The password to store
 * @returns {Promise<boolean>} True if successful
 */
export async function storePassword(account, password) {
  try {
    await ensureKeychain();
    await execFileAsync(
      'security', ['add-generic-password', '-a', account, '-s', SERVICE_NAME, '-l', SERVICE_NAME, '-U', '-w', password, KEYCHAIN_PATH]
    );
    return true;
  } catch (error) {
    logger.error('Failed to save to keychain:', { error: error.stderr?.trim() || error.message });
    return false;
  }
}
