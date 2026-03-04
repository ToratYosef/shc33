# MovieChat: production-ready terminal messaging (server + cross-platform CLI)

MovieChat is a real WebSocket chat system with:
- real-time messaging
- offline queue + delivery on reconnect
- account auth (register/login/logout/whoami)
- TLS-ready transport (wss in production)
- full-screen TUI + simple command mode
- cinematic “movie-hacker” terminal animations during startup/send/receive with slower dramatic timing and hacker status boxes

## Project layout

- `server/` Go WebSocket server + SQLite
- `client/` Go CLI/TUI client (`chat`)
- `Makefile` build/test helpers

## Quickstart (dev)

### 1) Run server

```bash
cd server
go run ./cmd/server
```

Server defaults to `0.0.0.0:8080` (plain ws for dev).

### 2) Run client commands

```bash
cd client
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat register
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat login
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat users
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat send --to bob --message "yo"
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat open
```

## Commands


### Interactive prompt mode (`chat>`)

Run with no args:

```bash
cd client
CHAT_SERVER=ws://127.0.0.1:8080 go run ./cmd/chat
```

Then use prompt format:

```text
chat> saul -- hello
```

Prompt commands:
- `/help`
- `/users`
- `/inbox`
- `/open`
- `/register`
- `/login`
- `/quit`

- `chat register`
- `chat login`
- `chat logout`
- `chat whoami`
- `chat users`
- `chat ping`
- `chat send --to <username> [--message "..."]`
- `chat inbox`
- `chat open` (full-screen TUI)

If `--to` or `--message` is omitted in `send`, client prompts interactively.

## Full-screen TUI

`chat open` provides:
- left pane: contact list (+ online/offline markers)
- right pane: conversation stream
- bottom input box
- `Ctrl+S` send, `Ctrl+C` quit

## Protocol (JSON envelopes over WebSocket)

Envelope:
```json
{ "type": "MSG_SEND", "requestId": "...", "ts": 1730000000000, "payload": {} }
```

Types implemented:
- `AUTH_REGISTER`, `AUTH_LOGIN`, `AUTH_OK`, `ERROR`, `AUTH_LOGOUT`
- `USERS_LIST`, `PRESENCE_UPDATE`
- `MSG_SEND`, `MSG_ACK`, `MSG_DELIVERED`, `MSG_SEEN`
- `INBOX_LIST`, `PING`, `PONG`

## Security baseline

- Password hashing: bcrypt
- Session token: JWT + hashed token record in DB sessions table
- Auth rate-limit per IP
- Send rate-limit per user
- Message size validation (`MAX_MESSAGE_BYTES`)
- Logs include events only (connect/disconnect/auth errors), never message plaintext
- TLS support built into server (`TLS_CERT_PATH` + `TLS_KEY_PATH`)

## Environment variables (server)

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8080`)
- `DATABASE_PATH` (default `./moviechat.db`)
- `TOKEN_SECRET` (default `dev-secret-change-me`, change in prod)
- `TOKEN_TTL_HOURS` (default `24`)
- `ALLOW_REGISTRATION` (`true` default)
- `EPHEMERAL_MODE` (`false` default, `true` keeps data in-memory)
- `MAX_MESSAGE_BYTES` (default `4096`)
- `TLS_CERT_PATH` (optional)
- `TLS_KEY_PATH` (optional)

## TLS

### Dev self-signed

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=localhost"

cd server
TLS_CERT_PATH=../cert.pem TLS_KEY_PATH=../key.pem go run ./cmd/server
```

Then client:
```bash
CHAT_SERVER=wss://127.0.0.1:8080 go run ./cmd/chat login
```

### Production Let’s Encrypt (example with reverse proxy)

Use Caddy or Nginx to terminate TLS and proxy `/ws` to `http://127.0.0.1:8080/ws`.
If running TLS directly in app, place cert/key and set `TLS_CERT_PATH`/`TLS_KEY_PATH`.

## Build

```bash
make build
make build-client-all
make build-server
```

Cross-platform client outputs:
- `dist/chat-linux-amd64`
- `dist/chat-windows-amd64.exe`
- `dist/chat-darwin-amd64`
- `dist/chat-darwin-arm64`

Server output:
- `dist/server`

## Tests

```bash
make test
```

Includes:
- auth hashing/validation tests
- offline queue / delivery-state DB logic tests

## Notes on E2EE

Current mode is transport security via TLS (`E2EE: OFF` shown by client movie sequence).
Server stores plaintext message bodies in DB by design in this mode.
