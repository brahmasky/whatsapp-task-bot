import { TPGService } from './tpg.service.js';
import { getStoredPassword } from './keychain.service.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * TPG Invoice Task
 *
 * Flow:
 * 1. User sends /invoice
 * 2. Bot initializes browser, logs into TPG, triggers SMS
 * 3. User receives SMS on phone, replies with 6-digit code
 * 4. Bot completes login, downloads invoice PDF
 * 5. Bot sends PDF to user via WhatsApp
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

    // Get credentials
    let username = config.tpg.username;
    let password = config.tpg.password;

    // Try Keychain if env vars not set
    if (!username || !password) {
      await ctx.reply('Looking up credentials from Keychain...');

      // If username is set, use it for keychain lookup
      if (username) {
        password = await getStoredPassword(username);
      } else {
        // Try to get password with a generic lookup
        password = await getStoredPassword('');
      }

      if (!password) {
        await ctx.reply(
          'No TPG credentials found.\n\n' +
          'Please set TPG_USERNAME and TPG_PASSWORD in your .env file, ' +
          'or store them in macOS Keychain with service name "TPG".'
        );
        ctx.completeTask();
        return;
      }

      // If we got password from keychain but no username, we need username
      if (!username) {
        await ctx.reply(
          'TPG_USERNAME not set in environment.\n' +
          'Please set TPG_USERNAME in your .env file.'
        );
        ctx.completeTask();
        return;
      }
    }

    // Initialize TPG service
    const tpgService = new TPGService();
    userServices.set(ctx.userId, tpgService);

    try {
      await tpgService.initialize();

      await ctx.reply('Logging into TPG... This will trigger an SMS to your phone.');

      const result = await tpgService.login({ username, password });

      if (result.needsSMS) {
        ctx.updateTask('awaiting_sms', { tpgService });
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

    if (state.taskState === 'awaiting_sms') {
      await this.handleSMSCode(ctx, text);
    } else {
      await ctx.reply('Unexpected state. Type /cancel to abort.');
    }
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
