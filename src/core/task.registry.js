import logger from '../utils/logger.js';

/**
 * Registry for all available tasks.
 * Tasks are self-contained modules with a standard interface.
 */
class TaskRegistry {
  constructor() {
    // Map of command -> task module
    this.tasks = new Map();
  }

  /**
   * Register a task
   * @param {object} task - Task module with command, description, start, onMessage, cleanup
   */
  register(task) {
    if (!task.command || !task.start || !task.onMessage) {
      throw new Error('Task must have command, start, and onMessage methods');
    }

    logger.info(`Registering task: ${task.command} - ${task.description || 'No description'}`);
    this.tasks.set(task.command, task);
  }

  /**
   * Get a task by command
   * @param {string} command - The command (e.g., '/invoice')
   * @returns {object|null} The task module or null
   */
  getTask(command) {
    return this.tasks.get(command) || null;
  }

  /**
   * Check if a command is registered
   * @param {string} command - The command to check
   * @returns {boolean}
   */
  hasTask(command) {
    return this.tasks.has(command);
  }

  /**
   * List all registered tasks
   * @returns {Array<{command: string, description: string}>}
   */
  listTasks() {
    const list = [];
    for (const [command, task] of this.tasks.entries()) {
      list.push({
        command,
        description: task.description || 'No description',
      });
    }
    return list;
  }

  /**
   * Get formatted help text for all tasks
   * @returns {string}
   */
  getTasksHelp() {
    const tasks = this.listTasks();
    if (tasks.length === 0) {
      return 'No tasks registered.';
    }

    return tasks
      .map(t => `${t.command} - ${t.description}`)
      .join('\n');
  }
}

// Export singleton instance
const taskRegistry = new TaskRegistry();
export default taskRegistry;
