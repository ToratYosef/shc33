import path from 'path';
import os from 'os';

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  jwtSecret: process.env.JWT_SECRET || 'chat-ma-dev-secret-change-me',
  jwtExpiresIn: '7d',
  messageTtlMs: 5 * 60 * 1000,
  dataDir: path.resolve(process.cwd(), 'server', 'data'),
  userDbPath: path.resolve(process.cwd(), 'server', 'data', 'users.db'),
  clientConfigPath: path.join(os.homedir(), '.chat-ma', 'config.json')
};
