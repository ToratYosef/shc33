import crypto from 'crypto';
import { config } from './config.js';

const messages = new Map();

export function createMessage({ from, to, body }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  messages.set(id, {
    id,
    from,
    to,
    body,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + config.messageTtlMs,
    viewed: false
  });
  return messages.get(id);
}

export function getPendingForUser(username) {
  const now = Date.now();
  return [...messages.values()].filter(
    (msg) => msg.to === username && msg.expiresAt > now && !msg.viewed
  );
}

export function getMessageForRecipient(id, username) {
  const msg = messages.get(id);
  if (!msg || msg.to !== username) return null;
  if (msg.expiresAt <= Date.now()) {
    messages.delete(id);
    return null;
  }
  return msg;
}

export function markViewed(id) {
  const msg = messages.get(id);
  if (!msg) return false;
  msg.viewed = true;
  return true;
}

export function deleteMessage(id) {
  return messages.delete(id);
}

export function cleanupExpired() {
  const now = Date.now();
  for (const [id, msg] of messages) {
    if (msg.expiresAt <= now) {
      messages.delete(id);
    }
  }
}

setInterval(cleanupExpired, 15_000).unref();
