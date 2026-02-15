import { ETradeService } from './etrade.service.js';
import { getStoredTokens, storeTokens, deleteTokens, SHARED_USER_ID } from './keychain.service.js';
import { runPortfolioAgent } from './agent.service.js';
import { getETradeClient } from '../../mcp/client.js';
import { savePortfolioCache } from '../market/cache.service.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * E*TRADE Portfolio Advisor Task
 *
 * Flow:
 * 1. User sends /portfolio
 * 2. Bot checks for stored OAuth tokens in Keychain
 * 3. If no tokens or tokens invalid:
 *    a. Generate authorization URL
 *    b. User clicks link, authorizes, gets PIN
 *    c. User replies with PIN
 *    d. Bot exchanges PIN for access tokens, stores in Keychain
 * 4. Fetch portfolio data (accounts, balances, positions)
 * 5. Send to Claude API for analysis
 * 6. Reply with actionable advice
 *
 * Subcommands:
 * - /portfolio logout - Clear stored tokens
 */

// Store ETradeService instances per user (for OAuth flow continuity)
const userServices = new Map();

export default {
  command: '/portfolio',
  description: 'Get E*TRADE portfolio analysis and investment advice',

  /**
   * Called when user sends /portfolio command
   */
  async start(ctx, args) {
    // Handle subcommands (args is an array from message router)
    const subcommand = args?.[0]?.toLowerCase();

    if (subcommand === 'logout') {
      return await this.handleLogout(ctx);
    }

    // Check for required config
    if (!config.etrade.consumerKey || !config.etrade.consumerSecret) {
      await ctx.reply(
        'E*TRADE credentials not configured.\n\n' +
        'Please set ETRADE_CONSUMER_KEY and ETRADE_CONSUMER_SECRET in your .env file.'
      );
      ctx.completeTask();
      return;
    }

    if (!config.claude.apiKey) {
      await ctx.reply(
        'Claude API not configured.\n\n' +
        'Please set ANTHROPIC_API_KEY in your .env file.'
      );
      ctx.completeTask();
      return;
    }

    const envLabel = config.etrade.sandbox ? '🧪 SANDBOX' : '🔴 PRODUCTION';
    await ctx.reply(`Checking E*TRADE authentication... [${envLabel}]`);

    // Check for stored tokens (using shared user ID for single-user mode)
    const storedTokens = await getStoredTokens(SHARED_USER_ID);

    if (storedTokens) {
      logger.info('Found stored OAuth tokens, validating...');

      const etradeService = new ETradeService();
      etradeService.setTokens(storedTokens.oauthToken, storedTokens.oauthTokenSecret);
      userServices.set(ctx.userId, etradeService);

      try {
        const isValid = await etradeService.validateTokens();

        if (isValid) {
          await ctx.reply('Authentication valid. Fetching portfolio data...');
          await this.fetchAndAnalyze(ctx);
          return;
        } else {
          logger.info('Stored tokens are invalid, need re-auth');
          await deleteTokens(SHARED_USER_ID);
        }
      } catch (error) {
        logger.warn('Token validation error:', error.message);
        await deleteTokens(SHARED_USER_ID);
      }
    }

    // Need to authenticate
    await this.startAuthFlow(ctx);
  },

  /**
   * Start OAuth authentication flow
   */
  async startAuthFlow(ctx) {
    const etradeService = new ETradeService();
    userServices.set(ctx.userId, etradeService);

    try {
      const { authUrl } = await etradeService.getAuthorizationUrl();

      ctx.updateTask('awaiting_pin', { authUrl });

      const envNote = config.etrade.sandbox ? ' (SANDBOX)' : '';

      await ctx.reply(
        `E*TRADE Authorization Required${envNote}\n\n` +
        '1. Click this link to authorize:\n' +
        `${authUrl}\n\n` +
        '2. Log in to E*TRADE and click "Accept"\n' +
        '3. Copy the verification code (PIN)\n' +
        '4. Reply here with the PIN\n\n' +
        'Type /cancel to abort.'
      );
    } catch (error) {
      logger.error('Failed to start auth flow:', error);
      await ctx.reply(`Authentication error: ${error.message}`);
      await this.cleanup(ctx);
    }
  },

  /**
   * Called for messages while task is active
   */
  async onMessage(ctx, text) {
    const state = ctx.getState();

    switch (state.taskState) {
      case 'awaiting_pin':
        await this.handlePIN(ctx, text);
        break;
      default:
        await ctx.reply('Unexpected state. Type /cancel to abort.');
    }
  },

  /**
   * Handle PIN input from user
   */
  async handlePIN(ctx, text) {
    const pin = text.trim();

    // E*TRADE PINs are typically alphanumeric, 5-10 characters
    if (!pin || pin.length < 4 || pin.length > 20) {
      await ctx.reply(
        'Invalid PIN format. Please enter the verification code from E*TRADE.\n' +
        'It should be displayed after you click "Accept" on the authorization page.'
      );
      return;
    }

    const etradeService = userServices.get(ctx.userId);

    if (!etradeService) {
      await ctx.reply('Session expired. Please start again with /portfolio');
      ctx.completeTask();
      return;
    }

    try {
      await ctx.reply('Verifying PIN...');
      ctx.updateTask('exchanging_token');

      const tokens = await etradeService.exchangeToken(pin);

      // Store tokens in Keychain (using shared user ID for single-user mode)
      const saved = await storeTokens(SHARED_USER_ID, tokens.oauthToken, tokens.oauthTokenSecret);

      if (saved) {
        logger.info('OAuth tokens saved to Keychain');
      } else {
        logger.warn('Failed to save tokens to Keychain');
      }

      await ctx.reply('Authentication successful! Fetching portfolio data...');
      await this.fetchAndAnalyze(ctx);
    } catch (error) {
      logger.error('PIN verification failed:', error);

      if (error.status === 401) {
        await ctx.reply(
          'Invalid or expired PIN. Please try again:\n\n' +
          '1. Go back to the authorization link\n' +
          '2. Get a new PIN\n' +
          '3. Reply with the new PIN\n\n' +
          'Type /cancel to abort.'
        );
        ctx.updateTask('awaiting_pin');
      } else {
        await ctx.reply(`Verification failed: ${error.message}`);
        await this.cleanup(ctx);
      }
    }
  },

  /**
   * Fetch portfolio data and get Claude analysis (via MCP servers)
   */
  async fetchAndAnalyze(ctx) {
    try {
      ctx.updateTask('fetching_data');

      const envLabel = config.etrade.sandbox ? '🧪 SANDBOX' : '🔴 LIVE';

      // Fetch portfolio data via MCP (works for both sandbox and production)
      await ctx.reply(`Fetching portfolio data [${envLabel}]...`);

      const etradeClient = await getETradeClient();
      const summary = await etradeClient.callTool('get_portfolio_summary', {});
      const positions = await etradeClient.callTool('get_all_positions', {});

      // Save to cache for market updates
      try {
        const cacheData = {
          totalValue: summary.totalValue,
          accounts: summary.accounts,
          fetchedAt: summary.fetchedAt,
        };
        // Convert positions to the format expected by cache service
        cacheData.accounts = [{
          positions: positions.map(p => ({
            Product: { symbol: p.symbol },
            quantity: p.quantity,
            marketValue: p.marketValue,
            totalCost: p.costBasis,
            totalGain: p.gainLoss,
            totalGainPct: p.gainLossPct,
          })),
        }];

        await savePortfolioCache(cacheData);
        logger.info('Portfolio cache updated for market updates');
      } catch (cacheError) {
        logger.warn('Failed to save portfolio cache:', cacheError.message);
      }

      await ctx.reply(
        `Portfolio loaded [${envLabel}]:\n` +
        `- ${summary.accountCount} account(s)\n` +
        `- ${summary.positionCount} position(s)\n` +
        `- Total value: ${summary.totalValueFormatted}`
      );

      if (config.etrade.sandbox) {
        // Sandbox mode - just show positions, skip AI
        await ctx.reply('Sandbox mode - skipping AI analysis.');

        // Format and send positions
        const positionsText = positions.map(p =>
          `${p.symbol}: ${p.quantity} shares, ${p.portfolioWeight} of portfolio, ${p.gainLossPct >= 0 ? '+' : ''}${p.gainLossPct.toFixed(1)}%`
        ).join('\n');

        if (positionsText.length > 4000) {
          const chunks = this.splitMessage(positionsText, 3800);
          for (const chunk of chunks) {
            await ctx.reply(chunk);
          }
        } else {
          await ctx.reply(`Positions:\n${positionsText}`);
        }
      } else {
        // Production mode - use AI agent with MCP tools
        await ctx.reply(`🤖 Starting AI advisor agent [${envLabel}]...\n\nThe agent will analyze your portfolio using MCP servers.`);

        ctx.updateTask('analyzing');

        // Track tool calls for user feedback
        const toolUpdates = [];
        const onUpdate = (update) => {
          toolUpdates.push(update);
        };

        const { analysis, usage, toolCalls } = await runPortfolioAgent(onUpdate);

        // Show what the agent did
        if (toolUpdates.length > 0) {
          await ctx.reply(`Agent actions:\n${toolUpdates.join('\n')}`);
        }

        // Send the analysis (may need to split if too long)
        if (analysis.length > 4000) {
          const chunks = this.splitMessage(analysis, 3800);
          for (let i = 0; i < chunks.length; i++) {
            const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
            await ctx.reply(prefix + chunks[i]);
          }
        } else {
          await ctx.reply(analysis);
        }

        // Show token usage and tool calls
        const totalTokens = usage.inputTokens + usage.outputTokens;
        await ctx.reply(
          `📊 Agent stats:\n` +
          `• Tool calls: ${toolCalls}\n` +
          `• Tokens: ${usage.inputTokens.toLocaleString()} in + ${usage.outputTokens.toLocaleString()} out = ${totalTokens.toLocaleString()} total`
        );
      }

      await this.cleanup(ctx);
    } catch (error) {
      logger.error('Portfolio fetch/analysis error:', error);

      if (error.status === 401) {
        // Token expired, need re-auth
        await deleteTokens(SHARED_USER_ID);
        await ctx.reply('Session expired. Starting re-authentication...');
        await this.startAuthFlow(ctx);
      } else {
        await ctx.reply(`Error: ${error.message}`);
        await this.cleanup(ctx);
      }
    }
  },

  /**
   * Handle /portfolio logout subcommand
   */
  async handleLogout(ctx) {
    const deleted = await deleteTokens(SHARED_USER_ID);

    if (deleted) {
      await ctx.reply('E*TRADE tokens cleared. You will need to re-authenticate next time.');
    } else {
      await ctx.reply('No stored tokens found or error clearing them.');
    }

    ctx.completeTask();
  },

  /**
   * Split long message into chunks
   */
  splitMessage(text, maxLength) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline or space)
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint < maxLength * 0.5) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trimStart();
    }

    return chunks;
  },

  /**
   * Cleanup task resources
   */
  async cleanup(ctx) {
    userServices.delete(ctx.userId);
    ctx.completeTask();
  },
};
