import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const SERVICE_NAME = 'TPG';

/**
 * Retrieves the password from the macOS Keychain.
 * Looks for a Generic Password item with service name 'TPG'.
 *
 * @param {string} account The username/account
 * @returns {Promise<string|null>} The password or null if not found
 */
export async function getStoredPassword(account) {
  try {
    // Try exact match (Account + Service 'TPG')
    const { stdout } = await execAsync(
      `security find-generic-password -s "${SERVICE_NAME}" -a "${account}" -w`
    );
    return stdout.trim();
  } catch (error) {
    // Fallback: Search by Label "TPG" (Generic Password only)
    try {
      const { stdout } = await execAsync(
        `security find-generic-password -l "${SERVICE_NAME}" -w`
      );
      return stdout.trim();
    } catch (fallbackError) {
      // Ignore failures
    }
  }
  return null;
}

/**
 * Stores the password in the macOS Keychain.
 * Creates a Generic Password item with:
 * - Service: TPG
 * - Label: TPG
 * - Account: <username>
 *
 * @param {string} account The username/account
 * @param {string} password The password to store
 * @returns {Promise<boolean>} True if successful
 */
export async function storePassword(account, password) {
  try {
    // -U updates item if it exists
    const command = `security add-generic-password -a "${account}" -s "${SERVICE_NAME}" -l "${SERVICE_NAME}" -w "${password}" -U`;
    await execAsync(command);
    return true;
  } catch (error) {
    console.error('Failed to save to keychain:', error.message);
    return false;
  }
}
