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
┌────────────┼─────────────────────────────────┐
│            │                    │            │
▼            ▼                    ▼            ▼
┌──────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐
│ /invoice │ │ /system  │ │ /portfolio │ │  /market   │
│          │ │          │ │            │ │            │
│Playwright│ │ macOS    │ │ Claude     │ │ Scheduled  │
│+ Email   │ │ Stats    │ │ Agent      │ │ Updates    │
└────┬─────┘ └──────────┘ └─────┬──────┘ └─────┬──────┘
     │                          │              │
     ▼                          │              │
┌──────────┐                    │              │
│ TPG Site │                    │              │
│ Keychain │                    │              │
│ Gmail    │                    │              │
└──────────┘                    │              │
                                ▼              ▼
                    ┌─────────────────────────────────────┐
                    │           MCP Servers               │
                    │  ┌───────────┐    ┌──────────────┐  │
                    │  │ E*TRADE   │    │ Stock        │  │
                    │  │ Server    │    │ Research     │  │
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

## Adding a New Task

1. Create task module in `src/tasks/taskname/index.js`
2. Export object with `command`, `description`, `start()`, `onMessage()`, optional `cleanup()`
3. Import and register in `src/index.js` via `taskRegistry.register(task)`

## Key Constraints

- **Single active task per user** - state machine tracks one task at a time
- **In-memory state** - lost on restart, no database
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

## Environment Variables

See `.env.example`. Key vars:
- `ALLOWED_USERS` - comma-separated phone numbers
- `HEADLESS` - browser mode for Playwright
- `SMS_TIMEOUT_MINUTES` - task timeout
- `SMTP_USER`, `SMTP_PASS`, `EMAIL_RECIPIENT` - Gmail SMTP for email delivery
- `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET` - E*TRADE API credentials
- `ETRADE_SANDBOX` - set to `false` for production E*TRADE API
- `ANTHROPIC_API_KEY` - Claude API key for portfolio analysis
