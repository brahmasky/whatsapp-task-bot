# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp Task Bot is an extensible Node.js automation bot that runs on WhatsApp, enabling users to trigger automated workflows via WhatsApp commands. It uses Baileys for WhatsApp Web integration and Playwright for browser automation.

## Commands

```bash
npm start        # Run the bot
npm run dev      # Run with hot-reload (nodemon)
```

No test or lint scripts are configured.

## Architecture

```
WhatsApp Messages → MessageRouter → TaskRegistry → Task Handlers
                                        ↓
                                 StateManager (per-user state)
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

## Environment Variables

See `.env.example`. Key vars: `ALLOWED_USERS` (comma-separated phone numbers), `HEADLESS` (browser mode), `SMS_TIMEOUT_MINUTES`.
