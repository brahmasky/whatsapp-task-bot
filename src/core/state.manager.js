import logger from '../utils/logger.js';

/**
 * Manages per-user state for active tasks.
 * Each user can have one active task at a time.
 */
class StateManager {
  constructor() {
    // Map of userId -> { activeTask, taskState, data, startedAt }
    this.userStates = new Map();
  }

  /**
   * Get the current state for a user
   * @param {string} userId - The user's JID
   * @returns {object|null} The user's state or null if no active task
   */
  getState(userId) {
    return this.userStates.get(userId) || null;
  }

  /**
   * Check if user has an active task
   * @param {string} userId - The user's JID
   * @returns {boolean}
   */
  hasActiveTask(userId) {
    const state = this.userStates.get(userId);
    return state !== undefined && state.activeTask !== null;
  }

  /**
   * Get the active task name for a user
   * @param {string} userId - The user's JID
   * @returns {string|null}
   */
  getActiveTask(userId) {
    const state = this.userStates.get(userId);
    return state?.activeTask || null;
  }

  /**
   * Start a new task for a user
   * @param {string} userId - The user's JID
   * @param {string} taskName - The task command (e.g., '/invoice')
   * @param {object} initialData - Initial task data
   */
  startTask(userId, taskName, initialData = {}) {
    logger.debug(`Starting task '${taskName}' for user ${userId}`);
    this.userStates.set(userId, {
      activeTask: taskName,
      taskState: 'started',
      data: initialData,
      startedAt: Date.now(),
    });
  }

  /**
   * Update the task state for a user
   * @param {string} userId - The user's JID
   * @param {string} newState - New task state
   * @param {object} newData - Data to merge into existing data
   */
  updateTask(userId, newState, newData = {}) {
    const current = this.userStates.get(userId);
    if (!current) {
      logger.warn(`Cannot update task for user ${userId}: no active task`);
      return;
    }

    this.userStates.set(userId, {
      ...current,
      taskState: newState,
      data: { ...current.data, ...newData },
    });
  }

  /**
   * Get task data for a user
   * @param {string} userId - The user's JID
   * @returns {object}
   */
  getTaskData(userId) {
    const state = this.userStates.get(userId);
    return state?.data || {};
  }

  /**
   * Clear the task state for a user
   * @param {string} userId - The user's JID
   */
  clearTask(userId) {
    const state = this.userStates.get(userId);
    if (state) {
      logger.debug(`Clearing task '${state.activeTask}' for user ${userId}`);
    }
    this.userStates.delete(userId);
  }

  /**
   * Check for and cleanup stale tasks (tasks that have been running too long)
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @returns {Array<{userId: string, taskName: string}>} List of cleaned up tasks
   */
  cleanupStaleTasks(maxAgeMs) {
    const now = Date.now();
    const cleaned = [];

    for (const [userId, state] of this.userStates.entries()) {
      if (now - state.startedAt > maxAgeMs) {
        cleaned.push({ userId, taskName: state.activeTask });
        this.userStates.delete(userId);
      }
    }

    if (cleaned.length > 0) {
      logger.info(`Cleaned up ${cleaned.length} stale task(s)`);
    }

    return cleaned;
  }

  /**
   * Get all active tasks (for debugging/stats)
   * @returns {Array<{userId: string, task: string, state: string, startedAt: number}>}
   */
  getAllActiveTasks() {
    const tasks = [];
    for (const [userId, state] of this.userStates.entries()) {
      tasks.push({
        userId,
        task: state.activeTask,
        state: state.taskState,
        startedAt: state.startedAt,
      });
    }
    return tasks;
  }
}

// Export singleton instance
const stateManager = new StateManager();
export default stateManager;
