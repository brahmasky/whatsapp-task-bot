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
│     User        │                              │   (node-cron)   │
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
  Scheduled (8AM/4:30PM ET)              On-demand (/market)
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
- `whatsapp.service.js` - WhatsApp connection via Baileys, QR auth, message handling
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

**Global Commands:** `/help`, `/tasks`, `/cancel`, `/status`

## Shared Services (`src/shared/`)

**Before implementing anything in a new task, check here first.** If more than one task might need something, it belongs in `src/shared/`.

| Service | File | Use for |
|---------|------|---------|
| Yahoo Finance quotes | `shared/yahoo.service.js` | Any price fetch — `fetchQuote(symbol)`, 60s cache, never throws |
| Claude agent loop | `shared/agent.service.js` | Any agentic tool-use loop — `runAgentLoop({model, system, messages, tools, maxIterations, maxTokens, executeTool, onToolCall?, onTurnText?})` |
| E*TRADE auth | `shared/etrade.helper.js` | Get authenticated service — `getAuthenticatedService()`, loads tokens from keychain |
| E*TRADE orders | `shared/etrade.order.js` | All order ops — `placeBuyOrder()`, `cancelBuyOrder()`, `placeExitOrders()`, `getOrderStatus()`, `checkCashBalance()`, `refreshPortfolioCache()`, `calcQty()`, `getFirstBrokerageAccount()` |
| OAuth flow | `shared/auth.service.js` | PIN-based OAuth for E*TRADE — `startAuthFlow(userId)`, `exchangePin(userId, pin)`, `cleanupAuthFlow(userId)` |
| News fetching | `tasks/portfolio/news.service.js` | Google News RSS — `fetchMarketNews([symbols], maxSymbols)` |

**New task checklist — before writing any fetch or loop code:**
- Fetching a stock price? → `shared/yahoo.service.js`
- Running a Claude agent with tools? → `shared/agent.service.js`
- Talking to E*TRADE API (auth)? → `shared/etrade.helper.js`
- Placing/cancelling E*TRADE orders? → `shared/etrade.order.js`
- Running E*TRADE OAuth? → `shared/auth.service.js`
- Fetching news? → `tasks/portfolio/news.service.js`

## Adding a New Task

1. Create task module in `src/tasks/taskname/index.js`
2. Export object with `command`, `description`, `start()`, `onMessage()`, optional `cleanup()`
3. Import and register in `src/index.js` via `taskRegistry.register(task)`

## Key Constraints

- **Single active task per user** - state machine tracks one task at a time
- **In-memory state** - lost on restart, no database (exception: trade fill monitor persists to `data/pending-fills.json`)
- **macOS-specific** - Keychain service only works on macOS
- **First run requires QR scan** - session stored in `.baileys_auth/`
- **Authorization** - only self-messages or users in `ALLOWED_USERS` env var

## Utilities

**Email Service (`src/utils/email.service.js`):**
- Gmail SMTP integration via nodemailer
- `isEmailConfigured()` - check if email env vars are set
- `sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentFilename })` - send email with file

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

## Market Updates (/market)

The `/market` command provides sector rotation analysis with portfolio context.

**Features:**
- Track 11 S&P sector ETFs + major indices (SPY, QQQ, DIA, IWM)
- Sector rotation analysis (leaders, laggards, defensive/cyclical signal)
- Live portfolio valuation using cached positions + Yahoo prices
- Hybrid Claude analysis (template/Haiku/Sonnet/Deep based on market conditions)
- Deep analysis agent with research tools on extreme market events (SPY > 2.5%)

**Scheduled Updates:**
- Pre-market: 8:00 AM ET on market days
- Post-market: 4:30 PM ET on market days
- Weekly summary: 9:00 AM ET on Saturdays

**Commands:**
- `/market` - Current market status
- `/market status` - Scheduler info and next update times
- `/market pre` - Force pre-market style update
- `/market post` - Force post-market style update
- `/market weekly` - Force weekly summary
- `/market deep` - Force deep analysis with research tools

**Portfolio Caching:**
Portfolio data is cached locally when `/portfolio` runs. Market updates use this cache + live Yahoo prices to show real-time P&L without calling E*TRADE API.

**Analysis Tiers:**
| Level | Trigger | Model | Tools | Cost |
|-------|---------|-------|-------|------|
| template | SPY < 1% | none | no | $0 |
| haiku | SPY 1-1.5% | Haiku | no | ~$0.0001 |
| sonnet | SPY 1.5-2.5% | Sonnet | no | ~$0.001 |
| deep | SPY > 2.5% | Sonnet + agent loop | 3 research (MCP) | ~$0.03 |

Deep analysis also triggers on: any major index > 2.5%, portfolio day change > 3%, or sector spread > 4%. On failure, falls back to regular Sonnet.

## Stock Research (/research)

The `/research TICKER` command fetches fundamentals and runs a Sonnet agent loop to score a stock 0-100.

**Usage:** `/research AAPL`

**Architecture:**
1. Fetch price + 52w range from Yahoo Finance via `shared/yahoo.service.js` (60s cache)
2. Fetch last 7 trading days OHLCV via yahoo-finance2 `chart()` for entry plan support/resistance
3. Fetch fundamentals via yahoo-finance2 `quoteSummary` (primary — no key, better international coverage) using modules: `assetProfile`, `summaryDetail`, `financialData`, `defaultKeyStatistics`, `recommendationTrend`, `calendarEvents`, `earningsTrend`, `upgradeDowngradeHistory`
4. Fall back to FMP `/stable/` endpoints if Yahoo returns sparse data (<2 of 5 key metrics non-null)
5. Run Sonnet agent loop (max 4 turns) via `shared/agent.service.js` with scratchpad reasoning
6. Agent calls `get_news` tool (inline via Google News RSS) for sentiment
7. Agent outputs JSON: score, 4 sub-scores, recommendation, summary, and optional `entryPlan`

**Scoring dimensions (0-25 each):**
- Valuation: P/E vs norms, P/B, analyst target upside
- Quality: margins, ROE, FCF generation
- Momentum: 52w range position, recent price action (7-day OHLCV)
- Sentiment: news tone from `get_news` tool call

**Entry plan (BUY / STRONG BUY only):**
Agent produces `entryPlan` with `entryLow`, `entryHigh`, `takeProfit`, `stopLoss`, `rrRatio`, `notes` based on 7-day OHLCV support levels. After the report, task stays alive in `awaiting_trade` state. User replies `trade 1000` (budget) or `trade qty 14` (fixed shares) to place a GFD BUY LIMIT at the golden ratio of the entry zone (`entryLow + (entryHigh - entryLow) * 0.618`) immediately — same order + fill-monitor path as `/trade`. Re-auth handled inline if token expired.

**Key files:**
- `src/tasks/research/fundamentals.service.js` - Yahoo (yahoo-finance2) + FMP data fetching, OHLCV
- `src/tasks/research/agent.service.js` - Sonnet agent loop with scratchpad and entry plan prompt
- `src/tasks/research/index.js` - task definition, WhatsApp formatting, inline trade flow

**Requires:** `ANTHROPIC_API_KEY`. `FMP_API_KEY` optional (fallback for sparse data). Est. cost: ~$0.05/call.

## Bracket Trading (/trade)

The `/trade TICKER` command places a GFD BUY LIMIT order immediately and monitors for fill to auto-place TP + SL.

**Flow:**
1. `/trade UBER` — fetch current price for reference, prompt for plan
2. Enter: `buy 70 73 tp 81.30 sl 68 budget 1000`
3. Bot checks live cash balance (`getAccountBalances` — real-time API call), then places **BUY LIMIT at golden ratio of zone** (`buyLow + (buyHigh - buyLow) * 0.618`), **Good for Day**
4. E*TRADE handles execution — no price polling loop in the bot
5. Fill monitor (`alert.manager.js`) polls every 60s — on EXECUTED, automatically places TP (LIMIT SELL) + SL (STOP SELL) using `GOOD_UNTIL_CANCEL`
6. On GFD EXPIRED, user is notified to re-run the next day

**Order type:** BUY LIMIT at golden ratio (61.8%) of the buy zone. Better average cost than the zone ceiling — fills at the limit price or better.

**Order sequencing:** BUY placed first. TP and SL placed only after BUY is EXECUTED — avoids accidental short sell.

**Cash check:** `checkCashBalance()` fetches live `cashAvailableForInvestment` from E*TRADE before placing. Blocks if insufficient. Non-blocking on API failure (E*TRADE will also reject).

**Portfolio cache:** Refreshed (fire-and-forget) after fill + exit orders placed, so `/market` P&L stays current. Not refreshed after BUY placed (order is pending, portfolio unchanged).

**Fill monitor persistence:** Pending fills are written to `data/pending-fills.json` on every change. On startup, the monitor restores from disk and immediately checks status — so a bot restart (nodemon, crash) does not lose track of open orders. The map key is `SYMBOL:userId:buyOrderId`, supporting multiple simultaneous orders for the same symbol.

**Token expiry:** Both `/trade` and `/research` inline trade handle re-auth inline (`awaiting_pin` state). Plan data is preserved in task state so the order is placed automatically after PIN exchange.

**Commands:**
- `/trade TICKER` — set a new trade plan
- `/trade list` — show tracked orders with live E*TRADE status
- `/trade cancel TICKER` — cancel the pending BUY order on E*TRADE
- `/trade track TICKER ORDER_ID qty N tp X sl Y [limit P]` — re-register an existing order after bot restart (recovery only)
- `/trade fill TICKER` — simulate a fill (sandbox only)

**Key files:**
- `src/tasks/trade/index.js` - task definition, param parsing, re-auth flow
- `src/shared/etrade.order.js` - all E*TRADE order ops: `placeBuyOrder()`, `cancelBuyOrder()`, `placeExitOrders()`, `checkCashBalance()`, `getOrderStatus()`, `refreshPortfolioCache()`
- `src/tasks/trade/alert.manager.js` - fill monitor (60s cron, disk persistence, `_checkFills`, `_placeFillExits`)

## Bot Development (/dev)

The `/dev` command delegates codebase questions and code changes to the locally-installed Claude Code CLI — zero API cost, uses the Claude Pro subscription from `~/.claude/`.

**Handles two kinds of requests:**

- **Questions** — "how does X work?", "why does Y do Z?" — answered immediately, no confirmation loop
- **Build tasks** — "add X", "fix Y", "refactor Z" — two-phase plan → implement flow

**Flow (build tasks):**
1. `/dev add a /weather command using wttr.in`
2. Claude Code reads the codebase and outputs a plan (no file writes)
3. User replies `confirm`, `update: <feedback>` (revise plan), or `discard`
4. On confirm: Claude Code implements in a git worktree under `/tmp/` (outside project dir, never watched by nodemon)
5. Diff stat shown — user replies `confirm` to apply or `discard` to cancel
6. On confirm: `git merge` writes to `src/` → nodemon detects change → bot restarts with new code

**Intent detection:** Claude Code self-classifies its response with `[ANSWER]` (Q&A) or `[PLAN]` (build task). Bot branches on this marker — Q&A completes immediately, build tasks enter the confirmation loop.

**Key design decisions:**
- Worktree in `/tmp/` — nodemon never watches it, so file writes during implementation don't restart the bot mid-execution
- `ANTHROPIC_API_KEY` is stripped from the subprocess env — Claude Code uses `~/.claude/` Pro subscription credentials, not the bot's API key
- `stdin` closed (`ignore`) — prevents Claude Code from blocking on any interactive prompt

**Key files:**
- `src/tasks/dev/index.js` - full task implementation (planning, Q&A detection, implementation, git ops)

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
