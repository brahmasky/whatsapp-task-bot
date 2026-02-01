import logger from '../utils/logger.js';
import stateManager from './state.manager.js';
import taskRegistry from './task.registry.js';
import config from '../config/index.js';

/**
 * Routes incoming messages to appropriate handlers.
 * - If user has active task → route to task handler
 * - If message is a command → start task or run global command
 * - Otherwise → ignore
 *
 * Works with normalized messages from the gateway.
 */
class MessageRouter {
  constructor(gateway) {
    this.gateway = gateway;
  }

  /**
   * Check if user is allowed to use the bot
   * @param {NormalizedMessage} message - The normalized message
   * @returns {boolean}
   */
  isAllowedUser(message) {
    // Always allow self-messages
    if (message.fromMe) {
      return true;
    }

    // Check allowed users list
    if (config.bot.allowedUsers.length > 0) {
      // Extract phone number from the platform-specific part of userId
      // Format: whatsapp:123456@s.whatsapp.net → 123456
      const platformUserId = message.userId.split(':')[1] || message.userId;
      const phoneNumber = platformUserId.split('@')[0];
      return config.bot.allowedUsers.includes(phoneNumber);
    }

    // Default: only self-messages allowed
    return false;
  }

  /**
   * Handle an incoming normalized message
   * @param {NormalizedMessage} message - The normalized message from gateway
   */
  async handleMessage(message) {
    const { userId, text, fromMe } = message;

    // Skip empty messages
    if (!text || text.trim() === '') {
      return;
    }

    // Check if user is allowed
    if (!this.isAllowedUser(message)) {
      logger.debug(`Ignoring message from unauthorized user: ${userId}`);
      return;
    }

    const trimmedText = text.trim();

    const state = stateManager.getState(userId);
    const logText = state?.taskState === 'awaiting_password' ? '[password]' : trimmedText.substring(0, 50);
    logger.debug(`Message from ${fromMe ? 'self' : userId}: ${logText}...`);

    // Global commands always take priority, even during an active task
    if (trimmedText.startsWith('/')) {
      const command = trimmedText.split(/\s+/)[0].toLowerCase();
      if (['/help', '/tasks', '/cancel', '/status'].includes(command)) {
        await this.handleCommand(userId, message, trimmedText);
        return;
      }
    }

    // Check if user has an active task
    if (stateManager.hasActiveTask(userId)) {
      await this.routeToActiveTask(userId, message, trimmedText);
      return;
    }

    // Check if message is a command
    if (trimmedText.startsWith('/')) {
      await this.handleCommand(userId, message, trimmedText);
      return;
    }

    // No active task and not a command - ignore
    logger.debug(`Ignoring non-command message from ${userId}`);
  }

  /**
   * Route message to the user's active task
   */
  async routeToActiveTask(userId, message, text) {
    const taskName = stateManager.getActiveTask(userId);
    const task = taskRegistry.getTask(taskName);

    if (!task) {
      logger.error(`Active task '${taskName}' not found in registry`);
      stateManager.clearTask(userId);
      await this.reply(message, 'Something went wrong. Your task has been cancelled.');
      return;
    }

    // Create context for task handler
    const ctx = this.createContext(userId, message);

    try {
      await task.onMessage(ctx, text);
    } catch (error) {
      logger.error(`Error in task '${taskName}' handler:`, { error: error.message });
      await this.reply(message, `Error: ${error.message}\nTask cancelled.`);
      await this.cleanupTask(userId, task, ctx);
    }
  }

  /**
   * Handle a command message
   */
  async handleCommand(userId, message, text) {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Global commands
    switch (command) {
      case '/help':
        await this.showHelp(message);
        return;

      case '/tasks':
        await this.showTasks(message);
        return;

      case '/cancel':
        await this.cancelTask(userId, message);
        return;

      case '/status':
        await this.showStatus(userId, message);
        return;
    }

    // Check if command is a registered task
    if (taskRegistry.hasTask(command)) {
      await this.startTask(userId, message, command, args);
      return;
    }

    // Unknown command
    await this.reply(message, `Unknown command: ${command}\nType /help for available commands.`);
  }

  /**
   * Start a new task
   */
  async startTask(userId, message, command, args) {
    const task = taskRegistry.getTask(command);

    // Initialize state for this task
    stateManager.startTask(userId, command);

    // Create context
    const ctx = this.createContext(userId, message);

    try {
      logger.info(`Starting task '${command}' for user ${userId}`);
      await task.start(ctx, args);
    } catch (error) {
      logger.error(`Error starting task '${command}':`, { error: error.message });
      await this.reply(message, `Failed to start task: ${error.message}`);
      await this.cleanupTask(userId, task, ctx);
    }
  }

  /**
   * Create context object for task handlers.
   * The context provides a channel-agnostic interface for tasks.
   */
  createContext(userId, message) {
    const { channelType } = message;

    return {
      userId,
      message,

      // Send text reply
      reply: (text) => this.reply(message, text),

      // Send document
      sendDocument: (filePath, filename, mimetype, caption) =>
        this.gateway.send(channelType, {
          type: 'document',
          userId,
          filePath,
          filename,
          mimetype: mimetype || 'application/pdf',
          caption: caption || '',
        }),

      // State management
      getState: () => stateManager.getState(userId),
      getTaskData: () => stateManager.getTaskData(userId),
      updateTask: (state, data) => stateManager.updateTask(userId, state, data),
      completeTask: () => stateManager.clearTask(userId),
    };
  }

  /**
   * Send a text reply to a message
   */
  async reply(message, text) {
    await this.gateway.send(message.channelType, {
      type: 'text',
      userId: message.userId,
      text,
      quotedMessage: message.raw?._original || null,
    });
  }

  /**
   * Cleanup a task (call cleanup handler and clear state)
   */
  async cleanupTask(userId, task, ctx) {
    try {
      if (task.cleanup) {
        await task.cleanup(ctx);
      }
    } catch (error) {
      logger.error(`Error in task cleanup:`, { error: error.message });
    }
    stateManager.clearTask(userId);
  }

  /**
   * Show help message
   */
  async showHelp(message) {
    const tasksHelp = taskRegistry.getTasksHelp();

    const help = `*WhatsApp Task Bot*

*Global Commands:*
/help - Show this help message
/tasks - List available tasks
/cancel - Cancel current task
/status - Show current task status

*Available Tasks:*
${tasksHelp}

To start a task, type its command (e.g., /invoice)`;

    await this.reply(message, help);
  }

  /**
   * Show available tasks
   */
  async showTasks(message) {
    const tasks = taskRegistry.listTasks();

    if (tasks.length === 0) {
      await this.reply(message, 'No tasks are registered.');
      return;
    }

    const taskList = tasks
      .map(t => `${t.command} - ${t.description}`)
      .join('\n');

    await this.reply(message, `*Available Tasks:*\n${taskList}`);
  }

  /**
   * Cancel current task
   */
  async cancelTask(userId, message) {
    if (!stateManager.hasActiveTask(userId)) {
      await this.reply(message, 'No active task to cancel.');
      return;
    }

    const taskName = stateManager.getActiveTask(userId);
    const task = taskRegistry.getTask(taskName);
    const ctx = this.createContext(userId, message);

    await this.cleanupTask(userId, task, ctx);
    await this.reply(message, `Task '${taskName}' cancelled.`);
    logger.info(`Task '${taskName}' cancelled by user ${userId}`);
  }

  /**
   * Show current task status
   */
  async showStatus(userId, message) {
    const state = stateManager.getState(userId);

    if (!state) {
      await this.reply(message, 'No active task.');
      return;
    }

    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    await this.reply(
      message,
      `*Current Task:* ${state.activeTask}\n` +
      `*State:* ${state.taskState}\n` +
      `*Running for:* ${elapsed} seconds`
    );
  }
}

export default MessageRouter;
