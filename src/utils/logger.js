/**
 * Logger with console output (ANSI colors) + structured file output.
 *
 * Console: unchanged — colored, human-readable.
 * File:    data/logs/bot-YYYY-MM-DD.jsonl — one JSON entry per line.
 *          info/warn/error written to file; debug skipped to keep files lean.
 * Buffer:  last 100 entries kept in memory for /status health.
 *          Access via logger.getRecent(n) and logger.getStats().
 *
 * Set LOG_LEVEL=debug to see debug output in console (default: info).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

const colors = {
  reset:   '\x1b[0m',
  bright:  '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
};

// ─── File output ───────────────────────────────────────────────────────────────

const LOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/logs'
);
let _logDirReady = false;

function _ensureLogDir() {
  if (_logDirReady) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _logDirReady = true;
  } catch { /* non-fatal */ }
}

function _today() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function _writeFile(entry) {
  try {
    _ensureLogDir();
    const fp = path.join(LOG_DIR, `bot-${_today()}.jsonl`);
    fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* never throw from logger */ }
}

// ─── In-memory ring buffer ─────────────────────────────────────────────────────

const BUFFER_SIZE = 100;
const _buffer = [];

function _record(level, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  _buffer.push(entry);
  if (_buffer.length > BUFFER_SIZE) _buffer.shift();
  // Write info/warn/error to file; skip debug
  if (level !== 'debug') _writeFile(entry);
  return entry;
}

// ─── Console formatting (unchanged) ───────────────────────────────────────────

function getTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, data) {
  const timestamp = getTimestamp();
  let colorCode = colors.reset;

  switch (level) {
    case 'INFO':  colorCode = colors.green;   break;
    case 'WARN':  colorCode = colors.yellow;  break;
    case 'ERROR': colorCode = colors.red;     break;
    case 'DEBUG': colorCode = colors.cyan;    break;
  }

  let logMessage = `${colors.dim}${timestamp}${colors.reset} ${colorCode}[${level}]${colors.reset} ${message}`;

  if (data) {
    logMessage += '\n' + JSON.stringify(data, null, 2);
  }

  return logMessage;
}

// ─── Public API ────────────────────────────────────────────────────────────────

const logger = {
  info: (message, data) => {
    _record('info', message, data);
    console.log(formatMessage('INFO', message, data));
  },

  warn: (message, data) => {
    _record('warn', message, data);
    console.warn(formatMessage('WARN', message, data));
  },

  error: (message, data) => {
    _record('error', message, data);
    console.error(formatMessage('ERROR', message, data));
  },

  debug: (message, data) => {
    if (LOG_LEVEL <= LEVELS.debug) {
      _record('debug', message, data);
      console.log(formatMessage('DEBUG', message, data));
    }
  },

  success: (message, data) => {
    // success is a display-only level — record as info
    _record('info', message, data);
    console.log(`${colors.green}${colors.bright}[OK]${colors.reset} ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  },

  // ─── Buffer access (for /status health) ───────────────────────────────────

  /**
   * Return the last `n` log entries from the in-memory buffer.
   * @param {number} n - Number of entries to return (default 20)
   * @returns {{ ts, level, message, data? }[]}
   */
  getRecent(n = 20) {
    return _buffer.slice(-n);
  },

  /**
   * Return a summary of log counts by level since startup.
   * @returns {{ info: number, warn: number, error: number, debug: number }}
   */
  getStats() {
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const entry of _buffer) {
      if (entry.level in counts) counts[entry.level]++;
    }
    return counts;
  },
};

export default logger;
