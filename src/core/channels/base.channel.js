/**
 * BaseChannel - Abstract base class defining the channel interface.
 *
 * All channel implementations (WhatsApp, Telegram, CLI, etc.) should extend
 * this class and implement the required methods.
 */
class BaseChannel {
  /**
   * Create a new channel.
   * @param {Gateway} gateway - The gateway instance to connect to
   */
  constructor(gateway) {
    if (new.target === BaseChannel) {
      throw new Error('BaseChannel is abstract and cannot be instantiated directly');
    }

    this.gateway = gateway;
    this.channelType = 'base';
  }

  /**
   * Initialize the channel connection.
   * Called by the gateway during startup.
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Send a response to a user.
   *
   * @abstract
   * @param {Response} response - The response to send
   * @returns {Promise<void>}
   */
  async send(response) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Shutdown the channel gracefully.
   * Called by the gateway during shutdown.
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async shutdown() {
    throw new Error('shutdown() must be implemented by subclass');
  }

  /**
   * Forward a normalized message to the gateway.
   * Helper method for subclasses to use when receiving messages.
   *
   * @param {NormalizedMessage} message - The normalized message
   */
  forwardToGateway(message) {
    this.gateway.handleMessage(message);
  }

  /**
   * Create a normalized user ID that includes the channel type.
   * Format: channelType:platformUserId
   *
   * @param {string} platformUserId - The platform-specific user ID
   * @returns {string} The normalized user ID
   */
  normalizeUserId(platformUserId) {
    return `${this.channelType}:${platformUserId}`;
  }

  /**
   * Extract the platform-specific user ID from a normalized user ID.
   *
   * @param {string} normalizedUserId - The normalized user ID
   * @returns {string} The platform-specific user ID
   */
  extractPlatformUserId(normalizedUserId) {
    const prefix = `${this.channelType}:`;
    if (normalizedUserId.startsWith(prefix)) {
      return normalizedUserId.slice(prefix.length);
    }
    return normalizedUserId;
  }
}

export default BaseChannel;
