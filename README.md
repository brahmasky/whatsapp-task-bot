# WhatsApp Task Bot

An extensible Node.js automation bot that runs on WhatsApp, enabling automated workflows triggered via chat commands.

## Features

- **WhatsApp Integration** - Uses Baileys for WhatsApp Web connection
- **Task System** - Modular, extensible task architecture
- **Browser Automation** - Playwright for web scraping and form interaction
- **Email Delivery** - Optional Gmail SMTP integration for sending files via email
- **Secure Credentials** - macOS Keychain for credential storage; all keychain operations use `execFile` (argument arrays, no shell interpolation)
- **Portfolio Analysis** - Claude-powered agent with E*TRADE MCP integration
- **Market Updates** - Scheduled sector rotation analysis with adaptive AI tiers
- **Stock Research** - AI-scored stock analysis (0-100) with fundamentals from Yahoo + FMP fallback
- **GFD Bracket Trading** - Place BUY LIMIT orders instantly (Good for Day) with automatic TP + SL on fill via E*TRADE
- **Persistent Fill Monitor** - Pending orders survive bot restarts via `data/pending-fills.json`
- **Bot Development** - Delegate codebase questions and code changes to Claude Code CLI (zero API cost)
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
        ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────┐  │
        │ /invoice │  │ /system  │  │ /portfolio │  │ /market  │  │  /research   │  │   /dev   │  │
        │Playwright│  │ macOS    │  │   Claude   │  │Scheduled │  │ Sonnet Agent │  │  Claude  │  │
        │+ Keychain│  │  Stats   │  │   Agent    │  │+ Deep AI │  │ Yahoo + FMP  │  │ Code CLI │  │
        └──────────┘  └──────────┘  └─────┬──────┘  └────┬─────┘  └──────────────┘  └──────────┘  │
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
    │  etrade.order   │                   │
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
| `/research TICKER` | AI-scored stock analysis (0-100) with fundamentals, recommendation, and entry plan |
| `/trade TICKER` | Place a GFD BUY LIMIT order with auto TP + SL on fill via E*TRADE |
| `/trade list` | Show pending orders with live E*TRADE status |
| `/trade cancel TICKER` | Cancel the pending BUY order on E*TRADE |
| `/trade track TICKER ORDER_ID ...` | Re-register an existing order after bot restart (recovery) |
| `/trade fill TICKER` | Simulate a fill for sandbox testing |
| `/dev <question or instruction>` | Ask Claude Code a question about the codebase, or delegate a code change |

### Research Scoring

The `/research` command runs a Sonnet agent loop that scores a stock across four dimensions:

| Dimension | What it measures | Max |
|-----------|-----------------|-----|
| Valuation | P/E vs sector norms, P/B, analyst target upside | 25 |
| Quality | Profit margins, ROE, FCF generation, balance sheet | 25 |
| Momentum | 52-week range position, recent price action | 25 |
| Sentiment | News tone and recency of catalysts | 25 |

Data sources: Yahoo Finance `quoteSummary` via yahoo-finance2 (primary, no key needed, better international coverage) with FMP `/stable/` API as fallback when Yahoo returns sparse data (free tier = 250 calls/day).
Requires `ANTHROPIC_API_KEY`. `FMP_API_KEY` optional but recommended. Est. cost: ~$0.05/call.

**Entry plan (BUY / STRONG BUY only):** The agent produces an entry zone, take profit, stop loss, and R/R ratio based on 7-day OHLCV support levels. After receiving the report, reply `trade 1000` (budget) or `trade qty 14` (shares) to place the order inline — no need to switch to `/trade`. The limit price is set at the golden ratio (61.8%) of the entry zone for a better average cost than the ceiling.

### Bracket Trading (/trade)

The `/trade` command places a GFD BUY LIMIT order immediately and automatically places TP + SL once the buy is confirmed executed by E*TRADE.

**Flow:**
1. `/trade UBER` — fetch current price for reference, prompt for plan
2. Enter plan: `buy 70 73 tp 81.30 sl 68 budget 1000`
3. Bot checks live cash balance, then places a **BUY LIMIT at the golden ratio of the zone** (`$70 + ($73-$70) × 0.618 = $71.85`), **Good for Day**
4. E*TRADE handles execution — no price monitoring loop
5. Fill monitor polls every 60s — when BUY executes, bot automatically places TP + SL

**Order type:** BUY LIMIT at the golden ratio (61.8%) of the buy zone, GFD. Better average cost than buying at the zone ceiling — fills at the limit price or better. Expires at market close if not filled — run `/trade` again the next day.

**Order sequencing:** BUY is placed first. TP and SL are only placed after the BUY is confirmed EXECUTED — avoids accidental short sell.

**Cash check:** Live E*TRADE cash balance is verified before placing any order. Order is blocked if insufficient funds.

**Token expiry:** E*TRADE OAuth tokens expire at midnight ET. Both `/trade` and `/research` inline trade handle re-authentication inline without needing to switch to `/portfolio`.

**Fill monitor persistence:** Pending orders are saved to `data/pending-fills.json` on every change. On restart, the monitor restores from disk and immediately checks status — a bot restart never loses track of an open order. Use `/trade list` anytime to see live E*TRADE status.

**Sandbox testing:** Use `/trade fill TICKER` to simulate a fill and trigger exit order placement (sandbox only — blocked in production).

### Bot Development (/dev)

The `/dev` command lets you interact with the codebase via natural language — either asking questions or delegating code changes — using the locally-installed Claude Code CLI. Zero API cost: uses your Claude Pro subscription.

**Questions** (answered immediately, no confirmation needed):
```
/dev how does the fill monitor work?
/dev why does /research fall back to FMP?
/dev what files handle E*TRADE auth?
```

**Code changes** (plan → confirm → implement):
```
/dev add a /weather command that shows forecast from wttr.in
/dev refactor the market scheduler to support configurable times
```

For build tasks, Claude Code first reads the codebase and outputs a plan. You can `confirm`, give `update: <feedback>` to revise, or `discard`. On confirm, implementation runs in a git worktree under `/tmp/` (outside the project directory, so nodemon doesn't restart mid-execution). After implementation, review the diff and `confirm` to merge or `discard` to cancel.

**Requires:** Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) and authenticated via `claude` in your terminal.

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
