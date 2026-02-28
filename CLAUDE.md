# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp Task Bot is an extensible Node.js automation bot that runs on WhatsApp, enabling users to trigger automated workflows via WhatsApp commands. It uses Baileys for WhatsApp Web integration and Playwright for browser automation.

## Commands

```bash
npm start        # Run the bot
npm run dev      # Run with hot-reload (nodemon)
npm run mcp      # Run E*TRADE MCP server (for Claude Desktop)
```

No test or lint scripts are configured.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          WhatsApp Task Bot Architecture                          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐                              ┌─────────────────┐
│    WhatsApp     │                              │    Scheduler    │
│     User        │                              │  (setInterval)  │
└────────┬────────┘                              └────────┬────────┘
         │                                                │
         ▼                                                │
┌─────────────────┐                                       │
│ WhatsAppChannel │◄──────────────────────────────────────┘
│   (Baileys)     │        (scheduled messages)
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│        Gateway          │
│   (EventEmitter bus)    │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│    MessageRouter        │
└────────────┬────────────┘
             │
┌────────────┼─────────────────────────────────┬────────────┐
│            │                    │            │            │
▼            ▼                    ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│ /invoice │ │ /system  │ │ /portfolio │ │  /market   │ │ /research  │ │   /dev     │
│          │ │          │ │            │ │            │ │            │ │            │
│Playwright│ │ macOS    │ │ Claude     │ │ Scheduled  │ │ Sonnet     │ │ Claude     │
│+ Email   │ │ Stats    │ │ Agent      │ │ Updates    │ │ Agent Loop │ │ Code CLI   │
└────┬─────┘ └──────────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
     │                          │              │
     ▼                          │              │
┌──────────┐                    │              │
│ TPG Site │                    │              │
│ Keychain │                    │              │
│ Gmail    │                    │              │
└──────────┘                    │              │
                                ▼              ▼              ▼
                    ┌─────────────────────────────────────┐  ┌──────────────────┐
                    │           MCP Servers               │  │ Yahoo Finance    │
                    │  ┌───────────┐    ┌──────────────┐  │  │ + FMP stable API │
                    │  │ E*TRADE   │    │ Stock        │  │  │ (fundamentals)   │
                    │  │ Server    │    │ Research     │  │  └──────────────────┘
                    │  └─────┬─────┘    └──────┬───────┘  │
                    └────────┼─────────────────┼──────────┘
                             │                 │
                             ▼                 ▼
                    ┌─────────────┐    ┌─────────────────┐
                    │ E*TRADE API │    │ Yahoo Finance   │
                    │ (OAuth)     │    │ Google News     │
                    └─────────────┘    └─────────────────┘
```

### /market Data Flow

```
  Scheduled (4:30PM ET)                  On-demand (/market)
         │                                      │
         └──────────────┬───────────────────────┘
                        ▼
              ┌──────────────────┐
              │  Market Calendar │ ──► Skip if weekend/holiday
              └────────┬─────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────────┐
   │ Yahoo    │  │ Portfolio│  │ Google News  │
   │ Finance  │  │ Cache    │  │ RSS          │
   │ (sectors)│  │ (local)  │  │              │
   └────┬─────┘  └────┬─────┘  └──────┬───────┘
        │             │               │
        └─────────────┼───────────────┘
                      ▼
            ┌──────────────────┐
            │ Analyze & Format │
            │                  │
            │ • Sector rotation│
            │ • Portfolio P&L  │
            │ • Hybrid Claude  │
            └────────┬─────────┘
                     │
            ┌────────┴─────────┐
            │  Level Router    │
            │                  │
            │ SPY < 1%  → template ($0)
            │ SPY 1-1.5% → haiku  (~$0.0001)
            │ SPY 1.5-2.5% → sonnet (~$0.001)
            │ SPY > 2.5% → deep   (~$0.03)
            └────────┬─────────┘
                     │
               (if deep)
                     │
            ┌────────▼─────────┐
            │  Deep Analyzer   │
            │  (agent loop)    │
            │                  │
            │ • 5 iterations   │
            │ • 3 research     │
            │   tools via MCP  │
            │ • Falls back to  │
            │   sonnet on fail │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │  WhatsApp Msg    │
            └──────────────────┘
```

**Core Components (`src/core/`):**
- `whatsapp.service.js` - WhatsApp connection via Baileys, QR auth, message handling. Fetches the live WhatsApp Web version via `fetchLatestWaWebVersion()` on every startup (bundled version goes stale and causes connection rejection). Uses `Browsers.macOS('Chrome')` as the device identifier. Reconnect logic distinguishes fatal reasons (loggedOut, badSession, forbidden, connectionReplaced, multideviceMismatch — stop immediately) from retryable ones (exponential backoff 3s→24s, max 10 attempts). Generation counter prevents stale socket events from interfering with retry counting. **Expected startup warning:** `"Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer"` — Baileys times out (~20s) waiting for WhatsApp's initial history sync and forces the connection online anyway. Normal and harmless; the bot is fully operational after this.
- `message.router.js` - Routes commands to tasks, handles authorization, creates task context
- `task.registry.js` - Registers tasks, provides lookup by command
- `state.manager.js` - Per-user state storage (in-memory), stale task cleanup

**Entry Point:** `src/index.js` - bootstraps services, registers tasks, sets up shutdown handlers

**Task System:** Tasks are modular plugins in `src/tasks/`. Each task has:
- `command` - trigger command (e.g., `/invoice`)
- `description` - help text
- `start(ctx, args)` - called when command invoked
- `onMessage(ctx, text)` - handles subsequent user messages
- `cleanup(ctx)` - optional resource cleanup

**Task Context Methods:**
- `ctx.reply(text)` - send WhatsApp message
- `ctx.sendDocument(path, filename, mimetype, caption)` - send file
- `ctx.getState()` / `ctx.getTaskData()` / `ctx.updateTask(state, data)` / `ctx.completeTask()`

**Global Commands:** `/help`, `/tasks`, `/cancel`, `/status`, `/status health`

**Command Aliases:** `/r` → `/research`, `/t` → `/trade`, `/m` → `/market`, `/p` → `/portfolio`, `/s` → `/sell`

## Shared Services (`src/shared/`)

**Before implementing anything in a new task, check here first.** If more than one task might need something, it belongs in `src/shared/`.

| Service | File | Use for |
|---------|------|---------|
| Yahoo Finance quotes | `shared/yahoo.service.js` | Any price fetch — `fetchQuote(symbol)`, 60s cache, never throws |
| Claude agent loop | `shared/agent.service.js` | Any agentic tool-use loop — `runAgentLoop({model, system, messages, tools, maxIterations, maxTokens, executeTool, onToolCall?, onTurnText?})` |
| E*TRADE auth | `shared/etrade.helper.js` | Get authenticated service — `getAuthenticatedService()`, loads tokens from keychain |
| E*TRADE orders | `shared/etrade.order.js` | All order ops — `placeBuyOrder()`, `placeSellOrder()`, `cancelBuyOrder()`, `cancelOrder()`, `placeExitOrders()`, `getOrderStatus()`, `getPositionQty()`, `checkCashBalance()`, `refreshPortfolioCache()`, `calcQty()`, `getFirstBrokerageAccount()` |
| Multi-stock compare | `shared/compare.service.js` | Parallel research + ranked table — `compareSymbols(symbols)`, `formatCompareTable(results)` |
| OAuth flow | `shared/auth.service.js` | PIN-based OAuth for E*TRADE — `startAuthFlow(userId)`, `exchangePin(userId, pin)`, `cleanupAuthFlow(userId)` |
| Mid-task re-auth | `shared/reauth.js` | Inline re-auth when token expires during /trade or /research — `startReAuth(ctx, note)`, `handleReAuthPin(ctx, pin, onSuccess)` |
| Message splitting | `utils/message.js` | Split long text for WhatsApp — `splitMessage(text, maxLength)`, `replyLong(replyFn, text)` |
| News fetching | `tasks/portfolio/news.service.js` | Google News RSS — `fetchMarketNews([symbols], maxSymbols)` |

**New task checklist — before writing any fetch or loop code:**
- Fetching a stock price? → `shared/yahoo.service.js`
- Running a Claude agent with tools? → `shared/agent.service.js`
- Talking to E*TRADE API (auth)? → `shared/etrade.helper.js`
- Placing/cancelling E*TRADE orders? → `shared/etrade.order.js`
- Running E*TRADE OAuth? → `shared/auth.service.js`
- Fetching news? → `tasks/portfolio/news.service.js`
- Re-authenticating mid-task (token expired)? → `shared/reauth.js`
- Sending a reply that might be too long for WhatsApp? → `utils/message.js`
- Persisting data to disk (history, cache, config)? → `utils/persistence.service.js`

## Adding a New Task

1. Create task module in `src/tasks/taskname/index.js`
2. Export object with `command`, `description`, `start()`, `onMessage()`, optional `cleanup()`
3. Import and register in `src/index.js` via `taskRegistry.register(task)`

## Key Constraints

- **Single active task per user** - state machine tracks one task at a time
- **State persistence** - task states survive crash/restart via `data/user-states.json`; trade fill monitor persists to `data/pending-fills.json`
- **macOS-specific** - Keychain service only works on macOS
- **First run requires QR scan** - session stored in `.baileys_auth/`
- **Authorization** - only self-messages or users in `ALLOWED_USERS` env var

## Utilities

**Email Service (`src/utils/email.service.js`):**
- Gmail SMTP integration via nodemailer
- `isEmailConfigured()` - check if email env vars are set
- `sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentFilename })` - send email with file

**Persistence Service (`src/utils/persistence.service.js`):**
- Simple key-value file storage under `data/`; keys map to filenames (`'trade-history'` → `data/trade-history.json`)
- Keys can include subdirectories: `'research-cache/AAPL'` → `data/research-cache/AAPL.json`
- `load(key)` — read and parse `data/<key>.json`; returns null if missing or corrupt
- `save(key, data)` — atomic write (tmp + rename) to `data/<key>.json`
- `append(key, record)` — append one JSON line to `data/<key>.jsonl` (for logs, history)
- `loadLines(key)` — read all lines from `data/<key>.jsonl`; returns array of objects

**Logger (`src/utils/logger.js`):**
- Console output unchanged (ANSI colors, human-readable)
- `info`/`warn`/`error` are also written to `data/logs/bot-YYYY-MM-DD.jsonl` (one JSON entry per line); `debug` skipped to keep files lean
- In-memory ring buffer: last 100 entries kept for `/status health`
- `logger.getRecent(n)` — last n entries from buffer
- `logger.getStats()` — count by level (`{ info, warn, error, debug }`) since startup

## MCP Server (E*TRADE)

The project includes an MCP server (`src/mcp/etrade-server.js`) that exposes E*TRADE portfolio tools via the Model Context Protocol. This allows Claude Desktop or other MCP clients to access your portfolio.

**Available Tools:**
- `get_portfolio_summary` - Total value, accounts, position count
- `get_all_positions` - All positions with details
- `get_top_holdings` - Largest positions by weight
- `get_worst_performers` - Positions with biggest losses
- `get_sector_breakdown` - Diversification analysis
- `get_stock_news` - Recent news for a symbol
- `refresh_portfolio` - Force refresh cached data

**Claude Desktop Setup:**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "etrade": {
      "command": "node",
      "args": ["/path/to/whatsapp-task-bot/src/mcp/etrade-server.js"],
      "env": {
        "ETRADE_CONSUMER_KEY": "your_key",
        "ETRADE_CONSUMER_SECRET": "your_secret",
        "ETRADE_SANDBOX": "false"
      }
    }
  }
}
```

**Note:** You must first authenticate via the WhatsApp bot (`/portfolio`) to store OAuth tokens in keychain before using the MCP server.

## Task Reference

### Global & System Commands

**Global commands** are built into `src/core/message.router.js` — always available regardless of active task:

| Command | Description |
|---------|-------------|
| `/help` | List all registered commands |
| `/tasks` | Show all task modules |
| `/cancel` | Cancel the current active task |
| `/status` | Show the running task and its current state |
| `/status health` | Bot health: uptime, memory, pending fills, recent log stats (uses `logger.getRecent()`) |

---

### `/system` — macOS Stats

**Key file:** `src/tasks/system/index.js`

Reports a snapshot of the host machine's health. No external APIs or credentials required.

- CPU: load averages (1/5/15 min) via `os.loadavg()`
- Memory: used / wired / free via macOS `vm_stat`
- Disk: usage for all mounted volumes via `df -k`
- Temperature: CPU temp via `osx-temperature-sensor`

Single-turn command — completes immediately, no state machine needed.

---

### `/invoice` — TPG Invoice

**Key files:** `src/tasks/invoice/index.js`, `src/tasks/invoice/tpg.service.js`, `src/tasks/invoice/keychain.service.js`

Automates the full TPG invoice download flow using Playwright.

**Flow:**
1. Check macOS Keychain for stored TPG credentials; prompt user on first run
2. Playwright launches browser (`HEADLESS` env var), logs into TPG portal, triggers SMS OTP
3. User replies with 6-digit SMS code
4. Bot completes login, downloads invoice PDF
5. PDF sent via WhatsApp (`ctx.sendDocument`); also emailed if `SMTP_*` env vars configured

**Credentials:** username/password stored in macOS Keychain via `keychain.service.js` — never written to disk or `.env`. Uses `execFile` (not `exec`) for all Keychain operations — no shell interpolation risk.

**States:** `awaiting_otp` (waiting for user's SMS code) → done

---

### Portfolio & Market Analysis

#### `/portfolio` — Portfolio Advisor

**Key files:** `src/tasks/portfolio/index.js`, `src/tasks/portfolio/agent.service.js`, `src/tasks/portfolio/etrade.service.js`

Claude-powered portfolio analysis using live E*TRADE data via MCP.

**Flow:**
1. Check Keychain for OAuth tokens; if missing/expired → start PIN-based auth flow via `shared/auth.service.js`
2. Fetch accounts, balances, positions from E*TRADE
3. Run Claude agent loop with E*TRADE MCP tools (`src/mcp/etrade-server.js`)
4. Reply with total value, position breakdown, sector exposure, gains/losses, and advice

**Portfolio cache:** Saved to disk after each successful run (`cache.service.js`). Used by `/market` for real-time P&L without calling E*TRADE on every market update.

**Analysis cache:** After each production agent run, analysis is saved to `data/portfolio-analysis.json` with a position signature (sorted `SYMBOL:qty` pairs). On the next `/portfolio` call, if positions haven't changed and cache is < 24h old, the cached analysis is returned instantly at $0. `/portfolio refresh` always forces a fresh agent run.

**Subcommands:** `/portfolio logout` — clears stored OAuth tokens from Keychain; `/portfolio refresh` — forces a fresh agent run bypassing the 24h analysis cache

**States:** `awaiting_pin` (PIN-based OAuth) → done

---

#### `/market` — Market Updates

**Key files:** `src/tasks/market/index.js`, `src/tasks/market/sector.service.js`, `src/tasks/market/cache.service.js`

Sector rotation analysis with portfolio context. Runs on a cron schedule and on demand.

**Commands:**
- `/market` — current market status
- `/market pre` / `/market post` / `/market weekly` — force a specific update style
- `/market deep` — force deep analysis with MCP research tools
- `/market status` — scheduler info and next update times
- `/market ideas` — auto-research top 2 positive-change sector ETFs (via `shared/compare.service.js`)
- `/market scorecard` (alias `card`) — multi-day sector performance scorecard via `fetchSectorHistory()`

**Scheduled updates** (market days only):
- Post-market: 4:30 PM ET
- Weekly summary: 9:00 AM ET on Saturdays

**Scheduler implementation note:** Uses `setInterval` polling every 30s instead of node-cron. node-cron v4 requires exact-second matching (second === 0 for 5-field expressions) — if the heartbeat fires 1s late, it misses the tick and reschedules 24h later, silently dropping the update. The 30s polling approach gives a 60-second window to catch the target minute and is immune to normal timer drift. Dedup via `lastFired` dict (keyed by ET date string) prevents double-firing within the same minute.

**Scheduler target JID:** At startup, `schedulerUserId` is constructed from `ALLOWED_USERS[0]` as a `@s.whatsapp.net` JID. Newer multi-device WhatsApp uses `@lid` JIDs that route correctly to the "Message yourself" chat; `@s.whatsapp.net` may land in a different chat. Fix: `index.js` registers a one-time `onFirstSelfMessage` listener that calls `setTargetUser(message.userId)` with the real `@lid` JID on the first self-message received. `setTargetUser` persists the JID to `data/scheduler-target-user.json`; `initScheduler` restores it on startup so the correct target survives restarts without needing a new self-message.

**Adaptive analysis tiers:**
| Level | Trigger | Model | Tools | Cost |
|-------|---------|-------|-------|------|
| template | SPY < 1% | none | no | $0 |
| haiku | SPY 1–1.5% | Haiku | no | ~$0.0001 |
| sonnet | SPY 1.5–2.5% | Sonnet | no | ~$0.001 |
| deep | SPY > 2.5% | Sonnet + agent loop | 3 MCP research tools | ~$0.03 |

Deep also triggers on: any major index > 2.5%, portfolio day change > 3%, sector spread > 4%. Falls back to sonnet on failure.

**Portfolio caching:** Market updates use the locally-cached portfolio data + live Yahoo prices to show P&L without calling E*TRADE API on every run.

---

### Stock Research

#### `/research` — AI Stock Analysis

**Key files:** `src/tasks/research/index.js`, `src/tasks/research/fundamentals.service.js`, `src/tasks/research/agent.service.js`

Fetches fundamentals and runs a Sonnet agent loop to score a stock 0–100.

**Commands:**
- `/research TICKER` — full analysis with score, recommendation, entry plan
- `/research compare A B [C D E]` — parallel research on up to 5 stocks, ranked table; uses `shared/compare.service.js`
- `/research list` — show all cached reports with scores and age
- `/research TICKER refresh` — force fresh fetch, bypass 24h cache

**Architecture:**
1. Fetch price + 52w range from `shared/yahoo.service.js` (60s cache)
2. Fetch 7-day OHLCV via yahoo-finance2 `chart()` for support/resistance
3. Fetch fundamentals via yahoo-finance2 `quoteSummary` (primary — no key, better international coverage): `assetProfile`, `summaryDetail`, `financialData`, `defaultKeyStatistics`, `recommendationTrend`, `calendarEvents`, `earningsTrend`, `upgradeDowngradeHistory`
4. Fallback to FMP `/stable/` if Yahoo returns sparse data (<2 of 5 key metrics non-null)
5. Run Sonnet agent loop (max 4 turns) via `shared/agent.service.js` with scratchpad reasoning
6. Agent calls `get_news` tool (Google News RSS inline) for sentiment
7. Agent outputs JSON: score, 4 sub-scores, recommendation, summary, optional `entryPlan`

**Entry plan (BUY / STRONG BUY only):** Agent produces `entryPlan` with `entryLow`, `entryHigh`, `takeProfit`, `stopLoss`, `rrRatio`, `notes` based on 7-day OHLCV. Task stays alive in `awaiting_trade` state. User replies `trade 1000` (budget) or `trade qty 14` (shares) to place a GFD BUY LIMIT at golden ratio (`entryLow + range * 0.618`) — same path as `/trade`. Re-auth handled inline.

**Research caching:** Results cached to `data/research-cache/<SYMBOL>.json` for 24h. Cache hit = instant + $0. `shared/compare.service.js` reuses this same cache for `/research compare` and `/market ideas`.

**Requires:** `ANTHROPIC_API_KEY`. `FMP_API_KEY` optional (fallback). Est. cost: ~$0.05/call.

---

### Trading

#### `/trade` — Buy Orders

**Key files:** `src/tasks/trade/index.js`, `src/tasks/trade/alert.manager.js`, `src/shared/etrade.order.js`

Places a GFD BUY order and monitors for fill to auto-place optional TP/SL exits.

**Commands:**
- `/trade TICKER` — start a new buy plan
- `/trade list` — show pending orders with live E*TRADE status
- `/trade cancel TICKER` — cancel pending BUY on E*TRADE
- `/trade modify TICKER [tp X] [sl Y]` — cancel old TP/SL and replace; fetches fresh `accountIdKey`, calls `cancelOrder()` + `placeExitOrders()`
- `/trade history` — last 10 completed trades from `data/trade-history.jsonl`
- `/trade journal` — export full trade history as CSV via `ctx.sendDocument`
- `/trade retry-exits TICKER` — retry failed TP/SL from `data/pending-exits/<SYMBOL>-<userId>.json`
- `/trade track TICKER ORDER_ID qty N [tp X] [sl Y] [limit P]` — recovery: re-register existing order after restart
- `/trade fill TICKER` — simulate fill (sandbox only), calls `forceTriggerFill()` in alert.manager

**States:** `awaiting_params` → `awaiting_confirmation` → `placing_order` → done (fill monitor takes over)

**Order type:** BUY LIMIT at golden ratio (61.8% of zone), or MARKET. All orders **Good for Day**.

**TP and SL are independently optional.** Fill monitor handles all 4 combinations (both, TP-only, SL-only, neither).

**Fill monitor (`alert.manager.js`):** 60s cron via `node-cron`. Polls `getOrderStatus()`. On EXECUTED: calls `placeExitOrders()` and appends to `trade-history.jsonl`. On CANCELLED/EXPIRED: notifies user with re-entry command. On OPEN at 3:30–3:59 PM ET: sends one-time GFD expiry warning.

**Persistence:** `data/pending-fills.json` written on every change; restored on startup and immediately re-checked. Key: `SYMBOL:userId:buyOrderId`.

**Failed exits:** Saved to `data/pending-exits/<SYMBOL>-<userId>.json` on placement failure.

**Cash check:** `checkCashBalance()` before every BUY — blocks if `cashAvailableForInvestment` < order cost.

**Portfolio cache refresh:** Fire-and-forget after fill+exits, so `/market` P&L stays current.

**Token expiry:** Re-auth handled inline (`awaiting_pin` state) in both `/trade` and `/research` inline trade. Plan data preserved in task state.

---

#### `/sell` — Sell Orders

**Key file:** `src/tasks/sell/index.js`

Places a single GFD SELL order for an existing position. No TP/SL — one-shot exit.

**Commands:** `/sell TICKER` (alias `/s`)

**Plan syntax** (send after `/sell TICKER`):
```
sell <qty> <price>     ← limit sell, GFD
sell <qty> market      ← market sell
sell all <price>       ← sell full position at limit (auto-fetches qty)
sell all market        ← sell full position at market
```

**States:** `awaiting_params` → `awaiting_confirmation` → `placing_order` → done

**`sell all`:** calls `getPositionQty(symbol)` from `shared/etrade.order.js` to fetch current position size from E*TRADE; errors if position not found.

**Re-auth:** 401 on order placement triggers `startReAuth(ctx, ...)` from `shared/reauth.js`.

---

### `/dev` — Bot Development

**Key file:** `src/tasks/dev/index.js`

Delegates codebase questions and code changes to the locally-installed Claude Code CLI. Zero API cost — uses Claude Pro subscription from `~/.claude/`.

**Two request types:**
- **Questions** (`[ANSWER]` marker) — answered immediately, no confirmation loop
- **Build tasks** (`[PLAN]` marker) — two-phase plan → implement flow

**Flow (build tasks):**
1. Claude Code reads codebase, outputs plan (no file writes yet)
2. User replies `confirm`, `update: <feedback>`, or `discard`
3. On confirm: implementation runs in git worktree under `/tmp/` (outside `src/`, never watched by nodemon)
4. Diff stat shown — `confirm` to merge (nodemon restarts), `discard` to cancel

**Intent detection:** Claude Code self-classifies with `[ANSWER]` or `[PLAN]` tag. Bot branches on this marker.

**Key design decisions:**
- Worktree in `/tmp/` — nodemon never watches it during implementation
- `ANTHROPIC_API_KEY` stripped from subprocess env — Claude Code uses `~/.claude/` Pro credentials
- `stdin` set to `ignore` — prevents blocking on any interactive prompt

**Requires:** Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`) and authenticated via `claude` in terminal.

## Environment Variables

See `.env.example`. Key vars:
- `ALLOWED_USERS` - comma-separated phone numbers
- `HEADLESS` - browser mode for Playwright
- `SMS_TIMEOUT_MINUTES` - task timeout
- `SMTP_USER`, `SMTP_PASS`, `EMAIL_RECIPIENT` - Gmail SMTP for email delivery
- `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET` - E*TRADE API credentials
- `ETRADE_SANDBOX` - set to `false` for production E*TRADE API
- `ANTHROPIC_API_KEY` - Claude API key for portfolio/market/research analysis
- `FMP_API_KEY` - Financial Modeling Prep key for `/research` fundamentals (free tier: 250 calls/day)
- `LOG_LEVEL` - log verbosity: `info` (default, hides debug) or `debug`
