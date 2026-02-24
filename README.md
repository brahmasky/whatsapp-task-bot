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

## Commands

### Global & System

Built-in framework commands — always available, no active task required.

| Command | Description |
|---------|-------------|
| `/help` | List all available commands with descriptions |
| `/tasks` | Show registered task modules |
| `/cancel` | Cancel the current active task |
| `/status` | Show what task is currently running |
| `/status health` | Bot health: uptime, memory, pending fills, recent log stats |

---

### `/system` — macOS Stats

Displays a snapshot of your Mac's current health.

```
/system
```

Reports: CPU load average, memory pressure (used / wired / free), disk usage for all mounted volumes, and CPU temperature (via `osx-temperature-sensor`). No external APIs or credentials required.

---

### `/invoice` — TPG Invoice

Automates the full TPG invoice download flow using Playwright browser automation.

```
/invoice
```

**Flow:**
1. Bot checks macOS Keychain for stored TPG credentials; prompts on first run
2. Playwright logs into the TPG portal and triggers an SMS verification code
3. You reply with the 6-digit SMS code
4. Bot downloads the invoice PDF
5. PDF is sent via WhatsApp; optionally also emailed if `SMTP_*` env vars are set

Credentials (username/password) are stored securely in macOS Keychain — never in `.env`. Requires `HEADLESS=false` if you need to see the browser.

---

### Portfolio & Market Analysis

#### `/portfolio` — Portfolio Advisor

Claude-powered portfolio analysis using live E*TRADE data via MCP.

```
/portfolio           ← full analysis
/portfolio logout    ← clear stored OAuth tokens
```

**Flow:**
1. Bot checks Keychain for OAuth tokens; if missing or expired, guides you through PIN-based auth
2. Fetches accounts, balances, and all positions from E*TRADE
3. Runs a Claude agent loop with E*TRADE MCP tools for deep analysis
4. Returns: total value, position breakdown, sector exposure, gains/losses, and actionable advice

Portfolio data is cached locally after each run — used by `/market` for real-time P&L without hitting E*TRADE again.

---

#### `/market` — Market Updates

Sector rotation analysis with portfolio context. Runs automatically on a schedule and is also available on demand.

**Commands:**

| Command | Description |
|---------|-------------|
| `/market` | Current market status with sector rotation |
| `/market pre` | Force pre-market style update |
| `/market post` | Force post-market style update |
| `/market weekly` | Force weekly summary |
| `/market deep` | Force deep analysis with research tools (MCP) |
| `/market status` | Scheduler info and next scheduled update times |
| `/market ideas` | Auto-research the top 2 positive sector ETFs of the day |
| `/market scorecard` | Multi-day sector performance scorecard |

**Scheduled updates** (market days only):
- **Pre-market:** 8:00 AM ET
- **Post-market:** 4:30 PM ET
- **Weekly summary:** 9:00 AM ET on Saturdays

**Adaptive analysis tiers** — cost scales with market significance:

| Level | Trigger | Model | Tools | Est. Cost |
|-------|---------|-------|-------|-----------|
| Template | SPY < 1% | none | no | $0 |
| Haiku | SPY 1–1.5% | Haiku | no | ~$0.0001 |
| Sonnet | SPY 1.5–2.5% | Sonnet | no | ~$0.001 |
| Deep | SPY > 2.5% | Sonnet + agent loop | 3 MCP research tools | ~$0.03 |

Deep analysis also triggers on: any major index > 2.5%, portfolio day change > 3%, or sector spread > 4%. Falls back to Sonnet on failure.

---

### Stock Research

#### `/research` — AI Stock Analysis

Runs a Sonnet agent loop to score a stock 0–100 across four dimensions, then produces an optional entry plan.

**Commands:**

| Command | Description |
|---------|-------------|
| `/research TICKER` | Full AI analysis: score, recommendation, entry plan |
| `/research compare A B C` | Compare up to 5 stocks in parallel — ranked score table, cache-aware |
| `/research list` | Show all cached reports with scores and age |
| `/research TICKER refresh` | Force a fresh fetch, bypassing the 24h cache |

**Scoring dimensions (0–25 each):**

| Dimension | What it measures |
|-----------|-----------------|
| Valuation | P/E vs sector norms, P/B, analyst target upside |
| Quality | Profit margins, ROE, FCF generation, balance sheet |
| Momentum | 52-week range position, recent 7-day price action |
| Sentiment | News tone and recency of catalysts |

Data: Yahoo Finance `quoteSummary` via yahoo-finance2 (primary, no key) with FMP `/stable/` as fallback when Yahoo data is sparse (free tier: 250 calls/day). Requires `ANTHROPIC_API_KEY`. Est. cost: ~$0.05/call.

**Entry plan (BUY / STRONG BUY only):** After the report, reply `trade 1000` (budget) or `trade qty 14` (shares) to place a GFD BUY LIMIT inline — no need to switch to `/trade`. Limit price is set at the golden ratio (61.8%) of the suggested entry zone.

**Compare** (`/research compare`): runs each symbol through the agent in parallel, reuses cached results where available, and returns a ranked table with `[c]` (cached) or `[f]` (fresh) markers.

---

### Trading

#### `/trade` — Buy Orders

Places a GFD BUY order and monitors for fill to auto-place optional TP/SL exits.

**Commands:**

| Command | Description |
|---------|-------------|
| `/trade TICKER` | Start a new buy — fetches current price, prompts for plan |
| `/trade list` | Show all pending orders with live E*TRADE status |
| `/trade cancel TICKER` | Cancel the pending BUY order on E*TRADE |
| `/trade modify TICKER [tp X] [sl Y]` | Cancel and replace TP/SL for a completed fill |
| `/trade history` | Show last 10 completed trades |
| `/trade journal` | Export full trade history as a CSV file to WhatsApp |
| `/trade retry-exits TICKER` | Retry failed TP/SL placement after a fill |
| `/trade track TICKER ORDER_ID ...` | Re-register an existing order after bot restart (recovery) |
| `/trade fill TICKER` | Simulate a fill (sandbox testing only) |

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
buy 70 73 budget 1000                   ← buy only, manage exits manually
buy market budget 1000                  ← market order, no exits
buy market tp 85 sl 68 qty 10          ← market order with exits
```

**Flow:**
1. `/trade UBER` — fetch current price, show prompt
2. Enter plan
3. Review shown (TP/SL if set, est. cost, R/R if both exits configured) → reply `confirm`
4. Bot checks live cash balance, places **BUY LIMIT at golden ratio** (61.8% of zone) or MARKET — all **Good for Day**
5. Fill monitor polls every 60s — on EXECUTED, auto-places any configured TP/SL exits

**Key behaviours:**
- All orders are **Good for Day** — expire at market close, never linger as GTC
- TP and SL are independently optional — omit either or both for a plain buy
- BUY placed first; TP/SL only after EXECUTED — no accidental short sell
- Cash check before every order; blocked if insufficient
- GFD expiry warning sent at 3:30 PM ET if order is still open
- Pending orders persist to `data/pending-fills.json` — survives restarts
- Re-auth handled inline if token expires mid-flow

---

#### `/sell` — Sell Orders

Places a single GFD SELL order for an existing position. One-shot exit — no TP/SL.

**Plan syntax** (send after `/sell TICKER`):
```
sell <qty> <price>     ← limit sell, GFD
sell <qty> market      ← market sell
sell all <price>       ← sell full position at limit (fetches qty from E*TRADE)
sell all market        ← sell full position at market
```

**Examples:**
```
sell 50 85.00
sell all market
```

**Flow:**
1. `/sell UBER` — prompt for sell plan
2. Enter plan
3. Review shown → `confirm` to place, `edit` to revise
4. `sell all` auto-fetches your current position size from E*TRADE
5. Re-auth handled inline if token expires

---

### `/dev` — Bot Development

Delegates codebase questions and code changes to the locally-installed Claude Code CLI. Zero API cost — uses your Claude Pro subscription.

**Questions** (answered immediately):
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

**Flow for code changes:**
1. Claude Code reads the codebase and outputs a plan
2. Reply `confirm`, `update: <feedback>` to revise, or `discard`
3. On confirm: implementation runs in a git worktree under `/tmp/` (nodemon never sees it)
4. Diff shown — `confirm` to merge into `src/` (nodemon restarts bot), or `discard`

**Requires:** Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) and authenticated via `claude` in your terminal.

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
