# WhatsApp Task Bot

An extensible Node.js automation bot that runs on WhatsApp, enabling automated workflows triggered via chat commands.

## Features

- **WhatsApp Integration** - Uses Baileys for WhatsApp Web connection
- **Task System** - Modular, extensible task architecture
- **Browser Automation** - Playwright for web scraping and form interaction
- **Email Delivery** - Optional Gmail SMTP integration for sending files via email
- **Secure Credentials** - macOS Keychain integration for password storage

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
                    ┌───────────────────────────────────────────────┼───────┐
                    │                       │                       │       │
                    ▼                       ▼                       ▼       ▼
             ┌────────────┐          ┌────────────┐          ┌────────────────┐
             │  /invoice  │          │  /system   │          │   /portfolio   │
             │            │          │            │          │                │
             │ Playwright │          │ macOS stat │          │  Claude Agent  │
             │ + Keychain │          │ CPU/Mem/   │          │  + MCP Tools   │
             │ + Email    │          │ Temp/Login │          │                │
             └────────────┘          └────────────┘          └───────┬────────┘
                                                                     │
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

- `/help` - Show available commands
- `/tasks` - List registered tasks
- `/invoice` - Download and send TPG invoice (via WhatsApp and email)
- `/cancel` - Cancel current task
- `/status` - Show current task status

## Configuration

| Variable | Description |
|----------|-------------|
| `ALLOWED_USERS` | Comma-separated phone numbers (e.g., `61400000000`) |
| `HEADLESS` | Browser mode: `true` (default) or `false` |
| `SMS_TIMEOUT_MINUTES` | Task timeout in minutes (default: 5) |
| `SMTP_USER` | Gmail address for sending emails |
| `SMTP_PASS` | Gmail app password (requires 2FA) |
| `EMAIL_RECIPIENT` | Default email recipient for invoices |

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
