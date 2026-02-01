import BaseChannel from './base.channel.js';
import whatsappService from '../whatsapp.service.js';
import logger from '../../utils/logger.js';

/**
 * WhatsAppChannel - Bridges WhatsApp (Baileys) to the gateway.
 *
 * Translates WhatsApp messages to normalized format and
 * gateway responses back to WhatsApp API calls.
 */
class WhatsAppChannel extends BaseChannel {
  constructor(gateway) {
    super(gateway);
    this.channelType = 'whatsapp';
    this.service = whatsappService;
  }

  /**
   * Initialize the WhatsApp connection.
   */
  async initialize() {
    // Setup message handler to forward messages to gateway
    this.service.onMessage((message) => {
      this.handleIncomingMessage(message);
    });

    // Initialize WhatsApp service (Baileys connection)
    await this.service.initialize();
  }

  /**
   * Handle incoming WhatsApp message and forward to gateway.
   *
   * @param {object} message - WhatsApp message from Baileys
   */
  handleIncomingMessage(message) {
    const normalizedMessage = this.normalizeMessage(message);
    this.forwardToGateway(normalizedMessage);
  }

  /**
   * Convert WhatsApp message to normalized format.
   *
   * @param {object} message - WhatsApp message from Baileys
   * @returns {NormalizedMessage} Normalized message
   */
  normalizeMessage(message) {
    return {
      id: message.id,
      channelType: this.channelType,
      userId: this.normalizeUserId(message.from),
      text: message.body || '',
      fromMe: message.fromMe,
      isGroup: message.isGroupMsg,
      timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
      raw: message,
    };
  }

  /**
   * Send a response via WhatsApp.
   *
   * @param {Response} response - The response to send
   */
  async send(response) {
    // Extract platform user ID from normalized format
    const platformUserId = this.extractPlatformUserId(response.userId);

    switch (response.type) {
      case 'text':
        await this.sendText(platformUserId, response.text, response.quotedMessage);
        break;

      case 'document':
        await this.sendDocument(
          platformUserId,
          response.filePath,
          response.filename,
          response.mimetype,
          response.caption
        );
        break;

      default:
        logger.warn(`Unknown response type: ${response.type}`);
    }
  }

  /**
   * Send a text message via WhatsApp.
   *
   * @param {string} to - WhatsApp JID
   * @param {string} text - Message text
   * @param {object} [quotedMsg] - Optional message to quote
   */
  async sendText(to, text, quotedMsg = null) {
    await this.service.sendMessage(to, text, quotedMsg);
  }

  /**
   * Send a document via WhatsApp.
   *
   * @param {string} to - WhatsApp JID
   * @param {string} filePath - Path to file
   * @param {string} filename - Display filename
   * @param {string} mimetype - MIME type
   * @param {string} [caption] - Optional caption
   */
  async sendDocument(to, filePath, filename, mimetype, caption) {
    await this.service.sendDocument(to, filePath, filename, mimetype, caption);
  }

  /**
   * Check if WhatsApp is connected.
   *
   * @returns {boolean}
   */
  isReady() {
    return this.service.isClientReady();
  }

  /**
   * Shutdown the WhatsApp connection.
   */
  async shutdown() {
    await this.service.shutdown();
  }
}

export default WhatsAppChannel;
