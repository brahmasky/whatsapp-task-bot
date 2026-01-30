import { EventEmitter } from 'events';
import logger from '../../utils/logger.js';

/**
 * Gateway - Central message bus for multi-channel messaging.
 *
 * Routes messages between channels (WhatsApp, Telegram, CLI, etc.) and
 * the message router using an EventEmitter pattern.
 *
 * Message flow:
 * Channel → Gateway (normalized message) → MessageRouter → Gateway (response) → Channel
 */
class Gateway extends EventEmitter {
  constructor() {
    super();
    this.channels = new Map();
  }

  /**
   * Register a channel with the gateway.
   * @param {string} channelType - Unique identifier for the channel (e.g., 'whatsapp')
   * @param {BaseChannel} channel - The channel instance
   */
  registerChannel(channelType, channel) {
    if (this.channels.has(channelType)) {
      throw new Error(`Channel '${channelType}' is already registered`);
    }

    this.channels.set(channelType, channel);
    logger.info(`Registered channel: ${channelType}`);
  }

  /**
   * Unregister a channel from the gateway.
   * @param {string} channelType - The channel type to unregister
   */
  unregisterChannel(channelType) {
    this.channels.delete(channelType);
    logger.info(`Unregistered channel: ${channelType}`);
  }

  /**
   * Get a registered channel by type.
   * @param {string} channelType - The channel type
   * @returns {BaseChannel|undefined}
   */
  getChannel(channelType) {
    return this.channels.get(channelType);
  }

  /**
   * Handle an incoming message from a channel.
   * Emits a 'message' event with the normalized message.
   *
   * @param {NormalizedMessage} message - The normalized message
   */
  handleMessage(message) {
    logger.debug(`Gateway received message from ${message.channelType}:${message.userId}`);
    this.emit('message', message);
  }

  /**
   * Send a response back to a user via the appropriate channel.
   *
   * @param {string} channelType - The channel to send through
   * @param {Response} response - The response object
   */
  async send(channelType, response) {
    const channel = this.channels.get(channelType);

    if (!channel) {
      logger.error(`Cannot send: channel '${channelType}' not found`);
      throw new Error(`Channel '${channelType}' not registered`);
    }

    await channel.send(response);
  }

  /**
   * Create a send function bound to a specific channel.
   * Useful for creating context objects.
   *
   * @param {string} channelType - The channel type
   * @returns {Function} A function that sends responses to the specified channel
   */
  createSender(channelType) {
    return async (response) => {
      await this.send(channelType, response);
    };
  }

  /**
   * Initialize all registered channels.
   */
  async initialize() {
    logger.info('Initializing gateway...');

    for (const [channelType, channel] of this.channels) {
      logger.info(`Initializing channel: ${channelType}`);
      await channel.initialize();
    }

    logger.info('Gateway initialized');
  }

  /**
   * Shutdown all registered channels.
   */
  async shutdown() {
    logger.info('Shutting down gateway...');

    for (const [channelType, channel] of this.channels) {
      logger.info(`Shutting down channel: ${channelType}`);
      await channel.shutdown();
    }

    this.channels.clear();
    logger.info('Gateway shut down');
  }
}

// Export singleton instance
const gateway = new Gateway();
export default gateway;

// Also export class for testing
export { Gateway };

/**
 * @typedef {Object} NormalizedMessage
 * @property {string} id - Unique message ID
 * @property {string} channelType - The originating channel type (e.g., 'whatsapp')
 * @property {string} userId - User identifier (format: channelType:platformId)
 * @property {string} text - Message text content
 * @property {boolean} fromMe - Whether the message was sent by the bot user
 * @property {boolean} isGroup - Whether the message is from a group chat
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {Object} raw - Original platform-specific message data
 */

/**
 * @typedef {Object} TextResponse
 * @property {'text'} type - Response type
 * @property {string} userId - Target user identifier
 * @property {string} text - Text content to send
 */

/**
 * @typedef {Object} DocumentResponse
 * @property {'document'} type - Response type
 * @property {string} userId - Target user identifier
 * @property {string} filePath - Path to the file
 * @property {string} filename - Display filename
 * @property {string} mimetype - File MIME type
 * @property {string} [caption] - Optional caption
 */

/**
 * @typedef {TextResponse|DocumentResponse} Response
 */
