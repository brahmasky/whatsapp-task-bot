// Simple console logger with timestamps and color coding

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function getTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, data) {
  const timestamp = getTimestamp();
  let colorCode = colors.reset;

  switch (level) {
    case 'INFO':
      colorCode = colors.green;
      break;
    case 'WARN':
      colorCode = colors.yellow;
      break;
    case 'ERROR':
      colorCode = colors.red;
      break;
    case 'DEBUG':
      colorCode = colors.cyan;
      break;
  }

  let logMessage = `${colors.dim}${timestamp}${colors.reset} ${colorCode}[${level}]${colors.reset} ${message}`;

  if (data) {
    logMessage += '\n' + JSON.stringify(data, null, 2);
  }

  return logMessage;
}

const logger = {
  info: (message, data) => {
    console.log(formatMessage('INFO', message, data));
  },

  warn: (message, data) => {
    console.warn(formatMessage('WARN', message, data));
  },

  error: (message, data) => {
    console.error(formatMessage('ERROR', message, data));
  },

  debug: (message, data) => {
    console.log(formatMessage('DEBUG', message, data));
  },

  success: (message, data) => {
    console.log(`${colors.green}${colors.bright}[OK]${colors.reset} ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  },
};

export default logger;
