import gateway from './core/gateway/index.js';
import WhatsAppChannel from './core/channels/whatsapp.channel.js';
import MessageRouter from './core/message.router.js';
import taskRegistry from './core/task.registry.js';
import stateManager from './core/state.manager.js';
import { disconnectAll as disconnectMCPClients } from './mcp/client.js';
import config from './config/index.js';
import logger from './utils/logger.js';

// Import tasks
import invoiceTask from './tasks/invoice/index.js';
import systemTask from './tasks/system/index.js';
import portfolioTask from './tasks/portfolio/index.js';

/**
 * WhatsApp Task Bot
 *
 * An extensible bot that handles various automated tasks triggered via WhatsApp commands.
 * Uses a gateway architecture to support multiple messaging channels.
 */

async function main() {
  logger.info('Starting WhatsApp Task Bot...');

  // Register tasks
  taskRegistry.register(invoiceTask);
  taskRegistry.register(systemTask);
  taskRegistry.register(portfolioTask);
  logger.info(`Registered ${taskRegistry.listTasks().length} task(s)`);

  // Create WhatsApp channel and register with gateway
  const whatsappChannel = new WhatsAppChannel(gateway);
  gateway.registerChannel('whatsapp', whatsappChannel);

  // Create message router connected to gateway
  const router = new MessageRouter(gateway);

  // Wire gateway messages to router
  gateway.on('message', async (message) => {
    try {
      await router.handleMessage(message);
    } catch (error) {
      logger.error('Error handling message:', { error: error.message });
    }
  });

  // Setup periodic cleanup of stale tasks (every 5 minutes)
  const cleanupIntervalMs = 5 * 60 * 1000;
  const maxTaskAgeMs = config.timeouts.smsMinutes * 60 * 1000 * 2; // 2x SMS timeout

  setInterval(() => {
    const cleaned = stateManager.cleanupStaleTasks(maxTaskAgeMs);
    for (const { userId, taskName } of cleaned) {
      logger.warn(`Cleaned up stale task '${taskName}' for user ${userId}`);
    }
  }, cleanupIntervalMs);

  // Initialize gateway (which initializes all channels)
  await gateway.initialize();

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);

    // Cleanup all active tasks
    const activeTasks = stateManager.getAllActiveTasks();
    for (const { userId, task } of activeTasks) {
      const taskModule = taskRegistry.getTask(task);
      if (taskModule?.cleanup) {
        try {
          await taskModule.cleanup({ userId, completeTask: () => stateManager.clearTask(userId) });
        } catch (error) {
          logger.error(`Error cleaning up task '${task}':`, { error: error.message });
        }
      }
      stateManager.clearTask(userId);
    }

    // Disconnect MCP clients
    await disconnectMCPClients();

    // Shutdown gateway (which shuts down all channels)
    await gateway.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run
main().catch((error) => {
  logger.error('Fatal error:', { error: error.message, stack: error.stack });
  process.exit(1);
});
