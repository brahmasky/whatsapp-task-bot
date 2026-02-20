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
- **Stock Research** - AI-scored stock analysis (0-100) with fundamentals from Yahoo + FMP
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
                    ┌──────────────────────────────────────────────────────────────┐
                    │                       │                │                  │
                    ▼                       ▼                ▼                  ▼
             ┌────────────┐          ┌────────────┐   ┌────────────┐   ┌────────────────┐
             │  /invoice  │          │  /system   │   │  /market   │   │   /portfolio   │
             │            │          │            │   │            │   │                │
             │ Playwright │          │ macOS stat │   │ Scheduled  │   │  Claude Agent  │
             │ + Keychain │          │ CPU/Mem/   │   │ Updates +  │   │  + MCP Tools   │
             │ + Email    │          │ Temp/Login │   │ Deep Agent │   │                │
             └────────────┘          └────────────┘   └─────┬──────┘   └───────┬────────┘
                                                            │                  │
                                                            └────────┬─────────┘
                                                        ┌────────────┴────────────┐
                                                        ▼                         ▼
                                                 ┌────────────┐            ┌────────────┐
                                                 │  E*TRADE   │            │  Research  │
                                                 │ MCP Server │            │ MCP Server │
                                                 └─────┬──────┘            └─────┬──────┘
                                                       ▼                         ▼
                                                 ┌────────────┐            ┌────────────┐
                                                 │ E*TRADE API│            │ News/Quote │
                                                 │ (OAuth)    │            │ APIs       │
                                                 └────────────┘            └────────────┘
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

### Research Scoring

The `/research` command runs a Sonnet agent loop that scores a stock across four dimensions:

| Dimension | What it measures | Max |
|-----------|-----------------|-----|
| Valuation | P/E vs sector norms, P/B, analyst target upside | 25 |
| Quality | Profit margins, ROE, FCF generation, balance sheet | 25 |
| Momentum | 52-week range position, recent price action | 25 |
| Sentiment | News tone and recency of catalysts | 25 |

Data sources: Yahoo Finance (price/52w range, free) + FMP `/stable/` API (fundamentals, free tier = 250 calls/day).
Requires `FMP_API_KEY` and `ANTHROPIC_API_KEY`. Est. cost: ~$0.05/call.

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
| `FMP_API_KEY` | Financial Modeling Prep key for `/research` fundamentals (free at financialmodelingprep.com) |
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
