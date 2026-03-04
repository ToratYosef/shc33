import http from 'http';
import { loginUser, registerUser, verifyToken, verifyUserPassword } from './auth.js';
import { config } from './config.js';
import { createMessage } from './memoryMessages.js';
import { createRateLimiter } from './rateLimit.js';
import { attachWsServer, pushIncomingMessage } from './ws.js';

const authLimiter = createRateLimiter({ windowMs: 60_000, maxHits: 15 });

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || 'unknown';
}

async function bodyParser(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getBearer(req) {
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/register') {
    const limit = authLimiter(`register:${getIp(req)}`);
    if (!limit.allowed) return json(res, 429, { error: 'Too many attempts' });
    try {
      const { username, password } = await bodyParser(req);
      const result = await registerUser(username?.trim(), password);
      return json(res, 200, {
        token: result.token,
        username: result.user.username
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/login') {
    const limit = authLimiter(`login:${getIp(req)}`);
    if (!limit.allowed) return json(res, 429, { error: 'Too many attempts' });
    try {
      const { username, password } = await bodyParser(req);
      const result = await loginUser(username?.trim(), password);
      return json(res, 200, {
        token: result.token,
        username: result.user.username
      });
    } catch (err) {
      return json(res, 401, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/send') {
    const auth = getBearer(req);
    if (!auth) return json(res, 401, { error: 'Unauthorized' });
    try {
      const { to, body } = await bodyParser(req);
      if (!to || !body) return json(res, 400, { error: 'Recipient and body required' });
      const message = createMessage({ from: auth.username, to: to.trim(), body: String(body) });
      pushIncomingMessage(to.trim(), message);
      return json(res, 200, {
        ok: true,
        id: message.id,
        expiresAt: message.expiresAt
      });
    } catch {
      return json(res, 400, { error: 'Failed to send message' });
    }
  }

  if (req.method === 'POST' && req.url === '/verify-password') {
    const auth = getBearer(req);
    if (!auth) return json(res, 401, { error: 'Unauthorized' });

    try {
      const { password } = await bodyParser(req);
      const ok = await verifyUserPassword(auth.sub, password);
      return json(res, ok ? 200 : 403, { ok });
    } catch {
      return json(res, 400, { ok: false });
    }
  }

  json(res, 404, { error: 'Not found' });
});

attachWsServer(server);

server.listen(config.port, () => {
  process.stdout.write(`chat-ma server listening on ${config.port}\n`);
});
