import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import {
  deleteMessage,
  getMessageForRecipient,
  getPendingForUser,
  markViewed
} from './memoryMessages.js';

const sessionsByUser = new Map();

export function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let username = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'AUTH') {
        try {
          const payload = verifyToken(msg.token);
          username = payload.username;
          sessionsByUser.set(username, ws);
          ws.send(JSON.stringify({ type: 'AUTH_OK', username }));

          const pending = getPendingForUser(username);
          for (const item of pending) {
            ws.send(
              JSON.stringify({
                type: 'INCOMING',
                id: item.id,
                from: item.from,
                len: item.body.length
              })
            );
          }
        } catch {
          ws.send(JSON.stringify({ type: 'AUTH_FAIL' }));
        }
        return;
      }

      if (!username) return;

      if (msg.type === 'VIEW_REQUEST') {
        const target = getMessageForRecipient(msg.id, username);
        if (!target || target.viewed) {
          ws.send(JSON.stringify({ type: 'VIEW_MISSING', id: msg.id }));
          return;
        }
        markViewed(target.id);
        ws.send(
          JSON.stringify({ type: 'VIEW_PAYLOAD', id: target.id, body: target.body })
        );
        return;
      }

      if (msg.type === 'VIEW_CLOSE') {
        deleteMessage(msg.id);
      }
    });

    ws.on('close', () => {
      if (username && sessionsByUser.get(username) === ws) {
        sessionsByUser.delete(username);
      }
    });
  });

  return wss;
}

export function pushIncomingMessage(toUser, message) {
  const ws = sessionsByUser.get(toUser);
  if (!ws || ws.readyState !== ws.OPEN) return;

  ws.send(
    JSON.stringify({
      type: 'INCOMING',
      id: message.id,
      from: message.from,
      len: message.body.length
    })
  );
}
