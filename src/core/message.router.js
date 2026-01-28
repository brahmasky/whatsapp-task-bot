import logger from '../utils/logger.js';
import stateManager from './state.manager.js';
import taskRegistry from './task.registry.js';
import config from '../config/index.js';

/**
 * Routes incoming messages to appropriate handlers.
 * - If user has active task → route to task handler
 * - If message is a command → start task or run global command
 * - Otherwise → ignore
 */
class MessageRouter {
  constructor(whatsappService) {
    this.whatsapp = whatsappService;
  }

  /**
   * Check if user is allowed to use the bot
   * @param {object} message - The message object
   * @returns {boolean}
   */
  isAllowedUser(message) {
    // Always allow self-messages
    if (message.fromMe) {
      return true;
    }

    // Check allowed users list
    if (config.bot.allowedUsers.length > 0) {
      const phoneNumber = message.from?.split('@')[0];
      return config.bot.allowedUsers.includes(phoneNumber);
    }

    // Default: only self-messages allowed
    return false;
  }

  /**
   * Handle an incoming message
   * @param {object} message - The message object from WhatsApp service
   */
  async handleMessage(message) {
    const { from, body, fromMe } = message;

    // Skip empty messages
    if (!body || body.trim() === '') {
      return;
    }

    // Check if user is allowed
    if (!this.isAllowedUser(message)) {
      logger.debug(`Ignoring message from unauthorized user: ${from}`);
      return;
    }

    const text = body.trim();
    const userId = from;

    logger.debug(`Message from ${fromMe ? 'self' : from}: ${text.substring(0, 50)}...`);

    // Check if user has an active task
    if (stateManager.hasActiveTask(userId)) {
      await this.routeToActiveTask(userId, message, text);
      return;
    }

    // Check if message is a command
    if (text.startsWith('/')) {
      await this.handleCommand(userId, message, text);
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
      await message.reply('Something went wrong. Your task has been cancelled.');
      return;
    }

    // Create context for task handler
    const ctx = this.createContext(userId, message);

    try {
      await task.onMessage(ctx, text);
    } catch (error) {
      logger.error(`Error in task '${taskName}' handler:`, { error: error.message });
      await message.reply(`Error: ${error.message}\nTask cancelled.`);
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
    await message.reply(`Unknown command: ${command}\nType /help for available commands.`);
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
      await message.reply(`Failed to start task: ${error.message}`);
      await this.cleanupTask(userId, task, ctx);
    }
  }

  /**
   * Create context object for task handlers
   */
  createContext(userId, message) {
    return {
      userId,
      message,
      reply: (text) => message.reply(text),
      sendDocument: (filePath, filename, mimetype, caption) =>
        this.whatsapp.sendDocument(userId, filePath, filename, mimetype, caption),

      // State management
      getState: () => stateManager.getState(userId),
      getTaskData: () => stateManager.getTaskData(userId),
      updateTask: (state, data) => stateManager.updateTask(userId, state, data),
      completeTask: () => stateManager.clearTask(userId),
    };
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

    await message.reply(help);
  }

  /**
   * Show available tasks
   */
  async showTasks(message) {
    const tasks = taskRegistry.listTasks();

    if (tasks.length === 0) {
      await message.reply('No tasks are registered.');
      return;
    }

    const taskList = tasks
      .map(t => `${t.command} - ${t.description}`)
      .join('\n');

    await message.reply(`*Available Tasks:*\n${taskList}`);
  }

  /**
   * Cancel current task
   */
  async cancelTask(userId, message) {
    if (!stateManager.hasActiveTask(userId)) {
      await message.reply('No active task to cancel.');
      return;
    }

    const taskName = stateManager.getActiveTask(userId);
    const task = taskRegistry.getTask(taskName);
    const ctx = this.createContext(userId, message);

    await this.cleanupTask(userId, task, ctx);
    await message.reply(`Task '${taskName}' cancelled.`);
    logger.info(`Task '${taskName}' cancelled by user ${userId}`);
  }

  /**
   * Show current task status
   */
  async showStatus(userId, message) {
    const state = stateManager.getState(userId);

    if (!state) {
      await message.reply('No active task.');
      return;
    }

    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    await message.reply(
      `*Current Task:* ${state.activeTask}\n` +
      `*State:* ${state.taskState}\n` +
      `*Running for:* ${elapsed} seconds`
    );
  }
}

export default MessageRouter;
