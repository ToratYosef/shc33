# chat-ma

Cinematic Matrix-style one-time terminal messenger distributed as an npm CLI package.

## Features

- WebSocket-based incoming message notifications.
- Full-screen terminal UI with Matrix digital rain and glitching header.
- Green hacker status boxes for register/login/send flows.
- One-time ephemeral messages only stored in memory.
- SQLite storage only for users + bcrypt password hashes.
- Password confirmation required before decrypting a message.

## Install

```bash
npm install
```

## Server URL used by CLI

Default CLI server URL is:

`https://api.secondhandcell.com/chat-ma`

Override any time with:

```bash
export CHAT_MA_SERVER=https://api.secondhandcell.com/chat-ma
```

## Run server directly

```bash
npm run serve
```

Server defaults:

- `PORT=3000`
- `CHAT_MA_BASE_PATH=/chat-ma`

So API endpoints are served under `/chat-ma/*`.

## Run server with PM2 (always on)

```bash
npm run pm2:start
npm run pm2:logs
```

Restart / stop:

```bash
npm run pm2:restart
npm run pm2:stop
```

Persist across host reboot:

```bash
npx pm2 save
npx pm2 startup
```

## Reverse proxy example

Proxy `https://api.secondhandcell.com/chat-ma` (including websocket upgrades) to your Node process on `127.0.0.1:3000`.

- HTTP: `/chat-ma/register`, `/chat-ma/login`, `/chat-ma/send`, `/chat-ma/verify-password`
- Base check: `GET /chat-ma` and `GET /chat-ma/health`
- WS: `/chat-ma/ws`

## Use CLI

```bash
npx chat-ma register
npx chat-ma login
npx chat-ma send
npx chat-ma open
```

## Authentication + local config

After successful register/login, client stores token in:

`~/.chat-ma/config.json`

Example:

```json
{
  "serverUrl": "https://api.secondhandcell.com/chat-ma",
  "token": "...",
  "username": "alice"
}
```

## Security model

- Passwords are hashed with bcrypt and never stored plaintext.
- JWT session token for API/WebSocket auth.
- In-memory messages only (never written to SQLite).
- Message TTL defaults to 5 minutes.
- Message is destroyed after close (`VIEW_CLOSE`) or expiry.
- Basic rate limiting on register/login endpoints.

## Publish to npm

1. Update `version` in `package.json`.
2. Login to npm:
   ```bash
   npm login
   ```
3. Publish:
   ```bash
   npm publish --access public
   ```

## Project structure

```
chat-ma/
  package.json
  README.md
  /bin
    chat.js
  /server
    server.js
    ws.js
    auth.js
    userDb.js
    memoryMessages.js
    rateLimit.js
    config.js
  /client
    /lib
      ui.js
      matrixRain.js
      glitch.js
      hackerBoxes.js
      decryptAnimation.js
      wsClient.js
      prompts.js
      localConfig.js
```
