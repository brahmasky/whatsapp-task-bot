/**
 * Simple key-value file persistence for bot data.
 *
 * All data lives under data/ in the project root.
 *
 * API:
 *   load(key)           → read data/<key>.json      → parsed object, or null
 *   save(key, data)     → write data/<key>.json      → atomic (tmp + rename)
 *   append(key, record) → append to data/<key>.jsonl → one JSON line per call
 *   loadLines(key)      → read all lines from data/<key>.jsonl → array of objects
 *
 * Keys can include subdirectories:
 *   save('trade-history', [...])
 *   append('logs/audit', { ... })
 *   load('research-cache/AAPL')
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data'
);

function _jsonPath(key)  { return path.join(DATA_DIR, `${key}.json`); }
function _jsonlPath(key) { return path.join(DATA_DIR, `${key}.jsonl`); }

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// ─── JSON (structured object) ──────────────────────────────────────────────────

/**
 * Read and parse a JSON file.
 * @returns {any} Parsed data, or null if file doesn't exist or is corrupt.
 */
export function load(key) {
  const fp = _jsonPath(key);
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (err) {
    logger.warn(`persistence.load(${key}): ${err.message}`);
    return null;
  }
}

/**
 * Atomically write data as pretty-printed JSON.
 * Writes to a .tmp file then renames — crash-safe.
 */
export function save(key, data) {
  const fp  = _jsonPath(key);
  const tmp = fp + '.tmp';
  try {
    _ensureDir(fp);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, fp);
  } catch (err) {
    logger.warn(`persistence.save(${key}): ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ─── JSONL (append-only log / history) ────────────────────────────────────────

/**
 * Append one record as a newline-delimited JSON entry.
 * Creates the file (and any parent directories) if it doesn't exist.
 */
export function append(key, record) {
  const fp = _jsonlPath(key);
  try {
    _ensureDir(fp);
    fs.appendFileSync(fp, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(`persistence.append(${key}): ${err.message}`);
  }
}

/**
 * Read all records from a .jsonl file, in order (oldest first).
 * Returns an empty array if the file doesn't exist or any line fails to parse.
 */
export function loadLines(key) {
  const fp = _jsonlPath(key);
  try {
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    logger.warn(`persistence.loadLines(${key}): ${err.message}`);
    return [];
  }
}
