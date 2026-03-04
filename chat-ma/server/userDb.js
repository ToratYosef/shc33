import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.userDbPath), { recursive: true });

const db = new Database(config.userDbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    passhash TEXT,
    created_at TEXT
  );
`);

const insertUserStmt = db.prepare(
  'INSERT INTO users (username, passhash, created_at) VALUES (?, ?, ?)'
);
const findByUsernameStmt = db.prepare(
  'SELECT id, username, passhash, created_at FROM users WHERE username = ?'
);
const findByIdStmt = db.prepare(
  'SELECT id, username, passhash, created_at FROM users WHERE id = ?'
);

export function createUser(username, passhash) {
  const createdAt = new Date().toISOString();
  const info = insertUserStmt.run(username, passhash, createdAt);
  return findByIdStmt.get(info.lastInsertRowid);
}

export function findUserByUsername(username) {
  return findByUsernameStmt.get(username);
}

export function findUserById(id) {
  return findByIdStmt.get(id);
}
