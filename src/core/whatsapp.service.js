import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { readFileSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

class WhatsAppService {
  constructor() {
    this.socket = null;
    this.isReady = false;
    this.messageHandler = null;
  }

  /**
   * Initialize WhatsApp connection using Baileys
   */
  async initialize() {
    logger.info('Initializing WhatsApp client (Baileys)...');

    // Setup authentication state
    const authPath = path.join(process.cwd(), '.baileys_auth');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // Create socket connection (with silent logger to reduce noise)
    this.socket = makeWASocket({
      auth: state,
      browser: ['WhatsApp Task Bot', 'Chrome', '120.0.0'],
      logger: {
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg) => logger.error('Baileys error:', msg),
        fatal: (msg) => logger.error('Baileys fatal:', msg),
        child: () => ({
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          fatal: () => {},
        }),
      },
    });

    // Handle credential updates
    this.socket.ev.on('creds.update', saveCreds);

    // Handle connection updates
    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n'); // Add spacing
        qrcode.generate(qr, { small: true });
        console.log('\n'); // Add spacing
        logger.info('Scan the QR code above with WhatsApp on your phone');
        logger.info('Go to WhatsApp > Settings > Linked Devices > Link a Device');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn('Connection closed:', {
          reason: lastDisconnect?.error?.message,
          reconnecting: shouldReconnect
        });

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.initialize();
        } else {
          logger.error('Logged out. Please delete .baileys_auth folder and restart.');
        }
      }

      if (connection === 'open') {
        this.isReady = true;
        logger.success('WhatsApp Task Bot is ready!');
        logger.info('Waiting for messages...');
      }
    });

    // Handle incoming messages
    this.socket.ev.on('messages.upsert', async (messageUpdate) => {
      const { messages, type } = messageUpdate;

      // Only process new messages (not history sync)
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Skip if no message handler registered
        if (!this.messageHandler) continue;

        // Skip status updates
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // Extract message info
        const messageInfo = {
          from: msg.key.remoteJid,
          fromMe: msg.key.fromMe,
          id: msg.key.id,
          isGroupMsg: msg.key.remoteJid?.endsWith('@g.us'),
          body: this.extractMessageText(msg),
          pushName: msg.pushName,
          timestamp: msg.messageTimestamp,
          _original: msg,
        };

        // Create a message object with reply helper
        const messageObj = {
          ...messageInfo,
          reply: async (text) => {
            await this.sendMessage(messageInfo.from, text, msg);
          },
        };

        // Call the message handler
        this.messageHandler(messageObj);
      }
    });

    logger.info('Waiting for WhatsApp connection...');
  }

  /**
   * Extract text content from message
   */
  extractMessageText(msg) {
    const messageContent = msg.message;
    if (!messageContent) return '';

    // Handle different message types
    if (messageContent.conversation) {
      return messageContent.conversation;
    }
    if (messageContent.extendedTextMessage?.text) {
      return messageContent.extendedTextMessage.text;
    }
    if (messageContent.imageMessage?.caption) {
      return messageContent.imageMessage.caption;
    }
    if (messageContent.videoMessage?.caption) {
      return messageContent.videoMessage.caption;
    }

    return '';
  }

  /**
   * Send a text message
   */
  async sendMessage(to, text, quotedMsg = null) {
    if (!this.socket) {
      throw new Error('WhatsApp not connected');
    }

    const options = quotedMsg ? { quoted: quotedMsg } : {};
    await this.socket.sendMessage(to, { text }, options);
  }

  /**
   * Send a document (file)
   * @param {string} to - Recipient JID
   * @param {string} filePath - Path to the file
   * @param {string} filename - Display filename
   * @param {string} mimetype - File MIME type (optional)
   * @param {string} caption - Caption text (optional)
   */
  async sendDocument(to, filePath, filename, mimetype = 'application/pdf', caption = '') {
    if (!this.socket) {
      throw new Error('WhatsApp not connected');
    }

    const fileBuffer = readFileSync(filePath);

    await this.socket.sendMessage(to, {
      document: fileBuffer,
      mimetype: mimetype,
      fileName: filename,
      caption: caption,
    });
  }

  /**
   * Register message handler
   */
  onMessage(handler) {
    this.messageHandler = handler;
  }

  /**
   * Check if client is ready
   */
  isClientReady() {
    return this.isReady;
  }

  /**
   * Gracefully shutdown
   */
  async shutdown() {
    if (this.socket) {
      logger.info('Shutting down WhatsApp client...');
      this.socket.end();
      logger.info('WhatsApp client shut down successfully');
    }
  }
}

// Create singleton instance
const whatsappService = new WhatsAppService();

export default whatsappService;
