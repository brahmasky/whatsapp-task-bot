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
- **GFD Bracket Trading** - Place BUY LIMIT or MARKET orders (Good for Day) with optional auto TP/SL on fill via E*TRADE
- **Simple Sell Orders** - Place GFD LIMIT or MARKET sell orders; `sell all` fetches your current position size automatically
- **Persistent Fill Monitor** - Pending orders survive bot restarts via `data/pending-fills.json`
- **State Persistence** - Active task states survive crash/restart via `data/user-states.json`
- **Multi-stock Compare** - Research up to 5 stocks in parallel with a ranked score table
- **Market Ideas** - Auto-research the top sector leaders of the day
- **Trade Journal** - Export full trade history as a CSV file directly to WhatsApp
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
    │  etrade.order   │  reauth           │
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
| `/research compare A B C` | Compare up to 5 stocks in parallel — ranked score table, cache-aware |
| `/research list` | Show all cached research reports with scores and age |
| `/trade TICKER` | Place a GFD BUY LIMIT or MARKET order; TP and SL are optional |
| `/trade list` | Show pending orders with live E*TRADE status |
| `/trade cancel TICKER` | Cancel the pending BUY order on E*TRADE |
| `/trade modify TICKER [tp X] [sl Y]` | Cancel and replace TP/SL orders for a completed trade |
| `/trade journal` | Export full trade history as a CSV file |
| `/trade history` | Show last 10 completed trades |
| `/trade retry-exits TICKER` | Retry failed TP/SL placement after a fill |
| `/trade track TICKER ORDER_ID ...` | Re-register an existing order after bot restart (recovery) |
| `/trade fill TICKER` | Simulate a fill for sandbox testing |
| `/sell TICKER` | Place a GFD SELL order for an existing position |
| `/market ideas` | Auto-research top positive-performing sector leaders |
| `/market scorecard` | Multi-day sector performance scorecard |
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

### Buying (/trade)

The `/trade` command places a GFD BUY order immediately. TP and SL are optional — omit them for a simple buy with no auto-exits.

**Plan syntax** (send after `/trade TICKER`):
```
buy <low> <high> [tp <target>] [sl <stop>] budget <amount>
buy <low> <high> [tp <target>] [sl <stop>] qty <shares>
buy market [tp <target>] [sl <stop>] budget <amount>
buy market [tp <target>] [sl <stop>] qty <shares>
```

**Examples:**
```
buy 70 73 tp 81.30 sl 68 budget 1000   ← full bracket (auto TP+SL on fill)
buy 70 73 budget 1000                   ← buy only, manage exit manually
buy market budget 1000                  ← market order, no exits
buy market tp 85 sl 68 qty 10          ← market with exits
```

**Flow:**
1. `/trade UBER` — fetch current price, show prompt
2. Enter plan
3. Review shown (price, TP/SL if set, est. cost, R/R if applicable) → reply `confirm`
4. Bot checks live cash balance, places **BUY LIMIT at golden ratio of zone** (61.8%) or MARKET order — all **Good for Day**
5. Fill monitor polls every 60s — on EXECUTED, auto-places any configured TP/SL exits

**Key behaviours:**
- All orders are **Good for Day** — expire at market close, never linger as GTC
- TP and SL are independently optional. If omitted, fill notification is sent with no auto-exits
- BUY is placed first; TP/SL only placed after EXECUTED — no accidental short sell
- Cash check before every order; blocked if insufficient
- GFD expiry warning sent at 3:30 PM ET if order is still open
- Pending orders persist to `data/pending-fills.json` — survives restarts
- Re-auth handled inline if token expired mid-flow

### Selling (/sell)

The `/sell` command places a single GFD SELL order for an existing position.

**Plan syntax** (send after `/sell TICKER`):
```
sell <qty> <price>     ← limit sell, GFD
sell <qty> market      ← market sell
sell all <price>       ← sell full position (fetches qty from E*TRADE), limit GFD
sell all market        ← sell full position at market
```

**Examples:**
```
sell 50 85.00
sell all market
```

No TP/SL — this is a one-shot exit order. Re-auth handled inline if token expired.

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
