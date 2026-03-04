import fs from 'fs';
import os from 'os';
import path from 'path';

const cfgDir = path.join(os.homedir(), '.chat-ma');
const cfgPath = path.join(cfgDir, 'config.json');

function normalizeServerUrl(url) {
  if (!url) return url;
  return url.replace(/\/+$/, '');
}

export function loadLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    const envUrl = process.env.CHAT_MA_SERVER;
    const defaultHosted = 'https://api.secondhandcell.com/chat-ma';
    return {
      serverUrl: normalizeServerUrl(envUrl || defaultHosted)
    };
  }
}

export function getServerCandidates(cfg) {
  const preferred = normalizeServerUrl(
    cfg.serverUrl || process.env.CHAT_MA_SERVER || 'https://api.secondhandcell.com/chat-ma'
  );
  const candidates = [preferred];

  if (/localhost:3000\/?$/.test(preferred)) {
    candidates.push(preferred.replace('localhost:3000', 'localhost:3001'));
  }

  if (/127\.0\.0\.1:3000\/?$/.test(preferred)) {
    candidates.push(preferred.replace('127.0.0.1:3000', '127.0.0.1:3001'));
  }

  if (preferred.endsWith('/chat-ma')) {
    candidates.push(preferred.replace(/\/chat-ma$/, ''));
  }

  return [...new Set(candidates.map(normalizeServerUrl).filter(Boolean))];
}

export function saveLocalConfig(partial) {
  const current = loadLocalConfig();
  const merged = {
    ...current,
    ...partial,
    ...(partial.serverUrl ? { serverUrl: normalizeServerUrl(partial.serverUrl) } : {})
  };
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
