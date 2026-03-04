import path from 'path';
import os from 'os';

function normalizeBasePath(input) {
  if (!input || input === '/') return '';
  const trimmed = input.trim();
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, '');
}

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  jwtSecret: process.env.JWT_SECRET || 'chat-ma-dev-secret-change-me',
  jwtExpiresIn: '7d',
  messageTtlMs: 5 * 60 * 1000,
  basePath: normalizeBasePath(process.env.CHAT_MA_BASE_PATH || '/chat-ma'),
  dataDir: path.resolve(process.cwd(), 'server', 'data'),
  userDbPath: path.resolve(process.cwd(), 'server', 'data', 'users.db'),
  clientConfigPath: path.join(os.homedir(), '.chat-ma', 'config.json')
};
