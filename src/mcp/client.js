/**
 * MCP Client Wrapper
 *
 * Spawns MCP servers and provides a simple interface to call their tools.
 * Used by the WhatsApp bot to communicate with MCP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * MCP Server Client
 *
 * Manages connection to an MCP server via stdio transport.
 */
export class MCPServerClient {
  constructor(name, serverPath) {
    this.name = name;
    this.serverPath = serverPath;
    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  /**
   * Connect to the MCP server (spawns it as a child process)
   */
  async connect() {
    if (this.connected) {
      return;
    }

    logger.info(`Starting MCP server: ${this.name} from ${this.serverPath}`);

    // Create transport (spawns the server process internally)
    this.transport = new StdioClientTransport({
      command: 'node',
      args: [this.serverPath],
      env: { ...process.env },
    });

    this.client = new Client({
      name: `whatsapp-bot-${this.name}-client`,
      version: '1.0.0',
    });

    // Connect
    await this.client.connect(this.transport);
    this.connected = true;

    logger.info(`Connected to MCP server: ${this.name}`);
  }

  /**
   * Call a tool on the MCP server
   *
   * @param {string} toolName - Name of the tool to call
   * @param {object} args - Tool arguments
   * @returns {Promise<any>} - Tool result (parsed from JSON)
   */
  async callTool(toolName, args = {}) {
    if (!this.connected) {
      await this.connect();
    }

    logger.debug(`Calling MCP tool: ${this.name}/${toolName}`, args);

    const result = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    // Parse the result (MCP returns content array)
    const textContent = result.content?.find(c => c.type === 'text');
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return result;
  }

  /**
   * List available tools on the server
   */
  async listTools() {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools || [];
  }

  /**
   * Disconnect from the server
   */
  async disconnect() {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
      logger.info(`Disconnected from MCP server: ${this.name}`);
    }
  }
}

// Pre-configured clients for our servers
const ETRADE_SERVER_PATH = path.join(__dirname, 'etrade-server.js');
const RESEARCH_SERVER_PATH = path.join(__dirname, 'stock-research-server.js');

// Singleton instances
let etradeClient = null;
let researchClient = null;

/**
 * Get the E*TRADE MCP client (singleton)
 */
export async function getETradeClient() {
  if (!etradeClient) {
    etradeClient = new MCPServerClient('etrade', ETRADE_SERVER_PATH);
    await etradeClient.connect();
  }
  return etradeClient;
}

/**
 * Get the Stock Research MCP client (singleton)
 */
export async function getResearchClient() {
  if (!researchClient) {
    researchClient = new MCPServerClient('stock-research', RESEARCH_SERVER_PATH);
    await researchClient.connect();
  }
  return researchClient;
}

/**
 * Disconnect all MCP clients
 */
export async function disconnectAll() {
  if (etradeClient) {
    await etradeClient.disconnect();
    etradeClient = null;
  }
  if (researchClient) {
    await researchClient.disconnect();
    researchClient = null;
  }
}

export default {
  MCPServerClient,
  getETradeClient,
  getResearchClient,
  disconnectAll,
};
