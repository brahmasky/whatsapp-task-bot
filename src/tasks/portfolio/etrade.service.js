import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * E*TRADE OAuth1 + API Service
 *
 * Ported from Python reference implementation (auth_flow.py, etrade_client.py)
 * Uses PIN-based OAuth1 flow for authentication.
 */

class ETradeError extends Error {
  constructor(message, status, payload) {
    super(`[${status}] ${message}`);
    this.name = 'ETradeError';
    this.status = status;
    this.payload = payload || {};
  }
}

export class ETradeService {
  constructor() {
    this.consumerKey = config.etrade.consumerKey;
    this.consumerSecret = config.etrade.consumerSecret;
    this.baseUrl = config.etrade.sandbox
      ? 'https://apisb.etrade.com'
      : 'https://api.etrade.com';

    // OAuth1 helper
    this.oauth = new OAuth({
      consumer: {
        key: this.consumerKey,
        secret: this.consumerSecret,
      },
      signature_method: 'HMAC-SHA1',
      hash_function: (baseString, key) =>
        crypto.createHmac('sha1', key).update(baseString).digest('base64'),
    });

    // Token storage (set after authentication)
    this.oauthToken = null;
    this.oauthTokenSecret = null;

    // Request token (temporary, used during PIN flow)
    this.requestToken = null;
    this.requestTokenSecret = null;
  }

  /**
   * Sets access tokens (from keychain storage)
   */
  setTokens(oauthToken, oauthTokenSecret) {
    this.oauthToken = oauthToken;
    this.oauthTokenSecret = oauthTokenSecret;
  }

  /**
   * Step 1: Get request token and authorization URL
   * @returns {Promise<{authUrl: string}>}
   */
  async getAuthorizationUrl() {
    const requestTokenUrl = `${this.baseUrl}/oauth/request_token`;

    const requestData = {
      url: requestTokenUrl,
      method: 'POST',
      data: { oauth_callback: 'oob' },
    };

    // Get OAuth parameters including oauth_callback in the signature
    const oauthParams = this.oauth.authorize(requestData);

    // RFC 3986 percent encoding for OAuth
    const percentEncode = (str) =>
      encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    // Build Authorization header manually to include oauth_callback
    const authHeaderParts = Object.keys(oauthParams)
      .sort()
      .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
      .join(', ');

    const authHeader = { Authorization: `OAuth ${authHeaderParts}` };

    const response = await fetch(requestTokenUrl, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ETradeError('Failed to get request token', response.status, { raw: text });
    }

    const text = await response.text();
    const params = new URLSearchParams(text);

    this.requestToken = params.get('oauth_token');
    this.requestTokenSecret = params.get('oauth_token_secret');

    if (!this.requestToken || !this.requestTokenSecret) {
      throw new ETradeError('Invalid request token response', 500, { raw: text });
    }

    // E*TRADE uses /etws/authorize endpoint on us.etrade.com
    const authUrl = `https://us.etrade.com/e/t/etws/authorize?key=${this.consumerKey}&token=${this.requestToken}`;

    return { authUrl };
  }

  /**
   * Step 2: Exchange verifier PIN for access token
   * @param {string} verifier The PIN code from E*TRADE
   * @returns {Promise<{oauthToken: string, oauthTokenSecret: string}>}
   */
  async exchangeToken(verifier) {
    if (!this.requestToken || !this.requestTokenSecret) {
      throw new ETradeError('No request token. Call getAuthorizationUrl first.', 400);
    }

    const accessTokenUrl = `${this.baseUrl}/oauth/access_token`;

    const requestData = {
      url: accessTokenUrl,
      method: 'POST',
      data: { oauth_verifier: verifier },
    };

    const token = {
      key: this.requestToken,
      secret: this.requestTokenSecret,
    };

    // Get OAuth parameters including oauth_verifier in the signature
    const oauthParams = this.oauth.authorize(requestData, token);

    // RFC 3986 percent encoding for OAuth
    const percentEncode = (str) =>
      encodeURIComponent(String(str)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    // Build Authorization header manually to include oauth_verifier
    const authHeaderParts = Object.keys(oauthParams)
      .sort()
      .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
      .join(', ');

    const authHeader = { Authorization: `OAuth ${authHeaderParts}` };

    const response = await fetch(accessTokenUrl, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ETradeError('Failed to exchange token', response.status, { raw: text });
    }

    const text = await response.text();
    const params = new URLSearchParams(text);

    this.oauthToken = params.get('oauth_token');
    this.oauthTokenSecret = params.get('oauth_token_secret');

    if (!this.oauthToken || !this.oauthTokenSecret) {
      throw new ETradeError('Invalid access token response', 500, { raw: text });
    }

    // Clear request tokens
    this.requestToken = null;
    this.requestTokenSecret = null;

    return {
      oauthToken: this.oauthToken,
      oauthTokenSecret: this.oauthTokenSecret,
    };
  }

  /**
   * Make authenticated API request
   */
  async _request(method, path, params = null) {
    if (!this.oauthToken || !this.oauthTokenSecret) {
      throw new ETradeError('Not authenticated. Call setTokens or complete OAuth flow.', 401);
    }

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          url.searchParams.append(key, value);
        }
      });
    }

    const requestData = {
      url: url.toString(),
      method: method.toUpperCase(),
    };

    const token = {
      key: this.oauthToken,
      secret: this.oauthTokenSecret,
    };

    const headers = this.oauth.toHeader(
      this.oauth.authorize(requestData, token)
    );

    const response = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: {
        ...headers,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    let payload = null;
    const contentType = response.headers.get('content-type');

    if (response.status !== 204 && contentType?.includes('application/json')) {
      try {
        payload = await response.json();
      } catch {
        payload = { raw: await response.text() };
      }
    }

    if (!response.ok) {
      const msg = payload?.message || payload?.Error?.message || response.statusText;
      throw new ETradeError(msg, response.status, payload);
    }

    return payload;
  }

  /**
   * Test if current tokens are valid by making a simple API call
   */
  async validateTokens() {
    try {
      await this.getAccounts();
      return true;
    } catch (error) {
      if (error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  // ---------- Account API Methods ----------

  /**
   * Get list of accounts
   */
  async getAccounts() {
    const response = await this._request('GET', '/v1/accounts/list');
    return response?.AccountListResponse?.Accounts?.Account || [];
  }

  /**
   * Get account balances
   */
  async getAccountBalances(accountIdKey) {
    const response = await this._request('GET', `/v1/accounts/${accountIdKey}/balance`, {
      instType: 'BROKERAGE',
      realTimeNAV: 'true',
    });
    return response?.BalanceResponse;
  }

  /**
   * Get account positions
   */
  async getPositions(accountIdKey) {
    const response = await this._request('GET', `/v1/accounts/${accountIdKey}/portfolio`);
    return response?.PortfolioResponse?.AccountPortfolio || [];
  }

  /**
   * Get account orders
   */
  async getOrders(accountIdKey, options = {}) {
    const response = await this._request('GET', `/v1/accounts/${accountIdKey}/orders`, options);
    return response?.OrdersResponse?.Order || [];
  }

  // ---------- Portfolio Data Aggregation ----------

  /**
   * Fetch all portfolio data for analysis
   */
  async fetchPortfolioData() {
    logger.info('Fetching E*TRADE portfolio data...');

    const accounts = await this.getAccounts();

    if (!accounts || accounts.length === 0) {
      throw new ETradeError('No accounts found', 404);
    }

    const portfolioData = {
      accounts: [],
      totalValue: 0,
      fetchedAt: new Date().toISOString(),
    };

    for (const account of accounts) {
      const accountIdKey = account.accountIdKey;
      const accountData = {
        accountId: account.accountId,
        accountIdKey,
        accountName: account.accountName || account.accountDesc,
        accountType: account.accountType,
        institutionType: account.institutionType,
        balances: null,
        positions: [],
        orders: [],
      };

      try {
        // Fetch balances
        const balances = await this.getAccountBalances(accountIdKey);
        accountData.balances = balances;

        if (balances?.Computed?.RealTimeValues?.totalAccountValue) {
          portfolioData.totalValue += parseFloat(balances.Computed.RealTimeValues.totalAccountValue);
        }
      } catch (error) {
        logger.warn(`Failed to fetch balances for account ${accountIdKey}:`, error.message);
      }

      try {
        // Fetch positions
        const portfolios = await this.getPositions(accountIdKey);
        for (const portfolio of portfolios) {
          if (portfolio.Position) {
            accountData.positions.push(...portfolio.Position);
          }
        }
      } catch (error) {
        logger.warn(`Failed to fetch positions for account ${accountIdKey}:`, error.message);
      }

      try {
        // Fetch recent orders
        const orders = await this.getOrders(accountIdKey, { count: 10 });
        accountData.orders = orders;
      } catch (error) {
        logger.warn(`Failed to fetch orders for account ${accountIdKey}:`, error.message);
      }

      portfolioData.accounts.push(accountData);
    }

    return portfolioData;
  }

  /**
   * Format portfolio data as a readable string for Claude analysis
   */
  formatPortfolioForAnalysis(portfolioData) {
    const lines = [];

    lines.push(`Portfolio Overview (as of ${portfolioData.fetchedAt})`);
    lines.push(`Total Portfolio Value: $${portfolioData.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    lines.push('');

    for (const account of portfolioData.accounts) {
      lines.push(`=== ${account.accountName || account.accountId} (${account.accountType}) ===`);

      // Balances
      if (account.balances?.Computed) {
        const computed = account.balances.Computed;
        const rtv = computed.RealTimeValues || {};

        lines.push('Balances:');
        if (rtv.totalAccountValue) {
          lines.push(`  Account Value: $${parseFloat(rtv.totalAccountValue).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
        }
        if (computed.cashAvailableForInvestment !== undefined) {
          lines.push(`  Cash Available: $${parseFloat(computed.cashAvailableForInvestment).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
        }
        if (computed.marginBuyingPower !== undefined) {
          lines.push(`  Margin Buying Power: $${parseFloat(computed.marginBuyingPower).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
        }
      }

      // Positions
      if (account.positions.length > 0) {
        lines.push('');
        lines.push('Positions:');

        // Sort by market value descending
        const sortedPositions = [...account.positions].sort((a, b) => {
          const aValue = a.marketValue || 0;
          const bValue = b.marketValue || 0;
          return bValue - aValue;
        });

        for (const pos of sortedPositions) {
          const symbol = pos.Product?.symbol || pos.symbolDescription || 'Unknown';
          const qty = pos.quantity || 0;
          const marketValue = pos.marketValue || 0;
          const costBasis = pos.totalCost || pos.costPerShare * qty || 0;
          const gainLoss = pos.totalGain || (marketValue - costBasis);
          const gainLossPct = pos.totalGainPct || (costBasis > 0 ? ((gainLoss / costBasis) * 100) : 0);
          const pricePaid = pos.pricePaid || pos.costPerShare || 0;
          const currentPrice = pos.Quick?.lastTrade || (qty > 0 ? marketValue / qty : 0);

          lines.push(`  ${symbol}: ${qty} shares @ $${currentPrice.toFixed(2)} = $${marketValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
          lines.push(`    Cost Basis: $${costBasis.toLocaleString('en-US', { minimumFractionDigits: 2 })} | Gain/Loss: $${gainLoss.toFixed(2)} (${gainLossPct >= 0 ? '+' : ''}${gainLossPct.toFixed(2)}%)`);
        }
      } else {
        lines.push('  No positions');
      }

      // Recent Orders
      if (account.orders.length > 0) {
        lines.push('');
        lines.push('Recent Orders:');

        for (const order of account.orders.slice(0, 5)) {
          const details = order.OrderDetail?.[0] || {};
          const instrument = details.Instrument?.[0] || {};
          const symbol = instrument.Product?.symbol || 'Unknown';
          const action = instrument.orderAction || 'Unknown';
          const qty = instrument.orderedQuantity || instrument.filledQuantity || 0;
          const status = order.orderStatus || 'Unknown';
          const orderType = details.orderType || 'Unknown';

          lines.push(`  ${action} ${qty} ${symbol} (${orderType}) - ${status}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}

export default ETradeService;
