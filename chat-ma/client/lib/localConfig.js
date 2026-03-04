import fs from 'fs';
import os from 'os';
import path from 'path';

const cfgDir = path.join(os.homedir(), '.chat-ma');
const cfgPath = path.join(cfgDir, 'config.json');

export function loadLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {
      serverUrl: process.env.CHAT_MA_SERVER || 'http://localhost:3000'
    };
  }
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
