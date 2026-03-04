import WebSocket from 'ws';

function withPath(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function connectWs(serverHttpUrl, token, handlers) {
  const wsUrl = withPath(serverHttpUrl.replace(/^http/, 'ws'), '/ws');
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'AUTH', token }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handlers?.onMessage?.(msg, ws);
    } catch {
      // ignore malformed frames
    }
  });

  ws.on('close', () => handlers?.onClose?.());
  ws.on('error', (err) => handlers?.onError?.(err));

  return ws;
}
