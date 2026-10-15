import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  try {
    // Ensure directory exists
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Set timeout to 5 seconds to prevent database locks
    db.pragma('busy_timeout = 5000');

    return db;
  } catch (error) {
    logger.errorFromError('db.connection', 'Failed to initialize database', error);
    throw new Error('Database initialization failed');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
