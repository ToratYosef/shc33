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

## Run server

```bash
npm run serve
```

Server default: `http://localhost:3000`

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
  "serverUrl": "http://localhost:3000",
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
