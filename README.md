# WhatsApp Task Bot

An extensible Node.js automation bot that runs on WhatsApp, enabling automated workflows triggered via chat commands.

## Features

- **WhatsApp Integration** - Uses Baileys for WhatsApp Web connection
- **Task System** - Modular, extensible task architecture
- **Browser Automation** - Playwright for web scraping and form interaction
- **Email Delivery** - Optional Gmail SMTP integration for sending files via email
- **Secure Credentials** - macOS Keychain integration for password storage
- **Portfolio Analysis** - Claude-powered agent with E*TRADE MCP integration
- **Market Updates** - Scheduled sector rotation analysis with adaptive AI tiers
- **Stock Research** - AI-scored stock analysis (0-100) with fundamentals from Yahoo + FMP fallback
- **Price Alerts & Trading** - Price zone monitoring with bracket order execution via E*TRADE
- **System Monitoring** - macOS CPU, memory, disk, and temperature stats

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. Run the bot:
   ```bash
   npm start        # Production
   npm run dev      # Development with hot-reload
   ```

4. Scan the QR code with WhatsApp (Settings > Linked Devices > Link a Device)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  WhatsApp   │────▶│   Gateway   │────▶│   Router     │────▶│    Tasks    │
│   User      │     │  (Channel)  │     │  (Auth/Cmd)  │     │  Registry   │
└─────────────┘     └─────────────┘     └──────────────┘     └──────┬──────┘
                                                                     │
              ┌──────────────────────────────────────────────────────────────────────┐
              │              │               │              │                │        │
              ▼              ▼               ▼              ▼                ▼        │
        ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐  │
        │ /invoice │  │ /system  │  │ /portfolio │  │ /market  │  │  /research   │  │
        │Playwright│  │ macOS    │  │   Claude   │  │Scheduled │  │ Sonnet Agent │  │
        │+ Keychain│  │  Stats   │  │   Agent   │  │+ Deep AI │  │ Yahoo + FMP  │  │
        └──────────┘  └──────────┘  └─────┬──────┘  └────┬─────┘  └──────────────┘  │
                                          │              │                            │
              ┌───────────────────────────┘              │          ┌──────────────┐  │
              │                                          │          │    /trade    │◄─┘
              │                                          │          │ Price Alerts │
              │                                          │          │+ E*T Orders  │
              │                                          │          └──────┬───────┘
              │                                          │                 │
              │          ┌───────────────────────────────┘                 │
              ▼          ▼                                                  │
    ┌─────────────────────────────────────┐                                │
    │          src/shared/                │◄───────────────────────────────┘
    │  yahoo.service  │  agent.service    │
    │  etrade.helper  │  auth.service     │
    └────────┬────────────────┬───────────┘
             │                │
             ▼                ▼
    ┌──────────────┐  ┌───────────────────┐
    │  MCP Servers │  │  External APIs    │
    │  etrade      │  │  Yahoo Finance    │
    │  research    │  │  E*TRADE (OAuth)  │
    └──────┬───────┘  │  Google News      │
           │          │  FMP (fallback)   │
           ▼          └───────────────────┘
    ┌──────────────┐
    │ Claude Agent │
    │  tool calls  │
    └──────────────┘
```

## Available Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/tasks` | List registered tasks |
| `/cancel` | Cancel current task |
| `/status` | Show current task status |
| `/invoice` | Download and send TPG invoice (via WhatsApp and email) |
| `/system` | macOS system stats (CPU, memory, disk, temperature) |
| `/portfolio` | Claude-powered portfolio analysis with E*TRADE data |
| `/market` | Current market status with sector rotation analysis |
| `/market pre` | Force pre-market style update |
| `/market post` | Force post-market style update |
| `/market weekly` | Force weekly summary |
| `/market deep` | Force deep analysis with research tools |
| `/market status` | Scheduler info and next update times |
| `/research TICKER` | AI-scored stock analysis (0-100) with fundamentals and recommendation |
| `/trade TICKER` | Set a price alert + bracket order plan (buy zone, take profit, stop loss) |
| `/trade list` | Show active price alerts and pending fills |
| `/trade cancel TICKER` | Cancel a price alert |
| `/trade fill TICKER` | Simulate a fill for sandbox testing |

### Research Scoring

The `/research` command runs a Sonnet agent loop that scores a stock across four dimensions:

| Dimension | What it measures | Max |
|-----------|-----------------|-----|
| Valuation | P/E vs sector norms, P/B, analyst target upside | 25 |
| Quality | Profit margins, ROE, FCF generation, balance sheet | 25 |
| Momentum | 52-week range position, recent price action | 25 |
| Sentiment | News tone and recency of catalysts | 25 |

Data sources: Yahoo Finance `v10/quoteSummary` (primary, no key needed, better international coverage) with FMP `/stable/` API as fallback when Yahoo returns sparse data (free tier = 250 calls/day).
Requires `ANTHROPIC_API_KEY`. `FMP_API_KEY` optional but recommended. Est. cost: ~$0.05/call.

### Price Alerts & Trading (/trade)

The `/trade` command monitors stock prices and executes bracket orders via E*TRADE.

**Flow:**
1. `/trade UBER` — fetch current price, prompt for plan
2. Enter plan: `buy 70 72.50 tp 81.30 sl 68 budget 1000`
3. Bot saves alert, monitors price every 60 seconds
4. When price enters buy zone — alert fires with trend sparkline
5. Reply `confirm` — bot places a GTC limit buy order on E*TRADE
6. When buy fills — bot automatically places take profit + stop loss orders

**Order sequencing:** BUY is placed first. TP and SL are only placed after the BUY is confirmed EXECUTED — avoids accidental short sell.

**Token expiry:** E*TRADE OAuth tokens expire at midnight ET. If expired, `/trade` handles re-authentication inline without needing to switch to `/portfolio`.

**Sandbox testing:** Use `/trade fill TICKER` to simulate a fill and trigger exit order placement (sandbox only — blocked in production).

### Market Analysis Tiers

The `/market` command uses an adaptive analysis system that scales cost with market significance:

| Level | Trigger | Model | Tools | Est. Cost |
|-------|---------|-------|-------|-----------|
| Template | SPY < 1% | none | no | $0 |
| Haiku | SPY 1-1.5% | Haiku | no | ~$0.0001 |
| Sonnet | SPY 1.5-2.5% | Sonnet | no | ~$0.001 |
| Deep | SPY > 2.5% | Sonnet + agent loop | 3 research tools (MCP) | ~$0.03 |

Deep analysis also triggers on: any major index > 2.5%, portfolio day change > 3%, or sector spread > 4%. On failure, falls back to regular Sonnet.

Scheduled updates run automatically on market days:
- **Pre-market:** 8:00 AM ET
- **Post-market:** 4:30 PM ET
- **Weekly summary:** 9:00 AM ET on Saturdays

## Configuration

| Variable | Description |
|----------|-------------|
| `ALLOWED_USERS` | Comma-separated phone numbers (e.g., `61400000000`) |
| `HEADLESS` | Browser mode: `true` (default) or `false` |
| `SMS_TIMEOUT_MINUTES` | Task timeout in minutes (default: 5) |
| `SMTP_USER` | Gmail address for sending emails |
| `SMTP_PASS` | Gmail app password (requires 2FA) |
| `EMAIL_RECIPIENT` | Default email recipient for invoices |
| `ETRADE_CONSUMER_KEY` | E*TRADE API consumer key |
| `ETRADE_CONSUMER_SECRET` | E*TRADE API consumer secret |
| `ETRADE_SANDBOX` | `false` for production E*TRADE API |
| `ANTHROPIC_API_KEY` | Claude API key for portfolio/market/research analysis |
| `FMP_API_KEY` | Financial Modeling Prep key — fallback for `/research` when Yahoo data is sparse (free tier: 250 calls/day) |
| `LOG_LEVEL` | Log verbosity: `info` (default) or `debug` |

## Adding Tasks

Create a task module in `src/tasks/taskname/index.js`:

```javascript
export default {
  command: '/taskname',
  description: 'Task description',

  async start(ctx, args) {
    // Initialize task
  },

  async onMessage(ctx, text) {
    // Handle user messages
  },

  async cleanup(ctx) {
    // Optional cleanup
  }
};
```

Register in `src/index.js`:

```javascript
import myTask from './tasks/taskname/index.js';
taskRegistry.register(myTask);
```

## License

ISC
