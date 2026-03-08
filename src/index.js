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
import marketTask, { initScheduler } from './tasks/market/index.js';
import { stopScheduler, setTargetUser } from './tasks/market/scheduler.js';
import researchTask from './tasks/research/index.js';
import tradeTask, { initAlertMonitor, stopAlertMonitor } from './tasks/trade/index.js';
import devTask from './tasks/dev/index.js';
import sellTask from './tasks/sell/index.js';

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
  taskRegistry.register(marketTask);
  taskRegistry.register(researchTask);
  taskRegistry.register(tradeTask);
  taskRegistry.register(devTask);
  taskRegistry.register(sellTask);
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

  // Capture the actual JID of the primary user from their first self-message.
  // The scheduler is initialized with a @s.whatsapp.net JID constructed from
  // ALLOWED_USERS, but newer multi-device WhatsApp uses @lid JIDs that don't
  // match. Updating on first self-message ensures scheduled sends use the
  // correct JID going forward.
  const onFirstSelfMessage = (message) => {
    if (message.fromMe) {
      router.setSelfJid(message.userId);
      if (schedulerUserId) setTargetUser(message.userId);
      gateway.off('message', onFirstSelfMessage);
    }
  };
  gateway.off('message', onFirstSelfMessage); // no-op guard
  gateway.on('message', onFirstSelfMessage);

  // Setup periodic cleanup of stale tasks (every 5 minutes)
  const cleanupIntervalMs = 5 * 60 * 1000;
  const maxTaskAgeMs = config.timeouts.smsMinutes * 60 * 1000 * 2; // 2x SMS timeout

  // Restore task states from disk (crash/restart recovery)
  const restored = stateManager.restoreState(maxTaskAgeMs);
  if (restored > 0) logger.info(`Restored ${restored} task state(s) from disk`);

  // Initialize gateway (which initializes all channels)
  await gateway.initialize();

  // Initialize market update scheduler
  // Send to first allowed user (self) for scheduled updates
  const schedulerUserId = config.bot.allowedUsers?.[0]
    ? `whatsapp:${config.bot.allowedUsers[0]}@s.whatsapp.net`
    : null;

  let sendFn = null;
  if (schedulerUserId) {
    sendFn = gateway.createSender('whatsapp');
    initScheduler(sendFn, schedulerUserId, () => whatsappChannel.isReady());
    initAlertMonitor(sendFn);
  } else {
    logger.warn('No allowed users configured - market scheduler and trade alerts disabled');
  }

  setInterval(() => {
    // Warn tasks approaching timeout (2 min before expiry)
    if (sendFn) {
      const WARN_BEFORE_MS = 2 * 60 * 1000;
      for (const { userId, startedAt } of stateManager.getAllActiveTasks()) {
        const remaining = maxTaskAgeMs - (Date.now() - startedAt);
        if (remaining > 0 && remaining < WARN_BEFORE_MS) {
          const st = stateManager.getState(userId);
          if (st && !st.data?._timeoutWarned) {
            stateManager.updateTask(userId, st.taskState, { _timeoutWarned: true });
            sendFn({
              type: 'text',
              userId,
              text: `Your active task (${st.activeTask}) will auto-cancel in ~${Math.ceil(remaining / 60000)} min due to inactivity.`,
            });
          }
        }
      }
    }
    // Cleanup stale tasks
    const cleaned = stateManager.cleanupStaleTasks(maxTaskAgeMs);
    for (const { userId, taskName } of cleaned) {
      logger.warn(`Cleaned up stale task '${taskName}' for user ${userId}`);
    }
  }, cleanupIntervalMs);

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

    // Stop market scheduler and trade alert monitor
    stopScheduler();
    stopAlertMonitor();

    // Disconnect MCP clients
    await disconnectMCPClients();

    // Shutdown gateway (which shuts down all channels)
    await gateway.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Catch unhandled promise rejections and uncaught exceptions so crashes are
// always logged (e.g. a failed reconnection attempt silently killing the process)
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', {
    error: reason?.message ?? String(reason),
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Run
main().catch((error) => {
  logger.error('Fatal error:', { error: error.message, stack: error.stack });
  process.exit(1);
});
