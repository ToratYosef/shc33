import fs from 'fs';
import os from 'os';
import path from 'path';

const cfgDir = path.join(os.homedir(), '.chat-ma');
const cfgPath = path.join(cfgDir, 'config.json');

export function loadLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    const envUrl = process.env.CHAT_MA_SERVER;
    const envPort = process.env.PORT;
    const defaultPort = envPort ? Number(envPort) : 3000;
    return {
      serverUrl: envUrl || `http://localhost:${defaultPort}`
    };
  }
}

export function getServerCandidates(cfg) {
  const preferred = cfg.serverUrl || process.env.CHAT_MA_SERVER || 'http://localhost:3000';
  const candidates = [preferred];

  if (/localhost:3000\/?$/.test(preferred)) {
    candidates.push(preferred.replace('localhost:3000', 'localhost:3001'));
  }

  if (/127\.0\.0\.1:3000\/?$/.test(preferred)) {
    candidates.push(preferred.replace('127.0.0.1:3000', '127.0.0.1:3001'));
  }

  return [...new Set(candidates)];
}

export function saveLocalConfig(partial) {
  const current = loadLocalConfig();
  const merged = { ...current, ...partial };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
  return merged;
}

export function requireAuthConfig() {
  const cfg = loadLocalConfig();
  if (!cfg.token || !cfg.username) {
    throw new Error('Not logged in. Run: npx chat-ma login');
  }
  return cfg;
}
