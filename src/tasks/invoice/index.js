import { TPGService } from './tpg.service.js';
import { getStoredPassword, storePassword } from './keychain.service.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * TPG Invoice Task
 *
 * Flow:
 * 1. User sends /invoice
 * 2. Bot checks for credentials (env -> keychain -> prompt user)
 * 3. Bot initializes browser, logs into TPG, triggers SMS
 * 4. User receives SMS on phone, replies with 6-digit code
 * 5. Bot completes login, downloads invoice PDF
 * 6. Bot sends PDF to user via WhatsApp
 */

// Store TPG service instances per user (for cleanup)
const userServices = new Map();

export default {
  command: '/invoice',
  description: 'Generate and download TPG monthly invoice',

  /**
   * Called when user sends /invoice command
   */
  async start(ctx) {
    await ctx.reply('Starting TPG invoice generation...');

    // Get credentials from environment
    let username = config.tpg.username;
    let password = config.tpg.password;

    // Try Keychain if env vars not set
    if (!username || !password) {
      logger.info('Credentials not in env, checking Keychain...');

      // If username is set, use it for keychain lookup
      if (username) {
        password = await getStoredPassword(username);
        if (password) {
          logger.info('Password found in Keychain');
        }
      } else {
        // Try generic lookup by service name
        password = await getStoredPassword('');
      }
    }

    // If still missing credentials, prompt user
    if (!username) {
      ctx.updateTask('awaiting_username', {});
      await ctx.reply(
        'No TPG username found.\n\n' +
        'Please enter your TPG username (email):'
      );
      return;
    }

    if (!password) {
      ctx.updateTask('awaiting_password', { username });
      await ctx.reply(
        'No TPG password found in Keychain.\n\n' +
        'Please enter your TPG password:'
      );
      return;
    }

    // Credentials ready, proceed with login
    await this.proceedWithLogin(ctx, username, password);
  },

  /**
   * Proceed with TPG login after credentials are obtained
   */
  async proceedWithLogin(ctx, username, password) {
    const tpgService = new TPGService();
    userServices.set(ctx.userId, tpgService);

    try {
      await tpgService.initialize();

      await ctx.reply('Logging into TPG... This will trigger an SMS to your phone.');

      const result = await tpgService.login({ username, password });

      if (result.needsSMS) {
        ctx.updateTask('awaiting_sms', { username, password });
        await ctx.reply(
          'SMS code has been sent to your phone.\n\n' +
          'Please reply with the 6-digit code.\n' +
          '(Type /cancel to abort)'
        );
      } else {
        // Login might have completed without SMS (unlikely but possible)
        await ctx.reply('Login completed without SMS. Downloading invoice...');
        await this.downloadAndSend(ctx, tpgService);
      }
    } catch (error) {
      logger.error('Error starting invoice task:', { error: error.message });
      await ctx.reply(`Error: ${error.message}`);
      await this.cleanup(ctx);
    }
  },

  /**
   * Called for messages while task is active
   */
  async onMessage(ctx, text) {
    const state = ctx.getState();

    switch (state.taskState) {
      case 'awaiting_username':
        await this.handleUsername(ctx, text);
        break;
      case 'awaiting_password':
        await this.handlePassword(ctx, text);
        break;
      case 'awaiting_save_confirm':
        await this.handleSaveConfirm(ctx, text);
        break;
      case 'awaiting_sms':
        await this.handleSMSCode(ctx, text);
        break;
      default:
        await ctx.reply('Unexpected state. Type /cancel to abort.');
    }
  },

  /**
   * Handle username input
   */
  async handleUsername(ctx, text) {
    const username = text.trim();

    if (!username || username.length < 3) {
      await ctx.reply('Invalid username. Please enter your TPG username (email):');
      return;
    }

    // Check if password exists in Keychain for this username
    const storedPassword = await getStoredPassword(username);

    if (storedPassword) {
      await ctx.reply('Password found in Keychain!');
      await this.proceedWithLogin(ctx, username, storedPassword);
    } else {
      ctx.updateTask('awaiting_password', { username });
      await ctx.reply('Please enter your TPG password:');
    }
  },

  /**
   * Handle password input
   */
  async handlePassword(ctx, text) {
    const password = text.trim();
    const { username } = ctx.getTaskData();

    if (!password || password.length < 4) {
      await ctx.reply('Invalid password. Please enter your TPG password:');
      return;
    }

    // Ask if user wants to save to Keychain
    ctx.updateTask('awaiting_save_confirm', { username, password });
    await ctx.reply(
      'Save password to macOS Keychain for future use?\n\n' +
      'Reply *yes* to save, or *no* to continue without saving:'
    );
  },

  /**
   * Handle save confirmation
   */
  async handleSaveConfirm(ctx, text) {
    const response = text.trim().toLowerCase();
    const { username, password } = ctx.getTaskData();

    if (response === 'yes' || response === 'y') {
      const saved = await storePassword(username, password);
      if (saved) {
        await ctx.reply('Password saved to Keychain.');
      } else {
        await ctx.reply('Failed to save to Keychain. Continuing anyway...');
      }
    } else if (response !== 'no' && response !== 'n') {
      await ctx.reply('Please reply *yes* or *no*:');
      return;
    }

    // Proceed with login
    await this.proceedWithLogin(ctx, username, password);
  },

  /**
   * Handle SMS code input
   */
  async handleSMSCode(ctx, text) {
    const code = text.trim().replace(/\s/g, '');

    // Validate code format
    if (!/^\d{6}$/.test(code)) {
      await ctx.reply(
        'Invalid code format. Please enter exactly 6 digits.\n' +
        'Example: 123456'
      );
      return;
    }

    const tpgService = userServices.get(ctx.userId);

    if (!tpgService) {
      await ctx.reply('Session expired. Please start again with /invoice');
      ctx.completeTask();
      return;
    }

    try {
      await ctx.reply('Verifying SMS code...');
      ctx.updateTask('verifying_sms');

      await tpgService.completeSMS(code);

      await ctx.reply('Verification successful! Downloading invoice...');
      await this.downloadAndSend(ctx, tpgService);
    } catch (error) {
      logger.error('Error verifying SMS:', { error: error.message });
      await ctx.reply(`Verification failed: ${error.message}\nPlease try again or type /cancel to abort.`);
      ctx.updateTask('awaiting_sms');
    }
  },

  /**
   * Download invoice and send to user
   */
  async downloadAndSend(ctx, tpgService) {
    try {
      ctx.updateTask('downloading');

      const { pdfPath, invoiceInfo } = await tpgService.downloadInvoice();

      // Format month name
      const dateParts = invoiceInfo.date.split('-');
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const monthName = monthNames[parseInt(dateParts[1]) - 1];
      const year = dateParts[0];

      // Send the PDF
      const filename = `TPG_Invoice_${invoiceInfo.date.slice(0, 7)}.pdf`;
      const caption = `TPG Invoice for ${monthName} ${year}\nAmount: $${invoiceInfo.amount.toFixed(2)}`;

      await ctx.sendDocument(pdfPath, filename, 'application/pdf', caption);

      await ctx.reply(`Invoice ${invoiceInfo.invoiceNumber} sent successfully!`);

      // Cleanup
      await this.cleanup(ctx);
    } catch (error) {
      logger.error('Error downloading invoice:', { error: error.message });
      await ctx.reply(`Failed to download invoice: ${error.message}`);
      await this.cleanup(ctx);
    }
  },

  /**
   * Cleanup task resources
   */
  async cleanup(ctx) {
    const tpgService = userServices.get(ctx.userId);

    if (tpgService) {
      try {
        await tpgService.cleanup();
      } catch (error) {
        logger.error('Error cleaning up TPG service:', { error: error.message });
      }
      userServices.delete(ctx.userId);
    }

    ctx.completeTask();
  },
};
