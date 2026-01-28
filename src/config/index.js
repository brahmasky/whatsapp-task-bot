import 'dotenv/config';

const config = {
  // TPG credentials (optional - can use Keychain)
  tpg: {
    username: process.env.TPG_USERNAME,
    password: process.env.TPG_PASSWORD,
  },

  // Playwright settings
  playwright: {
    headless: process.env.HEADLESS !== 'false',
  },

  // Timeouts
  timeouts: {
    smsMinutes: parseInt(process.env.SMS_TIMEOUT_MINUTES) || 5,
  },

  // Bot settings
  bot: {
    // Comma-separated list of allowed phone numbers (without +)
    // If empty, only responds to self-messages
    allowedUsers: process.env.ALLOWED_USERS
      ? process.env.ALLOWED_USERS.split(',').map(u => u.trim())
      : [],
  },

  // Email settings (Gmail SMTP)
  email: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    recipient: process.env.EMAIL_RECIPIENT,
  },

  // Environment
  env: process.env.NODE_ENV || 'development',
};

export default config;
